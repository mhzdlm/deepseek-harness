# Agent Note: RLM DAG orchestration protocol + quality gate (LAYERS.md §4, NEXT T7.12 / T3.3)

Status: implemented

[English](2026-08-30-rlm-dag-protocol-and-quality-gate.md) | 中文

## Problem

The outer-layer pieces from LAYERS.md §4 were missing: the paper's LongCoT orchestration protocol (+69.5%, arXiv:2512.24601v3 Appendix C.3 — plan subcalls into a DAG, dispatch each layer as a batch, verify every answer with the cheapest deterministic check before it propagates, retry cycles with seed+cache, assemble with dict logic) had no concrete form in the harness, and the "when not to recurse" discipline (Observation 2: depth=0 beats all recursive variants on CodeQA) existed only as research notes. The automated depth/use routing was already ruled out ("automatic judgement waits for evaluation data" — LAYERS.md §4.2), so the startup form is a skill + persona guidance. T3.3's autonomous quality gate (verify score threshold, prime's "gate pass ≠ task success" wording) belonged to this layer and was parallel cleanup.

## Decision

**`rlm_dag` kernel skill** (`plugin-rlm-kernel/skills/rlm_dag/`, pure-stdlib python, deployed like the loop-audit skill: copy to `<dataDir>/skills/rlm_dag/`
+ a global harness python entry):

- `validate_tasks` — two-pass validation (ids first, then dependencies), so a task may depend on a task declared anywhere in the list; self-dependencies are filtered.
- `layers` — topological layering with a *visiting* set so a cyclic DAG raises `ValueError` instead of overflowing the recursion stack.
- `substitute` — `{{id}}` placeholders replaced from the already-computed answers; a missing dependency stays visibly unresolved rather than propagating a bad answer.
- `run` — per layer, one batched `llm_query(prompts=[...])`; every answer is verified by the cheapest deterministic check (non-empty, plus an optional caller `validator`) and the bridge's `degenerate` flag; rejected tasks are re-generated one by one under fresh seeds (the answers dict is the cache and is intentionally not consulted on retry, so a retry is a real retry); the result is a plain `{id: answer}` dict.
- The layer batch and the retries carry `use: "dag-layer" / "dag-retry"` and a `depth` tag that ride the bridge payload into the `session/subcall-query` event — the §5 evaluation data, with no automatic routing yet.

**`llm.query` use/depth passthrough**: the bridge handler forwards caller `use`/`depth` fields into the subcall-query event (optional; routine calls omit them).

**Persona guidance** (`docs/recipes/agent-presets/rlm/agent.cordis.yml`): the "when not to recurse" discipline (fan-out only for information-dense, semantic-transform work; never per line or per trivial step) and the DAG discipline (batch per layer, cheapest deterministic check before propagation, plain dict assembly — "Root compute = dict lookup, string formatting, correctness checks").

**T3.3 quality gate** (`plugin-rlm-verifier` `verify` tool): optional `gate_score` (0-1) reports `gate: 'passed' | 'failed'` from the best candidate score, plus the model-visible note "a passing gate does not mean the task succeeded; verify against the actual outcome" (prime's wording). Omitting the threshold leaves `gate: 'unset'` — no behavior change.

## Testing

`tests/dag-skill.spec.ts` (6 cases, executed in the real venv interpreter, self-skipping without one): malformed-shape rejection, layering of a linear chain and a diamond, cycle ValueError, placeholder substitution, a two-layer DAG with one batched call per layer and answer propagation, a rejected answer retried under a fresh seed, and a fully-rejected (bridge-degenerate) DAG assembling an empty dict. `verify.spec.ts` gains the gate three-state case (threshold 0 → passed, 1 → failed, omitted → unset + the disclaimer text). Kernel: 153/153; verifier: 45/45; typecheck RLM zero errors.

## Alternatives considered

**Automatic depth/use routing now.** Rejected (LAYERS.md §4.2, kept): the "when not to recurse" decision needs evaluation data; this batch ships the data hooks (use/depth in events) and the persona guidance, nothing more.

**A new plugin for the DAG protocol.** Rejected (LAYERS.md §4.1, kept): the protocol is a kernel skill + preset persona, not a plugin — the skill rides the existing python-skill install pipeline and the host bridge.

**Strict answer propagation (fail a layer when any answer is rejected).** Rejected: a partial dict with visible placeholders costs less than a failed run; the caller decides retry/rollback from what is actually assembled.

## Consequences

The outer-layer protocol is expressible in the harness: a model can decompose into a DAG, fan out layer-batched cheap subcalls through the `llm.query` bridge, verify deterministically, retry rejected rounds, and assemble with plain dict logic — with every batch audited in `session/subcall-query` (including `use`/`depth` tags). The recursion guard starts as persona guidance, not an automatic policy. Cost: one batched bridge round per layer plus one generation per rejected task (bounded by `max_retries`); `gate_score` adds a small result field and a disclaimer line only when set; the dogfood record that validates the skill on a real task is deferred until the T7.11 evaluation tool exists (LAYERS.md §6 build order), as recorded in NEXT.md.