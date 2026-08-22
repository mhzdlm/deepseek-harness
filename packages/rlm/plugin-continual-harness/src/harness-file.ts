/**
 * Harness state file access, 1:1 aligned with the vendored `harness.py` JSON
 * layout so the TS host and the kernel runtime share the same file safely
 * (single writer at a time; atomic rename).
 *
 * The kernel plugin places the state at
 * `<ctx.baseDir>/session-artifacts/<sessionId>/harness/harness_state.json`
 * (it sets `RLM_HARNESS_STATE_DIR` for the kernel env). This module owns the
 * read/render path and the reverse-snapshot/rollback used by /refine.
 * @module @deepseek-ai/dsh-plugin-continual-harness
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import path from 'node:path'

export type HarnessKind = 'prompt' | 'memory' | 'skill' | 'subagent'
export type HarnessScope = 'local' | 'global'

export interface HarnessEntry {
	id: string
	kind: HarnessKind
	title: string
	content: string
	path: string
	scope: HarnessScope
	reference: Record<string, unknown>
	arguments: Record<string, unknown>
	metadata: Record<string, unknown>
	source: string
	created_at: string
	updated_at: string
	version: number
}

export interface RefinementEvent {
	id: string
	trigger: string
	changes: string[]
	evidence: string
	outcome: string
	snapshot?: { path: string } | null
}

export interface HarnessStateFile {
	schema: number
	entries: Partial<Record<HarnessKind, Record<string, HarnessEntry>>>
	refinements: RefinementEvent[]
}

export function harnessStatePath(baseDir: string, sessionId: string): string {
	return path.join(baseDir, 'session-artifacts', sessionId, 'harness', 'harness_state.json')
}

export async function readHarnessState(filePath: string): Promise<HarnessStateFile> {
	try {
		const raw = await readFile(filePath, 'utf8')
		const data: unknown = JSON.parse(raw)
		if (!isRecord(data)) return emptyHarnessState()
		return {
			schema: typeof data.schema === 'number' ? data.schema : 1,
			entries: isRecord(data.entries) ? data.entries : {},
			refinements: Array.isArray(data.refinements) ? data.refinements : [],
		}
	} catch {
		// Missing or corrupt state is treated as empty, matching harness.py.load().
		return emptyHarnessState()
	}
}

export async function writeHarnessState(filePath: string, state: HarnessStateFile): Promise<void> {
	await mkdir(path.dirname(filePath), { recursive: true })
	const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`
	await writeFile(tmp, JSON.stringify(state, null, 2), 'utf8')
	await rename(tmp, filePath)
}

/**
 * Synchronous read for system-prompt sections (their `text` provider is sync).
 */
export function readHarnessStateSync(filePath: string): HarnessStateFile {
	try {
		const data: unknown = JSON.parse(readFileSync(filePath, 'utf8'))
		if (!isRecord(data)) return emptyHarnessState()
		return {
			schema: typeof data.schema === 'number' ? data.schema : 1,
			entries: isRecord(data.entries) ? data.entries : {},
			refinements: Array.isArray(data.refinements) ? data.refinements : [],
		}
	} catch {
		return emptyHarnessState()
	}
}

function emptyHarnessState(): HarnessStateFile {
	return { schema: 1, entries: {}, refinements: [] }
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}
