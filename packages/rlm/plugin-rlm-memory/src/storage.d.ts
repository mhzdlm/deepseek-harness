/**
 * File-authoritative Markdown store for the memory layer. Notes are
 * YAML-frontmatter Markdown; the dialog jsonl is the derived-rebuildable
 * source of truth the extraction subagent reads (REME.md §4 D3: "Memory as
 * File, File as Memory"; frontmatter provenance fields borrow ReMe
 * `auto_memory.py _ensure_session_frontmatter`).
 *
 * All paths live under one `memoryDir` with subdirs `published/`, `drafts/`,
 * `archived/`, `dialog/`, `index/`, `logs/`, `snapshots/` (see {@link SUBDIRS}).
 * This module owns the directory
 * layout and the frontmatter round-trip; it does not own the evidence gate
 * (see ./evidence.ts) or the capture buffer (see ./capture.ts).
 *
 * Phase B adds the `published/` read path: `listPublished`, `readNote`, and
 * `updateUsage` (REME.md §5.2 D4 use-signal; `use_count`/`last_accessed`
 * increment on each recall hit without bumping `version`, which tracks
 * content, not access — see updateUsage). The keyword index is NOT persisted
 * here; buildIndex derives it from `published/` each call so it can never
 * drift (delete-and-rerun equivalence, REME.md §5.2 / §10 Phase B acceptance).
 *
 * @module @deepseek-ai/dsh-plugin-rlm-memory/storage
 */
import { relative } from 'node:path';
/** The three ReMe-style buckets (REME.md §4 D4: tri-bucket borrows ReMe `dream_bucket_enum`). */
export type NoteKind = 'procedure' | 'personal' | 'wiki';
/** Note scope, aligned with harness local/global semantics (REME.md §4). */
export type NoteScope = 'session' | 'global';
/** Frontmatter contract for every note this plugin writes (REME.md §4). */
export interface NoteFrontmatter {
    kind: NoteKind;
    scope: NoteScope;
    session_id: string;
    /**
     * Model-generated title from the extraction proposal (Phase 10, T6.19).
     * Present when the extractor supplied one; the draft slug still derives
     * from the body, so this field is descriptive, not an identifier.
     */
    title?: string;
    /** Evidence gate product — a reference that locates inside the source dialog jsonl (REME.md §5.1 D6). */
    source: string;
    /** Pointer to the original conversation (dialog jsonl) for traceability. */
    source_conversation: string;
    created_at: string;
    updated_at: string;
    version: number;
    use_count: number;
    last_accessed: string;
    /** Publish-gate placeholder; Phase A leaves every draft at observe/pass, Phase C reviews it. */
    gate: {
        mode: string;
        verdict: string;
        reviewed_at: string;
    };
    /**
     * Set only on an `enforce`-rejected draft (REME.md §5.3 D10): the ISO time the gate
     * refused promotion and the human-readable reason. Absent on published/promoted notes.
     */
    rejected_at?: string;
    /** Rejection reason recorded when `enforce` refuses a draft (see `rejected_at`). */
    rejection?: string;
    /** Set only on an archived note (REME.md §5.4 D12): the ISO time the note was retired (moved to `archive/`). */
    retired_at?: string;
    /** Phase C: the mailbox belief subject this projected note renders (absent on legacy notes). */
    subject?: string;
}
/** One note file: its frontmatter plus its Markdown body. */
export interface Note {
    frontmatter: NoteFrontmatter;
    body: string;
}
/**
 * Subdirectory names under `memoryDir` (REME.md §4 layout).
 * `snapshots/` added in Phase C (D11); `archived/` is the Phase D retire target (D12).
 */
export declare const SUBDIRS: readonly ["published", "drafts", "dialog", "index", "logs", "snapshots", "archived"];
/**
 * Create the memory directory tree if absent. Idempotent.
 * @param memoryDir - resolved memory root.
 */
export declare function ensureMemoryDirs(memoryDir: string): void;
/**
 * Path of the sanitized dialog jsonl for one session.
 * @param memoryDir - resolved memory root.
 * @param sessionId - the captured session id.
 * @returns absolute path `memoryDir/dialog/<sessionId>.jsonl`.
 */
