# @deepseek-ai/dsh-plugin-continual-harness

English | [中文](README.zh.md)

Continual-learning substrate for the rlm family. It owns the CAS-backed harness-state store, the `/refine` self-refinement flow, and the landing pipeline that turns verified loop progress into durable `memory` entries.

## Config

| Config | Type | Default | Description |
|---|---|---|---|
| `dataDir` | string | `~/.dsh/rlm` | Harness base dir for the CAS state store and landed entries; must match the other rlm plugins' `dataDir`. |
| `autoRefine` | boolean | `false` | Opt-in scheduler that triggers `/refine` on a root-agent turn-interval gate. |
| `autoRefineTurnInterval` | number | `12` | Root-agent idle turns between automatic review attempts. |
| `autoRefineCooldownMs` | number | `600000` | Minimum gap between automatic reviews (stamped on both success and rejection). |
| `maxEntriesPerKind` | number | `6` | Per-kind cap when rendering the harness overview into the prompt. Mirrors prime-agent's hints-only injected overview: surface routing hints, not the full harness; the model reads underlying entries on demand. |
| `maxCharsPerEntry` | number | `180` | Per-entry content cap when rendering the harness overview. Truncate each entry to a hint, keeping the id/tag/title visible for reference. |
| `maxTotalChars` | number | `6000` | Total character ceiling for the whole harness overview section — a bounded routing index across the four kinds. |
| `refineProvider` | string | `spawn` | Subagent provider name used by `/refine` and the auto-refine review. |
| `maxRefinementEvents` | number | `100` | RefinementEvents (and their snapshot files) retained per session; oldest pruned beyond the cap. |
| `recallInject` | `off\|observe\|enforce` | `observe` | T7.13 active recall injection (LAYERS.md §3): `off` does nothing; `observe` (default) runs the recall and records a `session/memory-recall-inject` event without touching the prompt; `enforce` actually injects the top-N recall section. |
| `recallInjectTopN` | number | `3` | How many ranked hits the injected recall section may carry. |
| `recallInjectBudgetChars` | number | `2000` | Hard budget (chars) for the whole injected recall section; overflow truncates with a marker. |

## Behavior: active recall injection (default observe)

At each harness section render, the plugin takes the most recent user message and runs a lightweight lexical recall over `<dataDir>/memory`'s `published/` store (the memory package search). Under the default `observe` mode the hits are only recorded in a log-only `session/memory-recall-inject` event (mode, query, hit relPaths, would-be injected chars) — the prompt is untouched, so default behavior is unchanged. Under `enforce`, the top-N hits are injected as a `## Relevant Memories` section with a hard character budget. The recall is the relevance channel; the harness overview stays the time-index channel.

## Tool: `/refine`

`/refine` reviews the recent transcript, has a subagent propose small evidence-backed harness updates, reverse-snapshots the entries that will change, applies them, and records a `RefinementEvent`; rollback restores a snapshot by event id. The proposal and review subagents run with `reasoningEffort: 'none'` so the JSON budget is not spent on a chain-of-thought.

## Behavior: automatic refinement (opt-in)

When `autoRefine` is enabled, `registerAutoRefine` listens on `agent/status` and counts root-agent turn completions (`currentInitiator()` undefined). At the turn-interval and once the cooldown gate passes, it runs a scoped review subagent (`reviewAutoRefine`); only when `shouldRefine` is true does it reuse the `runRefine` pipeline. Child agents are excluded, and the cooldown is persisted so a failed review cannot immediately re-trigger. Defaults keep existing deployments manual-only until they opt in.

## Model Experience

### Refinement flow

#### What the model sees

The proposal subagent receives the current harness overview with authoritative entry ids, so update/delete proposals can name real ids; the tool adds no model-facing guidance beyond that overview.

#### Token effect

One `/refine` call adds the review prompt plus the proposal prompt to the turn and records a single `RefinementEvent`; cost is one review plus one proposal per invocation.

#### KV Cache effect

Landed entries re-enter context through the harness overview injection, so later turns read trusted state from the prompt instead of re-deriving it from history; the plugin never edits earlier request tokens.

## Known Limitations and Deferred Work

- `/refine` proposals are validated after extraction; a parse failure drops the proposal rather than applying a partial update.
- Real-runtime mounting awaits the same dependency-closure fix as the other rlm plugins (`apps/cli` does not depend on rlm packages); until then the tool reaches sessions via explicit `ctx.plugin()` mounting or vitest-toolchain compositions.
