# 2026-08-24 — rlm family coverage-gap tests and two latent Windows/persistence bugs

## Context

A coverage-gap audit of `packages/rlm` (179 tests at the time) against the repo's per-file 100% gate found the family inside the gate's include glob with no exclusions, plus several "documented as fixed" behaviors that no test pinned. This batch adds 51 keyless cases across the five packages, runs the real-key e2e suite green on Windows, and — because writing the tests was the audit — fixes two defects the new assertions exposed immediately.

## Decision

- Test the handler/tool seams through their real public surfaces: `createHostHandlers` over structurally faked `agents`/`subagents`/`llm`; verifier disposal wiring through a real `ctx.plugin(PluginRlmVerifier)` mount with stub services; loop events through a recording fake session; harness CAS through real temp files. No source exports were widened for testability except one vendor helper (below).
- Vendor gets `[local patch #16]`: `run()` routes PATHEXT-resolved `.bat`/`.cmd` targets through `%COMSPEC% /d /s /c "<quoted command line>"` with `windowsVerbatimArguments`. Node's CVE-2024-27980 mitigation makes direct batch spawns fail with `EINVAL`, so on machines where `uv` resolves to a launcher shim (observed: `C:\WINDOWS\system32\uv.bat`), kernel bootstrap could never run. This extends the platform-residue batch in [2026-08-24-rlm-publish-surface-and-platform-residues](../bug-fix/2026-08-24-rlm-publish-surface-and-platform-residues.md) (#13f/#13b/#15); the PowerShell installer choice from #15 stays authoritative. The spec builder is exported and unit-pinned in `platform.spec.ts`; audit-vendor gains check #16 (43 total now).
- `writeHarnessStates` rollback was doubly broken: the pre-write snapshot was taken *after* the local half landed (restoring the new content — a no-op), and the compensating write CASed against the caller's stale expectation instead of the mtime that write produced, so its conflict was silently swallowed. Fixed to snapshot before the local write and compensate against the freshly observed mtime; torn-view-on-rollback-failure remains a documented limit.
- The FIX-7 stale-mtime checks gained 20 ms pauses between competing writes: back-to-back renames can land in the same mtime tick on NTFS, making the conflict (and therefore the assertion) flaky.

## Why

Handler-table and disposal wiring were exactly where AUDIT P1-1 had already caught one-sided fixes; without regression tests the same drift recurs silently. For #16, patching the shared `run()` covers every bootstrap child (uv install/upgrade, pip, python import probes) in one place, keeps the scrubbed-env boundary from #14 intact, and matches how #13e already made `.bat` shims reachable. Widening only the pure spec-builder (not `run` itself) keeps the spawn path vendor-shaped while still testable.

## Given up

- Direct unit tests for inline `findExecutable` (#13e) and `state-snapshot` size caps: both need either exporting more vendor surface or a live kernel; the dangerous `.bat/.cmd` spawn face is covered via #16 specs, and snapshot limits stay exercised indirectly by idle-reclaim/e2e.
- A stale shim whose target exe is missing still defeats bootstrap (`isExecutable` checks existence of the shim only). Repairing machine state (reinstalling uv) was chosen over teaching the resolver to probe-exec candidates; noted in windows-compatibility §7.6.

## Required verification

- Package suites all green on win32: kernel 69 (13 files), verifier 30, moa 33, loop 18; continual-harness refine-test 80 checks. Real-key e2e 5/5 (`rlm-e2e` + `refine-e2e`) after the fixes, including depth-2 recursion.
- `pnpm --filter @deepseek-ai/dsh-plugin-rlm-kernel run vendor:check` → 43/43 with the new #16 entry.
- venv rebuilt from scratch through the patched bootstrap path (`ensureKernelPython` succeeded where it previously failed with `spawn EINVAL`).
