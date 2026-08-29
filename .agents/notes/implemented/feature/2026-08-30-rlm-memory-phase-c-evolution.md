# plugin-rlm-memory Phase C — evolution (consolidation + publish gate + reverse-snapshot rollback)

- **Date**: 2026-08-30
- **Package**: `@deepseek-ai/dsh-plugin-rlm-memory`
- **Design**: [docs/REME.md](../../../docs/REME.md) §5.3 (Phase C), §8 D2/D10, §9 `gateMode`, §10 Phase C acceptance, §12 open question 1
- **Predecessor patterns**: plugin-rlm-loop `loop-tool.ts` `runs` Map (single-flight); plugin-continual-harness `harness-file.ts` `writeHarnessStates` override-warning + CAS

## What landed

Phase C turns Phase A drafts into searchable published notes under a growth budget, with safe undo:

1. **Publish gate `gateMode`** (Config, default `observe`) — `off` is a logged no-op; `observe` promotes every eligible draft and flags `gate:'observe'` (non-blocking, even when the `source` is not strictly valid); `enforce` promotes only drafts whose `source` locates in their `dialog` via the Phase A `admitByEvidence` locator (REME.md §5.1 D6), and writes `rejected_at`/`rejection` into the draft frontmatter for the rest (they stay drafts).
2. **Deterministic consolidation** — `consolidate(memoryDir, { gateMode, maxPublishedNotes, maxPublishedBytes })`: scan all drafts → decide per draft (promote / reject / skip-budget) → reverse-snapshot any existing `published/` note this promotion would overwrite (slug collision) → write published + remove the consumed draft. No LLM merge: one published note per promoted draft. Lightweight dedup reuses `tokenize` from `search.ts` (token-overlap, not semantic — embeddings deferred per REME.md §12 open question 1, so no dsh embeddings seam).
3. **Single-flight lock** — in-process `Map<string, Promise>` keyed by target published relPath (`withLock`), mirroring the `runs` Map in `loop-tool.ts`, so two concurrent consolidations of the same note cannot clobber.
4. **Reverse-snapshot rollback** — `/memory rollback <noteId> [force]` restores the latest `snapshots/<noteId>/<iso>.md` over the published note. Override-warning (改过告警) borrows the harness `writeHarnessStates` discipline: if the published note's current mtime is newer than the latest snapshot's mtime (a user/extern edit after our last write), `rollback` returns `warnedUserEdit: true` and does NOT overwrite unless `force` is given.
5. **Growth budget** (Config `maxPublishedNotes`=200, `maxPublishedBytes`=5_000_000) — before promoting, count current `published/` notes and total bytes; `observe` logs + skips, `enforce` rejects. Overwrites of existing notes (dedup/collision) are not new growth, so they pass the budget.

## Provenance (borrow sources)

- Consolidation + dedup borrows ReMe `auto_dream`/`auto_memory` merge discipline + the paper's growth-evaluation/retrieval-quality policy (arXiv 2605.09998); the four-step scan→decide→reverse-snapshot→write is a deterministic, no-LLM simplification of auto_dream's topics→extract→integrate→finish; the paper's growth evaluation is the budget that makes a round merge-only when over quota (D2 growth budget; D9 consolidation).
- Publish gate `enforce` reuses the Phase A evidence locator (`admitByEvidence`, D6) verbatim — `turn:N`/`turn:N-M`/`contains:<text>` that locate in the draft's `source_conversation` dialog.
- Reverse-snapshot rollback borrows the harness `writeHarnessStates` override-warning pattern (`harness-file.ts`): snapshot the prior version before overwrite; warn + require confirmation when the live file changed underneath.
- Growth budget borrows the paper's growth evaluation (D2): over budget, the round only merges, never grows unbounded.
- Embeddings deferred per REME.md §12 open question 1 (no dsh embeddings seam), so dedup is token-overlap (reuse `tokenize` from `search.ts`), not semantic.

## Files

- `src/consolidate.ts` (new): `withLock`, `consolidate`, `promoteDraft`, `rollbackNote`, `publishedRelFor` re-use, dedup via `tokenize`.
- `src/storage.ts`: `snapshotsDir`, `takeSnapshot` (`snapshots/<relPath>/<iso>.md`), `listSnapshots`, `restoreSnapshot`; `SUBDIRS` now includes `snapshots`; `NoteFrontmatter` gains optional `rejected_at`/`rejection`; `publishedRelFor` exported for slug-stable targeting.
- `src/memory-cmd.ts`: `consolidateText`, `rollbackText` (+ `consolidate`/`rollback` subcommands in the `/memory` switch).
- `src/index.ts`: Config `gateMode`/`maxPublishedNotes`/`maxPublishedBytes` (defaults `observe`/200/5_000_000) passed into the command handlers.
- `tests/consolidate.spec.ts` (6), `tests/rollback.spec.ts` (2), `tests/budget.spec.ts` (2), `tests/persistence-catalog.spec.ts` (+dir assertion); `tests/rlm-memory-real.e2e.ts` (+1 real-key promote→search test, now 3 e2e).

## Verification

- `pnpm --filter @deepseek-ai/dsh-plugin-rlm-memory run test` — 54 specs pass (42 Phase A/B + 12 Phase C).
- `tsc` on the package — clean (no new errors).
- Real-key e2e (3rd test) exercises `writeDraft` → `consolidate(observe)` → assert promoted + `memory_search` returns it.
- Phase A/B (43 prior specs) remain green; the new `published/`/`snapshots/` dirs registered in `SUBDIRS` and the persistence-catalog spec.

## Deviations

- **Deterministic, no-LLM consolidation**: the design's "propose" step (subagent merge/rewrite proposals) is replaced by a deterministic one-note-per-draft promotion with token-overlap dedup. This keeps consolidation reproducible and avoids a model call on the promotion path; the subagent-driven merge is explicitly deferred. The audit trail is the `/memory consolidate` return + note frontmatter (`gate`/`version`/`updated_at`/`rejected_at`/`rejection`), not a separate `logs/consolidation/*.jsonl` writer (that log dir is reserved but not yet appended).
- **Dedup heuristic is lexical token-overlap** (Jaccard ≥ 0.5), not semantic — embeddings are absent (REME.md §12 open question 1). A draft overlapping an existing published note overwrites it (after reverse-snapshot).
- **Snapshot mtime warning**: the override-warning compares the published note's mtime against the latest snapshot's mtime, with a +100ms stamp margin (and 1ms comparison tolerance) to absorb sub-millisecond disk-flush jitter between `writePublished` and the snapshot stamp; a genuine user edit is detected as any mtime materially newer than our write.
- No new Cordis session events were added (per the task constraint); the persistence catalog generator was run to sync `session/memory-captured` (added in Phase B) into the runtime `known-event-types.ts`, which Phase B had left stale.
