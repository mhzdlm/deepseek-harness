/**
 * Render the harness state into a system-prompt section. Budget-truncated per
 * kind (newest first) so a large harness cannot blow the prompt. The defaults
 * mirror prime-agent's injected-overview hints-only philosophy
 * (`DEFAULT_OVERVIEW_ENTRY_LIMIT=6` / `CONTENT_LIMIT=180`): surface only
 * routing hints, forcing the model to read the underlying entry on demand
 * (`/harness show <id>`) rather than dumping the whole harness into context.
 *
 * FIX-10: budgets are enforced at two levels — per-entry content length and a
 * total character ceiling for the whole section — so a single oversized entry
 * cannot inflate every assembled prompt (the old cap counted entries only).
 * FIX-2: every rendered line carries a short id prefix so the agent (and the
 * /refine proposal prompt) can reference entries for update/delete.
 * @module @deepseek-ai/dsh-plugin-continual-harness
 */
import type { HarnessStateFile } from './harness-file.ts';
/**
 * Options controlling how {@link renderHarnessOverview} truncates and budgets
 * the rendered harness state section.
 */
export interface HarnessOverviewOptions {
    /** Per-kind cap on the number of entries shown. */
    maxEntriesPerKind?: number;
    /** Per-entry cap on rendered `content` length (title stays intact). */
    maxCharsPerEntry?: number;
    /** Hard ceiling for the whole rendered section. */
    maxTotalChars?: number;
}
/**
 * Render the harness state into a system-prompt section, budget-truncated per
 * kind (newest first) so a large harness cannot blow the prompt.
 *
 * @param state - The harness state file whose entries are rendered.
 * @param options - Truncation and character-budget controls.
 * @returns The assembled, budget-truncated overview string.
 */
export declare function renderHarnessOverview(state: HarnessStateFile, options?: HarnessOverviewOptions): string;
//# sourceMappingURL=prompt.d.ts.map