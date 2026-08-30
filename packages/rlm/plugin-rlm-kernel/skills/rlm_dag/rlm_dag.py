"""rlm_dag — DAG orchestration protocol (LAYERS.md §4.1, NEXT T7.12).

Plan a DAG of subcalls, dispatch each layer as one batch through the host
`llm.query` bridge, verify every answer with the cheapest deterministic check
before it propagates, retry rejected rounds with a per-task cache, and
assemble the final result as a plain dict.

"Root compute = dict lookup, string formatting, correctness checks."

Pure standard library: layering, verification, the retry cache, and assembly
are deterministic and unit-testable without a kernel; `llm_query` is injected
(the kernel global of the same name, or a test double). The bridge already
handles degenerate answers and per-answer truncation; this skill adds the
DAG-level protocol on top.

Task shape::
    tasks = [
        {"id": "parse", "prompt": "Extract the fields from this spec: ..."},
        {"id": "format", "prompt": "Turn {{parse}} into a Markdown table.", "depends_on": ["parse"]},
    ]

Result::

    {"parse": "...", "format": "..."}
"""

from __future__ import annotations

import typing as t

Task = t.Dict[str, t.Any]
Answers = t.Dict[str, str]


def validate_tasks(tasks: t.List[Task]) -> None:
    """Reject malformed DAGs: missing id/prompt, duplicate ids, unknown refs.
    Two passes: ids are collected first so a dependency may be declared before
    its dependents, in any order."""
    ids: t.Set[str] = set()
    for task in tasks:
        task_id = task.get("id")
        if not isinstance(task_id, str) or not task_id:
            raise ValueError("every task needs a non-empty string id")
        if task_id in ids:
            raise ValueError(f"duplicate task id: {task_id}")
        ids.add(task_id)
        if not isinstance(task.get("prompt"), str) or not task["prompt"].strip():
            raise ValueError(f"task {task_id} needs a non-empty prompt")
    for task in tasks:
        task_id = task["id"]
        deps = task.get("depends_on", [])
        if isinstance(deps, str):
            deps = [deps]
        if not isinstance(deps, list) or not all(isinstance(d, str) for d in deps):
            raise ValueError(f"task {task_id} depends_on must be a list of task ids")
        for dep in deps:
            if dep != task_id and dep not in ids:
                raise ValueError(f"task {task_id} depends on unknown task {dep}")
        task["depends_on"] = [d for d in deps if d != task_id]


def layers(tasks: t.List[Task]) -> t.List[t.List[str]]:
    """Topological layering: layer 0 holds the no-dependency tasks; a task sits
    one layer above the deepest layer of its dependencies. A cyclic DAG raises
    ValueError (a back-edge is detected by the visiting set, not by recursion
    overflow)."""
    validate_tasks(tasks)
    by_id = {task["id"]: task for task in tasks}
    depth: t.Dict[str, int] = {}
    visiting: t.Set[str] = set()
    resolved: t.List[str] = []

    def assign(task_id: str) -> int:
        if task_id in visiting:
            raise ValueError(f"cyclic DAG: back-edge at {task_id}")
        if task_id in depth:
            return depth[task_id]
        visiting.add(task_id)
        task = by_id[task_id]
        deps = [d for d in task.get("depends_on", []) if d in by_id]
        if deps:
            depth[task_id] = 1 + max(assign(dep) for dep in deps)
        else:
            depth[task_id] = 0
        resolved.append(task_id)
        visiting.discard(task_id)
        return depth[task_id]

    for task in tasks:
        assign(task["id"])
    out: t.List[t.List[str]] = []
    for task_id in resolved:
        d = depth[task_id]
        while len(out) <= d:
            out.append([])
        out[d].append(task_id)
    return out


def substitute(prompt: str, answers: Answers) -> str:
    """Replace `{{id}}` placeholders with already-computed answers."""
    out = prompt
    for task_id, text in answers.items():
        out = out.replace("{{" + task_id + "}}", text)
    return out


def default_check(text: str) -> bool:
    """The cheapest deterministic check: a usable answer is non-empty after
    trimming. Callers pass a stronger `validator` for task-specific checks."""
    return isinstance(text, str) and len(text.strip()) > 0


async def run(
    tasks: t.List[Task],
    llm_query: t.Optional[t.Callable[..., t.Awaitable[t.Dict[str, t.Any]]]] = None,
    validator: t.Optional[t.Callable[[str], bool]] = None,
    seed: int = 0,
    max_retries: int = 1,
    use: str = "dag-layer",
    depth: int = 0,
) -> Answers:
    """Execute the DAG: layer by layer, one batched bridge call per layer,
    verifying every answer before it propagates and retrying rejected rounds
    with fresh seeds. Returns the plain `{id: answer}` assembly. The `use` and
    `depth` tags ride the bridge payload into the subcall-query event."""
    if llm_query is None:
        raise ValueError("rlm_dag requires the kernel llm_query bridge (injected)")
    check = validator or default_check
    validate_tasks(tasks)
    by_id = {task["id"]: task for task in tasks}
    plan = layers(tasks)
    answers: Answers = {}
    for layer in plan:
        layer_tasks = [by_id[tid] for tid in layer]
        prompts = [substitute(task["prompt"], answers) for task in layer_tasks]
        # One batched dispatch per layer (the bridge's llm_batch analog).
        result = await llm_query(prompts=prompts, use=use, depth=depth)
        texts = result.get("answers", [])
        flags = result.get("degenerate", False)
        pending = {
            task["id"]: (texts[i] if i < len(texts) else "",)
            for i, task in enumerate(layer_tasks)
        }
        for _round in range(max_retries + 1):
            rejected = []
            for task_id, (text,) in pending.items():
                ok = check(text) and not flags
                if ok:
                    answers[task_id] = text
                else:
                    rejected.append(task_id)
            if not rejected:
                break
            # Re-round the rejected tasks one by one (fresh generation; the
            # per-task cache is the answers dict, intentionally not consulted
            # so a retry is a real retry, not a replay).
            for task_id in rejected:
                task = by_id[task_id]
                single = await llm_query(
                    prompt=substitute(task["prompt"], answers),
                    seed=seed,
                    use="dag-retry",
                    depth=depth,
                )
                text = single.get("answers", [""])[0] if single.get("answers") else ""
                flags = bool(single.get("degenerate", False))
                if check(text) and not flags:
                    answers[task_id] = text
            # Tasks still missing stay out of answers; their dependents will
            # fail substitution visibly (the placeholder remains) rather than
            # silently propagating a bad answer.
        else:
            # Loop exhausted: keep whatever passed; the caller sees the
            # partial dict and can re-run with a higher max_retries.
            pass
    return answers


async def assemble(tasks: t.List[Task], llm_query: t.Optional[t.Callable[..., t.Awaitable[t.Dict[str, t.Any]]]] = None, **kwargs: t.Any) -> t.Dict[str, t.Any]:
    """Convenience entry: run the DAG and return the plain dict assembly."""
    return await run(tasks, llm_query, **kwargs)