# Agent Note: plugin-rlm-memory Phase C — evolution (consolidation + publish gate + reverse-snapshot rollback)

Status: implemented

Design: [docs/REME.md](../../../docs/REME.md) §5.3 (Phase C), §8 D2/D10, §9 `gateMode`, §10 Phase C acceptance, §12 open question 1. Predecessor patterns: plugin-rlm-loop `loop-tool.ts` `runs` Map (single-flight); plugin-continual-harness `harness-file.ts` `writeHarnessStates` override-warning + CAS.

## Problem

Phase A drafts had no path into searchable published notes: promotion was ungated and unmeasured (no growth budget), and a bad promotion had no undo. The Phase C design (REME.md §5.3) required a publish gate, a growth budget, and safe reverse-snapshot rollback, all without adding Cordis session events.

## Decision

`@deepseek-ai/dsh-plugin-rlm-memory` Phase C turns Phase A drafts into searchable published notes under a growth budget, with safe undo:

1. **Publish gate `gateMode`** (Config, default `observe`) — `off` is a logged no-op; `observe` promotes every eligible draft and flags `gate:'observe'` (non-blocking, even when the `source` is not strictly valid); `enforce` promotes only drafts whose `source` locates in their `dialog` via the Phase A `admitByEvidence` locator (REME.md §5.1 D6), and writes `rejected_at`/`rejection` into the draft frontmatter for the rest (they stay drafts).
2. **Deterministic consolidation** — `consolidate(memoryDir, { gateMode, maxPublishedNotes, maxPublishedBytes })`: scan all drafts → decide per draft (promote / reject / skip-budget) → reverse-snapshot any existing `published/` note this promotion would overwrite (slug collision) → write published + remove the consumed draft. No LLM merge: one published note per promoted draft. Lightweight dedup reuses `tokenize` from `search.ts` (token-overlap, not semantic — embeddings deferred per REME.md §12 open question 1, so no dsh embeddings seam).
3. **Single-flight lock** — in-process `Map<string, Promise>` keyed by target published relPath (`withLock`), mirroring the `runs` Map in `loop-tool.ts`, so two concurrent consolidations of the same note cannot clobber.
4. **Reverse-snapshot rollback** — `/memory rollback <noteId> [force]` restores the latest `snapshots/<noteId>/<iso>.md` over the published note. Override-warning (改过告警) borrows the harness `writeHarnessStates` discipline: if the published note's current mtime is newer than the latest snapshot's mtime (a user/extern edit after our last write), `rollback` returns `warnedUserEdit: true` and does NOT overwrite unless `force` is given.
5. **Growth budget** (Config `maxPublishedNotes`=200, `maxPublishedBytes`=5_000_000) — before promoting, count current `published/` notes and total bytes; `observe` logs + skips, `enforce` rejects. Overwrites of existing notes (dedup/collision) are not new growth, so they pass the budget.

Files: `src/consolidate.ts` (new: `withLock`, `consolidate`, `promoteDraft`, `rollbackNote`, dedup via `tokenize`); `src/storage.ts` (`snapshotsDir`, `takeSnapshot`, `listSnapshots`, `restoreSnapshot`; `SUBDIRS` += `snapshots`; `NoteFrontmatter` gains optional `rejected_at`/`rejection`; `publishedRelFor` exported); `src/memory-cmd.ts` (`consolidateText`, `rollbackText` + subcommands); `src/index.ts` (Config `gateMode`/`maxPublishedNotes`/`maxPublishedBytes`).

Provenance: consolidation + dedup borrows ReMe `auto_dream`/`auto_memory` merge discipline + the paper's growth-evaluation/retrieval-quality policy (arXiv 2605.09998); the four-step scan→decide→reverse-snapshot→write is a deterministic, no-LLM simplification of auto_dream's topics→extract→integrate→finish. Publish gate `enforce` reuses the Phase A evidence locator (`admitByEvidence`, D6) verbatim.

## Testing

`tests/consolidate.spec.ts` (6), `tests/rollback.spec.ts` (2), `tests/budget.spec.ts` (2), `tests/persistence-catalog.spec.ts` (+dir assertion); `tests/rlm-memory-real.e2e.ts` (+1 real-key promote→search test, now 3 e2e). Phase A/B (43 prior specs) remain green; the new `published/`/`snapshots/` dirs registered in `SUBDIRS` and the persistence-catalog spec. The persistence catalog generator was run to sync `session/memory-captured` (added in Phase B) into the runtime `known-event-types.ts`, which Phase B had left stale.

## Alternatives considered

**The design's subagent merge/rewrite "propose" step.** Rejected in favor of deterministic no-LLM consolidation: one published note per promoted draft with token-overlap dedup keeps consolidation reproducible and avoids a model call on the promotion path; the subagent-driven merge is explicitly deferred.

**Semantic (embedding) dedup.** Rejected: no dsh embeddings seam exists (REME.md §12 open question 1), so dedup is lexical token-overlap (Jaccard ≥ 0.5), and a draft overlapping an existing published note overwrites it (after reverse-snapshot).

**A separate `logs/consolidation/*.jsonl` audit writer.** Rejected: the audit trail is the `/memory consolidate` return + note frontmatter (`gate`/`version`/`updated_at`/`rejected_at`/`rejection`); the log directory is reserved but not yet appended.

## Consequences

Promotions are gated, budgeted, and reversible; rollback warns before overwriting a user edit unless `force` is given. Cost: no LLM consolidation (the merge quality is limited to per-draft promotion), lexical dedup can overwrite overlapping notes, and the override-warning uses a +100ms stamp margin (and 1ms comparison tolerance) to absorb sub-millisecond disk-flush jitter between `writePublished` and the snapshot stamp — a genuine user edit is detected as any mtime materially newer than our write.