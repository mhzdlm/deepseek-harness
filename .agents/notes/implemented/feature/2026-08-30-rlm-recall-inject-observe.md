# Agent Note: RLM active recall injection, observe-first (LAYERS.md §3, NEXT Phase 7 T7.13)

Status: implemented

[English](2026-08-30-rlm-recall-inject-observe.md) | 中文

## Problem

The middle-layer gap tracked in LAYERS.md §3: the harness overview is a pure time-index channel (recent entries), so a "what is relevant NOW" question had no per-turn relevance channel. The ReMe integration analysis (research, "ReMe与dsh集成分析.md" §12.1) sketched the fix — at `continual-harness` section render, run one lightweight recall against the most recent user message and inject top-N relevant memories with a hard budget. The three-branch discipline (off | observe | enforce, default unaffected) applies: nothing may change the prompt by default.

## Decision

The active recall injection ships observe-first in `@deepseek-ai/dsh-plugin-continual-harness`:

- **`src/recall-inject.ts`** (new): `latestUserQuery(session)` takes the most recent user message from the derived transcript (truncated to a query budget); `renderRecallSection(query, hits, budgetChars)` renders a `## Relevant Memories` section in rank order under a hard character budget — a hit whose header does not fit is dropped, an admitted body is truncated with an ellipsis marker, and the slice length is floor-guarded so a tiny budget cannot produce negative slices.
- **Section wiring**: the harness section render now appends the recall suffix under `enforce` only. `observe` (the default) runs the same recall and records what WOULD be injected; `off` skips everything. Default behavior is unchanged (the acceptance criterion).
- **Config**: `recallInject` (`off|observe|enforce`, default `observe`), `recallInjectTopN` (3), `recallInjectBudgetChars` (2000).
- **Recall source**: the memory package's synchronous lexical `search` over `<dataDir>/memory` `published/` (the plugin now depends on `@deepseek-ai/dsh-plugin-rlm-memory` via its `./src/*` seam). Cheap by design: no embeddings, no network, one `deriveMessages` pass.
- **Event**: every render with hits (observe or enforce) appends a log-only `session/memory-recall-inject` event (mode, query, hit relPaths, would-be/did inject chars) — the LAYERS.md §5 evaluation source for the middle layer. The persistence catalog was regenerated.
- **No use-signal updates**: an injection is a machine action, not a recall use, so `use_count`/`last_accessed` are untouched (the memory_search tool remains the only use-signal writer).

## Testing

`tests/recall-inject.spec.ts` (6 cases): helper coverage (latest-user-query extraction/tail-truncation/blank-skip; render rank order, budget refusing a hit, budget truncating a body, empty hits → '') and apply-level three-branch behavior off / observe / enforce / no-hits, driving the real `apply()` through a captured `systemPrompt.section` callback with a fake session whose `append` collects the event. Harness package: 40/40; typecheck RLM zero errors.

## Alternatives considered

**Injecting in `observe` mode with a marker.** Rejected: observe means the prompt is untouched — the record lives in the event, and the model-visible diff stays zero until a deployment opts into `enforce` (the same conservative semantics as `exitMode: observe` in memory Phase D).

**An embedding/hybrid recall for relevance.** Rejected: the design constraint is "cheap per turnover" — the synchronous lexical search is O(index) per render with no network; the hybrid seam stays available to the memory tool path, and the injection quality can be measured later from the events before any upgrade.

**Injection updating the memory use-signal.** Rejected: every render would touch notes the model never read, poisoning the aging/retirement signal; the `memory_search` tool call remains the only use-signal writer.

## Consequences

The middle layer now has its relevance channel, gated three-way and defaulting to observability-only: deployments can measure what WOULD be recalled per turn from `session/memory-recall-inject` before flipping `enforce` with data. Costs: one synchronous index scan per section render when not `off` (bounded by the published store size); the injection section consumes part of the prompt under `enforce` (hard-budgeted at 2000 chars → 3 hits); and the memory dir is derived as `<dataDir>/memory` — a deployment that customizes the memory package's `memoryDir` must point the harness `dataDir` to match (recorded here; the two defaults already coincide).