/**
 * Harness state file access, 1:1 aligned with the vendored `harness.py` JSON
 * layout so the TS host and the kernel runtime share the same file safely
 * (single writer at a time; atomic rename).
 *
 * The kernel plugin places the state at
 * `<ctx.baseDir>/session-artifacts/<sessionId>/harness/harness_state.json`
 * (it sets `RLM_HARNESS_STATE_DIR` for the kernel env) and global-scope state
 * at `<ctx.baseDir>/global/harness/harness_state.json` (`RLM_GLOBAL_HARNESS_STATE_DIR`).
 * This module owns the read/render path and the reverse-snapshot/rollback used by /refine,
 * including merging the two files into one working view.
 *
 * FIX-7: writers can pass the mtime observed at read time; writeHarnessState
 * re-stats before renaming and throws {@link HarnessConflictError} when the
 * file moved underneath us — mirroring the vendored `harness.py`
 * `_sync_from_disk()` guard on the host side.
 *
 * FIX-11: a corrupt (unparseable) state file is backed up as
 * `harness_state.json.corrupt-<ts>` before being treated as empty, so a
 * salvageable file is never silently overwritten to zero.
 * @module @deepseek-ai/dsh-plugin-continual-harness
 */
/**
 * Error thrown when a harness state CAS write detects that the on-disk file
 * moved underneath a read-modify-write (FIX-7). Surfaces retryable conflicts
 * to callers that can re-read and retry.
 */
export declare class HarnessConflictError extends Error {
    constructor(filePath: string);
}
/** The categories of content a harness state entry can hold. */
export type HarnessKind = 'prompt' | 'memory' | 'skill' | 'subagent';
/** Whether a harness entry belongs to a single session or to every session. */
export type HarnessScope = 'local' | 'global';
/** One persisted harness item (prompt, memory, skill, or subagent) in state. */
export interface HarnessEntry {
    id: string;
    kind: HarnessKind;
    title: string;
    content: string;
    path: string;
    scope: HarnessScope;
    reference: Record<string, unknown>;
    arguments: Record<string, unknown>;
    metadata: Record<string, unknown>;
    source: string;
    created_at: string;
    updated_at: string;
    version: number;
}
/** A single /refine edit event plus the post-apply snapshot used for rollback. */
export interface RefinementEvent {
    id: string;
    trigger: string;
    changes: string[];
    evidence: string;
    outcome: string;
    snapshot?: {
        path: string;
    } | null;
    /**
       * FIX-5: state of every touched key immediately after this event applied
       * (null = deleted). rollbackRefine compares the live value against this
       * before overwriting, so a rollback cannot silently clobber newer edits.
       */
    after?: Record<string, HarnessEntry | null> | null;
}
/** The full persisted harness state: schema version, entries, and refinements. */
export interface HarnessStateFile {
    schema: number;
    entries: Partial<Record<HarnessKind, Record<string, HarnessEntry>>>;
    refinements: RefinementEvent[];
}
/** State plus the on-disk mtime observed at read, for CAS writes (FIX-7). */
export interface HarnessStateWithMeta {
    state: HarnessStateFile;
    /** `null` when the file did not exist. */
    mtimeMs: number | null;
}
/**
 * Resolve the per-session harness state file path.
 * @param baseDir - the harness base directory (`ctx.baseDir`).
 * @param sessionId - the session whose artifacts directory to target.
 * @returns the absolute path to that session's `harness_state.json`.
 */
export declare function harnessStatePath(baseDir: string, sessionId: string): string;
/**
 * Cross-session global harness state file. The kernel writes `global_=True`
 * entries here via `RLM_GLOBAL_HARNESS_STATE_DIR` (see the kernel plugin);
 * this is the one file that makes the harness "continual" across sessions.
 * @param baseDir - the harness base directory (`ctx.baseDir`).
 * @returns the absolute path to the global `harness_state.json`.
 */
export declare function globalHarnessStatePath(baseDir: string): string;
/**
 * Read state plus observed mtime; missing or corrupt files yield empty state.
 * @param filePath - the state file to read.
 * @returns the parsed state plus the on-disk mtime observed at read (`null` if absent).
 */
export declare function readHarnessStateDetailed(filePath: string): Promise<HarnessStateWithMeta>;
/**
 * Read a harness state file, returning its parsed state (no mtime metadata).
 * @param filePath - the state file to read.
 * @returns the parsed {@link HarnessStateFile}, or an empty state if missing/corrupt.
 */
