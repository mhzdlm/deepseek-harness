# @deepseek-ai/dsh-plugin-rlm-verifier

English | [中文](README.zh.md)

LLM-as-a-Verifier best-of-N selection, hosted entirely on the harness LLM seam. The scoring contract is the TypeScript port in `src/scoring.ts` (20-letter scale, pairwise judge prompt, expectation over the token distribution at the verdict position) and the selection loop is the Probabilistic Pivot Tournament in `src/tournament.ts` — O(Nk) directed comparisons instead of O(N²). With `rlm.store` mounted, tournament outcomes land through the judgment channel under `crit/verify-eq31-tournament` (structured tier); absent store degrades to no landing.

## Config

| Config | Type | Default | Description |
|---|---|---|---|
| `provider` | string | `deepseek-official` | Default provider route for scoring calls. |
| `model` | string | `deepseek-v4-flash` | Verifier model used when the tool argument does not name one. |
| `subagentProvider` | string | `spawn` | Subagent provider used by `auto_spawn` candidate generation. |
| `maxChildChars` | number | `20000` | Character cap per spawned candidate's collected output. |
| `privacyFilter` | `'' \| 'display' \| 'full'` | `''` | `display` annotates output with per-judge provenance; `full` masks credential/PII material (via `@deepseek-ai/dsh-plugin-rlm-redact`) in candidate digests and the durable detail archive. |
| `judgeProfiles` | record | — | Named judge profiles (`name → { model, provider? }`); the tool's `judges[]` argument selects among them for multi-judge fusion. |
| `dataDir` | string | `~/.dsh/rlm` | Root for run artifacts; every verify run writes a full-detail JSON under `<dataDir>/session-artifacts/<sid>/verify/` and the result carries the path. |
| `maxCandidates` | number | `24` | Hard cap on the candidate pool per call; larger lists fail loud. |
| `maxEvaluations` | number | `8` | Cap on `n_evaluations` (scoring passes per pair). |
| `maxAutoSpawn` | number | `8` | Cap on the `auto_spawn` child count. |
| `verifyTimeoutMs` | number | `600000` | Whole-verify wall-clock budget; a hanging judge endpoint must not pin the turn. |
| `maxPivots` | number | `8` | Absolute cap on the `pivots` argument (T9.2). |
| `maxInFlightPairCalls` | number | `4` | Bounded pool for concurrent pair-scoring calls. |
| `maxTokens` | number | `4096` | Per-scoring-call output token ceiling. |

## Tool: `verify`

Parameters: `problem` (required), `candidates` (required array; at least 2 recommended), `criteria` (optional JSON name→description map, defaulting to specification/output/errors), `n_evaluations` (K per criterion, default 4), `pivots` (PPT pivots k, default 2, clamped to N), `seed` (ring-pass seed, default 0), `model`, `judges` (named profiles, one independent verification each, rankings fused), `auto_spawn` (>0 with empty `candidates` spawns that many subagents to solve the task, best-of-N), `gate_score`. Spawned children are tracked per session and aborted on `session/disposed`.

## Behavior: autonomous quality gate (T3.3)

An optional `gate_score` (0-1 threshold) makes the result report a `gate` of `passed`/`failed` from the best candidate's score, with the model-visible note that a passing gate does not mean the task succeeded — it is a lower-bound filter for autonomous loops, never a verdict. Omitting `gate_score` leaves the gate `unset` (no behavior change).

## Model Experience

### Verification result

#### What the model sees

The candidate text reaches the judge model verbatim inside the pairwise judge prompt built by `buildJudgePrompt`; the tool never adds model-facing guidance of its own beyond that prompt.

#### Token effect

One `verify` call adds the panel's scoring prompts plus the structured result text (`N judge(s)`, chosen scores) to the turn; cost scales with candidate and judge counts, not with the problem size.

#### KV Cache effect

Stateless in the request path: each scoring prompt is a fresh call, so the verifier never edits earlier request tokens.

## Known Limitations and Deferred Work

- The v1 LLM seam surfaces only chosen-token logprobs, so every verdict position carries a single alternative and the Eq 3.1 expectation reduces to the chosen letter's scale value; the multi-alternative machinery stays intact for a seam that exposes variants.
- Detail-archive writes (`artifactRoot`) are best-effort: a write failure drops the file, never the verification.

## Status

Phase D (2026-09-01): the family's scored selection gate — tournament results land in the store as structured-tier judgments, so verified selections are auditable stream entries, not tool-side notes. Family overview: [packages/rlm/README.md](../README.md); family-level status: see BUILD.md in the docs repo.
