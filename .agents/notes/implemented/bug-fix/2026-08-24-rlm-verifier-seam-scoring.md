# Agent Note: verify scoring migrates onto the host seam and the Python bridge retires

Status: implemented

English | [中文](2026-08-24-rlm-verifier-seam-scoring.zh.md)

## Problem

`verify` scored candidates through a vendored Python package (`llm_verifier`) in a subprocess or a live kernel. That transport forced a credential-forwarding surface (`forwardProviderCredentials`), single-backend judging per invocation, no purpose attribution, and a class of known limitations (the kernel path could never authenticate; payload transport needed base64 tricks). The convergence trigger recorded when the family contract was written — dsh-llm exposing chosen-token logprobs — has now fired.

## Decision

The verify tool's execution layer is the host seam itself:

- `src/scoring.ts` ports the judging contract verbatim: the 20-letter scale map, the pairwise prompt layout, tag location over streamed logprob entries (cumulative-text matching with fused `>` handling and last-match rule), and Eq 3.1 expected-score extraction with the literal-text fallback. The v1 seam surfaces chosen-token logprobs only (no top-k variants), so every verdict position carries a single alternative and the expectation equals the chosen letter's scale value; the multi-alternative math stays for a variant-serving seam, and the calibration probe consumes real top-20 data over raw HTTP.
- `src/tournament.ts` ports the Probabilistic Pivot Tournament (seeded ring cycle, Bradley-Terry soft wins, pivot selection/rounds). mulberry32 replaces Python's Mersenne Twister: same-seed runs are deterministic within TypeScript; cross-language ring equality is explicitly not part of the contract.
- Single-model and multi-judge (`judges[]`) runs share one code path — a full PPT per judge, Borda-fused rankings across judges. Multi-judge no longer needs per-profile credential variables; each judge picks any adapter route.
- `src/python-bridge.ts`, its spec, and `forwardProviderCredentials` are deleted. `cacheFile` is removed from Config (it cached llm_verifier results that no longer exist); scoring calls carry `logprobs: { topLogprobs: 20 }`, temperature defaults, and `maxTokens` 4096 like the reference DeepSeek path.

Calibration evidence: the live probe (`scripts/calibrate-judge.mts`) against deepseek-v4-flash and v4-pro shows both models emit the `<score_A>/<score_B>` tags themselves and the ported extraction returns exactly 1.0 / 0.0 on a known-answer fixture.

## Alternatives considered

**Keep the Python bridge and add per-judge credential forwarding.** Rejected: widens the secret-blast radius per added vendor and keeps three transports alive for one capability.

**Port only the tournament, keep llm_verifier for pairwise scoring via injected clients.** Rejected: the client still authenticates from process env inside a child, so the forwarding wart survives; and the pairwise call shape (single user prompt, logprobs flag) is the trivially portable half anyway.

## Consequences

One execution model for the whole rlm family: every model call rides the seam with adapter-managed credentials, session correlation, and event records. Costs: scoring prompts are now TypeScript string constants that must track upstream paper revisions manually (mitigated by contract tests pinning the prompt layout and extraction math against fixtures); providers without logprobs support degrade to the literal-text fallback instead of raising; and the removed `cacheFile` means repeated identical runs re-pay scoring calls unless a future cache is designed against the new engine.

## Testing

- `tests/scoring.spec.ts`: 8 items — tag location (following-position alternatives, split-tag cumulative matching, last-match precedence, null cases) and Eq 3.1 extraction (case-merged max-prob expectation, fused `>` stripping, literal fallback with letter-value mapping, invalid-letter 0.5).
- `tests/tournament.spec.ts`: 4 items — ring coverage, comparison-count formula N + k(N−k) + C(k,2), tie-break to lower index, Bradley-Terry monotonicity.
- `tests/events.spec.ts`: request event written even when every scoring call fails; result event follows under on-error ties; best-effort emission pinned.
- Full package suite 26/26 green; four-plugin preset mount unchanged; tsc clean.
