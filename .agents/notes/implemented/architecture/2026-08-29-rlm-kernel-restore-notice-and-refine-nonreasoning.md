# Agent Note: RLM kernel restore notice + refine non-reasoning (P2)

Status: implemented

## Problem

Two prime-agent omissions in the RLM reference implementation: (A) the kernel-namespace revival/loss was surfaced to the model only when the next `!python` result was prefixed, not **immediately after restore** (prime's `<ipython_state_restored>`); (B) the refine subagent (and its review gate) ran with chain-of-thought, spending the JSON output budget on reasoning instead of prime's `thinkingLevel: 'none'`.

## Decision

- **P2-A** (`packages/rlm/plugin-rlm-kernel/src/kernels.ts`):
  - New private `appendRestoreNotice(sessionId, restore)` on `SessionKernelRegistry`. After `restoreState()` in `provision`, when `restore` carries revived or lost names, it appends a `user/message` with `source: { kind: 'plugin', plugin: 'dsh-rlm-kernel', form: 'notice', summary: 'kernel namespace restored from snapshot' }` and `surfaceOp: 'append'`. The body is `<ipython_state_restored> revived: … </ipython_state_restored>` and, when names were lost, a `lost (not restored): …` line. Empty restore results are skipped.
  - Uses the existing `options.resolveSession` resolver (best-effort; silent when absent or when `append` throws).
  - The prior `consumeRestoreNotice` prefix-on-next-result behavior is retained; the immediate notice is the authoritative model-visible signal and the prefix is harmless reinforcement on the actual cell output.
- **P2-B** (`packages/rlm/plugin-continual-harness/src/refine.ts`):
  - `runRefine` and `reviewAutoRefine` now pass `agentOptions: { reasoningEffort: 'none' as ReasoningEffortId }` on the `SubagentStartRequest` to `ctx.subagents.start`. `'none'` is the catalog-conventional off value, the dsh equivalent of prime's `thinkingLevel: 'none'`.

## Testing

- `packages/rlm/plugin-rlm-kernel/tests/restore-notice.spec.ts` (new): injects a `form:'notice'` `user/message` with revived/lost text; no-op without a session resolver; no-op on empty restore.
- `packages/rlm/plugin-continual-harness/refine-test.mts`: new check that `runRefine` requests `reasoningEffort: 'none'`.

Verification caveat: `conversation-snapshot.spec.ts` is venv-gated. In the authoring environment one of its cases (`folds back-to-back cells into a single cell-flush`) failed on the clean HEAD too — a pre-existing venv-dependent flake, not introduced by this change. The P2-A injection path does not touch snapshot-event emission; the error-result cell case passes in isolation.

## Alternatives considered

**Prefixing only the next `!python` result.** Rejected: prime injects the restore result as a model-visible message right after restore so the next turn knows the namespace was revived before it issues a cell; the prefix alone leaves a gap between restore and the next cell. The immediate notice is authoritative, with the prefix kept as harmless reinforcement.

**Using a `display`-flagged message instead of the semantic `notice` form.** Rejected: the `notice` form lets consumers present it appropriately, and the `surfaceOp: 'append'` keeps it out of derived model history.

**Leaving refine on the default reasoning effort.** Rejected: forcing non-reasoning mirrors prime's explicit `void thinkingLevel` on its refinery call — the JSON output budget is not spent on chain-of-thought.

## Consequences

The model sees its kernel namespace revival/loss immediately after restore (the next turn knows before issuing a cell), and refine/review children spend their whole output budget on proposals. Cost: one extra `user/message` per restore with names, and refine no longer benefits from chain-of-thought.