# 2026-08-25 — Kernel keep-alive leases (NEXT T3.2 Phase A)

## Context

LIFETIME.md (T3.2 design) resolved the dsh idle-reclaim/session-dispose model versus prime's daemon survival into a three-state machine (HOT/WARM/COLD) plus explicit leases: the desktop host is the daemon, and time-dimension features must be able to keep a kernel alive without inventing per-feature hacks. Phase A ships the lease mechanism inside the kernel plugin; the jobs/goal/schedule wiring is Phase B (with T3.1).

## Decision

- `SessionKernelRegistry.pin(sessionId, reason)` / `unpin(sessionId, reason)`: counted per (session, reason); an unpin without a matching pin is a no-op; `session/disposed` clears all leases (disposal is the terminal event, mirroring T1.2's parent-authority hierarchy).
- Reclamation excludes `busy ∪ pinned`: `disposeIdle` passes the union into `IdleTracker.expired`; the cap pass sorts candidates via a new `IdleTracker.oldest` (least-recently-used, unknown ids dropped).
- `maxLiveKernels` (default 4): when HOT count exceeds the cap, the oldest kernels **without** a lease or busy flag are disposed (LRU); leased kernels are never cap-evicted. Config key `maxLiveKernels` (0 disables).
- Leased reclaim snapshot protection: before disposing an idle **leased** kernel, force `snapshotState()`; on failure schedule a retry after `reclaimSnapshotGraceMs` (default 5000) and keep the kernel HOT, so a temporary dill failure cannot silently lose a lease-held namespace. Unleased kernels keep the pre-existing behavior (dispose immediately, snapshot flushed inside vendor dispose).
- `disposeIdle` became async (its callers already fire-and-forget or await; tests updated).

## Given up

- Per-lease TTL in the registry: lifetimes belong to the holder's semantics (Phase B consumers pin for their window), per LIFETIME.md §6.
- Phase B wiring and Phase C supervisor both remain documented and deferred.

## Required verification

- Unit suite (`keep-alive.spec.ts`): oldest ordering, lease counting/clearing, LRU eviction order with lease/busy exclusion, and the snapshot-failure retry cycle. Real-kernel integration continues via the existing idle-reclaim spec.
- Kernel suite green across package-root and filter runs (loop-audit spec's skill dir now resolves via `import.meta.dirname`).