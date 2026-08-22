/**
 * Render the harness state into a system-prompt section, aligned with the
 * vendored `harness.py` `overview()`. Budget-truncated per kind (newest
 * first) so a large harness cannot blow the prompt.
 * @module @deepseek-ai/dsh-plugin-continual-harness
 */

import type { HarnessKind, HarnessStateFile } from './harness-file.ts'

const KIND_HEADINGS: Record<HarnessKind, string> = {
	prompt: '## Persistent instructions',
	memory: '## Memories',
	skill: '## Skills',
	subagent: '## Subagents',
}

export interface HarnessOverviewOptions {
	maxEntriesPerKind?: number
}

export function renderHarnessOverview(
	state: HarnessStateFile,
	options: HarnessOverviewOptions = {},
): string {
	const max = options.maxEntriesPerKind ?? 20
	const lines: string[] = []

	for (const kind of ['prompt', 'memory', 'skill', 'subagent'] as const) {
		const entries = state.entries[kind]
		if (!entries) continue
		const sorted = Object.values(entries).sort((a, b) =>
			String(b.updated_at ?? b.created_at).localeCompare(String(a.updated_at ?? a.created_at)),
		)
		if (sorted.length === 0) continue

		lines.push(KIND_HEADINGS[kind])
		const shown = sorted.slice(0, max)
		for (const entry of shown) {
			const scoped = entry.scope === 'global' ? ' [global]' : ''
			lines.push(`- ${entry.title}${scoped}: ${entry.content}`)
		}
		if (sorted.length > shown.length) {
			lines.push(`- … ${sorted.length - shown.length} more entries omitted`)
		}
	}

	return lines.join('\n')
}
