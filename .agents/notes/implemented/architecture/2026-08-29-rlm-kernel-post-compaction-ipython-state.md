# RLM kernel post-compaction `<ipython_state>` notice (P3-#1)

- **Decision**: Close the prime-agent gap where compaction silently dropped the
  model's awareness that its persistent kernel namespace survived. prime's
  `_syncKernelStateAfterCompaction` injects an `<ipython_state>` message listing
  surviving variables after every compaction; we only injected the restore-time
  `<ipython_state_restored>` (P2-A), leaving a post-compaction blind spot.
- **What shipped** (`packages/rlm/plugin-rlm-kernel`):
  - `src/index.ts` `apply` registers `ctx.on('session/event', (session, event) => …)`
    and, when `(event as { type?: string }).type === 'compaction/end'`, forwards
    `String(session.id)` to `kernels.notifyCompactionEnd`. The `compaction/end`
    event is log-only and absent from this package's view of the `SessionEvent`
    union, so the type is widened for the comparison. The subscription is a
    `ctx.on` effect and is torn down with the plugin.
  - `src/kernels.ts` `SessionKernelRegistry`:
    - New `listVariables(sessionId, signal?)` delegates to the vendored
      `KernelManager.listNamespaceNames` (returns `string[] | null`; coerced to
      `string[] | undefined`), or `undefined` when no kernel is live.
    - New public `notifyCompactionEnd(sessionId)`: no-op when no live kernel
      exists; otherwise `void appendPostCompactionNotice(sessionId)`.
    - New private `appendPostCompactionNotice(sessionId)`: lists surviving
      top-level names via `listVariables`, and when non-empty appends a
      `user/message` with `source: { kind: 'plugin', plugin: 'dsh-rlm-kernel',
      form: 'notice', summary: 'kernel namespace intact after compaction' }` and
      `surfaceOp: 'append'`. The body is `<ipython_state> still alive after
      compaction (kernel keeps running): <names> </ipython_state>`. Missing
      resolver, empty namespace, or `append` throw are silent no-ops.
- **Difference from prime (documented, not aligned)**: prime prunes variables over
  16 MiB before reporting and lists the pruned ones; our kernel has no such prune
  hook, so the notice lists only surviving names. Recorded in
  `docs/research/prime-agent-rlm-gap-analysis.md` (#6).
- **Tests**: no new unit test in this change; the injection path mirrors the
  P2-A `appendRestoreNotice` shape already covered by
  `packages/rlm/plugin-rlm-kernel/tests/restore-notice.spec.ts`. A real
  post-compaction notice requires a live kernel + compaction event and is covered
  by the integration path rather than a new isolated spec.
- **Verification**: `pnpm --filter @deepseek-ai/dsh-plugin-rlm-kernel exec tsc -b` passes.
- **Why this shape**: reuses the existing `session/event` subscription pattern
  (same as `session/disposed`) and the vendored `listNamespaceNames` rather than
  adding a new Python round-trip; the notice is best-effort observability that
  cannot break the compaction transaction.