export declare function dialogPath(memoryDir: string, sessionId: string): string;
/**
 * Write the sanitized dialog jsonl for one session, creating parent dirs.
 * @param memoryDir - resolved memory root.
 * @param sessionId - the captured session id.
 * @param jsonl - newline-terminated JSONL text.
 */
export declare function writeDialog(memoryDir: string, sessionId: string, jsonl: string): void;
/**
 * Read the stored dialog jsonl as parsed turn objects.
 * @param memoryDir - resolved memory root.
 * @param sessionId - the captured session id.
 * @returns an array of `{ role, content }` turns; `[]` when the file is absent.
 */
export declare function readDialog(memoryDir: string, sessionId: string): Array<{
    role: string;
    content: string;
}>;
/**
 * Serialize a note to frontmatter + body Markdown text.
 * @param note - the note to serialize.
 * @returns the complete `.md` file content with a leading `---` fence.
 */
export declare function serializeNote(note: Note): string;
/**
 * Parse a note file's frontmatter + body. Reads the file at `path`.
 * @param path - absolute note file path.
 * @returns the parsed note, or null when the file is missing or has no frontmatter.
 */
export declare function parseNote(path: string): Note | null;
/**
 * Write one draft note, creating the kind subdirectory. The note MUST carry a
 * `source` that the caller has already validated as locatable in its dialog
 * jsonl (the evidence gate lives in ./evidence.ts); this function only persists.
 * @param memoryDir - resolved memory root.
 * @param note - the note to write (frontmatter + body).
 * @param sessionId - the originating session id (used for the slug + collision-avoidance).
 * @param title - the note title used to derive the slug.
 * @returns the absolute path written.
 */
export declare function writeDraft(memoryDir: string, note: Note, sessionId: string, title: string): string;
/**
 * List draft note paths under `memoryDir/drafts` (recursively across kind subdirs).
 * @param memoryDir - resolved memory root.
 * @returns absolute paths of every `.md` file under drafts/.
 */
export declare function listDrafts(memoryDir: string): string[];
/**
 * Delete one draft note. Published notes are NOT deletable here (Phase C owns
 * promotion/rollback); this throws if the path is outside `memoryDir/drafts`.
 * @param memoryDir - resolved memory root.
 * @param path - absolute draft note path to delete.
 */
export declare function deleteDraft(memoryDir: string, path: string): void;
/**
 * Absolute path of the `published/` directory under `memoryDir`.
 * @param memoryDir - resolved memory root.
 * @returns `memoryDir/published`.
 */
export declare function publishedDir(memoryDir: string): string;
/**
 * The relative published path (`published/<kind>/<slug>.md`) a note will occupy once
 * promoted. Uses the same slug derivation as {@link writePublished} so consolidation
 * can compute the single-flight key and dedup target without duplicating the slug rule.
 * @param note - the note whose published path to compute.
 * @returns the relative path under `memoryDir`, e.g. `published/personal/turn-0-a1b2c3d4.md`.
 *
 * Phase 8 (review round 6): the path carries an 8-char session disambiguator.
 * The slug used to derive from `source` alone, so every session's first-turn
 * note landed on `published/<kind>/turn-0.md` and the later promotion silently
 * overwrote the earlier one (cross-session knowledge loss). Content-level dedup
 * (consolidate.ts `dedupTarget`) still merges genuinely-similar notes.
 */
export declare function publishedRelFor(note: Note): string;
/**
 * Write one published note, creating the kind subdirectory. Published notes are
 * the recall index scope (REME.md §5.2 D8: search only reads `published/` — the
 * publish gate is what admits a note into recall). Rewriting frontmatter through
 * {@link serializeNote} keeps the on-disk YAML stable; callers own `version`.
 * @param memoryDir - resolved memory root.
 * @param note - the note to write (frontmatter + body).
 * @param targetRel - optional relative path under `memoryDir` (e.g.
 *   `published/personal/<id>.md`); defaults to a slug path under `published/`
 *   derived from the note's kind and source.
 * @returns the absolute path written.
 */
export declare function writePublished(memoryDir: string, note: Note, targetRel?: string): string;
/**
 * List published note paths under `memoryDir/published` (recursively across kind
 * subdirs). Drafts and archive are deliberately excluded — recall indexes only
 * published notes (REME.md §5.2 D8, publish-gate semantics).
 * @param memoryDir - resolved memory root.
 * @returns absolute paths of every `.md` file under published/.
 */
