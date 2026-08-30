# Agent Note: RLM split-turn compaction provider (P1-B)

Status: implemented

## Problem

`selectCompactableRange` aligns cuts to tool-pairing, so a cut never breaks a step — but a long single-turn analysis batch can still be cut mid-assistant-turn. Without a prefix summary, the condensed region's opening user request and early progress are lost to the suffix that must continue the turn. Prime-agent solves this with `TURN_PREFIX_SUMMARIZATION_PROMPT`; the RLM compaction path shipped without it, and the user requires the shared `compaction-basic` package to stay untouched ("不要和官方混在一起").

## Decision

Prime's split-turn prefix-summary behavior ships as a **dedicated RLM provider**, not a change to `@deepseek-ai/dsh-compaction-basic`:

- New package `packages/rlm/plugin-rlm-compaction` (`@deepseek-ai/dsh-plugin-rlm-compaction`): `RlmSplitTurnCompactionEngine extends BasicCompactionEngine`, overriding **only** the documented sole hook `summarize()`. The trigger policy, retention, the durable `compaction/start`–`compaction/end` transaction, and the `toolPairingBalancedBefore/After` cut alignment are inherited unchanged.
- `src/split-turn-summarizer.ts`: `buildRlmInstruction` appends a `## Turn Prefix` section when the replayed region begins mid-assistant-turn (first message role is `assistant`), and always carries the `## Files Touched` section with the cross-round `PREVIOUS FILES TOUCHED` hint (P1-A parity, kept local so the RLM provider does not regress). `parseRlmSummary` decodes both sections from the model output. `summarizeRlm` reuses the official replay-aware prefix-cache protocol (`ctx.llm.stream`, `purpose: 'compaction'`, provider/model resolved via `conversationTarget` → `agent.options`) and never imports a private symbol from `compaction-basic`.
- `docs/recipes/agent-presets/rlm/agent.cordis.yml`: the `compaction` isolate group mounts `@deepseek-ai/dsh-plugin-rlm-compaction` instead of `@deepseek-ai/dsh-compaction-basic`; `command-compact` and `tool-result-pruner` stay in the same realm and consume `ctx.compaction` (now the RLM subclass) unchanged.
- `package.json` / `tsconfig.json` / `src/invariant.ts` / `README.md` follow the dsh package conventions; `pnpm install` registers the workspace symlink.

## Testing

`tests/rlm-compaction.spec.ts` (7 checks): the instruction contains `## Turn Prefix` only when mid-turn, always contains `## Files Touched` and the `PREVIOUS FILES TOUCHED` hint, `parseRlmSummary` decodes both sections, and the prompt passed to `ctx.llm.stream` is inspected for the mid-turn branch.

## Alternatives considered

**Adding the prefix behavior to the shared `compaction-basic` package.** Rejected on the user's standing instruction; subclassing the single `summarize` hook delivers the behavior without touching shared core, and keeps `command-compact` / `tool-result-pruner` working unchanged.

**Extending `SummarizationInput` in `compaction-basic` for a precise "cut inside a turn" signal.** Deferred and rejected for the same isolation reason: the shipped mid-turn detection is heuristic (first replayed message role === `assistant`), and a precise signal would require modifying the shared package, which this provider avoids.

## Consequences

The shared `compaction-basic` stays untouched and the RLM subclass is the only consumer of the override hook, so isolation is guaranteed structurally (the provider imports no private symbol). Cost: mid-turn detection is heuristic, and the recipe must mount the RLM provider explicitly. Recorded in `docs/research/prime-agent-rlm-gap-analysis.md` (P1 section).