export declare function readHarnessState(filePath: string): Promise<HarnessStateFile>;
/**
 * FIX-7: CAS write. When `expectedMtimeMs` is provided, re-stats the file
 * immediately before renaming and throws {@link HarnessConflictError} if it
 * moved — so `/refine` cannot clobber a kernel-side write that landed between
 * its read and its write.
 *
 * On Windows a concurrent writer holding the destination turns the finalizing
 * rename into EPERM/EBUSY instead of a clean replace. That is observably the
 * same event as an mtime conflict — the file changed underneath this writer —
 * so it is surfaced as the retryable {@link HarnessConflictError} (with the
 * temp file cleaned up) rather than as a raw fs error callers cannot retry on.
 * @param filePath - the state file to write.
 * @param state - the harness state to serialize.
 * @param expectedMtimeMs - when provided, the mtime observed at read for CAS; `null` matches an absent file.
 * @returns void; rejects with {@link HarnessConflictError} on a stale mtime or Windows sharing violation.
 */
export declare function writeHarnessState(filePath: string, state: HarnessStateFile, expectedMtimeMs?: number | null): Promise<void>;
/** Both harness state files with the mtime observed at read (for CAS writes). */
export interface HarnessStatesWithMeta {
    global: HarnessStateWithMeta;
    local: HarnessStateWithMeta;
}
/**
 * Read global + per-session state in parallel, each with its observed mtime.
 * @param baseDir - the harness base directory (`ctx.baseDir`).
 * @param sessionId - the session whose local artifacts directory to target.
 * @returns both files' parsed states, each with the mtime observed at read.
 */
export declare function readHarnessStatesDetailed(baseDir: string, sessionId: string): Promise<HarnessStatesWithMeta>;
/**
 * CAS-write both files; a stale mtime on either throws {@link HarnessConflictError}.
 *
 * P1-fix: global-write failure rolls back the local write (restores the previous
 * local state) so the two files stay consistent — otherwise the next system-prompt
 * render sees a local-new + global-old torn view. The pre-write snapshot is taken
 * BEFORE the local half lands, and the compensating write CASes against the mtime
 * that write produced, so the restore actually applies instead of conflicting
 * with itself.
 * @param baseDir - the harness base directory (`ctx.baseDir`).
 * @param sessionId - the session whose local artifacts directory to target.
 * @param global - the global state file to write.
 * @param local - the per-session state file to write.
 * @param expected - the mtimes observed at read for CAS; `null` matches an absent file.
 * @returns void; rejects with {@link HarnessConflictError} on a stale mtime or torn write.
 */
export declare function writeHarnessStates(baseDir: string, sessionId: string, global: HarnessStateFile, local: HarnessStateFile, expected: {
    global: number | null;
    local: number | null;
}): Promise<void>;
/** The four content categories a harness state entry can hold, in render order. */
export declare const HARNESS_KINDS: readonly ["prompt", "memory", "skill", "subagent"];
/**
 * Merge global + local into one working view for rendering and /refine.
 * Entries carry their own `scope` field, so renderers can distinguish
 * `[global]`-marked lines; refinements come from the session (local) file.
 * @param global - the global state file.
 * @param local - the per-session state file.
 * @returns the merged working view with local refinements preserved.
 */
export declare function mergeHarnessStates(global: HarnessStateFile, local: HarnessStateFile): HarnessStateFile;
/**
 * Split a merged working state back into global/local files by each entry's
 * `scope` field. `globalRefinements` is preserved from the pre-merge global
 * read so kernel-side global ops' events are never dropped on rewrite.
 * @param merged - the merged working state to split by entry `scope`.
 * @param globalRefinements - refinements to carry into the global file (preserved from its pre-merge read).
 * @returns the separated global and local state files.
 */
export declare function splitHarnessStateByScope(merged: HarnessStateFile, globalRefinements: RefinementEvent[]): {
    global: HarnessStateFile;
    local: HarnessStateFile;
};
/**
 * Synchronous read for system-prompt sections (their `text` provider is sync).
 * @param filePath - the state file to read.
 * @returns the parsed {@link HarnessStateFile}, or an empty state if missing/corrupt.
 */
export declare function readHarnessStateSync(filePath: string): HarnessStateFile;
//# sourceMappingURL=harness-file.d.ts.map