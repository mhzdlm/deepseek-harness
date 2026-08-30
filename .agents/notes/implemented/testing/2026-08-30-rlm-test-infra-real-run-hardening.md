# Agent Note: RLM test infrastructure real-run hardening (NEXT Phase 7 T7.0/T7.1)

Status: implemented

[English](2026-08-30-rlm-test-infra-real-run-hardening.md) | 中文

## Problem

The 2026-08-30 final review reported two blockers: the kernel package's vitest "never exits" (so the package cannot enter CI) and "STATUS.md's all-green was never actually run" (full-suite runs kept stalling on slow venv provisioning). Both blocked every real-run acceptance downstream — including development of the `llm.query` bridge (NEXT T7.10), which lives in the same package. The review also claimed two orphan specs (`restore-notice`, verifier `loop-preset`) and asserted "seven packages `tsc --noEmit` green", and the conversation-snapshot spec was flagged flaky on a 60 ms fixed sleep. None of these claims had been reconciled against an actually-completed full run.

## Decision

Resolving the blockers by real runs, in CI-equivalent form (repo root cwd, repo-root-relative filters, log-redirected background execution):

- **The teardown hang does not reproduce** — single files ×3 and full suite ×2 all exit cleanly in ~60 s. The report's `EXIT=124` matches the `timeout | tail` artifact its own methodology note warns about; closed as tooling, not product.
- **The first completed full run surfaced six real hidden failures**, all one root cause: test doubles `dispose: () => undefined` violate the real `KernelManager.dispose(): Promise<void>` contract (`vendor/kernel/index.ts:1871`), so `kernels.ts:570`'s `void manager.dispose().catch(...)` threw on undefined. Fixed the three fakes to `async () => undefined` (the host-handlers.spec precedent) and gave `fakeManager` an explicit return type so future drift is a compile error. Product code was correct; this is fake contract drift.
- **Repo-level typecheck exposed eight RLM test-type errors behind the review's "seven packages green"** (per-package programs have `rootDir: src` and never see `tests/`). Fixed: `tsconfig.host.json` references gained the missing `plugin-rlm-compaction` (TS6307); `restore-notice.spec.ts` got white-box casts for the private `appendRestoreNotice` plus literals typed as the real `RestoreResult` (TS2341); memory specs tightened (TS18048 via concrete cast shapes, TS2345 via corrected `fm()` argument position). Repo typecheck now holds exactly the six documented official pre-existing errors.
- **conversation-snapshot swapped fixed sleeps for event polling** (`waitForCellEvents`, 5 s deadline, 10 ms step); the absence-after-dispose case keeps a 300 ms fixed observation window. Runtime no longer depends on machine speed.
- **Both "orphan spec" claims are false**: `restore-notice` and verifier `loop-preset` are in their package test whitelists (T6.8 already fixed them; STATUS.md carried stale pre-fix wording, now removed). Run counts close the loop: kernel static 135 − 2 `it.skip` = 133 run; memory 78 unit + 5 real-key e2e = 83.
- **Acceptance discipline is now written**: venv-gated / real-key self-skip does not count as acceptance; such cases must really run on a venv/keyed machine (STATUS.md, test-statistics section).

Related: [coverage gap closers](2026-08-26-rlm-coverage-gap-closers.md) (owns the keep-alive cap-eviction matrix whose fakes drifted), [restore notice + refine non-reasoning](../architecture/2026-08-29-rlm-kernel-restore-notice-and-refine-nonreasoning.md) (owns the retyped spec).

## Alternatives considered

**Make production defensive: `Promise.resolve(manager.dispose()).catch(...)` at `kernels.ts:570`.** Rejected: the boundary is typed same-process, the repo trusts TypeScript there, and a defensive wrapper would have silently absorbed every future fake drift instead of failing loudly.

**Chase the teardown hang as a real product bug.** Rejected on evidence: after clean exits across five runs through the CI path, the remaining report observations matched its self-admitted tooling artifact; keeping the blocker open would have blocked all downstream work on an unreproducible premise.

**Larger fixed sleeps (≥300 ms) for conversation-snapshot.** Rejected: still a time-budget guess against a real-timed flush (debounce + dill serialization); polling asserts the actual event, and only the absence case needs a fixed window.

**Automate the venv real-run gate in CI.** Deferred: per the framework ruling, evaluation stays manual for now; the discipline lives as prose in STATUS.md and can be promoted to a gate when a venv-bearing CI lane exists.

## Consequences

The kernel and memory packages now have a trustworthy all-green full-run baseline (×2 runs), repo typecheck is RLM-clean, and T7.10 development is unblocked. The cost of the typed fakes is small ongoing ceremony: new kernel fakes must declare `dispose(): Promise<void>`. Three review-report conclusions stand corrected (hang, orphan specs, seven-packages-green) and the review document itself is not edited — corrections live in NEXT.md Phase 7 rows, STATUS.md test statistics, and this note; FIXES-ARCHIVE records the batch at commit time.
