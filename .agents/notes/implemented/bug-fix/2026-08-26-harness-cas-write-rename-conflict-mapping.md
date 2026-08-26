# Agent Note: Harness CAS writes map Windows rename collisions to conflicts

Status: implemented

English | [中文](2026-08-26-harness-cas-write-rename-conflict-mapping.zh.md)

## Problem

`writeHarnessState` finalizes its write with `rename(tmp, dest)`. On Windows, a concurrent writer holding the destination turns that rename into EPERM/EBUSY instead of a clean replace. The conflict-retry paths in `/refine` and rollback retry only `HarnessConflictError`, so a rename collision surfaced as a raw fs error: in practice the refine-test "conflict retry converges" section crashed the whole process once and produced a false failure twice when run under concurrent machine load — the test's interference writer also wrote blind (no expected mtime), so it could land after the pipeline's successful write and clobber the landed state, failing the durability assertions against a pipeline that had reported success.

## Decision

Two changes, one contract:

- `writeHarnessState` maps a failed rename with code `EPERM` or `EBUSY` to `HarnessConflictError` (after force-cleaning the temp file); every other error keeps its cause. A collision is observably "the destination changed underneath this writer", which is exactly what the mtime check already reports — both now flow into the existing single-retry path. Disk-full and permission failures are not conflated with conflicts.
- The refine-test interference writer (`bump`) performs a real CAS write: read with mtime, write with that expected mtime, skip on conflict. Interference still invalidates in-flight attempts' observed mtimes (the retry path stays exercised) but can no longer clobber a state that landed after its read.

## Alternatives considered

**Retry raw rename failures generically inside writeHarnessState.** Rejected: callers own retry policy (once, with re-read and re-apply); silently looping inside the writer would hide sustained contention and multiply writes without bound.

**Make the interference writer sleep longer / fewer ticks.** Rejected: tuning delays trades flake rate for coverage; the race was structural (a writer without a compare-and-scan obligation), not a timing constant.

**Serialize all harness writes through one queue.** Rejected for now: the single-writer assumption plus CAS is the documented contract shared with the kernel-side Python writer; a host-side queue would not cover the kernel writer anyway.

## Consequences

Concurrent harness writers on Windows degrade into typed conflicts instead of crashes, and the FIX-7 convergence suite is deterministic under load. Residual: the stat→rename window is still not an atomic compare-and-swap — two writers whose checks pass in the same window can both rename; the documented single-writer assumption remains the authoritative guard, as before.

## Testing

- `refine-test.mts`: 85 checks green solo and under concurrent load with the kernel package suite (previously reproducible false failures).
