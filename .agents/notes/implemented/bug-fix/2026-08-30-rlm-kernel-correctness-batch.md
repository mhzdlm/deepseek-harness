# Agent Note: Kernel correctness batch — snapshot race, retained cap, ReDoS guard (NEXT Phase 7 T7.6)

Status: implemented

[English](2026-08-30-rlm-kernel-correctness-batch.md) | 中文

## Problem

Three defects from the 2026-08-30 review, all in `plugin-rlm-kernel`.

**Interrupt-recovery snapshot race (P1#4).** `KernelManager.dispose()` is async and ends with a final dill flush (`flushSnapshotForDispose`, vendored `vendor/kernel/index.ts`). `SessionKernelRegistry.disposeSession` fired it as `void manager.dispose()` and returned immediately. The interrupt-recovery path then called `forSession` on the same session — provisioning a new kernel from the same `kernel-state.dill` while the old kernel's flush could still be writing it. Two writers over one dill can corrupt the snapshot. The comment claiming "the snapshot flush happened inside disposeSession" was false in practice: disposeSession returned before the flush did.

**Retained-child records unbounded within a session (P1#5).** The `rlm.run` fan-out cap counted only `!record.retained` records, so a looping model could create unlimited retained (continuable) children — each a durable child session plus a tracked `AbortController` in `sessionRuns` — with no per-session bound. The records only land in `sessionRuns` after the `await startContinuable` resolves, so parallel `rlm.run` calls could also all pass a cap check that counted none of them yet.

**Model-controlled regex ReDoS (P2).** `session.query`'s grep built `new RegExp(source, 'i')` from up to 200 model-supplied characters and scanned rendered messages up to a 400k-character budget. The budget bounds total input volume, not the time of a single `pattern.test()` on one message: a pattern like `(a+)+` can backtrack exponentially over a single 10k-character message and stall the single-threaded host.

## Decision

**Dispose awaits the flush.** `disposeSession` is now `async` and `await`s `manager.dispose()` (and the in-flight provision's disposal). The interrupt-recovery path `await`s `disposeSession` before `forSession`. `disposeIdle` and `enforceLiveCap` collect their targets and `await Promise.all(...)` so a sweep does not serialize on one flush but still never returns before they settle; `disposeAll` became async and its two callers use `void`. This makes the dispose→re-provision ordering contract explicit instead of accidental.

**The cap counts every live child plus in-flight spawns.** `rlm.run`'s governor now checks `sessionRuns.size + inflightSpawns` — retained children included (reversing the 2026-08-26 hardening-sweep decision that rejected counting them). A new `inflightSpawns` per-session counter bumps before the spawn awaits and drops when the record lands (or on failure), so parallel `rlm.run` calls see each other's pending spawns and cannot overrun the cap in the window where no record exists yet. `abortSession` clears the counter.

**A regex complexity guard, not more input caps.** `assertReDosSafePattern(source)` rejects two dangerous families with actionable text, then grep builds the pattern:
1. an unbounded quantifier (`+`, `*`, `{n,}`) over a group whose content quantifies or alternates — `(a+)+`, `(a|b)*`, `(a?)+`, `(a{1,2})*`;
2. the same quantified atom repeated 3+ times — `a*a*a*`, `\d+\d+\d+` (ambiguous splits make the scan polynomial).

Escape sequences are neutralized to a placeholder (`\\.` → `x`) before scanning so `\d+\d+\d+` is caught while `\d+\s*\d+` stays allowed. Bounded forms remain legal: `(1|2)?`, `(ab)+`, `\d+\s*\d+`. The existing scan budget stays as the total-volume bound.

Tests: retained children now trip the cap (the old "retained exempt" assertion was rewritten, per "tests describe behavior"); a hanging `startContinuable` proves the in-flight window is capped; two ReDoS tests pin rejections (`(a+)+`, `(a|b)*`, `(a{1,2})*`, `a*a*a*`, `\d+\d+\d+`) and allowances (`(1|2)?\d`, `(ab)+`, `\d+\s*\d+`).

Related: [hardening sweep](../bug-fix/2026-08-26-rlm-hardening-sweep.md) (owns the fan-out and grep bounds this batch tightened; its retained-exempt decision is reversed here).

## Alternatives considered

**Regex timeout via worker threads.** Rejected for the same reason the hardening sweep did: moving transcript rendering off-thread duplicates session-state access for one call. A complexity guard at construction is the honest synchronous bound — one `test()` on one message becomes bounded by construction, and the scan budget still bounds total volume.

**Deleting escapes instead of substituting a placeholder.** Tried first and wrong: stripping `\d` from `\d+\d+\d+` leaves `+++`, destroying the structure the guard needs to recognize. A placeholder (`x`) preserves quantifier positions.

**Counting only retained, or only one-shot, with separate caps.** Rejected: two counters would let a model max out both; one live-children cap is the simpler invariant, and the error text names `rlm.delete_subagent` for reclaiming finished children.

## Consequences

The dispose→re-provision ordering is now guaranteed: a follow-up `forSession` on a freshly disposed session cannot race the old kernel's dill flush. The fan-out cap now actually bounds a session's live children, retained included, and is exact even under parallel spawns; a workflow that legitimately needs more than `maxChildrenPerSession` retained children must raise the Config or delete finished ones via `rlm.delete_subagent`. Grep rejects ReDoS-shaped patterns with actionable text while keeping bounded forms and the scan budget. Costs: `disposeSession`/`disposeAll` are async (callers use `void`), eviction now waits for flushes, and one note-worthy honesty caveat — the snapshot race itself has no deterministic unit test (there is no fake-manager seam; the venv-gated `idle-reclaim` spec exercises the dispose→restore ordering end-to-end, now deterministic by construction rather than by luck).
