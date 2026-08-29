# plugin-rlm-memory Phase D — retire / aging (archive move, reversible)

- **Date**: 2026-08-30
- **Package**: `@deepseek-ai/dsh-plugin-rlm-memory`
- **Design**: [docs/REME.md](../../../docs/REME.md) §5.4 (Phase D), §8 D3/D12, §9 `exitMode`/`agingMinAgeDays`/`agingMinUseCount`, §10 Phase D acceptance, §12 open question 1
- **Predecessor patterns**: Phase C `consolidate.ts` `withLock` single-flight (D9); ReMe `FaissLocalFileStore` "chunk JSONL stays authoritative" / "Memory as File" (D3); Continual Harness paper (arXiv 2605.09998) aging + importance-demotion / forgetting strategy.

## What landed

Phase D gives the knowledge base a conservative, reversible retirement channel so it does not grow stale/unbounded, while NEVER deleting user-owned notes:

1. **Aging scan `scanAging(memoryDir, { exitMode, agingMinAgeDays, agingMinUseCount }, now)`** — scores every `published/` note by value: combines `use_count` (written by `memory_search` hits in Phase B, REME.md §8 D4) with recency of `last_accessed`/`updated_at`. A note is a retire candidate when it is older than `agingMinAgeDays` AND `use_count < agingMinUseCount`. Deterministic and unit-testable: no LLM, no embeddings (REME.md §12 open question 1 — no dsh embeddings seam), so scoring is `use_count` + recency, not semantic.
2. **`exitMode`** (Config, default `off` — conservative, REME.md §5.4): `off` makes `retire`/`scanAging` logged no-ops (notes stay `published/`); `observe` returns candidates and `retire` LOGS the intent but does NOT move the note; `enforce` MOVES the note `published/` → `archived/` (reversible via `unretireNote`).
3. **Archive = move, never delete** — `archiveNote` copies the file to `archived/<same relPath>` (preserving bytes, stamping `retired_at` into frontmatter) then removes the `published/` original; `unarchiveNote` moves it back and clears `retired_at`. Reversible by construction; asserted in tests that NO file is ever deleted (the moved note exists under `archived/`).
4. **Conservative global thresholds** — defaults deliberately high so normal use never triggers retirement: `agingMinAgeDays` = 180, `agingMinUseCount` = 1 (a note used even once is safe), `exitMode` = `off` (REME.md §9 "global 阈值更保守").
5. **Single-flight lock** — reuses `withLock` from `consolidate.ts` (the `Map<relPath, Promise>` pattern, D9) so concurrent `retire`/`unretire` of the same note cannot race.

## Provenance (borrow sources)

- Retirement/aging borrows the Continual Harness paper (arXiv 2605.09998) aging + importance-demotion strategy (low-use, stale notes retired); the file-authoritative model (ReMe, "Memory as File") makes archive a MOVE not a delete, so retirement is reversible (D3/D12); conservative global defaults (exitMode:off, agingMinAgeDays:180, agingMinUseCount:1) prevent premature forgetting; single-flight lock reuses Phase C consolidate.ts withLock; embeddings deferred per REME.md §12 Q1 so scoring is use_count+recency, not semantic.

## Files

- `src/retire.ts` (new): `scanAging`, `retireNote(memoryDir, noteId, { exitMode, agingMinAgeDays, agingMinUseCount }, force?)`, `unretireNote(memoryDir, noteId)`, `listArchivedNotes`, `isRetireCandidate`; reuses `withLock` from `consolidate.ts`.
- `src/storage.ts`: `archivedDir`, `archiveNote` (published→archived, stamps `retired_at`), `unarchiveNote` (archived→published, clears `retired_at`), `listArchived`, `resolvePublishedAbs` (basename-or-path, with/without `.md`), `toPublishedRel`; `archived` added to `SUBDIRS`; `NoteFrontmatter` gains optional `retired_at`.
- `src/memory-cmd.ts`: `retireText`, `archivedText`, `unretireText`; wired into the `/memory` switch in `index.ts` as `retire <noteId> [force]`, `archived`, `unretire <noteId>`.
- `src/index.ts`: Config `exitMode` (`off|observe|enforce`, default `off`), `agingMinAgeDays` (180), `agingMinUseCount` (1); explicit default resolution (no hidden `??`); passed into handlers.
- `tests/retire.spec.ts` (9), `tests/persistence-catalog.spec.ts` (+`archived` dir assertion); `tests/rlm-memory-real.e2e.ts` (+1 real-key retire→unretire test, now 4 e2e in the same file); `package.json` `test` script now lists `retire.spec.ts`; `description` updated (Phase D implemented).
- `README.md` Config table + `/memory` subcommands + storage layout + Known Limitations updated; `docs/STATUS.md` and `docs/NEXT.md` updated (T5.3 done).

## Verification

- `pnpm --filter @deepseek-ai/dsh-plugin-rlm-memory run test` — 63 specs pass (54 A/B/C + 9 Phase D). `retire.spec.ts` appears in the run output and is in the `test` script file list.
- `pnpm run typecheck` (package) — clean; no NEW errors in `src/`. (Repo-wide `tsc` shows only pre-existing `llm-pi-ai` errors + pre-existing test-file `noUnusedLocals` warnings unrelated to this change.)
- Real-key e2e (4th test, key-injection workaround) — `retireNote(enforce+force)` moves the note to `archived/` (with `retired_at`), clears `published/`; `unretireNote` restores it to `published/` with identical content and clears `archived/`. Passed.
- A/B/C (their 54 specs) remain green; `archived/` registered in `SUBDIRS` + persistence-catalog spec; `pnpm run gen-persistence-catalog` run (no new session events).
- `git status --short | Select-String STATUS` is empty — no stray `STATUS.md` created.

## Deviations

- **Aging is lexical/use-count only** (no embeddings, REME.md §12 open question 1): `isRetireCandidate` = `ageDays > agingMinAgeDays && use_count < agingMinUseCount`, where `ageDays` is from `last_accessed` (falling back to `updated_at`). No semantic/embedding signal — a deliberate Phase D boundary, unchanged from the design.
- **`retire`/`unretire` resolve a note id as basename (with or without `.md`) or as a relative path**, matching the directory's `kind/<slug>.md` nesting; the lock key is the normalized `published/<kind>/<slug>.md` relPath so `retire` and `unretire` of the same note serialize under one `withLock`.
- **No new Cordis session events** (per task constraint): retirement is recorded via the command return + note frontmatter (`retired_at`), not a log-only event. The persistence catalog generator was run so `session/memory-captured` (added in Phase B) stays in sync.
- **`force` bypasses the age/use threshold only under `enforce`** (explicit user retire); under `off`/`observe` `force` has no effect (the mode already prevents the move).
