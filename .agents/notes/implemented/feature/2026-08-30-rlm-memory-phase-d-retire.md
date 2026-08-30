# Agent Note: plugin-rlm-memory Phase D — retire / aging (archive move, reversible)

Status: implemented

Design: [docs/REME.md](../../../docs/REME.md) §5.4 (Phase D), §8 D3/D12, §9 `exitMode`/`agingMinAgeDays`/`agingMinUseCount`, §10 Phase D acceptance, §12 open question 1. Predecessor patterns: Phase C `consolidate.ts` `withLock` single-flight (D9); ReMe `FaissLocalFileStore` "chunk JSONL stays authoritative" / "Memory as File" (D3); Continual Harness paper (arXiv 2605.09998) aging + importance-demotion / forgetting strategy.

## Problem

The knowledge base could grow stale and unbounded: nothing retired low-value notes, and a retirement path that deleted user-owned notes would violate the file-authoritative, reversible storage model. Phase D (REME.md §5.4) required a conservative, reversible retirement channel.

## Decision

`@deepseek-ai/dsh-plugin-rlm-memory` Phase D gives the knowledge base a conservative, reversible retirement channel that NEVER deletes user-owned notes:

1. **Aging scan `scanAging(memoryDir, { exitMode, agingMinAgeDays, agingMinUseCount }, now)`** — scores every `published/` note by value: combines `use_count` (written by `memory_search` hits in Phase B, REME.md §8 D4) with recency of `last_accessed`/`updated_at`. A note is a retire candidate when it is older than `agingMinAgeDays` AND `use_count < agingMinUseCount`. Deterministic and unit-testable: no LLM, no embeddings (REME.md §12 open question 1 — no dsh embeddings seam), so scoring is `use_count` + recency, not semantic.
2. **`exitMode`** (Config, default `off` — conservative, REME.md §5.4): `off` makes `retire`/`scanAging` logged no-ops (notes stay `published/`); `observe` returns candidates and `retire` LOGS the intent but does NOT move the note; `enforce` MOVES the note `published/` → `archived/` (reversible via `unretireNote`).
3. **Archive = move, never delete** — `archiveNote` copies the file to `archived/<same relPath>` (preserving bytes, stamping `retired_at` into frontmatter) then removes the `published/` original; `unarchiveNote` moves it back and clears `retired_at`. Reversible by construction; tests assert that NO file is ever deleted (the moved note exists under `archived/`).
4. **Conservative global thresholds** — defaults deliberately high so normal use never triggers retirement: `agingMinAgeDays` = 180, `agingMinUseCount` = 1 (a note used even once is safe), `exitMode` = `off` (REME.md §9 "global 阈值更保守").
5. **Single-flight lock** — reuses `withLock` from `consolidate.ts` (the `Map<relPath, Promise>` pattern, D9) so concurrent `retire`/`unretire` of the same note cannot race.

Files: `src/retire.ts` (new: `scanAging`, `retireNote`, `unretireNote`, `listArchivedNotes`, `isRetireCandidate`); `src/storage.ts` (`archivedDir`, `archiveNote`, `unarchiveNote`, `listArchived`, `resolvePublishedAbs`, `toPublishedRel`; `archived` added to `SUBDIRS`; `NoteFrontmatter` gains optional `retired_at`); `src/memory-cmd.ts` (`retireText`, `archivedText`, `unretireText`); `src/index.ts` (Config `exitMode`/`agingMinAgeDays`/`agingMinUseCount`, explicit default resolution).

Provenance: retirement/aging borrows the Continual Harness paper (arXiv 2605.09998) aging + importance-demotion strategy; the file-authoritative model (ReMe, "Memory as File") makes archive a MOVE not a delete, so retirement is reversible (D3/D12).

## Testing

`tests/retire.spec.ts` (9), `tests/persistence-catalog.spec.ts` (+`archived` dir assertion); `tests/rlm-memory-real.e2e.ts` (+1 real-key retire→unretire test, now 4 e2e in the same file); `package.json` `test` script lists `retire.spec.ts`. A/B/C (their 54 specs) remain green; `archived/` registered in `SUBDIRS` + persistence-catalog spec; `pnpm run gen-persistence-catalog` run (no new session events).

## Alternatives considered

**Semantic/embedding scoring for aging.** Rejected: no dsh embeddings seam (REME.md §12 open question 1) — `isRetireCandidate` stays `ageDays > agingMinAgeDays && use_count < agingMinUseCount` with `ageDays` from `last_accessed` (falling back to `updated_at`); a deliberate Phase D boundary.

**Soft-delete tombstone instead of a move.** Rejected: the file-authoritative model (D3) makes archive a move — a tombstone would leave the note in `published/` (still served by recall) or invent a new state with no file presence; the move is reversible by construction and asserted in tests.

**No `force` bypass.** Rejected: `force` bypasses the age/use threshold only under `enforce` (explicit user retire); under `off`/`observe` `force` has no effect (the mode already prevents the move).

## Consequences

Retirement is conservative (default `off`, 180 days, use_count ≥ 1 keeps a note safe), reversible (move + `retired_at` stamp, `unretire` restores identical bytes), and race-free (single-flight lock keyed on the normalized `published/<kind>/<slug>.md` relPath). Cost: aging is lexical/use-count only — a stale-but-used note never retires, and a low-use recent note is protected by the age floor. No new Cordis session events (per task constraint): retirement is recorded via the command return + note frontmatter (`retired_at`).