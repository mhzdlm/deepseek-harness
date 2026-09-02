# @deepseek-ai/dsh-plugin-rlm-memory

English | [中文](README.zh.md)

RLM cross-session memory layer. ReMe's form, the Continual Harness paper's evidence discipline, dsh's host-owned sovereignty. Capture is the salvage (拾遗) path: completed root sessions are buffered from the `session/event` bus, sanitized (tool results stripped), persisted to `dialog/<id>.jsonl`, and a host-owned extraction subagent proposes draft notes gated by an evidence locator. Recall is the `memory_search` tool over `published/` plus a hints-only `agent/session-start` guidance injection. Since Phase C the store's mailbox scope is the cross-session authority when `rlm.store` is mounted: `published/` Markdown files are its projection, consolidation promotes drafts as provisional mailbox beliefs, human file edits are detected and written back as `rlm/human-revision` events, and arriving sessions pick up mailbox nominations as PROVISIONAL beliefs. Phase D adds retire/archive (`exitMode`) and the audit freeze lock on publish. Phase E adds the opt-in external embeddings seam (default `off`).

## Config

All fields validated by the `Config` schema; defaults resolved explicitly in `apply`.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `memoryDir` | string | `~/.dsh/rlm/memory` | Memory root; subdirs `published/ drafts/ archived/ dialog/ snapshots/ index/ logs/`. |
| `captureMode` | `off \| sessionEnd \| intervalTurns` | `sessionEnd` | When to capture. `intervalTurns` flushes every `captureIntervalTurns` turns. |
| `captureIntervalTurns` | natural | `16` | Turn interval for `intervalTurns` mode. |
| `captureTimeoutMs` | natural | `120000` | Wall-clock budget for the extraction child; expiry lands the dialog without drafts. |
| `rootAgentsOnly` | boolean | `true` | Only root (non-subagent) sessions enter capture (REME.md §5.1 D5). |
| `privacyFilter` | `'' \| display \| full` | `''` | `full` masks credential/PII-shaped material before the dialog jsonl lands; `display` is accepted but has no display surface. |
| `recallTopK` | natural | `5` | Default top-K returned by `memory_search`. |
| `recallMode` | `keyword \| auto` | `keyword` | `auto` without an embeddings provider logs a one-time downgrade to keyword. |
| `language` | string | `en` | Session-start hint language: `en` or `zh`. |
| `gateMode` | `off \| observe \| enforce` | `observe` | Publish gate (REME.md §5.3 D10): `off` no promotion; `observe` promotes eligible drafts (flagged); `enforce` promotes only drafts whose `source` locates in their dialog. |
| `maxPublishedNotes` | natural | `200` | Growth budget: max `published/` notes before promotion is skipped/rejected. |
| `maxPublishedBytes` | natural | `5_000_000` | Growth budget: max total bytes across `published/`. |
| `exitMode` | `off \| observe \| enforce` | `off` | Retirement exit mode (REME.md §5.4 D12): `off` no-op; `observe` logs intent only; `enforce` moves `published/` → `archived/` (reversible). |
| `agingMinAgeDays` | natural | `180` | Aging scan: minimum age before a note can be a retire candidate. |
| `agingMinUseCount` | natural | `1` | A note used at least this often is never retired. |
| `embeddingsProvider` | `off \| external` | `off` | `external` enables the OpenAI-compatible provider; `memory_search` runs `hybridSearch` and consolidation caches vectors under `index/embeddings/`. Missing base URL/model/key fails loud at load. |
| `embeddingsBaseURL` / `embeddingsModel` | string | — (required if `external`) | OpenAI-compatible base URL (no `/embeddings` suffix) and model id. |
| `embeddingsApiKey` / `embeddingsApiKeyEnv` | string | — | Provider key, or env var to read it from. |
| `embeddingsDim` | natural | inferred | Fixed vector dimension; inferred from the first response when omitted. |
| `embeddingsBatchSize` | natural | `32` | Max texts per embeddings request. |
| `embeddingsTimeoutMs` | natural | `30000` | Per-request wall-clock budget; expiry degrades recall to lexical. |

## Tool: `memory_search`

`memory_search(query, limit?, kind?)` returns the top-K `published/` notes as full text. The keyword index is rebuilt in memory from `published/` on every call (never persisted, so it cannot drift); on each hit the tool increments `use_count` and sets `last_accessed` without bumping `version` (the Phase D aging signal, REME.md §8 D4). Drafts and archive are excluded from the index. With `embeddingsProvider: 'external'` the tool runs `hybridSearch` (lexical + cached cosine).

## Command: `/memory`

`/memory list | show <name> | delete <name>` — draft notes (delete is drafts-only). `/memory consolidate` — publish gate + growth budget over every draft; with `rlm.store` mounted, promotions land in the mailbox as provisional beliefs and `published/` re-renders from the projection (without the store, legacy direct-file promotion). `/memory rollback <noteId> [force]` — restore the latest snapshot over a published note (override-warning unless `force`). `/memory retire <noteId> [force]` / `/memory archived` / `/memory unretire <noteId>` — Phase D retirement under `exitMode`. `/memory stats` — the observe-grade report from `observeReport`/`renderObserveReport` (needs `rlm.store`). `/memory criteria list | propose <id> <tier> <title> | approve <id> <tier> <title>` — the criterion-revision track: propose parks the revision in the mailbox; approve is the human-only act that registers it (needs `rlm.store`).

## Mailbox surface (Phase C/D, `src/mailbox.ts`)

With `rlm.store` mounted: `publishToMailbox` records the publication in the mailbox stream FIRST, then the session-side handover record; subjects whose latest live mailbox belief is `frozen` skip publication (`frozenSkips`) — re-publishing would route around the audit freeze. `syncMailboxProjection` renders `published/` as a pure function of the mailbox view; `watchMailboxProjection` watches the directory for the process lifetime and `detectHumanRevisions` turns direct file edits into `rlm/human-revision` events (the human semantic-exempt write still goes through the stream). `importLegacyNotes` absorbs pre-Phase-C notes as human-revision events. `pickupMailboxSeeds` joins mailbox nominations into an arriving session as PROVISIONAL beliefs, marking same-subject conflict sets, and a hints-only notice is injected at `agent/session-start`. Without the store every mailbox surface degrades to legacy direct-file behavior with a one-time warning.

## Events

`session/memory-captured` (log-only): appended to the captured session's durable log on each capture, carrying `sessionId`, `dialogTurns`, `draftsAdmitted`, `extractionRan`, `draftChars`.

## Known Limitations and Deferred Work

- **In-memory capture buffer** — per-session turns accumulate in a `Map`; a host restart mid-session loses the buffered turns. The durable artifact is the `dialog/<id>.jsonl`.
- **Index rebuilt per call** — the keyword index is derived from `published/` on every `memory_search`; an incremental index is an optimization, not a correctness requirement.
- **Aging scan is lexical/use-count only** — `scanAging` combines `use_count` with recency; deterministic, no model call.
- **`privacyFilter: 'display'` inert** — accepted by the schema, but no display surface consumes provenance labels; only `'full'` masks.
- **Embeddings opt-in (default `off`)** — DeepSeek exposes no embeddings API, so the external provider points at an OpenAI-compatible endpoint; a future dsh-native seam replaces it without touching call sites (REME.md §12.1).

## Status

Phase D (2026-09-01): the family's memory authority face — capture is the salvage path, the mailbox (via `rlm.store`) is the cross-session authority, `published/` is its projection, and the freeze lock keeps audited beliefs unpublishable until human release. Family overview: [packages/rlm/README.md](../README.md); family-level status: see BUILD.md in the docs repo.
