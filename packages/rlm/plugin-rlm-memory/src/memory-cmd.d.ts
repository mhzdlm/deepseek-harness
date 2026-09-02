/**
 * `/memory` command handlers: `list | show | delete | consolidate | rollback | retire | archived | unretire`. Pure
 * functions over the file store so the Cordis command registration in index.ts stays a
 * thin switch (mirrors plugin-rlm-moa/moa-cmd.ts). `delete` operates on drafts only;
 * published notes go through the Phase C promotion/rollback gate (REME.md §5.1,
 * §10 Phase A acceptance: `delete` is drafts-only). `consolidate` runs the publish gate
 * + growth budget + reverse-snapshot promotion (REME.md §5.3); `rollback <noteId>`
 * restores the latest snapshot over a published note, honoring the override-warning
 * discipline (REME.md §5.3 D11). Phase D: `retire <noteId> [force]` moves a published
 * note to `archived/` under `exitMode` (off|observe|enforce); `archived` lists retired
 * notes; `unretire <noteId>` restores one (REME.md §5.4 D12).
 *
 * @module @deepseek-ai/dsh-plugin-rlm-memory/memory-cmd
 */
import { readNote } from './storage.ts';
import { consolidate, type ConsolidateOptions } from './consolidate.ts';
import { type RetireOptions } from './retire.ts';
/**
 * `/memory list`: every draft note with its kind, title (from body/source), and
 * the evidence `source` reference.
 * @param memoryDir - resolved memory root.
 * @returns a newline-joined text listing, or a notice when no drafts exist.
 */
export declare function listMemoryText(memoryDir: string): string;
/**
 * `/memory show <name>`: full frontmatter + body for one draft note.
 * @param memoryDir - resolved memory root.
 * @param name - the draft note filename (basename) or absolute/relative path.
 * @returns the formatted note text, or an error message when not found.
 */
export declare function showMemoryText(memoryDir: string, name: string): string;
/**
 * `/memory delete <name>`: remove one draft note. Throws when the resolved path
 * is not a draft (published notes are not deletable in Phase A).
 * @param memoryDir - resolved memory root.
 * @param name - the draft note filename (basename) or absolute/relative path.
 * @returns a confirmation or an error message.
 */
export declare function deleteMemoryText(memoryDir: string, name: string): string;
/**
 * `/memory consolidate`: run the publish gate + growth budget + reverse-snapshot
 * promotion over every draft (REME.md §5.3). Returns a human-readable audit summary; the
 * numeric result is the {@link consolidate} report.
 * @param memoryDir - resolved memory root.
 * @param options - resolved gate + budget options (from plugin Config).
 * @returns the consolidation summary text, plus the structured report for callers.
 */
export declare function consolidateText(memoryDir: string, options: ConsolidateOptions): Promise<{
    text: string;
    result: Awaited<ReturnType<typeof consolidate>>;
}>;
/**
 * `/memory rollback <noteId>`: restore the latest snapshot over a published note
 * (REME.md §5.3 D11). `noteId` is the relative published path (or basename). With the
 * `force` flag, overrides a user-edited note (override-warning); without it, a note
 * edited after the last snapshot is not overwritten.
 * @param memoryDir - resolved memory root.
 * @param noteId - the published note id (relative path or basename).
 * @param force - when true, restore even over a user edit.
 * @returns a human-readable outcome text.
 */
export declare function rollbackText(memoryDir: string, noteId: string, force: boolean): Promise<string>;
/**
 * `/memory retire <noteId> [force]`: retire one published note (REME.md §5.4). Under
 * `exitMode: off` this is a logged no-op; under `observe` it logs intent but does not move
 * the note; under `enforce` it moves the note `published/` → `archived/` (reversible). The
 * `force` flag bypasses the age/use threshold for an explicit user retire (enforce only).
 * @param memoryDir - resolved memory root.
 * @param noteId - the published note id (relative path or basename).
 * @param force - when true, bypass the aging threshold.
 * @param options - resolved exitMode + aging thresholds.
 * @returns a human-readable outcome (the note stays put unless `enforce` + candidate).
 */
export declare function retireText(memoryDir: string, noteId: string, force: boolean, options: RetireOptions): Promise<string>;
/**
 * `/memory archived`: list every archived note (REME.md §5.4 D12). The `archive/` dir is
 * read directly; an empty archive reports a notice (no notes retired yet).
 * @param memoryDir - resolved memory root.
 * @returns a newline-joined listing of `archived/<kind>/<slug>.md` paths, or a notice.
 */
export declare function archivedText(memoryDir: string): string;
/**
 * `/memory unretire <noteId>`: move an archived note back to `published/` (REME.md §5.4
 * D12, "retirement is reversible"). The note id is the SAME relPath it had under
 * `published/`; a basename is resolved against `archived/`.
 *
 * Phase 8 (review round 6): the id resolves against the ARCHIVED tree. The old
 * code ran the published-tree resolver here, so every hand-fed id — bare
 * basename, `basename.md`, or the absolute path `/memory archived` prints —
 * failed to resolve and the command always answered "not found". Accepted
 * forms: `archived/<kind>/<slug>.md`, `<kind>/<slug>.md`, `<slug>`,
 * `<slug>.md`, or an absolute path inside `memoryDir/archived/`.
 * @param memoryDir - resolved memory root.
 * @param noteId - the archived note id (relative path, basename, or absolute archived path).
 * @returns a human-readable outcome (restored, or a not-found notice).
 */
export declare function unretireText(memoryDir: string, noteId: string): Promise<string>;
/** Re-export so the command layer and tests share the read helper. */
export { readNote };
//# sourceMappingURL=memory-cmd.d.ts.map