export declare function listPublished(memoryDir: string): string[];
/**
 * Embedding cache (Phase E, REME.md §12.1). Embeddings are a DERIVED artifact cached
 * beside the lexical `index/` — NOT persisted inside the human-readable note Markdown,
 * and stored under `index/embeddings/` so no `SUBDIRS`/persistence-catalog change is
 * needed. Keyed by published relPath. The lexical `search` path never reads these; only
 * `hybridSearch` does, and a missing cache degrades to lexical-only.
 */
/**
 * Path of the embedding cache directory (`memoryDir/index/embeddings`).
 * @param memoryDir - resolved memory root.
 * @returns the absolute embedding-cache directory path.
 */
export declare function embeddingCacheDir(memoryDir: string): string;
/**
 * Cache one note's embedding vector. Best-effort store; callers must never fail because
 * caching failed.
 * @param memoryDir - resolved memory root.
 * @param relPath - the published note relPath (e.g. `published/wiki/x.md`).
 * @param vector - the embedding vector.
 */
export declare function writeEmbedding(memoryDir: string, relPath: string, vector: number[]): void;
/**
 * Read a cached embedding vector, or null when absent (the note predates embeddings or
 * was written directly). `hybridSearch` treats null as "no semantic signal".
 * @param memoryDir - resolved memory root.
 * @param relPath - the published note relPath.
 * @returns the cached vector, or null.
 */
export declare function readEmbedding(memoryDir: string, relPath: string): number[] | null;
/**
 * Remove a cached embedding (e.g. when a note is retired). Best-effort; a missing cache
 * is not an error.
 * @param memoryDir - resolved memory root.
 * @param relPath - the published note relPath.
 */
export declare function deleteEmbedding(memoryDir: string, relPath: string): void;
/**
 * Read one note by its relative path under `memoryDir` (e.g. `published/wiki/x.md`).
 * Thin wrapper over {@link parseNote} that prepends `memoryDir` when given a
 * relative path. Returns null for an absent or frontmatter-less file.
 * @param memoryDir - resolved memory root.
 * @param relPath - relative note path (may already be absolute).
 * @returns the parsed note, or null when missing.
 */
export declare function readNote(memoryDir: string, relPath: string): Note | null;
/**
 * Increment a published note's `use_count` and set `last_accessed` to `nowIso`,
 * rewriting ONLY the frontmatter — `version` is left unchanged because it tracks
 * content, not access (REME.md §4 D4 / §5.2 D4 aging signal; the use-signal fields
 * borrow ReMe `auto_memory.py` provenance + the paper's aging strategy). The body
 * and every other field are preserved byte-for-byte except where YAML re-serializes
 * the unchanged scalars. Best-effort: a missing or unparseable note is a no-op.
 * @param memoryDir - resolved memory root.
 * @param relPath - relative note path under `memoryDir`.
 * @param nowIso - ISO timestamp for the new `last_accessed`.
 */
export declare function updateUsage(memoryDir: string, relPath: string, nowIso: string): void;
/**
 * Absolute path of the `snapshots/` directory under `memoryDir` (Phase C reverse
 * snapshot store, REME.md §5.3 D11 — rollback history lives in `snapshots/`, mirroring
 * the `/refine` RefinementEvent snapshot shape from plugin-continual-harness).
 * @param memoryDir - resolved memory root.
 * @returns `memoryDir/snapshots`.
 */
export declare function snapshotsDir(memoryDir: string): string;
/**
 * Copy `content` into `snapshots/<relPath>/<iso>.md`, preserving the prior published
 * version before a consolidation overwrite (REME.md §5.3 D11 reverse-snapshot: precede
 * the apply step with a snapshot of the file it will change, so rollback has a restore
 * source). The iso segment is derived from `new Date().toISOString()` (lexically
 * sortable, so the latest snapshot is the last entry). Idempotent: creates the nested
 * dir under `snapshots/`.
 * @param memoryDir - resolved memory root.
 * @param relPath - the relative published note path being overwritten (e.g. `published/wiki/x.md`).
 * @param content - the current on-disk content of that note to preserve.
 * @returns the absolute snapshot file path written.
 */
