# Agent Note: MoA panel arrives as the fourth RLM plugin on the host LLM seam

Status: implemented

English | [中文](2026-08-24-rlm-moa-plugin.zh.md)

## Problem

The RLM plugin family had selection (`verify`, best-of-N over candidates) but no synthesis surface: when a hard problem warrants several independent model opinions, the model's only options were spawning full subagents (expensive, tool-capable, drift-prone) or trusting one answer. Hermes' Mixture-of-Agents solves exactly this with turn-level orchestration — parallel pure-LLM reference calls plus one aggregator — but that orchestration lives in Hermes' core loop, not in any portable form.

## Decision

`packages/rlm/plugin-rlm-moa/` registers a `moa` tool through the same Cordis shape as its siblings. The panel runs entirely on this context's LLM seam: every reference slot and the aggregator are `ctx.llm.stream()` calls (the compaction summarizer's call shape — `createUserMessage`, `BlockAssembler`, finish normalization), so credentials stay inside each adapter's own resolution and no subprocess bridge or forwarded key list exists.

- Config holds named presets (`referenceModels[]` + `aggregator`, per-preset `referenceMaxTokens`, `referenceTimeoutMs`, `degradedPolicy`). With none configured, the built-in preset fans out to two `deepseek-v4-flash` slots and aggregates on flash — pro is a manual choice, named in an explicit panel when a task wants it (the all-flash default keeps the test-API bill predictable; high-effort thinking and pro pricing made a pro default expensive per invocation). `dataDir` defaults to the shared `~/.dsh/rlm`; traces append JSONL under `<dataDir>/moa-traces/<sessionId>.jsonl`.
- Failure semantics follow Hermes' `aggregate_moa_context`: a failed or timed-out reference becomes a label in `failedLabels` (announced to the aggregator under `loud`, dropped under `quiet`); only an all-reference failure throws, skipping the aggregator call entirely.
- The aggregator never receives `referenceMaxTokens` — capping synthesis truncates long outputs; only references carry the cap.
- Each reference runs under `AbortSignal.any([exec.signal, AbortSignal.timeout(referenceTimeoutMs)])`; the tool-call abort stays authoritative.
- `privacyFilter: 'display'` annotates rendered output with per-reference provenance. Full redaction is deferred until a central redactor exists in the harness.

Deliberate deviations from Hermes, recorded as such: the guidance-injection cache argument does not apply because the synthesis lands as one tool result rather than injected dialogue; and reference slots stay pure LLM calls by default (a `subagent` slot mode remains a possible extension, not a default).

## Alternatives considered

**Fold into plugin-rlm-verifier.** Rejected: selection ranking and synthesis are different cognitive actions with different dependencies; merging would drag verifier's Python bridge concerns into an orchestration-only tool.

**Python bridge like llm_verifier.** Rejected: MoA has no algorithm-package dependency, so a subprocess would add credential forwarding and lifecycle complexity for zero capability — and reintroduce the cannot-authenticate-inside-a-live-kernel class of problems.

**Reference slots as rlm.run subagents.** Deferred: each reference becomes a full tool-calling agent — costlier and less predictable; Hermes keeps references tool-free for good reason. A future `slotMode` may expose it opt-in.

## Consequences

The RLM preset gains a synthesis primitive that composes with `verify` (moa drafts → verify selects, or verify.auto_spawn candidates → moa synthesizes) without any wiring between the two tools yet. Costs: each `moa` call is N+1 provider round trips, bounded only by the tool description's usage guidance plus `referenceMaxTokens`; presets naming non-configured provider routes fail at fan-out time per slot, which the degraded path absorbs. `purpose` attribution for these auxiliary calls awaits extending the closed `GenerateOptions.purpose` union in dsh-llm.

## Testing

- `tests/moa.spec.ts`: 13 items — fan-out completeness, labelled aggregator prompt assembly (task/context/reference blocks), loud-vs-quiet degraded notices, all-failed short-circuit without aggregation, wall-clock timeout failing one slot while siblings succeed, candidates-mode review prompts, unknown-preset rejection listing available names, reference-cap vs uncapped-aggregator token bounds, JSONL trace content, display-filter provenance rendering, and preset normalization (built-in fallback, disabled/invalid slot dropping, `model@provider` labeling).
- Verifier `rlm-preset.spec.ts` now asserts the four-plugin composition registers `ipython`, `verify`, and `moa`.
- `pnpm exec tsc --noEmit -p packages/rlm/plugin-rlm-moa/tsconfig.json` clean; package vitest run 13/13 green.
