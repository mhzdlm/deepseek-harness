# RLM kernel restore notice + refine non-reasoning (P2)

- **Decision**: Close two prime-agent omissions in our RLM reference implementation:
  (A) surface the kernel-namespace revival/loss to the model **immediately after
  restore** (prime's `<ipython_state_restored>`), not only when the next `!python`
  result is prefixed; (B) force the refine subagent (and its review gate) to run
  with non-reasoning so the JSON output budget is not spent on chain-of-thought
  (prime passes `thinkingLevel: 'none'`).
- **What shipped**:
  - **P2-A** (`packages/rlm/plugin-rlm-kernel/src/kernels.ts`):
    - New private `appendRestoreNotice(sessionId, restore)` on `SessionKernelRegistry`.
      After `restoreState()` in `provision`, when `restore` carries revived or lost
      names, it appends a `user/message` with `source: { kind: 'plugin', plugin:
      'dsh-rlm-kernel', form: 'notice', summary: 'kernel namespace restored from
      snapshot' }` and `surfaceOp: 'append'`. The body is `<ipython_state_restored>
      revived: … </ipython_state_restored>` and, when names were lost, a `lost
      (not restored): …` line. Empty restore results are skipped.
    - Uses the existing `options.resolveSession` resolver (best-effort; silent when
      absent or when `append` throws).
    - The prior `consumeRestoreNotice` prefix-on-next-result behavior is retained;
      the immediate notice is the authoritative model-visible signal and the prefix
      is harmless reinforcement on the actual cell output.
  - **P2-B** (`packages/rlm/plugin-continual-harness/src/refine.ts`):
    - `runRefine` and `reviewAutoRefine` now pass `agentOptions: { reasoningEffort:
      'none' as ReasoningEffortId }` on the `SubagentStartRequest` to
      `ctx.subagents.start`. `'none'` is the catalog-conventional off value, the
      dsh equivalent of prime's `thinkingLevel: 'none'`.
- **Tests**:
  - `packages/rlm/plugin-rlm-kernel/tests/restore-notice.spec.ts` (new): injects a
    `form:'notice'` `user/message` with revived/lost text; no-op without a session
    resolver; no-op on empty restore.
  - `packages/rlm/plugin-continual-harness/refine-test.mts`: new check that
    `runRefine` requests `reasoningEffort: 'none'`.
- **Verification caveat**: `conversation-snapshot.spec.ts` is venv-gated. In this
  environment one of its cases (`folds back-to-back cells into a single
  cell-flush`) fails on the clean HEAD too — a pre-existing venv-dependent flake,
  not introduced here. The P2-A injection path does not touch snapshot-event
  emission; the error-result cell case passes in isolation.
- **Why this shape**: prime injects the restore result as a model-visible message
  right after restore so the next turn knows the namespace was revived before it
  issues a cell. We reuse dsh's semantic `notice` form (not a visual `display`
  flag) so consumers present it appropriately. Forcing non-reasoning on refine
  mirrors prime's explicit `void thinkingLevel` on its refinery call.