export declare function takeSnapshot(memoryDir: string, relPath: string, content: string): string;
/**
 * List snapshot file paths for one note id, newest first. `noteId` is the relative
 * published path (e.g. `published/wiki/x.md`); snapshots live at
 * `snapshots/<noteId>/<iso>.md`. When there are none, returns `[]`.
 * @param memoryDir - resolved memory root.
 * @param noteId - the relative published note path whose snapshots to enumerate.
 * @returns absolute snapshot paths sorted by descending mtime (newest first).
 */
export declare function listSnapshots(memoryDir: string, noteId: string): string[];
/**
 * Restore the named snapshot over the published note it backs up. `noteId` is the
 * relative published path; `snapshotFile` is one entry from {@link listSnapshots}.
 * Rewrites the published note at `memoryDir/noteId` with the snapshot's stored content
 * (REME.md §5.3 D11 rollback — reverse-snapshot restore). Callers own the
 * "override-warning" discipline (do not overwrite a user-edited note without `force`);
 * this function only performs the file write.
 * @param memoryDir - resolved memory root.
 * @param noteId - the relative published note path to restore.
 * @param snapshotFile - the absolute snapshot file to copy from.
 * @returns the absolute published note path written.
 */
export declare function restoreSnapshot(memoryDir: string, noteId: string, snapshotFile: string): string;
/**
 * Absolute path of the `archived/` directory under `memoryDir` (Phase D retire
 * target, REME.md §4 D12 — "retirement is a move, naturally reversible").
 * @param memoryDir - resolved memory root.
 * @returns `memoryDir/archived`.
 */
export declare function archivedDir(memoryDir: string): string;
/**
 * Move a published note to `archived/<same relPath>`, preserving its bytes. The
 * original `published/` file is removed after the copy succeeds (never deleted:
 * the content lives on under `archived/`, fully reversible via
 * {@link unarchiveNote}, REME.md §5.4 D12). Stamps `retired_at` into the
 * archived note's frontmatter so the retire time is auditable. Uses a copy+unlink
 * (not `renameSync`) so the move is robust across same-filesystem renames and
 * leaves a clean `published/` index behind. The `archived/` copy keeps the same
 * relative kind/slug nesting as the source.
 * @param memoryDir - resolved memory root.
 * @param relPath - relative published note path (e.g. `published/personal/turn-0.md`).
 * @returns the absolute archived note path written.
 */
export declare function archiveNote(memoryDir: string, relPath: string): string;
/**
 * Move an archived note back to its original `published/<same relPath>`
 * (REME.md §5.4 D12, "retirement is reversible"). Clears `retired_at` from the
 * frontmatter on the way back so the note re-enters the recall index cleanly.
 * @param memoryDir - resolved memory root.
 * @param archivedRelPath - relative note path under `archived/`, the SAME relPath it had
 *   under `published/` (e.g. `published/personal/turn-0.md`). The `archived/` source is
 *   derived by swapping the leading `published` segment for `archived`.
 * @returns the absolute published note path written.
 */
export declare function unarchiveNote(memoryDir: string, archivedRelPath: string): string;
/**
 * List archived note paths under `memoryDir/archived` (recursively across kind
 * subdirs). Excludes `published/`/`drafts/` deliberately — recall indexes only
 * published notes (REME.md §5.2 D8), so archived notes are out of the recall scope.
 * @param memoryDir - resolved memory root.
 * @returns absolute paths of every `.md` file under archived/.
 */
export declare function listArchived(memoryDir: string): string[];
/**
 * Absolute published note path for a note id, resolving a basename to its
 * `published/` relPath when the argument is not already a relative path. Shared
 * by the Phase D command layer and tests so the lock key and the file path agree.
 * @param memoryDir - resolved memory root.
 * @param noteId - relative published path or basename.
 * @returns the absolute published note path.
 */
export declare function resolvePublishedAbs(memoryDir: string, noteId: string): string;
/**
 * Relative `published/` path for an absolute or relative note path. Inverse of
 * {@link resolvePublishedAbs}'s relative form; used to compute the lock key and
 * the `archived/` target from a resolved absolute path.
 * @param memoryDir - resolved memory root.
 * @param absPath - absolute note path.
 * @returns the relative `published/<kind>/<slug>.md` path.
 */
export declare function toPublishedRel(memoryDir: string, absPath: string): string;
/** Re-export `relative` for callers needing path-relative math. */
export { relative };
//# sourceMappingURL=storage.d.ts.map