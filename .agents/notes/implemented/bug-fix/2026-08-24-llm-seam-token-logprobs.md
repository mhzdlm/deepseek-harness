# Agent Note: The LLM seam can serve chosen-token logprobs

Status: implemented

English | [中文](2026-08-24-llm-seam-token-logprobs.zh.md)

## Problem

Scoring engines that need token-level distributions (the LLM-as-a-Verifier fine-grained reward) had to run beside the seam — today via a vendored Python package in a subprocess — because `ctx.llm.stream()` carried no probability data. That forced per-engine credential forwarding, single-backend judging, and zero purpose attribution for exactly the calls most worth auditing.

## Decision

`GenerateOptions` gains an opt-in switch, `logprobs: { topLogprobs }`. When set, supporting adapters request chosen-token probabilities on the wire and emit a new stream chunk:

```ts
{ type: 'logprobs', index, tokens: readonly TokenLogprob[] }
```

(`TokenLogprob = { token, logprob }`; top-variant lists stay provider-side in v1.) `BlockAssembler` accumulates the entries behind a `logprobs` accessor in stream order. Durable `ContentBlock`s intentionally stay free of scoring metadata — replay history does not need to carry probability payloads.

The DeepSeek adapter maps the switch to `logprobs: true` + `top_logprobs` on the wire and translates each delta's `logprobs.content[]` into chunk entries; routes that cannot serve them leave streams unchanged, so consumers must treat absence as "unsupported", not "empty".

## Alternatives considered

**Attach logprobs to TextBlocks.** Rejected: blocks are durable, replayed, and rendered; probability payloads would ride every stored transcript for one consumer while the streaming accessor covers the actual use case.

**Out-of-band side channel from adapters.** Rejected: splits one logical response across two transports and breaks replay ordering guarantees.

## Consequences

Any consumer on the seam can now read token distributions with adapter-managed credentials, multi-route support, and purpose attribution — the convergence trigger recorded for verify scoring is satisfied at the capability level. Costs: the chunk union grows once per probability-serving feature by design; providers without support are silently indistinguishable from opted-out-until-now runs unless consumers check route capabilities.

## Testing

- `packages/llm/llm/tests/assembler.spec.ts`: accumulation order, empty default, and the invariant that assembled text blocks carry no logprob fields.
- `packages/llm/llm-deepseek/tests/translate.spec.ts`: wire `delta.logprobs.content[]` translates into chunk entries bound to the open text block; entries without an open text block emit nothing.
- `packages/llm/llm-deepseek/tests/serialize.spec.ts`: the opt-in sets `logprobs: true` + `top_logprobs` on the wire; omission leaves both fields absent.
- Generated catalogs refreshed through `gen-cordis-catalog` / `gen-cordis-inspect-catalog`.
