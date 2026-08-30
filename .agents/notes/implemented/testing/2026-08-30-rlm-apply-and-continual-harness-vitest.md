# Agent Note: memory apply()-level tests and continual-harness vitest migration (NEXT Phase 7 T7.7)

Status: implemented

[English](2026-08-30-rlm-apply-and-continual-harness-vitest.md) | 中文

## Problem

The 2026-08-30 review's §5 "补测试" asked for three coverage gaps to close:

- **memory had no apply()-level tests.** The T7.5 leak fix (the dispose handler now deletes `agentsBySession` unconditionally before its three early returns) had no regression net at the mounted-path level; the existing 14 spec files are all pure-function suites.
- **plugin-continual-harness had no vitest spec.** Its only test was a 768-line hand-rolled script (`refine-test.mts`) with a bespoke `check()`/console.log harness — not a vitest suite, invisible to vitest reporting, filtering, and the package whitelist protocol every other RLM package follows. The review's three named spots (`writeHarnessStates` ENOENT/EPERM branches, the local rollback compensation, `rollbackRefine`'s concurrent-version warning) were actually *covered* by that script but not in vitest form.
- **The orphan-spec question from T7.2④** (report claimed `restore-notice.spec.ts`/`loop-preset.spec.ts` were outside every script; T7.0/T7.1 claimed they were in the whitelists) needed a final reconciliation.

## Decision

**memory `tests/apply.spec.ts` (6 cases, driving the real `apply()` through a fake context + the real event-bus shapes).** The fake context captures `ctx.on`/`ctx.effect`/`ctx.tools.register`/`ctx.commands.register`/`ctx.get`/`ctx.logger`; tests fire `agent/session-start`, `session/event`, and `session/disposed` in the shapes `src/index.ts` subscribes to, and assert against the durable artifacts (dialog jsonl in a tmp dir, the mock subagent's spawn records, the appended `session/memory-captured` event, warn logs). Covered: mount registration counts; captureMode off / rootAgentsOnly-child / empty-buffer early-return branches (no spawn, no dialog, no event); sessionEnd flush writing a sanitized dialog (tool results stripped) plus the audit event; extraction failure logged and audited as `extractionRan:false` while the dialog still lands; intervalTurns flush every N turns (and no re-flush below the boundary); and the T7.5 lifecycle net — after disposing a session, a re-registered agent is what the next capture uses as extraction parent. Black-box honesty: the `agentsBySession` map itself has no read seam, so the leak regression is asserted structurally (every disposal path releases without capturing; re-registration observes the fresh agent), noted in the file header.

**continual-harness: full migration of `refine-test.mts` → vitest `tests/refine-test.spec.ts` (34 cases), zero coverage loss.** The whole 768-line script was mechanically transcribed (check() → expect, section prints → describe/it), the package `test` script switched from `tsx refine-test.mts` to the vitest whitelist, and the old file was deleted. Review spots are now explicit describe blocks: `writeHarnessState CAS conflict (FIX-7)` (stale mtime → `HarnessConflictError`, null-mtime absent-file matching), `writeHarnessStates global-failure rollback compensation (P1-fix)` (existing-local restore and the absent-local REMOVE inverse), `rollbackRefine concurrent-version warning (FIX-5)`. One added case pins the absent-file CAS contract (`null` matches absent; a number conflicts).

**The EPERM branch is honestly documented as not unit-testable cross-platform** (added as a comment in the CAS describe): vitest cannot spy ESM namespace exports (`Cannot spy on export "rename"... Module namespace is not configurable`), and a real Windows sharing violation requires a concurrent writer holding the destination, which cannot be provoked deterministically on Linux/macOS. The mtime-conflict path covers the same retryable-conflict contract users depend on.

**Orphan-spec reconciliation (T7.2④) settled:** both `restore-notice.spec.ts` (kernel) and `loop-preset.spec.ts` (verifier) are in their package whitelists (verified against both package.json `test` scripts) — the report's claim predates T6.8; no gap remains.

## Alternatives considered

**Discard `refine-test.mts` and write fresh vitest specs.** Rejected: the 768 lines encode years of accumulated edge coverage (bidirectional rollback, absent-local inverse, retry-convergence under interference timers, corrupt-backup pruning, auto-refine gating). Migration preserves it; rewriting risks silently dropping cases.

**`vi.mock('node:fs/promises')` or `vi.spyOn` for the EPERM branch.** Rejected after a real failure: vitest cannot redefine ESM namespace exports, and a module-level mock would infect every other test in the file. Real EPERM is platform-specific and not deterministically triggerable in CI.

**Add a test hook exposing the `agentsBySession` map.** Rejected: changing product signatures for observability is not worth it; the structural assertions (disposal branches capture nothing; a re-registered agent is picked up) already pin the fix's intent.

## Consequences

Both packages now run vitest-only, whitelisted, with no green-light illusion: memory 92/92, continual-harness 34/34, repo typecheck RLM-zero. The review's three named continual-harness spots and the memory branch matrix are all under vitest. Honest boundaries recorded in-file: `agentsBySession` deletion is asserted structurally, not directly; the EPERM/EBUSY rename path stays untested (comment explains why) with the mtime-conflict contract covered instead. The deferred `refine-test.mts`-style script is gone; the whitelist is the single source of test truth per package.