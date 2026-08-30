# Agent Note: RLM call-surface wall-clock timeouts (NEXT Phase 7 T7.3)

Status: implemented

[English](2026-08-30-rlm-call-surface-timeouts.md) | 中文

## Problem

The 2026-08-30 review's P1#1/P1#7: every auxiliary model call in the RLM family could hang forever. The `moa` aggregator ran under only the caller's abort signal with no token cap — a provider that never returns burned the full reference fan-out and then hung the tool call indefinitely. The memory plugin's embedding fetch had no signal, timeout, or retry, and it rides the synchronous `memory_search` path, so a wedged network endpoint froze the whole agent turn; the capture extraction child was equally unbounded. References in `moa` already carried a per-slot `AbortSignal.timeout` — the gaps were the aggregator, the embeddings request, and the capture child.

## Decision

Three wall-clock budgets, each composed with existing caller signals via `AbortSignal.any`, each a validated Config/preset field with an explicit default (no hidden `??`):

- **`moa` aggregator** — new per-preset `aggregatorTimeoutMs` (default `DEFAULT_AGGREGATOR_TIMEOUT_MS = 300_000`, floor 1 s, normalized in `presets.ts` alongside `referenceTimeoutMs`). The synthesis call composes `AbortSignal.any([signal, AbortSignal.timeout(...)])` in `moa-tool.ts`; an expired budget fails the tool loud *after* the `session/moa-reference` events have already landed, so the burned reference work stays visible in the log. The deliberate "no token cap on the aggregator" choice is unchanged — the budget is wall-clock, not truncation.
- **Embeddings request** — `createExternalEmbeddingProvider` gains `timeoutMs` (default 30 s), passed as `AbortSignal.timeout` per HTTP request in `embedding.ts`. Wired as memory Config `embeddingsTimeoutMs`. Consumers already degrade: `hybridSearch` catches embed failures into the lexical path (T6.7), and `promoteDraft` treats the embedding cache as best-effort — so an expired budget degrades recall quality, never fails the turn.
- **Capture extraction child** — `extractDrafts` gains a `timeoutMs` argument (default 120 s, memory Config `captureTimeoutMs`), composing the budget into the signal handed to `subagents.start`. An expired child rejects; the failure is logged and audited as `extractionRan: false` (failure semantics refined by the memory-lifecycle-and-capture-audit note, T7.5), and `persistCapture` still writes the durable dialog.

Tests pin each budget: a hung aggregator fails the tool within its budget (`moa.spec.ts`), a hung embeddings fetch rejects within its budget (`embedding.spec.ts`), and a hung extraction child rejects within its budget (failure semantics refined by T7.5) plus two static `parseExtractionProposal` items (new `capture.spec.ts`, whitelisted in the memory package test script).

Related: [moa plugin](../bug-fix/2026-08-24-rlm-moa-plugin.md) (owns the panel decision this budget bounds), [memory Phase E embedding seam](../feature/2026-08-30-rlm-memory-phase-e-embedding-seam.md) (owns the provider this timeout wraps).

## Alternatives considered

**Retry the embeddings request on timeout.** Rejected for now: a retry multiplies the worst-case latency on a synchronous path and masks endpoint health; the lexical fallback already covers the failure, and a bounded retry belongs with real latency data (recorded by future `purpose:'rlm-subcall'` telemetry rather than guessed today).

**Share one plugin-wide timeout constant.** Rejected: the three surfaces have different cost shapes (a synthesis is long-form generation, an embeddings batch is sub-second, an extraction child is a full agent run), so one number is either uselessly large or uselessly small somewhere. Per-surface Config fields keep the tunable where the semantics live.

**Abort capture children through session-disposal controllers (verifier pattern).** Deferred: real, but it belongs with the `agentsBySession` lifecycle fix (NEXT T7.5), which owns the dispose-path wiring; the wall-clock budget here is independent of it.

## Consequences

No auxiliary call in the family can hang the turn anymore; the failure of each surface is loud where loudness has value (moa throws after its references are logged) and degrading where degradation is already handled (embeddings → lexical, capture → dialog-only). Cost: three new Config fields to keep documented, and the moa preset shape gained a required resolved field, which surfaced one more preset literal in `llm-stream.spec.ts` that the compiler now forces future preset-shape changes to update.
