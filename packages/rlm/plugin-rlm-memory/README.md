# @deepseek-ai/dsh-plugin-rlm-memory

English | [中文](README.zh.md)

RLM cross-session memory layer — Phase A (write path) + Phase B (recall) + Phase C (evolution) + Phase D (retire/archive) + Phase E (embeddings seam). ReMe's file-authoritative form, the Continual Harness paper's evidence/audit discipline, dsh's host-owned sovereignty. Phase A captures completed root sessions, sanitizes the transcript (tool results stripped), writes `dialog/<id>.jsonl`, spawns a host-owned extraction subagent whose draft notes pass an evidence-locator gate before landing in `drafts/`, and appends a log-only `session/memory-captured` session event. Phase B adds the `memory_search` tool over `published/` (an in-memory keyword/BM25-ish index rebuilt from files each call, so it can never drift), updates each hit's `use_count`/ `last_accessed` aging signal, and injects a hints-only `agent/session-start` guidance message. Phase C (REME.md §5.3) adds the publish gate (`gateMode` off|observe|enforce), a deterministic consolidation that promotes drafts to `published/` under a growth budget, a single-flight lock preventing concurrent clobbers, and reverse-snapshot rollback (`/memory rollback`) with a harness-style override-warning. Phase D (REME.md §5.4) adds an aging scan that scores `published/` notes by `use_count` + recency and a reversible `archive/` move (`/memory retire` / `/memory unretire`, gated by `exitMode` off|observe|enforce) — the knowledge base never grows stale, and retirement is never a deletion. Phase E (REME.md §12.1) adds an opt-in embeddings seam: an `EmbeddingService` interface with an OpenAI-compatible `ExternalEmbeddingProvider` (default `off`); when `embeddingsProvider: 'external'`, `memory_search` blends cached cosine similarity with the keyword index (`hybridSearch`) and consolidation caches each promoted note's vector under `index/embeddings/`. Exposes `/memory list | show | delete | consolidate | rollback <noteId> [force] | retire <noteId> [force] | archived | unretire <noteId>`.

## Config

All fields are validated `Config` (schemastery); no hardcoded tunables. Defaults are resolved explicitly in `apply`, never hidden behind `??`.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `memoryDir` | string | `~/.dsh/rlm/memory` | Memory root; subdirs `published/ drafts/ archive/ dialog/ index/ logs/` are created on first capture. |
| `captureMode` | `off \| sessionEnd \| intervalTurns` | `sessionEnd` | When to capture. `off` disables the write path; `sessionEnd` flushes on `session/disposed`; `intervalTurns` is a reserved hook for periodic capture (Phase A lands only `sessionEnd`). |
| `captureIntervalTurns` | natural | `16` | Turn interval for `intervalTurns` mode (reserved; not yet wired to a periodic timer). |
| `captureTimeoutMs` | natural | `120000` | Wall-clock budget for the capture extraction child; a non-positive value falls back to this default. |
| `rootAgentsOnly` | boolean | `true` | Only root (non-subagent) sessions enter capture (REME.md §5.1 D5). |
| `privacyFilter` | `'' \| display \| full` | `''` | `full` masks credential/PII-shaped material before the dialog jsonl lands; `display` is accepted but has no display surface in Phase A. |
| `recallTopK` | natural | `5` | Default top-K returned by `memory_search` (REME.md §9/§10 Phase B acceptance). |
| `recallMode` | `keyword \| auto` | `keyword` | Recall mode. Accepted for Phase E (REME.md §12.1) but not a selector today: the path is driven by `embeddingsProvider` — `hybridSearch` when `external`, keyword otherwise. `auto` with no provider logs a one-time downgrade to keyword. |
| `language` | string | `en` | Language for the session-start hint: `en` or `zh`. |
| `gateMode` | `off \| observe \| enforce` | `observe` | Phase C publish gate (REME.md §5.3 D10): `off` no promotion (logged no-op); `observe` promotes every eligible draft, flagging gate `'observe'` (non-blocking even without a valid `source`); `enforce` promotes only drafts whose `source` locates in their `dialog` via `admitByEvidence` (REME.md §5.1 D6), rejecting the rest (they stay drafts with `rejected_at`/`rejection`). |
| `maxPublishedNotes` | natural | `200` | Phase C growth budget: max `published/` notes before a NEW promotion is skipped (`observe`) or rejected (`enforce`) (REME.md §5.3 D2). |
| `maxPublishedBytes` | natural | `5_000_000` | Phase C growth budget: max total bytes across `published/` before a NEW promotion is skipped/rejected (REME.md §5.3 D2). |
| `exitMode` | `off \| observe \| enforce` | `off` | Phase D retirement exit mode (REME.md §5.4 D12): `off` no-op (notes never retire); `observe` logs retire intent but does NOT move the note; `enforce` moves `published/` → `archived/` (reversible via `unretire`). Default `off` is deliberately conservative — nothing retires unless the deployer explicitly enables it. |
| `agingMinAgeDays` | natural | `180` | Phase D aging scan: a `published/` note must be older than this many days (by `last_accessed`/`updated_at`) to be a retire candidate (REME.md §5.4/§9 — deliberately high so normal use never triggers retirement). |
| `agingMinUseCount` | natural | `1` | Phase D aging scan: a note with `use_count` below this is a retire candidate (REME.md §5.4/§9 — a note used even once is never retired). |
| `embeddingsProvider` | `off \| external` | `off` | Phase E embeddings seam (REME.md §12.1): `off` keeps keyword/BM25 recall only (default; no network, no cache). `external` enables the OpenAI-compatible `ExternalEmbeddingProvider`: `memory_search` runs `hybridSearch` (lexical + cached cosine), and consolidation caches each promoted note's vector under `index/embeddings/`. Requires `embeddingsBaseURL`, `embeddingsModel`, and `embeddingsApiKey`/`embeddingsApiKeyEnv`; missing any fails loud at load. |
| `embeddingsBaseURL` | string | — (required if `external`) | OpenAI-compatible base URL (e.g. `https://api.openai.com/v1`); the `embeddings` path is appended, so do NOT include `/embeddings` here. |
| `embeddingsApiKey` | string | — | Provider API key. Prefer `embeddingsApiKeyEnv` to keep secrets out of cordis.yml; exactly one of the two is required for `external`. |
| `embeddingsApiKeyEnv` | string | — | Name of an env var holding the provider key (e.g. `EMBEDDINGS_API_KEY`); read once at load. |
| `embeddingsModel` | string | — (required if `external`) | Embedding model id passed as the OpenAI `model` field. |
| `embeddingsDim` | natural | inferred | Expected vector dimension; if omitted the first provider response's length is used. Supply it to skip the warm-up inference when caching the first note. |
| `embeddingsBatchSize` | natural | `32` | Texts per provider request; `hybridSearch`/`consolidate` chunk inputs to this size. |

