# Agent Note: RLM persona aligns with Prime Agent's base-prompt spirit

Status: implemented

English | [中文](2026-08-29-rlm-persona-prime-base-spirit.zh.md)

## Problem

The `rlm` preset's `persona` text (`docs/recipes/agent-presets/rlm/agent.cordis.yml`)
was ~350 words — about a quarter of Prime Agent's base system prompt (~1.5K words,
`coding-agent/src/core/prompts/rlm.ts`). It covered the kernel namespace-hygiene
guidance and the `verify`/`moa` combination recipes we added, but it omitted the
generic RLM behavior Prime writes into its immutable base prompt. Two gaps matter
most for "running as Prime intends":

- **IPython is the control surface, not the studied system's native runtime.** Prime
  tells the model to drive a repository/service/dataset through its own interface and
  run project commands via the project's own environment (`uv run`, its `.venv`, the
  repo-root interpreter) — never to install dependencies into the IPython kernel just
  to make an external project import or run there. Our persona said none of this; it
  only warned about namespace clutter.
- **Long-running work is non-blocking.** Prime instructs a non-blocking control loop
  (start work, record the handle, end the turn, read later) and forbids
  `time.sleep`/long blocking `await` polling. Our persona had no such guidance.

Without these, a recursive/long-task RLM can poll, block, or pollute the kernel —
exactly the failures Prime's base prompt exists to prevent.

## Decision

Extend the `rlm` persona with the spirit of Prime's `IPYTHON_CONTROL_PROMPT` and
`LONG_RUNNING_WORK_PROMPT`, kept concise:

- A new paragraph states IPython is the control surface, not the native runtime of
  whatever is studied; drive external systems through their own interface and run
  project commands from a `%%bash` cell through the project's own environment; do
  not install dependencies into the kernel to make an external project import there;
  read/edit files from Python so results become reusable named variables.
- A new paragraph states the non-blocking control loop for slow or independent work,
  parallel workers over serial awaits, and no `time.sleep`/blocking-`await` polling.
- The `rlm`/`refine` call contract is expanded from one sentence to a short paragraph:
  `rlm` admits a child and returns only a handle (the answer never comes back; results
  arrive via messaging or files), and `/refine` is a small, evidence-backed update that
  touches the smallest relevant durable component rather than rewriting the whole
  harness.

The existing namespace-hygiene and `verify`/`moa` paragraphs are retained and
re-anchored. The persona grows to ~600 words — still under half of Prime's base
prompt, which is acceptable because our kernel bootstrap already supplies the
pre-imported packages and `rlm` global, and our `verify`/`moa`/`refine` extensions are
Prime-absent additions the base prompt would not describe.

The mount test asserts the new guidance verbatim
(`packages/rlm/plugin-rlm-verifier/tests/rlm-preset.spec.ts`).

## Alternatives considered

- **Vendor Prime's `buildRlmPrompt` verbatim into our prompt layer.** Rejected: it is
  ~1.5K words of Prime-specific scaffolding (pre-installed package list, child-doctrine
  phrasing, refine philosophy) much of which our kernel bootstrap and `verify`/`moa`
  extensions already cover or supersede; copying it wholesale would duplicate and
  drift. Concise alignment, not reproduction, keeps one authoritative model-visible
  source.
- **Inject the IPython control text from `plugin-rlm-kernel`'s Python side instead of
  the persona.** Rejected: our model-visible system prompt is the TS `persona` row, and
  the vendored kernel already provides bootstrap (pre-imported packages, `rlm` global).
  Keeping all persona guidance in one place avoids split sources the model cannot
  reconcile.
- **Leave the persona thin.** Rejected: the gap is not cosmetic. Prime writes these
  rules into its immutable base precisely because recursive/long-task correctness
  depends on the model knowing IPython is a control surface and that it must not block
  or poll.

## Consequences

- Bought: the `rlm` agent now reads, in its own system prompt, that IPython is a
  control surface (not the studied runtime), to run project commands through the
  project's environment, and to drive long work non-blockingly. This closes the spirit
  gap with Prime for the behaviors that most affect recursive/long tasks.
- Cost: the persona is longer (~600 words). It stays well under half of Prime's base
  prompt; no runtime cost (prompt text only).
- Known boundary: we still do not replicate Prime's two-layer prompt structure (an
  immutable base plus a `/refine`-grown supplemental harness-state layer injected into
  the prompt). The continual-harness plugin provides `rlm.harness` state and `/refine`,
  but the persona does not yet describe that state as a prompt layer; that structural
  alignment is a separate, later step.
- Cross-reference: extends the persona introduced by
  [rlm namespace hygiene persona](../feature/2026-08-26-rlm-namespace-hygiene-persona.md);
  the discovery resolver that lets this preset mount in a pnpm dev checkout is recorded
  in [preset health resolves the rows it can prove will start](../architecture/2026-08-26-preset-health-resolves-rows.md).
