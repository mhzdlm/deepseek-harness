# @deepseek-ai/dsh-plugin-rlm-verifier

English | [中文](README.zh.md)

LLM-as-a-Verifier best-of-N selection, hosted entirely on the harness LLM seam. The scoring contract is the TypeScript port in `scoring.ts` (20-letter scale, pairwise judge prompt, expectation over the token distribution at the verdict position) and the selection loop is the Probabilistic Pivot Tournament in `tournament.ts` — O(Nk) directed comparisons instead of O(N²).

## Config

| Config | Type | Default | Description |
|---|---|---|---|
| `dataDir` | string | `~/.dsh/rlm` | Harness base dir for landing run artifacts; must match the other rlm plugins' `dataDir`. |
| `defaultModel` | string | — | Verifier model used when neither the tool argument nor the call wiring names one. |
| `provider` | string | — | Default provider route for the scoring model. |
| `privacyFilter` | `'' \| 'display' \| 'full'` | `''` | `display` annotates output with per-judge provenance; `full` masks candidate text before scoring prompts. |

## Tool: `verify`

`verify` takes a `problem`, one or more `candidates`, and optional `judges`, runs the panel, and returns the best candidate with the mean preference scores and the verification transcript.

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
- Real-runtime mounting awaits the same dependency-closure fix as the other rlm plugins (`apps/cli` does not depend on rlm packages); until then the tool reaches sessions via explicit `ctx.plugin()` mounting or vitest-toolchain compositions.
- Detail-archive writes (`artifactRoot`) are best-effort: a write failure drops the file, never the verification.