## Events

`session/memory-captured` (log-only, `MEMORY_EVENT_TYPES = ['session/memory-captured']`): appended to the captured session's durable log on each capture, carrying `sessionId`, `dialogTurns`, `draftsAdmitted`, `extractionRan`, `draftChars`. Registered in `SessionEventMap`; the persistence catalog must be regenerated after any change (`pnpm run gen-persistence-catalog`).

## Commands

`/memory list` — every draft note (kind/scope + evidence `source`). `/memory show <name>` — full frontmatter + body for one draft. `/memory delete <name>` — remove one draft note. Published notes are not deletable; they are demoted only via reverse-snapshot rollback. `/memory consolidate` — run the Phase C publish gate + growth budget over every draft, promoting eligible drafts to `published/` (reverse-snapshotting any overwritten note) and removing the consumed drafts (REME.md §5.3). `/memory rollback <noteId> [force]` — restore the latest `snapshots/<noteId>/<iso>.md` over the published note. If the published note was edited after the last snapshot (user/extern edit), returns an override-warning and does NOT overwrite unless `force` is given (REME.md §5.3 D11, borrowing the harness `writeHarnessStates` override-warning discipline). `/memory retire <noteId> [force]` — retire one published note (REME.md §5.4 D12): under `exitMode: off` it is a logged no-op; under `observe` it logs intent but does not move the note; under `enforce` it moves the note `published/` → `archived/` (bytes preserved, reversible). The `force` flag bypasses the age/use threshold for an explicit user retire (enforce only). `/memory archived` — list every archived (retired) note under `archived/`, with its `retired_at` time and kind/scope. `/memory unretire <noteId>` — move an archived note back to `published/` (REME.md §5.4 D12, "retirement is reversible"); clears `retired_at` and re-enters the recall index.

## Storage layout

```
<memoryDir>/
  published/<kind>/<slug>.md   # Phase B recall scope; search reads ONLY here (publish-gate semantics, REME.md §5.2 D8)
  drafts/<kind>/<slug>.md      # admitted draft notes (evidence-gated); not indexed by recall
  archived/<kind>/<slug>.md    # Phase D retire target: moved (never deleted) published notes, reversible via /memory unretire (REME.md §5.4 D12)
  dialog/<sessionId>.jsonl     # sanitized captured conversation (tool results stripped)
  snapshots/<relPath>/<iso>.md # Phase C reverse-snapshot store; one timestamped prior version per published note, restored by /memory rollback (REME.md §5.3 D11)
  index/                       # keyword index is NOT persisted — rebuilt from published/ each call (REME.md §5.2). `index/embeddings/` IS written when `embeddingsProvider: 'external'`: one `<relPath>.json` cached vector per promoted note (Phase E, REME.md §12.1).
  logs/                        # Phase C consolidation audit (not written in Phase A)
```

Every note is YAML-frontmatter Markdown. Frontmatter provenance fields (`session_id`, `source_conversation`) borrow ReMe `auto_memory.py _ensure_session_frontmatter`; `source` is the evidence-gate product and MUST locate inside the cited `dialog/<id>.jsonl` (REME.md §5.1 D6).

## Extension points (deferred)

