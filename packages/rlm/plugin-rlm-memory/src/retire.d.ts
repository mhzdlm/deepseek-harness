/**
 * Phase D retirement (REME.md §5.4, §8 D3/D12, §9 `exitMode`, §10 Phase D acceptance,
 * §12 open question 1): an aging scan that scores each `published/` note by value and a
 * reversible archive move that retires low-value, stale notes without ever deleting bytes.
 *
 * - Aging scan (`scanAging`): deterministic, no LLM and no embeddings. It combines
 *   `use_count` (written by `memory_search` hits in Phase B, REME.md §8 D4) with recency
 *   of `last_accessed`/`updated_at` to score each published note; a note is a retire
 *   candidate when it is older than `agingMinAgeDays` AND its `use_count` is below
 *   `agingMinUseCount`. Embeddings are deliberately absent (REME.md §12 open question 1:
 *   no dsh embeddings seam), so scoring is `use_count` + recency, not semantic.
 * - `exitMode` (`off|observe|enforce`, default `off` — conservative, REME.md §5.4): `off`
 *   makes `retire`/`scanAging` logged no-ops (notes stay `published/`); `observe` returns
 *   candidates and `retire` LOGS the intent but does NOT move the note; `enforce` MOVES the
 *   note `published/` → `archived/` (reversible via `unretireNote`).
 * - Archive = move, never delete (REME.md §4 D3 / §5.4 D12): `archiveNote` preserves the
 *   bytes under `archived/<same relPath>`; `unretireNote` moves it back. Reversible by
 *   construction — no `rm` of user-owned content, ever.
 * - Conservative global defaults (REME.md §9, the "global 阈值更保守" requirement):
 *   `agingMinAgeDays` default 180, `agingMinUseCount` default 1 (a note used even once is
 *   safe), `exitMode` default `off` — normal use never triggers retirement.
 * - Single-flight lock reuses `withLock` from ./consolidate.ts (the same
 *   `Map<relPath, Promise>` pattern, D9 single-flight precedent) so concurrent
 *   retire/unretire of the same note cannot race.
 *
 * Provenance: retirement/aging borrows the Continual Harness paper (arXiv 2605.09998)
 * aging + importance-demotion strategy (low-use, stale notes retired); the file-authoritative
 * model (ReMe, "Memory as File") makes archive a MOVE not a delete, so retirement is
 * reversible (D3/D12); conservative global defaults (exitMode:off, agingMinAgeDays:180,
 * agingMinUseCount:1) prevent premature forgetting; single-flight lock reuses Phase C
 * consolidate.ts withLock; embeddings deferred per REME.md §12 Q1 so scoring is
 * use_count+recency, not semantic.
 *
 * @module @deepseek-ai/dsh-plugin-rlm-memory/retire
 */
import { type Note } from './storage.ts';
/** Retirement exit mode (REME.md §5.4 / §9 `exitMode`). */
export type ExitMode = 'off' | 'observe' | 'enforce';
/** Options controlling the aging scan and retire behavior (from plugin Config). */
export interface RetireOptions {
    /** Retirement exit mode (default `'off'`). */
    exitMode: ExitMode;
    /** A note must be older than this many days to be a retire candidate (default 180). */
    agingMinAgeDays: number;
    /** A note with `use_count` below this is a retire candidate (default 1). */
    agingMinUseCount: number;
}
/** One scored candidate from the aging scan. */
export interface AgingCandidate {
    /** Relative `published/` path (e.g. `published/personal/turn-0.md`). */
    relPath: string;
    /** The parsed note. */
    note: Note;
    /** Days since the note was last accessed (derived from `last_accessed`). */
    ageDays: number;
    /** The note's `use_count` frontmatter. */
    useCount: number;
    /** Whether this note meets BOTH thresholds (age AND low use) — a true retire candidate. */
    isCandidate: boolean;
}
/** Result of an aging scan over `published/`. */
export interface AgingScan {
    /** Every published note scored, with its candidate status. */
    candidates: AgingCandidate[];
    /** Convenience: only the notes that meet both thresholds. */
    retireable: string[];
}
/**
 * Whether a note is a retire candidate: older than `agingMinAgeDays` AND `use_count`
 * below `agingMinUseCount` (REME.md §5.4 D3 — "idle 天数、最低命中" threshold). Recency
 * is taken from `last_accessed` when present, else `updated_at` (the note's content
 * freshness); either keeps the note out of the candidate set if recent.
 * @param note - the published note to score.
 * @param options - the resolved aging thresholds.
 * @param now - reference instant (injectable for deterministic tests).
 * @returns true when both age and use thresholds are exceeded.
 */
export declare function isRetireCandidate(note: Note, options: RetireOptions, now?: number): boolean;
/**
 * Retire one published note: move it `published/` → `archived/` (reversible). Behavior
 * depends on `exitMode` (REME.md §5.4):
 * - `off`: logged no-op — the note stays `published/` (returns a no-op report).
 * - `observe`: LOGS the intent, returns a report, but does NOT move the note (stays published).
 * - `enforce`: MOVES the note to `archived/` (bytes preserved), unless `force` bypasses the
 *   age/use threshold for an explicit user retire.
 * Runs under {@link withLock} on the note's published relPath so concurrent retire/unretire
 * of the same note serialize (D9 single-flight precedent, reused from consolidate.ts).
 * @param memoryDir - resolved memory root.
 * @param noteId - the published note id (relative path or basename).
 * @param options - resolved exitMode + aging thresholds.
 * @param force - when true, bypass the age/use threshold (explicit user retire), valid under `enforce`.
 * @returns a human-readable outcome string for the command layer.
 */
export declare function retireNote(memoryDir: string, noteId: string, options: RetireOptions, force?: boolean): Promise<string>;
/**
 * Un-retire one archived note: move it `archived/` → `published/` (REME.md §5.4 D12,
 * "retirement is reversible"). Runs under {@link withLock} on the note's published relPath.
 * @param memoryDir - resolved memory root.
 * @param noteId - the note id; the SAME relPath it had under `published/` (e.g.
 *   `published/personal/turn-0.md`). A basename is resolved against `archived/`.
 * @returns a human-readable outcome string for the command layer.
 */
export declare function unretireNote(memoryDir: string, noteId: string): Promise<string>;
/**
 * List archived notes (REME.md §5.4 D12 — inspect what has been retired). Thin wrapper
 * over {@link listArchived} that returns relative `archived/` paths for display.
 * @param memoryDir - resolved memory root.
 * @returns relative archived paths (e.g. `archived/personal/turn-0.md`).
 */
export declare function listArchivedNotes(memoryDir: string): string[];
//# sourceMappingURL=retire.d.ts.map