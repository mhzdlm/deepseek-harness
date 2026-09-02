# @deepseek-ai/dsh-plugin-rlm-loop

English | [中文](README.zh.md)

Loop Engineering bookkeeping for the rlm family. Registers the `loop` tool, which makes the Manage→Execute→Audit round protocol enforceable in code rather than model compliance:

- **Deterministic audit parsing** — the auditor's ordered three-line verdict (`Status` / `Integrity` / `Contract audit`) is parsed by code or fails loudly; prose bodies are never guessed into facts.
- **Trust gate** — only a `complete/clean/aligned` verdict counts as verified progress; the judge call lands a `check-pass` (clean) or `check-doubt` verdict under `crit/loop-three-line-header` in the session's store stream.
- **Store writes** — `begin` and each `record` append `rlm/action-boundary` events to the session scope; verified progress lands through the judgment channel, and the continual-harness projection picks it up from the store view.

The joining session stays the Manager; executor/auditor episodes ride the composition-provided delegation tools (see `docs/recipes/agent-presets/loop/`). The `rlm.store` service is required: `apply` throws when it is absent — mount `@deepseek-ai/dsh-plugin-rlm-store` first.

## Config

| Config | Type | Default | Description |
|---|---|---|---|
| `dataDir` | string | — | Deprecated since Phase A: the tool writes the unified store, not harness files. Kept for preset compatibility; ignored. |
| `maxRounds` | number | `32` | Soft per-run round ceiling; exceeding warns but never blocks. |

## Tool: `loop`

| Action | Arguments | Effect |
|---|---|---|
| `begin` | `task` (required), `contract?` | Opens a run; appends an `rlm/action-boundary` event to the session scope. |
| `record` | `round`, `route` (`gui\|cli\|done\|blocked\|ask`), `audit_report`, `progress_note?` | Parses the header, applies the trust gate, appends the round's action-boundary event, and lands a `check-pass`/`check-doubt` judgment; an accepted verdict with a `progress_note` lands verified progress. |
| `status` | — | Summarizes recorded vs verified rounds for this session. |

The structured output carries `runId`/`round`/`accepted`/`status`/`integrity`/`contractAudit`/`landed`; `text` carries model-facing guidance including rejection reasons (unparseable header, `done` route without a clean audit, missing note on a clean verdict). Run state lives in a per-session in-memory map, evicted on `session/disposed`; durable truth is the store stream.

Legacy `session/loop-start` / `session/loop-round-done` event types remain declared (`src/events.ts`) only so older session logs stay loadable; the tool no longer emits them.

## Model Experience

### Loop progress

#### What the model sees

The model sees the contract once (via `loop begin`) and a `loop record`'s result text each round; the tool replaces ad-hoc verdict reasoning with a parsed, trustworthy progress signal rather than emitting new model guidance.

#### Token effect

One `loop begin` per task adds the contract once; each round adds one `loop record` whose small result text replaces verdict prose, so cost grows only with recorded rounds.

#### KV Cache effect

Landed beliefs re-enter context through the harness overview injection (the store projection), so later rounds read trusted state from the prompt instead of re-deriving it from history; the tool never edits earlier request tokens.

## Known Limitations and Deferred Work

- The run registry (`runId`, recorded rounds) is in-memory per process; durable truth lives in the store stream, so a supervisor restart loses only the `status` convenience view.
- `maxRounds` is advisory — it warns past the ceiling but never blocks a round.

## Status

Phase D (2026-09-01): the loop protocol's write path into the unified store — action boundaries plus the deterministic-header check judgments; the harness projection renders what lands. Family overview: [packages/rlm/README.md](../README.md); family-level status: see BUILD.md in the docs repo.
