# Agent Note: RLM kernel snapshot history and flush event

Status: implemented

English | [中文](2026-08-26-rlm-kernel-snapshot-history.zh.md)

## Problem

The dill snapshot is the only namespace-continuity mechanism for a persistent
IPython kernel, but only the latest `kernel-state.dill` survives: each flush
atomically overwrites it, so a corrupt or lost latest loses every earlier
namespace. The durable session log records only cell actions and truncated
outputs — no per-flush object accounting — so post-hoc audit and cross-host
migration cannot tell which dill a given cell produced. Session-991e6b30 (19.6h,
167 cells) showed both gaps concretely: no history to roll back to, and no log
line explaining what a snapshot carried.

## Decision

- Add Config `snapshotHistory` (default 3, `0` disables) to plugin-rlm-kernel.
  After each successful dill flush, `SessionKernelRegistry.rotateSnapshot` keeps
  the last N copies as `kernel-state.<n>.dill` (n = 1 is the newest) by shifting
  older copies outward and dropping the oldest beyond the cap (T4.1).
- Route every flush through one method `flushSnapshot(sessionId, reason)` that
  (a) calls `manager.snapshotState()` to obtain the real `SnapshotResult`, (b)
  emits the log-only `session/kernel-snapshot` event `{ ok, vars, bytes, skipped[],
  pruned[], ms, reason }`, and (c) rotates history on success. It is called from
  the debounced post-cell flush (reason `cell`) and from the reclaim forced-
  snapshot gate (reason `reclaim`), which previously inlined
  `manager.snapshotState()` (T4.2).
- The vendored auto-snapshot stays enabled: it owns the atomic dill write and
  cannot be turned off without a `[local patch]` to vendored `KernelManager`
  (vendoring policy forbids source edits outside the sync procedure). The
  plugin's explicit `snapshotState()` therefore re-serializes the same namespace
  once per debounce window purely to capture the result and rotate. This is a
  deliberate extra serialization in exchange for leaving vendored execution
  untouched.
- `resolveSession`, injected from `ctx.sessions`, resolves the durable Session so
  the event reaches the log; emission is best-effort and skips when no session
  resolves. `session/kernel-snapshot` is added to `KNOWN_SESSION_EVENT_TYPES` by
  `pnpm run gen-persistence-catalog`.

## Alternatives considered

- **Own the flush entirely and disable the vendored auto-snapshot.** Rejected: it
  needs a `[local patch]` to vendored `KernelManager`, which the vendoring policy
  disallows outside the sync procedure, and would regress persistence if the new
  path had a bug — the vendored writer is the proven one.
- **Emit the event by reading the already-written dill instead of re-serializing.**
  Rejected: it forfeits the accurate `vars` / `skipped` / `pruned` / `bytes` / `ms`
  the event contract requires; one explicit `snapshotState()` per debounce window
  is cheap next to a cell's own cost.
- **Keep history in one tar / sqlite instead of numbered files.** Rejected: plain
  numbered files keep the on-disk shape debuggable and the budget trivial
  (N × maxBytes).

## Consequences

- Bought: the last N namespaces survive a lost latest, and the session log now
  carries per-flush object accounting for audit and migration.
- Cost: one extra dill serialization per debounce window (accepted); the on-disk
  budget is bounded by `snapshotHistory × maxBytes`.
- `packages/rlm/plugin-rlm-kernel/tests/persistence-catalog.spec.ts` guards the
  event-type / catalog pairing; `tests/snapshot-rotation.spec.ts` pins T4.1
  shifting and T4.2 emission with a stubbed `KernelManager` (7 tests, green).
- Deferred: `docs/persistence-catalog.zh.md` needs a pairing refresh through the
  translation tooling (the English catalog and `KNOWN_SESSION_EVENT_TYPES` are
  regenerated). `docs/config-catalog.md` regeneration is currently blocked
  repo-wide by pre-existing missing JSDoc on three moa config fields
  (`referenceModels.mode`, `aggregator.provider`, `aggregator.model`), so
  `snapshotHistory` is not yet in the generated config catalog even though its
  source JSDoc is present; fixing those three fields is a separate doc task.
