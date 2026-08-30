# Agent Note: RLM `llm.query` subcall bridge (LAYERS.md §2, NEXT Phase 7 T7.10)

Status: implemented

[English](2026-08-30-rlm-llm-query-bridge.md) | 中文

## Problem

The paper's core quantitative technique — the root model slicing overlong input and synchronously fanning out cheap inner-loop subcalls with programmatic aggregation (arXiv:2512.24601v3) — was inexpressible in dsh: `rlm()` spawns full child sessions (`maxChildrenPerSession=8`, fire-and-forget), and the host bridge had no handler that "just asks the LLM". Every result in the paper's main tables used a weaker-tier model for subcalls (GPT-5 root + GPT-5-mini subcalls), proving that default subcall downgrading is a lossless free cost rule.

## Decision

The `llm.query` bridge (LAYERS.md §2) ships end to end:

- **Kernel side**: the injected bootstrap binds `llm_query(prompt | prompts, **kwargs)` (`_PrimeAgentLlmQuery.query`, a bound method of a small wrapper over `_prime_agent_host_request`). An array payload is a batch — the paper's `llm_batch` analog. Both runtime paths (healthy import, missing-runtime install-guidance stub) bind it; exec-based regression probes assert routing on both.
- **Host side**: the 8th bridge handler (`'llm.query'`) executes each subcall through the host LLM seam (`ctx.llm.stream` + `BlockAssembler`, the verify/ compaction path), with `purpose: 'rlm-subcall'` attribution — the token-meter purpose union gained the member in the shared llm package.
- **Routing (R2)**: `subcallModel` is a kernel Config selector (preset-managed); resolution order is request model → route selector → owning agent's model. Omitted selector means no downgrade (default unchanged).
- **Quotas (R1)**: per-session in-flight streams capped at `maxInFlightSubcalls` (default 8) and batch length at `maxSubcallBatch` (default 32); overruns fail loud naming the key, `maxChildrenPerSession`-style. `abortSession` clears the counter.
- **Quality gate (§2.4)**: a degenerate answer (empty, trivially short, or the same token repeated 3+ times — prime Appendix F.1's "sub-LM gives up" pattern) is retried once; if still degenerate the answer is returned with `degenerate: true` and the retried text, leaving the exact chunking strategy to the kernel caller.
- **Bounds**: each answer is truncated at `maxSubcallAnswerChars` (default 8000) and flagged; each generation carries its own wall-clock budget `subcallTimeoutMs` (default 120 000, T7.3 same-layer timeout semantics).
- **Event**: every batch appends a log-only `session/subcall-query` event (batch size, resolved model, per-answer char counts, truncation flags, retries, duration) — the LAYERS.md §5 evaluation data source. The persistence catalog was regenerated.

The **total-cost ledger** (per-session purpose-accounted usage/coST aggregation) remains the more accurate quota direction recorded in LAYERS.md §2.2 for a future replacement once real `session/subcall-query` distributions exist.

## Testing

`host-handlers.spec.ts` gains 10 bridge cases: single prompt, batch, empty payload refusal, batch-cap refusal, in-flight quota refusal + release, degenerate→retry→recover, degenerate-stays-flagged, truncation, model resolution order (request → selector → agent), and loud failure without an llm service. `rlm-bootstrap.spec.ts` asserts the injection and extends the exec-based regression probes to route both call shapes on the healthy and missing-runtime paths. `snapshot-rotation.spec.ts`'s event-set assertion now expects both kernel event types. Kernel suite: 147/147; typecheck RLM/llm zero errors.

## Alternatives considered

**A purpose-accounted total-cost ledger as the quota.** Deferred and recorded (LAYERS.md §2.2): the ledger is the most accurate direction (the paper's cost story is median-cheap / long-tail-expensive, and the thing to bound is struggling trajectories), but its implementation cost is currently higher than the in-flight concurrency cap, which already prevents unbounded parallel fan-out. The event stream will supply the real distribution for a later swap.

**ML routing.** Rejected (LAYERS.md §2.3 R2): the route table is a validated kernel Config field managed through the preset surface; rule routing only.

**Host-side guesswork about chunking.** Rejected (LAYERS.md §2.4): the host detects the degeneracy signal (empty/short/repeating) and flags it; the exact strategy (chunk size, continuation) is the kernel caller's, matching the paper's root-model-decides behavior.

## Consequences

The inner-layer primitive is now expressible: a kernel can fan out cheap subcalls in a loop and aggregate programmatically, with per-session concurrency and batch bounds, per-answer truncation, wall-clock budgets, and a degenerate answer — everything is audited in `session/subcall-query`. Costs: one extra generation on degeneracy (a retry), sums already bounded by the concurrency quota; a deployment that wants the paper's cheap-tier rule must set `subcallModel`; and total-cost accounting remains future work recorded in LAYERS.md.