- **Phase C** — consolidation four-step (scan→propose→apply→audit) + publish gate + reverse-snapshot rollback; `published/` is the promotion target (REME.md §5.3).
- **Phase D** — retire/archive: implemented. `scanAging` scores `published/` notes by `use_count` + recency (no LLM, no embeddings — scoring is deterministic, REME.md §12 Q1 defers embeddings); `retireNote`/`unretireNote` move notes `published/` ⇄ `archived/` (never delete), gated by `exitMode` off|observe|enforce, with conservative defaults (exitMode:off, agingMinAgeDays:180, agingMinUseCount:1) so normal use never retires (REME.md §5.4 D12).

## Storage read path (Phase B)

`memory_search(query, limit?, kind?)` returns the top-K published notes as full text (title, path, score, body). The index is built in-memory from `published/` on every call (`buildIndex` in `search.ts`): `term -> Set<noteId>` over title+body tokenized into lowercased ASCII words (length ≥ 2) and CJK character bigrams, so mixed CN/EN queries match. Score = Σ tf × idf with a BM25-smoothed idf (`log(1 + (N - n + 0.5)/(n + 0.5))`), sorted by score desc then `updated_at` desc (deterministic, stable). The keyword index is a derivable artifact and is never persisted, so deletion + rerun is byte-equivalent (REME.md §5.2 / §10 Phase B acceptance). On each hit the tool rewrites the note's frontmatter to increment `use_count` and set `last_accessed` to now, WITHOUT bumping `version` (content identity, not access) — the Phase D aging signal (REME.md §8 D4). Drafts and archive are excluded from the index (publish-gate semantics, REME.md §5.2 D8).

## Model Experience

### What the model sees

Phase B adds the `memory_search` tool to the model-visible tool surface. On `agent/session-start` the plugin injects ONE hints-only instruction message (`source: { kind: 'plugin', plugin: 'plugin-rlm-memory', form: 'instructions' }`) pointing the model at `memory_search` — it names the tool and its purpose but dumps NO note contents (hints-only discipline, prime 6/180/6000). The recall result is a normal tool result that enters the conversation log, never the system prompt. The continual-harness time-index overview remains the "what was recently memorized" channel; `memory_search` is the "what is relevant now" channel (dual-channel recall, REME.md §5.2 D8).

### Token effect

`memory_search` returns full note bodies as a tool result; the cost scales with `recallTopK` and the matched notes' size. The session-start guidance is one short message. The harness time-index overview is unchanged.

### KV Cache effect

The guidance message is a fixed short prefix per session; `memory_search` results are normal tool-result turns and follow the usual tool-call cache behavior of the agent loop. Recall does not reshape any other prefix.

## Known Limitations and Deferred Work

- **In-memory capture buffer** — per-session turns accumulate in a `Map` keyed by session id; a host restart mid-session loses the buffered turns. The durable artifact is the `dialog/<id>.jsonl` written on disposal. A persistence-backed buffer is a Phase C extension point.
- **Embeddings are opt-in (default off)** — Phase E adds an `EmbeddingService` seam with an OpenAI-compatible `ExternalEmbeddingProvider`, but `embeddingsProvider` defaults to `off`, so the shipped behavior is unchanged keyword/BM25 recall (no network, no cache). When `embeddingsProvider: 'external'` is configured with `embeddingsBaseURL`, `embeddingsModel`, and a key, `memory_search` blends cached cosine similarity with the keyword index (`hybridSearch`) and consolidation writes one vector per promoted note under `index/embeddings/`. The blend runs whenever `external` is set (it is not gated by `recallMode`); `recallMode: 'auto'` without a provider just logs the downgrade once. DeepSeek exposes no embeddings API, so the external provider points at an OpenAI-compatible endpoint. The seam is a Phase E make-do: a future dsh-native `Embedding` capability (`packages/core`) should replace `external` without touching call sites (REME.md §12.1).
- **Index rebuilt per call** — the keyword index is derived from `published/` on every `memory_search`; on a large knowledge base an incremental/maintained index (the `index/` dir reserved in layout) is a Phase C/D optimization, not a correctness requirement.
- **Phase D aging scan is lexical/use-count only** — `scanAging` combines `use_count` with recency of `last_accessed`/`updated_at`; it does NOT use semantic embeddings (REME.md §12 open question 1 — no dsh embeddings seam). A note is a retire candidate only when older than `agingMinAgeDays` AND `use_count < agingMinUseCount`. Scoring is deterministic and unit-tested, not a model call.
- **`intervalTurns` mode reserved** — `captureIntervalTurns` and the periodic timer are specified but not yet wired; only `sessionEnd` capture ships in Phase A.
- **`privacyFilter: 'display'` inert** — accepted by the schema, but Phase A has no display surface to consume provenance labels; only `'full'` performs masking.
- **No `purpose` on the tool** — `defineTool` (packages/core/tools/src/schema.ts `DefineToolOptions`) does not accept a `purpose` field, so `memory_search` cannot carry REME.md §5.2's intended `purpose: 'memory'` attribution. The tool's `name` still routes it through the host-owned seam.
