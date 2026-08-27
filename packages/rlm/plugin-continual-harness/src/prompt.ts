/**
 * Render the harness state into a system-prompt section, aligned with the
 * vendored `harness.py` `overview()`. Budget-truncated per kind (newest
 * first) so a large harness cannot blow the prompt.
 *
 * FIX-10: budgets are enforced at two levels — per-entry content length and a
 * total character ceiling for the whole section — so a single oversized entry
 * cannot inflate every assembled prompt (the old cap counted entries only).
 * FIX-2: every rendered line carries a short id prefix so the agent (and the
 * /refine proposal prompt) can reference entries for update/delete.
 * @module @deepseek-ai/dsh-plugin-continual-harness
 */

import type { HarnessKind, HarnessStateFile } from './harness-file.ts'

const KIND_HEADINGS: Record<HarnessKind, string> = {
  prompt: '## Persistent instructions',
  memory: '## Memories',
  skill: '## Skills',
  subagent: '## Subagents',
}

/**
 * Options controlling how {@link renderHarnessOverview} truncates and budgets
 * the rendered harness state section.
 */
export interface HarnessOverviewOptions {
  /** Per-kind cap on the number of entries shown. */
  maxEntriesPerKind?: number
  /** Per-entry cap on rendered `content` length (title stays intact). */
  maxCharsPerEntry?: number
  /** Hard ceiling for the whole rendered section. */
  maxTotalChars?: number
}

/**
 * Render the harness state into a system-prompt section, budget-truncated per
 * kind (newest first) so a large harness cannot blow the prompt.
 *
 * @param state - The harness state file whose entries are rendered.
 * @param options - Truncation and character-budget controls.
 * @returns The assembled, budget-truncated overview string.
 */
export function renderHarnessOverview(
  state: HarnessStateFile,
  options: HarnessOverviewOptions = {},
): string {
  const max = options.maxEntriesPerKind ?? 20
  const maxCharsPerEntry = options.maxCharsPerEntry ?? 1_000
  const maxTotalChars = options.maxTotalChars ?? 16_000
  const lines: string[] = []
  let totalChars = 0

  outer:
  for (const kind of ['prompt', 'memory', 'skill', 'subagent'] as const) {
    const entries = state.entries[kind]
    if (!entries) continue
    const sorted = Object.values(entries).sort((a, b) =>
      String(b.updated_at ?? b.created_at).localeCompare(String(a.updated_at ?? a.created_at)),
    )
    if (sorted.length === 0) continue

    const heading = KIND_HEADINGS[kind]
    totalChars += heading.length + 1
    if (totalChars > maxTotalChars) break
    lines.push(heading)

    const shown = sorted.slice(0, max)
    for (const entry of shown) {
      const scoped = entry.scope === 'global' ? ' [global]' : ''
      // FIX-10: truncate content per entry so one huge memory can't blow
      // the prompt; the title and id prefix always stay visible.
      const content = entry.content.length > maxCharsPerEntry
        ? entry.content.slice(0, maxCharsPerEntry) + '…'
        : entry.content
      // FIX-2: expose a short id prefix so the agent (and the /refine
      // proposal prompt) can reference entries for update/delete.
      const line = `- [${entry.id.slice(0, 8)}] ${entry.title}${scoped}: ${content}`
      if (totalChars + line.length > maxTotalChars) {
        lines.push('- … remaining entries omitted (char budget)')
        break outer
      }
      lines.push(line)
      totalChars += line.length + 1
    }
    if (sorted.length > shown.length) {
      lines.push(`- … ${sorted.length - shown.length} more entries omitted`)
      totalChars += 24
    }
  }

  return lines.join('\n')
}
