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
