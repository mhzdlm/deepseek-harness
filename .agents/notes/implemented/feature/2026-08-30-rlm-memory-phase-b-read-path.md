# Agent Note: RLM memory plugin — Phase B read path

Status: implemented

English | [中文](2026-08-30-rlm-memory-phase-b-read-path.zh.md)

## Problem

Phase A lands the write path but leaves the knowledge base unreadable: completed
sessions evaporate from recall, and the Continual Harness paper's "retrieval
quality" strategy (one of its five management strategies) has no channel. ReMe
proves a `reme_search` (BM25 + embedding + wikilink) tool, but its embedding seam
depends on an embeddings API the dsh LLM seam does not expose (REME.md §12 open
question 1 — verified: `adapter.spec.ts:2224`'s "embedding" is a test fixture, not
a vector interface). REME.md §5.2 resolves this: ship a keyword/BM25-ish recall
channel now, defer vector recall to an upstream seam extension, and keep the
publish gate as the boundary of what enters the index.

## Decision

`packages/rlm/plugin-rlm-memory` gains the Phase B read path, added alongside the
Phase A write path without breaking it:

- `src/search.ts` — `tokenize(text)` emits lowercased ASCII words (length ≥ 2) and
  CJK character bigrams, so mixed CN/EN queries match. `buildIndex(memoryDir)`
  rebuilds an in-memory `term -> Set<noteId>` inverted index from `published/` only
  (drafts/archive excluded — publish-gate semantics, REME.md §5.2 D8), reading each
  note's title+body. `search(memoryDir, query, limit, kind?)` scores hits with
  Σ tf × idf (BM25-smoothed idf `log(1 + (N - n + 0.5)/(n + 0.5))`) and returns
  full text (title, path, score, body), sorted by score desc then `updated_at`
  desc. The index is a DERIVABLE artifact: built from files each call, never
  persisted to `index/keyword.json`, so delete-and-rerun is byte-equivalent (REME.md
  §5.2 / §10 Phase B acceptance: index rebuildability).
- `src/storage.ts` additions — `publishedDir`, `writePublished`, `listPublished`
  (published only), `readNote`, and `updateUsage(memoryDir, relPath, nowIso)`, which
  increments `use_count` and sets `last_accessed` WITHOUT bumping `version` (content
  identity, not access — REME.md §8 D4 / §4 D4 aging signal; the use-signal fields
  borrow ReMe `auto_memory.py` provenance + the paper's aging strategy).
- `src/memory-search-tool.ts` — `createMemorySearchTool({ memoryDir, recallTopK,
  recallMode })`, built on `defineTool` from `@deepseek-ai/dsh-tools`, mirroring the
  `loop-tool.ts` shape exactly (`parameters` field-map with `query.required`,
  `output: { schema, render }`, `execute(args, exec)` that reads `exec.agent?.session`
  and throws without one). On each hit it calls `updateUsage` (best-effort). Returns
  full text via `output.render`; the result rides the tool-result log, never the
  system prompt (REME.md §5.2 dual-channel). `recallMode: 'auto'` is accepted but the
  keyword implementation is the only one shipped.
- `src/guidance.ts` — `memoryGuidance(language)`, a one/two-sentence hints-only
  string (en/zh) naming the `memory_search` tool and its purpose, no note content.
- `src/index.ts` — Config gains `recallTopK` (default 5), `recallMode`
  (`keyword`|`auto`, default `keyword`), `language` (`en`|`zh`); the tool is
  registered via `ctx.effect(() => ctx.tools.register(...))`; and the existing
  `agent/session-start` listener now also injects the guidance through
  `agent.inject(createUserMessage({ content:[{type:'text', text: memoryGuidance(...)}],
  source: { kind:'plugin', plugin: name, form:'instructions' } }))` while preserving
  the `agentsBySession` capture (REME.md §6 D13; the `agent.inject` API and
  `source.form:'instructions'` are confirmed in `packages/core/agent/src/runtime-types.ts`
  and `packages/llm/llm/src/message.ts`).

`defineTool` does NOT accept a `purpose` field (`DefineToolOptions` in
`packages/core/tools/src/schema.ts` has no such key), so the REME.md §5.2
`purpose:'memory'` attribution is NOT set; the tool's `name` still routes it through
the host-owned seam. No new `SessionEventMap` member is added (search is a tool
result, already logged) and the persistence catalog is untouched. The package
`./invariant` remains the Phase A no-runtime-invariant companion.

## Alternatives considered

**Persist `index/keyword.json` for speed.** Rejected: REME.md §5.2 / §10 Phase B
acceptance explicitly requires index rebuildability (delete-and-rerun
equivalence); a persisted index can drift from `published/` and would need a
maintenance hook. Rebuilding from files each call is cheap at this scale and
removes a whole class of drift bugs. An incremental/maintained index is a clean
Phase C/D optimization over the reserved `index/` dir.

**Use classic `idf = log(N/n)` literally.** Rejected in practice: in a
single-note corpus every term appears in all notes, so `log(1/1) = 0` and recall
returns nothing — breaking the basic "search returns the matching note" acceptance.
The BM25-smoothed idf `log(1 + (N - n + 0.5)/(n + 0.5))` is positive whenever a
term appears in fewer than all notes, keeps the +0.5 divide-by-zero guard, and is
the "BM25式" form REME.md §5.2 names.

**Invent an embedding call for `recallMode: 'auto'`.** Rejected: REME.md §12 open
question 1 source-verified there is no embeddings API in the dsh LLM seam. `auto`
is accepted by the Config but logs a one-time downgrade warning and falls back to
keyword; no fabricated vector call is added. Vector recall is an upstream seam
extension.

**Carry `use_count`/`last_accessed` update inside `search()`.** Rejected: it would
mutate files during an index-rebuild call, undermining the "rebuild equivalence"
test's purity and coupling retrieval to side effects. `search` stays pure; the
tool applies the §8 D4 use-signal after ranking, mirroring how Phase D will read it.

## Consequences

- The knowledge base is now recallable: `memory_search` returns ranked full-text
  published notes, dual-channel with the harness time-index overview (REME.md §5.2
  D8). Drafts/archive stay outside recall (publish-gate semantics).
- Each recall hit raises that note's `use_count` and refreshes `last_accessed`
  without touching `version`, feeding the Phase D aging/demotion scan.
- The keyword index is always consistent with `published/` (rebuilt per call);
  no persisted index to maintain or rebuild.
- `recallMode: 'auto'` silently degrades to keyword until an upstream embeddings
  seam exists; `defineTool` cannot carry `purpose: 'memory'`.
- Phase C (consolidation/rollback, promotion into `published/`) and Phase D
  (retire/archive using `use_count`/`last_accessed`) remain unbuilt; the read path
  assumes notes already live in `published/` (this Phase B writes them in tests via
  `writePublished`, which Phase C will gate).
