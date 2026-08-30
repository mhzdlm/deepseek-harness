# Agent Note: Memory session lifecycle and capture audit honesty (NEXT Phase 7 T7.5)

Status: implemented

[English](2026-08-30-rlm-memory-lifecycle-and-capture-audit.md) | 中文

## Problem

Two defects surfaced by the 2026-08-30 review.

**Agent-per-session registry leak (T6.11 reopened, confirmed real).** `plugin-rlm-memory` keeps `agentsBySession: Map<sessionId, Agent>` so capture can hand the extraction child a real `parent` (a `Session` cast has no `.ctx`). The `session/disposed` handler had three early returns — `captureMode === 'off'`, `!eligible(session)` (the `rootAgentsOnly` default rejects every child session), and "no buffered entry" — all before `agentsBySession.delete(id)`. So in off mode, for every child session, and for every session with no captured turns, the `Agent` strong reference stayed in the map forever. With `rootAgentsOnly` defaulting to true, every subagent session leaked its `Agent`.

**Capture audit lie (P1#3).** `extractDrafts` wrapped `subagents.start` + `run.result` in `catch { return [] }`, silently folding spawn errors, child crashes, and timeouts into an empty result. `runCapture` then set `extractionRan = true` unconditionally after the call, and created an `AbortController` it never aborted. Net effect: a permanently failing extraction was indistinguishable from "nothing to extract" in the `session/memory/captured` audit event, and the failure was invisible in the logs.

## Decision

**Lifecycle: unconditional release.** The `agentsBySession` delete moves to the top of the dispose handler, before any early return; the `Agent` is read out first and the capture path uses it (the `session as Agent` fallback cast now only covers sessions the registry never saw, e.g. pre-existing sessions). A disposed session releases its `Agent` regardless of capture mode, eligibility, or buffer state. `buffers`/`counts` need no equivalent change: their only writer (`bufferTurn`) is already gated by the same early returns, so they are empty in exactly the paths that skip cleanup.

**Audit honesty: failures propagate, then get logged as failures.** `extractDrafts` drops its swallow-catch: an empty dialog still returns `[]` before spawning, a clean run that finds nothing still returns `[]`, but a spawn error or rejected child run now rejects. `runCapture` wraps the call in try/catch: on failure it logs `capture extraction failed for <id>` via `ctx.logger.warn` and keeps `extractionRan = false` in the audit event, then persists the dialog and lands whatever proposals exist either way. The dead `AbortController` is removed (the call passes a plain `new AbortController().signal` as the no-cancellation default; the wall-clock budget is composed inside `extractDrafts`, T7.3).

Tests (`tests/capture.spec.ts`): the T7.3 timeout item now asserts a reject within budget (its old "resolves []" assertion described the old swallow contract and was updated with it); a spawn error rejects; a clean empty result still returns `[]`; the empty-dialog short-circuit is unchanged. The dispose-path regression net (agent released per session) belongs to the `apply()`-level suite that T7.7 builds.

Related: [capture pipeline](../feature/2026-08-30-rlm-memory-phase-a-write-path.md), [call-surface timeouts](../bug-fix/2026-08-30-rlm-call-surface-timeouts.md).

## Alternatives considered

**Keep swallowing and only add a log.** Rejected: a log alone cannot fix the audit event, which is the model-visible record — `extractionRan` must be false for a failed extraction or the distinction is still lost downstream.

**Wire disposal-abort into the extraction child (verifier controller pattern).** Deferred: the child is already wall-clock bounded (T7.3) and fire-and-forget on disposal; a per-session disposal-abort controller adds lifecycle wiring that belongs with any future subagent-lifecycle work, not with this honesty fix.

## Consequences

No session `Agent` outlives its session, and a failed capture is now a logged, audited failure instead of a silent empty result — the durable dialog still lands either way. Cost: `extractDrafts`'s contract changed from "never throws" to "throws on child failure", which updated its T7.3-era test and keeps the swallow boundary only where leniency is actually correct (parse leniency in `parseExtractionProposal`).
