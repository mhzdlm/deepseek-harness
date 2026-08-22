/**
 * Unit tests for plugin-continual-harness (no host / no LLM required):
 *  - harness-file.ts read/write roundtrip, empty-state, atomic write
 *  - refine.ts applyProposals reverse-snapshot for upsert-new / upsert-update /
 *    delete-existing / delete-missing
 *  - rollbackRefine roundtrip for all three reversible shapes
 *
 * Run: node <repo>/node_modules/.pnpm/tsx@4.x/node_modules/tsx/dist/cli.mjs refine-test.mts
 */
import { mkdtempSync, existsSync, readdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { harnessStatePath, readHarnessState, writeHarnessState, type HarnessEntry, type HarnessKind, type HarnessStateFile } from './src/harness-file.ts'
import { applyProposals, rollbackRefine } from './src/refine.ts'

let failures = 0
function check(name: string, ok: boolean, detail = '') {
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
	if (!ok) failures++
}

function makeEntry(kind: HarnessKind, id: string, title: string, content = 'c'): HarnessEntry {
	return {
		id, kind, title, content,
		path: 'general', scope: 'local',
		reference: {}, arguments: {}, metadata: {},
		source: 'agent', created_at: '2026-08-22T00:00:00Z', updated_at: '2026-08-22T00:00:00Z', version: 1,
	}
}

const baseDir = mkdtempSync(path.join(os.tmpdir(), 'dsh-rlm-refine-test-'))
const sessionId = 'test-session'
const statePath = harnessStatePath(baseDir, sessionId)
let eventCounter = 0

async function applyAndPersist(
	state: HarnessStateFile,
	proposals: Parameters<typeof applyProposals>[1],
): Promise<{ changes: string[]; snapshotPath: string | null; eventId: string }> {
	const snapshotDir = path.join(path.dirname(statePath), 'refinements')
	const { changes, snapshotPath } = await applyProposals(state, proposals, snapshotDir)
	const eventId = `evt-${++eventCounter}`
	if (changes.length > 0) {
		state.refinements ??= []
		state.refinements.push({
			id: eventId, trigger: '/refine', changes, evidence: '', outcome: 'applied',
			snapshot: snapshotPath ? { path: snapshotPath } : null,
		})
		await writeHarnessState(statePath, state)
	}
	return { changes, snapshotPath, eventId }
}

console.log('== harness-file.ts ==')
{
	const empty = await readHarnessState(path.join(baseDir, 'does-not-exist.json'))
	check('read missing → empty state', empty.schema === 1 && Object.keys(empty.entries).length === 0 && empty.refinements.length === 0)

	const state: HarnessStateFile = { schema: 1, entries: { memory: { 'm1': makeEntry('memory', 'm1', 't1') } }, refinements: [] }
	await writeHarnessState(statePath, state)
	const back = await readHarnessState(statePath)
	check('write → read roundtrip', back.entries.memory?.['m1']?.title === 't1')

	const tmpFiles = readdirSync(path.dirname(statePath)).filter((f) => f.endsWith('.tmp'))
	check('atomic write leaves no .tmp', tmpFiles.length === 0, tmpFiles.join(','))
}

console.log('== applyProposals ==')
{
	// upsert-new: snapshot keys a null tombstone on the real id
	const s1: HarnessStateFile = { schema: 1, entries: {}, refinements: [] }
	const r1 = await applyProposals(s1, [{ kind: 'memory', action: 'upsert', title: 'new', content: 'x' }], path.join(path.dirname(statePath), 'refinements'))
	const newId = Object.keys(s1.entries.memory ?? {})[0]!
	check('upsert-new creates entry', s1.entries.memory?.[newId]?.title === 'new')
	check('upsert-new snapshot tombstones real id', r1.snapshotPath !== null && existsSync(r1.snapshotPath), r1.snapshotPath ?? '')
	const snap1 = JSON.parse(await import('node:fs/promises').then((m) => m.readFile(r1.snapshotPath!, 'utf8')))
	check('snapshot key is the real id (rollback-removable)', snap1[`memory:${newId}`] === null, JSON.stringify(Object.keys(snap1)))

	// upsert-update: snapshot preserves the prior value
	const s2: HarnessStateFile = { schema: 1, entries: { memory: { 'm1': makeEntry('memory', 'm1', 'old') } }, refinements: [] }
	await applyProposals(s2, [{ kind: 'memory', action: 'upsert', id: 'm1', title: 'new-title', content: 'y' }], path.join(path.dirname(statePath), 'refinements'))
	check('upsert-update mutates title', s2.entries.memory?.['m1']?.title === 'new-title')

	// delete-existing snapshots the prior value; delete-missing is a no-op
	const s3: HarnessStateFile = { schema: 1, entries: { memory: { 'm2': makeEntry('memory', 'm2', 'gone') } }, refinements: [] }
	const r3 = await applyProposals(s3, [
		{ kind: 'memory', action: 'delete', id: 'm2', title: 'gone', content: '' },
		{ kind: 'memory', action: 'delete', id: 'nope', title: 'missing', content: '' },
	], path.join(path.dirname(statePath), 'refinements'))
	check('delete-existing removes entry', s3.entries.memory?.['m2'] === undefined)
	check('delete-missing produces no change', r3.changes.length === 1, r3.changes.join('|'))
}

console.log('== rollbackRefine roundtrip ==')
{
	// rollback of an upsert-new: entry disappears
	const s1: HarnessStateFile = { schema: 1, entries: {}, refinements: [] }
	const p1 = await applyAndPersist(s1, [{ kind: 'memory', action: 'upsert', title: 'new', content: 'x' }])
	const after1 = await readHarnessState(statePath)
	const createdId = Object.keys(after1.entries.memory ?? {})[0]!
	check('persisted new entry present before rollback', after1.entries.memory?.[createdId] !== undefined)
	await rollbackRefine(baseDir, sessionId, p1.eventId)
	const rolled1 = await readHarnessState(statePath)
	check('rollback removes the fresh entry', (rolled1.entries.memory?.[createdId] ?? undefined) === undefined, createdId)

	// rollback of an upsert-update: title restored
	const s2: HarnessStateFile = { schema: 1, entries: { memory: { 'm1': makeEntry('memory', 'm1', 'old') } }, refinements: [] }
	const p2 = await applyAndPersist(s2, [{ kind: 'memory', action: 'upsert', id: 'm1', title: 'new-title', content: 'y' }])
	await rollbackRefine(baseDir, sessionId, p2.eventId)
	const rolled2 = await readHarnessState(statePath)
	check('rollback restores updated title', rolled2.entries.memory?.['m1']?.title === 'old', rolled2.entries.memory?.['m1']?.title)

	// rollback of a delete: entry restored
	const s3: HarnessStateFile = { schema: 1, entries: { memory: { 'm2': makeEntry('memory', 'm2', 'gone') } }, refinements: [] }
	const p3 = await applyAndPersist(s3, [{ kind: 'memory', action: 'delete', id: 'm2', title: 'gone', content: '' }])
	await rollbackRefine(baseDir, sessionId, p3.eventId)
	const rolled3 = await readHarnessState(statePath)
	check('rollback restores deleted entry', rolled3.entries.memory?.['m2']?.title === 'gone', rolled3.entries.memory?.['m2']?.title)
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
