# @deepseek-ai/dsh-plugin-continual-harness

English | [中文](README.zh.md)

Continual-learning substrate for the rlm family. It injects the harness overview (persistent instructions / memories / skills / subagents) into every assembled system prompt as the `continual-harness` section (order -100), and it owns the read surfaces. Since the Phase A authority flip the local `harness_state.json` is a PROJECTION of the session's unified-store view: producers write the store, the change listener here re-renders the file, and the prompt renderer reads it synchronously as before. The global-scope file is frozen read-only until the Phase C mailbox migration.

## Config

| Config | Type | Default | Description |
|---|---|---|---|
| `dataDir` | string | `~/.dsh/rlm` | Harness base dir; must match the other rlm plugins' `dataDir`. |
| `maxEntriesPerKind` | number | `6` | Per-kind cap when rendering the harness overview into the prompt (hints-only: routing hints, not the full harness). |
| `maxCharsPerEntry` | number | `180` | Per-entry content cap; truncate each entry to a hint, keeping id/tag/title visible. |
| `maxTotalChars` | number | `6000` | Total character ceiling for the whole harness overview section. |
| `refineProvider` | string | `spawn` | Subagent provider used by `/refine`. |
| `maxRefinementEvents` | number | `100` | Accepted for preset compatibility; the channelized `/refine` keeps no snapshot store. |
| `autoRefine` | boolean | `false` | Accepted but inert: the auto-refine scheduler died with `/refine`'s old direct-write path and nothing schedules until a channelized rewrite. |
| `autoRefineTurnInterval` | number | `12` | Accepted for preset compatibility (see `autoRefine`). |
| `autoRefineCooldownMs` | number | `600000` | Accepted for preset compatibility (see `autoRefine`). |
| `recallInject` | `off\|observe\|enforce` | `observe` | T7.13 active recall injection: `off` does nothing; `observe` runs the recall and records a log-only `session/memory-recall-inject` event without touching the prompt; `enforce` injects the top-N recall section. |
| `recallInjectTopN` | number | `3` | How many ranked hits the injected recall section may carry. |
| `recallInjectBudgetChars` | number | `2000` | Hard budget (chars) for the whole injected recall section. |

## Behavior: store projection

When `rlm.store` is mounted, `registerStoreProjection` subscribes to `store.onChange` and re-renders the per-session `harness_state.json` from the session scope's view; the overview render is cached by file (mtime, size). Absent store, the file keeps its last content — an honest stale cache, warned once at activation.

## Behavior: active recall injection (default observe)

At each harness section render, the plugin takes the most recent user message and runs a lightweight lexical recall (`search` from `@deepseek-ai/dsh-plugin-rlm-memory`) over `<dataDir>/memory`'s `published/` store. Under the default `observe` mode the hits are only recorded in the `session/memory-recall-inject` event (mode, query, hit relPaths, would-be injected chars) — the prompt is untouched. Under `enforce`, the top-N hits are injected as a recall section with a hard character budget. A failing recall degrades to the base prompt (recall is advisory). The recall is the relevance channel; the harness overview stays the time-index channel.

## Commands

- `/refine` — channelized (Phase B): a review whose findings land through the judgment channel, never by writing the projection file. Pipeline: recent transcript (24-turn window) → extraction subagent → JSON proposals (≤6, ≤1200 chars each) → the deterministic whitelist criterion `crit/refine-whitelist` (every proposal's evidence must locate verbatim in the transcript it cites) → one `conclusion` judgment per admitted proposal (procedural belief, subject `harness:memory:<slug>`; an existing belief on the same subject is superseded). Requires `rlm.store`; no reverse snapshots — retracted content is voided in the store and disappears from the next render.
- `/harness list [kind]` / `/harness show <id>` — inspect harness entries for the current session. `/harness delete <id>` is frozen: the file is a store projection, so it returns an error directing callers to the judgment channel.

## Model Experience

### Harness overview

#### What the model sees

A bounded overview section (per-kind caps, per-entry truncation) rendered from the merged global + session projection, plus — under `recallInject: enforce` — a budgeted recall section. `/refine`'s proposal subagent receives the transcript excerpt; the plugin adds no model-facing guidance beyond the overview itself.

#### Token effect

The overview is capped by `maxEntriesPerKind`/`maxCharsPerEntry`/`maxTotalChars`; the recall section by `recallInjectTopN`/`recallInjectBudgetChars`. One `/refine` call costs one extraction subagent plus one judgment per admitted proposal.

#### KV Cache effect

The overview section renders at identity order (-100) before the base prompt's later sections; landed beliefs re-enter context through it, so later turns read trusted state from the prompt instead of re-deriving it from history.

## Known Limitations and Deferred Work

- `/refine` proposals are validated after extraction; a parse failure drops the proposal rather than applying a partial update.
- `autoRefine*` config keys are accepted but inert until a channelized auto-refine scheduler is rebuilt.

## Status

Phase D (2026-09-01): the family's prompt-injection and read surface — the store is the write authority, this plugin renders the projection into the system prompt and exposes `/refine` (channelized) and `/harness` (read-only). Family overview: [packages/rlm/README.md](../README.md); family-level status: see BUILD.md in the docs repo.
