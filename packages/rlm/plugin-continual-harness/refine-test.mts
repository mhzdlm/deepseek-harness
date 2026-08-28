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
import { mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
	globalHarnessStatePath,
	harnessStatePath,
	HarnessConflictError,
	mergeHarnessStates,
	readHarnessState,
	readHarnessStateDetailed,
	readHarnessStateSync,
	splitHarnessStateByScope,
	writeHarnessState,
	writeHarnessStates,
	type HarnessEntry,
	type HarnessKind,
	type HarnessStateFile,
} from './src/harness-file.ts'
import { applyProposals, applyProposalsAndPersist, extractProposals, pruneRefinements, rollbackRefine, validateProposals } from './src/refine.ts'
import { deleteHarnessEntry, listHarness, showHarnessEntry } from './src/harness-cmd.ts'
import { createHarnessOverviewCache } from './src/prompt-cache.ts'
import { renderHarnessOverview } from './src/prompt.ts'

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
	const { changes, snapshotPath, after } = await applyProposals(state, proposals, snapshotDir)
	const eventId = `evt-${++eventCounter}`
	if (changes.length > 0) {
		state.refinements ??= []
		state.refinements.push({
			id: eventId, trigger: '/refine', changes, evidence: '', outcome: 'applied',
			snapshot: snapshotPath ? { path: snapshotPath } : null,
			after, // mirror runRefine so rollback's version check has an after-image
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
	const r1 = await applyProposals(s1, [{ kind: 'memory', action: 'upsert', title: 'new', content: 'x', evidence: 'turn 3 says X' }], path.join(path.dirname(statePath), 'refinements'))
	const newId = Object.keys(s1.entries.memory ?? {})[0]!
	check('upsert-new creates entry', s1.entries.memory?.[newId]?.title === 'new')
	check('upsert-new snapshot tombstones real id', r1.snapshotPath !== null && existsSync(r1.snapshotPath), r1.snapshotPath ?? '')
	const snap1 = JSON.parse(await import('node:fs/promises').then((m) => m.readFile(r1.snapshotPath!, 'utf8')))
	check('snapshot key is scope:kind:real-id (rollback-removable)', snap1[`local:memory:${newId}`] === null, JSON.stringify(Object.keys(snap1)))

	// upsert-global: snapshot keys the global scope and the entry carries scope:'global'
	const s1g: HarnessStateFile = { schema: 1, entries: {}, refinements: [] }
	const r1g = await applyProposals(s1g, [{ kind: 'memory', action: 'upsert', scope: 'global', title: 'g-new', content: 'x', evidence: 'turn 3 says G' }], path.join(path.dirname(statePath), 'refinements'))
	const gId = Object.keys(s1g.entries.memory ?? {})[0]!
	check('upsert-global creates entry with scope global', s1g.entries.memory?.[gId]?.scope === 'global')
	const snapG = JSON.parse(await import('node:fs/promises').then((m) => m.readFile(r1g.snapshotPath!, 'utf8')))
	check('upsert-global snapshot keys global scope', snapG[`global:memory:${gId}`] === null, JSON.stringify(Object.keys(snapG)))

	// upsert-update: snapshot preserves the prior value
	const s2: HarnessStateFile = { schema: 1, entries: { memory: { 'm1': makeEntry('memory', 'm1', 'old') } }, refinements: [] }
	await applyProposals(s2, [{ kind: 'memory', action: 'upsert', id: 'm1', title: 'new-title', content: 'y', evidence: 'turn 4 says Y' }], path.join(path.dirname(statePath), 'refinements'))
	check('upsert-update mutates title', s2.entries.memory?.['m1']?.title === 'new-title')

	// delete-existing snapshots the prior value; delete-missing is a no-op
	const s3: HarnessStateFile = { schema: 1, entries: { memory: { 'm2': makeEntry('memory', 'm2', 'gone') } }, refinements: [] }
	const r3 = await applyProposals(s3, [
		{ kind: 'memory', action: 'delete', id: 'm2', title: 'gone', content: '', evidence: 'turn 5 says G' },
		{ kind: 'memory', action: 'delete', id: 'nope', title: 'missing', content: '', evidence: 'turn 5 says M' },
	], path.join(path.dirname(statePath), 'refinements'))
	check('delete-existing removes entry', s3.entries.memory?.['m2'] === undefined)
	check('delete-missing produces no change', r3.changes.length === 1, r3.changes.join('|'))
}

console.log('== rollbackRefine roundtrip ==')
{
	// rollback of an upsert-new: entry disappears
	const s1: HarnessStateFile = { schema: 1, entries: {}, refinements: [] }
	const p1 = await applyAndPersist(s1, [{ kind: 'memory', action: 'upsert', title: 'new', content: 'x', evidence: 'turn 3 says X' }])
	const after1 = await readHarnessState(statePath)
	const createdId = Object.keys(after1.entries.memory ?? {})[0]!
	check('persisted new entry present before rollback', after1.entries.memory?.[createdId] !== undefined)
	await rollbackRefine(baseDir, sessionId, p1.eventId)
	const rolled1 = await readHarnessState(statePath)
	check('rollback removes the fresh entry', (rolled1.entries.memory?.[createdId] ?? undefined) === undefined, createdId)

	// rollback of an upsert-update: title restored
	const s2: HarnessStateFile = { schema: 1, entries: { memory: { 'm1': makeEntry('memory', 'm1', 'old') } }, refinements: [] }
	const p2 = await applyAndPersist(s2, [{ kind: 'memory', action: 'upsert', id: 'm1', title: 'new-title', content: 'y', evidence: 'turn 4 says Y' }])
	await rollbackRefine(baseDir, sessionId, p2.eventId)
	const rolled2 = await readHarnessState(statePath)
	check('rollback restores updated title', rolled2.entries.memory?.['m1']?.title === 'old', rolled2.entries.memory?.['m1']?.title)

	// rollback of a delete: entry restored
	const s3: HarnessStateFile = { schema: 1, entries: { memory: { 'm2': makeEntry('memory', 'm2', 'gone') } }, refinements: [] }
	const p3 = await applyAndPersist(s3, [{ kind: 'memory', action: 'delete', id: 'm2', title: 'gone', content: '', evidence: 'turn 5 says G' }])
	await rollbackRefine(baseDir, sessionId, p3.eventId)
	const rolled3 = await readHarnessState(statePath)
	check('rollback restores deleted entry', rolled3.entries.memory?.['m2']?.title === 'gone', rolled3.entries.memory?.['m2']?.title)
}

console.log('== global scope merge/split + rollback (P0-fix) ==')
{
	// merge: global entries (scope:'global') and local entries both surface;
	// split routes each entry back by its scope field.
	const gEntry = { ...makeEntry('memory', 'gm1', 'g-title'), scope: 'global' as const }
	const lEntry = makeEntry('memory', 'lm1', 'l-title')
	const globalState: HarnessStateFile = { schema: 1, entries: { memory: { gm1: gEntry } }, refinements: [{ id: 'g-evt', trigger: '/refine', changes: ['upsert global:memory:g-title'], evidence: '', outcome: 'applied' }] }
	const localState: HarnessStateFile = { schema: 1, entries: { memory: { lm1: lEntry } }, refinements: [] }
	const merged = mergeHarnessStates(globalState, localState)
	check('merge includes global entry', merged.entries.memory?.['gm1']?.title === 'g-title')
	check('merge includes local entry', merged.entries.memory?.['lm1']?.title === 'l-title')
	const split = splitHarnessStateByScope(merged, globalState.refinements)
	check('split keeps global entry in global store', split.global.entries.memory?.['gm1'] !== undefined)
	check('split keeps local entry in local store', split.local.entries.memory?.['lm1'] !== undefined)
	check('split preserves global refinements', split.global.refinements.length === 1)

	// rollback of a global-scope refine restores the global file
	await writeHarnessState(globalHarnessStatePath(baseDir), {
		schema: 1,
		entries: { memory: { gm1: { ...gEntry, title: 'g-new', version: 2 } } },
		refinements: [],
	})
	const snapDir = path.join(path.dirname(statePath), 'refinements')
	await mkdir(snapDir, { recursive: true })
	const snapPath = path.join(snapDir, 'global-snap.json')
	await writeFile(snapPath, JSON.stringify({ 'global:memory:gm1': gEntry }), 'utf8')
	const gLocal: HarnessStateFile = {
		schema: 1,
		entries: {},
		refinements: [{
			id: 'evt-global', trigger: '/refine', changes: ['upsert global:memory:g-new'], evidence: '',
			outcome: 'applied', snapshot: { path: snapPath },
			after: { 'global:memory:gm1': { ...gEntry, title: 'g-new', version: 2 } },
		}],
	}
	await writeHarnessState(statePath, gLocal)
	await rollbackRefine(baseDir, sessionId, 'evt-global')
	const gAfter = await readHarnessState(globalHarnessStatePath(baseDir))
	check('rollback restores global entry', gAfter.entries.memory?.['gm1']?.title === 'g-title', gAfter.entries.memory?.['gm1']?.title ?? '(missing)')
}

console.log('== extractProposals (FIX-4) ==')
{
	const plain = extractProposals('{"proposals":[{"kind":"memory","action":"upsert","title":"t","content":"c","evidence":"e"}]}')
	check('plain JSON object parses', plain.proposals.length === 1 && plain.parseError === undefined)

	const fenced = extractProposals('```json\n{"proposals":[]}\n```')
	check('markdown-fenced JSON parses', Array.isArray(fenced.proposals) && fenced.parseError === undefined, fenced.parseError ?? '')

	const prose = extractProposals('Here is my analysis of the trajectory. Nothing to change.')
	check('prose-only output → parseError, not empty success', prose.proposals.length === 0 && prose.parseError !== undefined, prose.parseError ?? '')

	const broken = extractProposals('{"proposals": [{"kind": "memory"')
	check('malformed JSON → parseError', broken.proposals.length === 0 && broken.parseError !== undefined)

	const noArray = extractProposals('{"result": "nothing"}')
	check('valid JSON without proposals → parseError', noArray.proposals.length === 0 && noArray.parseError !== undefined)

	const structured = extractProposals({ structured: { proposals: [{ kind: 'memory', action: 'upsert', title: 't', content: 'c', evidence: 'e' }] } })
	check('structured result unwraps', structured.proposals.length === 1)
}

console.log('== validateProposals (FIX-4) ==')
{
	const good = validateProposals([
		{ kind: 'memory', action: 'upsert', title: 't', content: 'c', evidence: 'turn 1 says t' },
		{ kind: 'skill', action: 'delete', id: '550e8400-e29b-41d4-a716-446655440000', title: 'old', content: '', evidence: 'turn 2 says old' },
	])
	check('valid proposals pass', good.valid.length === 2 && good.rejected.length === 0, JSON.stringify(good))

	const bad = validateProposals([
		{ kind: 'bogus', action: 'upsert', title: 't', content: 'c', evidence: 'e' },
		{ kind: 'memory', action: 'noop', title: 't', content: 'c', evidence: 'e' },
		{ kind: 'memory', action: 'upsert', title: 't', content: 'c', id: '__proto__', evidence: 'e' },
		{ kind: 'memory', action: 'upsert', title: 't', content: 'c' },
		{ kind: 'memory', action: 'delete', title: 'no-id-delete', content: '', evidence: 'e' },
		{ kind: 'memory', action: 'upsert', title: 'dup', content: '1', evidence: 'e' },
		{ kind: 'memory', action: 'upsert', title: 'dup', content: '2', evidence: 'e' },
	])
	check('bad kind rejected', bad.rejected.some((r) => r.includes('invalid kind "bogus"')))
	check('bad action rejected', bad.rejected.some((r) => r.includes('invalid action "noop"')))
	check('__proto__ id rejected', bad.rejected.some((r) => r.includes('__proto__') && r.includes('id')))
	check('missing evidence rejected', bad.rejected.some((r) => r.includes('evidence is required')))
	check('delete without id rejected', bad.rejected.some((r) => r.includes('delete requires an existing id')))
	check('duplicate target deduped', bad.valid.length === 1, `valid=${bad.valid.length} rejected=${bad.rejected.length}`)
}

console.log('== validateProposals slug-id tolerance (existence-first) ==')
{
	const known = new Set([
		'memory:loop_ab12cd34/round_001',
		'skill:loop-audit',
		'memory:550e8400-e29b-41d4-a716-446655440000',
	])

	const ok = validateProposals([
		{ kind: 'memory', action: 'delete', id: 'loop_ab12cd34/round_001', title: 'verified progress', content: '', evidence: 'turn 3' },
		{ kind: 'skill', action: 'upsert', id: 'loop-audit', title: 'loop-audit', content: 'desc', evidence: 'turn 4' },
	], { knownIds: known })
	check('known slug ids pass for delete and upsert-update', ok.valid.length === 2 && ok.rejected.length === 0, JSON.stringify(ok.rejected))

	const unknownSlug = validateProposals([
		{ kind: 'memory', action: 'delete', id: 'not_in_set/slug', title: 'x', content: '', evidence: 'e' },
	], { knownIds: known })
	check('unknown slug-shaped id still rejected with knownIds', unknownSlug.rejected.some((r) => r.includes('unknown or malformed id')))

	const dangerous = validateProposals([
		{ kind: 'memory', action: 'delete', id: '__proto__', title: 'x', content: '', evidence: 'e' },
	], { knownIds: new Set(['memory:__proto__']) })
	check('__proto__ rejected even when listed in knownIds', dangerous.rejected.some((r) => r.includes('__proto__')))

	const legacy = validateProposals([
		{ kind: 'memory', action: 'delete', id: 'loop_ab12cd34/round_001', title: 'x', content: '', evidence: 'e' },
	])
	check('legacy shape-only behavior preserved without knownIds', legacy.rejected.some((r) => r.includes('unknown or malformed id')))

	const hexOk = validateProposals([
		{ kind: 'memory', action: 'delete', id: '550e8400-e29b-41d4-a716-446655440000', title: 'x', content: '', evidence: 'e' },
	], { knownIds: new Set() })
	check('uuid-shaped id unaffected by knownIds absence', hexOk.valid.length === 1, JSON.stringify(hexOk))
}

console.log('== applyProposals evidence persistence (FIX-8) ==')
{
	const s: HarnessStateFile = { schema: 1, entries: {}, refinements: [] }
	await applyProposals(s, [{ kind: 'memory', action: 'upsert', title: 'ev', content: 'x', evidence: 'turn 9 quote…' }], path.join(path.dirname(statePath), 'refinements'))
	const entry = Object.values(s.entries.memory ?? {})[0]!
	check('evidence lands in metadata', entry.metadata.evidence === 'turn 9 quote…', JSON.stringify(entry.metadata))
}

console.log('== renderHarnessOverview id prefix (FIX-2) ==')
{
	const state: HarnessStateFile = { schema: 1, entries: { memory: { '0123456789abcdef': makeEntry('memory', '0123456789abcdef', 't1') } }, refinements: [] }
	const rendered = renderHarnessOverview(state)
	check('overview shows short id prefix', rendered.includes('[01234567]'), rendered)
}

console.log('== rollbackRefine bidirectional (FIX-5) ==')
{
	// A rollback must itself be reversible: roll it back to restore the state.
	const s: HarnessStateFile = { schema: 1, entries: {}, refinements: [] }
	const p = await applyAndPersist(s, [{ kind: 'memory', action: 'upsert', title: 'temp', content: 'x', evidence: 'e' }])
	const createdId = Object.keys((await readHarnessState(statePath)).entries.memory ?? {})[0]!

	await rollbackRefine(baseDir, sessionId, p.eventId)
	const afterRollback = await readHarnessState(statePath)
	check('rollback removed the entry', afterRollback.entries.memory?.[createdId] === undefined)

	const rollbackEvent = afterRollback.refinements.find((e) => e.trigger === 'rollback')
	check('rollback event has forward snapshot + after image', rollbackEvent?.snapshot?.path != null && rollbackEvent?.after != null)
	await rollbackRefine(baseDir, sessionId, rollbackEvent!.id)
	const restored = await readHarnessState(statePath)
	check('rollback of rollback restores the entry', restored.entries.memory?.[createdId]?.title === 'temp', restored.entries.memory?.[createdId]?.title)
}

console.log('== rollback version-mismatch warning (FIX-5) ==')
{
	const s: HarnessStateFile = { schema: 1, entries: { memory: { 'm1': makeEntry('memory', 'm1', 'old') } }, refinements: [] }
	const p = await applyAndPersist(s, [{ kind: 'memory', action: 'upsert', id: 'm1', title: 'new-title', content: 'y', evidence: 'e' }])

	// Simulate a concurrent edit after the refine applied: bump the version.
	const state = await readHarnessState(statePath)
	state.entries.memory!['m1']!.version += 10
	await writeHarnessState(statePath, state)

	const summary = await rollbackRefine(baseDir, sessionId, p.eventId)
	check('rollback warns about modified entry', summary.includes('Warnings') && summary.includes('version'), summary)
}

console.log('== duplicate-title upsert updates instead of duplicating (item-9) ==')
{
	const s: HarnessStateFile = {
		schema: 1,
		entries: { memory: { 'm1': makeEntry('memory', 'm1', 'same-title', 'old content') } },
		refinements: [],
	}
	const beforeCount = Object.keys(s.entries.memory ?? {}).length
	await applyProposals(s, [{ kind: 'memory', action: 'upsert', title: 'same-title', content: 'new content', evidence: 'turn 5 says update' }], path.join(path.dirname(statePath), 'refinements'))
	check('no-id upsert with matching title does not create a twin', Object.keys(s.entries.memory ?? {}).length === beforeCount, JSON.stringify(Object.keys(s.entries.memory ?? {})))
	check('matching entry is updated', s.entries.memory?.['m1']?.content === 'new content', s.entries.memory?.['m1']?.content)
	check('matching entry version bumped', s.entries.memory?.['m1']?.version === 2, `version=${s.entries.memory?.['m1']?.version}`)

	// A genuinely new title still creates a fresh entry.
	const s2: HarnessStateFile = { schema: 1, entries: {}, refinements: [] }
	await applyProposals(s2, [{ kind: 'memory', action: 'upsert', title: 'brand-new', content: 'x', evidence: 'e' }], path.join(path.dirname(statePath), 'refinements'))
	check('non-matching title still creates a new entry', Object.keys(s2.entries.memory ?? {}).length === 1)
}

console.log('== pruneRefinements retention (item-10) ==')
{
	const snapDir = path.join(path.dirname(statePath), 'refinements')
	await mkdir(snapDir, { recursive: true })
	const snapPaths: string[] = []
	const events: any[] = []
	for (let i = 0; i < 5; i++) {
		const snap = path.join(snapDir, `prune-${i}.snapshot.json`)
		await writeFile(snap, '{}', 'utf8')
		snapPaths.push(snap)
		events.push({ id: `evt-${i}`, trigger: '/refine', changes: [], evidence: '', outcome: 'applied', snapshot: { path: snap }, after: {} })
	}
	await pruneRefinements(events, 2)
	check('prune keeps the newest maxEvents entries', events.length === 2 && events[0].id === 'evt-3', events.map((e) => e.id).join(','))
	check('prune deletes the removed events snapshot files', !existsSync(snapPaths[0]) && !existsSync(snapPaths[1]) && !existsSync(snapPaths[2]), snapPaths.slice(0, 3).join(' | '))
	check('prune keeps the retained events snapshot files', existsSync(snapPaths[3]) && existsSync(snapPaths[4]))
}

console.log('== rollbackRefine respects retention cap (item-10) ==')
{
	// Roll back with a cap of 1: the rollback event survives, older events and
	// their snapshot files are pruned.
	const s: HarnessStateFile = { schema: 1, entries: {}, refinements: [] }
	const p = await applyAndPersist(s, [{ kind: 'memory', action: 'upsert', title: 'cap-test', content: 'x', evidence: 'e' }])
	await rollbackRefine(baseDir, sessionId, p.eventId, 1)
	const after = await readHarnessState(statePath)
	check('rollback with max=1 leaves a single event', after.refinements.length === 1, `len=${after.refinements.length}`)
	check('surviving event is the rollback', after.refinements[0].trigger === 'rollback')
}

console.log('== /harness command: list / show / delete (item-5) ==')
{
	const sId = 'harness-cmd-session'
	const localDir = path.join(baseDir, 'session-artifacts', sId, 'harness')
	await mkdir(localDir, { recursive: true })
	const localState: HarnessStateFile = {
		schema: 1,
		entries: {
			memory: {
				'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa': { ...makeEntry('memory', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Local memory', 'local content') },
			},
			skill: {
				'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb': { ...makeEntry('skill', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'A skill'), scope: 'local' },
			},
		},
		refinements: [],
	}
	await writeHarnessState(harnessStatePath(baseDir, sId), localState)
	const globalState: HarnessStateFile = {
		schema: 1,
		entries: {
			memory: {
				'cccccccc-cccc-4ccc-8ccc-cccccccccccc': { ...makeEntry('memory', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'Global memory', 'global content'), scope: 'global' },
			},
		},
		refinements: [],
	}
	await writeHarnessState(globalHarnessStatePath(baseDir), globalState)

	const listed = listHarness(baseDir, sId)
	check('list shows full ids', listed.includes('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') && listed.includes('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'))
	check('list shows global marker', listed.includes('[global]') && listed.includes('Global memory'))
	check('list kind filter works', !listHarness(baseDir, sId, 'skill').includes('Global memory'))

	const shown = showHarnessEntry(baseDir, sId, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
	check('show by exact id', shown.includes('Local memory') && shown.includes('local content'))
	const shownPrefix = showHarnessEntry(baseDir, sId, 'aaaaaaaa')
	check('show by unique prefix', shownPrefix.includes('Local memory'))
	check('show unknown id errors', showHarnessEntry(baseDir, sId, 'nope').includes('No harness entry matches'))

	// delete by prefix, then roll the manual delete back.
	const deleted = await deleteHarnessEntry(baseDir, sId, 'bbbbbbbb')
	check('delete by prefix removes the entry', deleted.includes('Deleted skill:A skill'), deleted)
	const eventId = deleted.split('/refine-rollback ')[1]?.trim()
	check('delete returns a rollback-able event id', typeof eventId === 'string' && eventId.length > 0, eventId ?? '')
	const afterDelete = await readHarnessState(harnessStatePath(baseDir, sId))
	check('entry gone after manual delete', afterDelete.entries.skill?.['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'] === undefined)
	await rollbackRefine(baseDir, sId, eventId!)
	const afterRollback = await readHarnessState(harnessStatePath(baseDir, sId))
	check('manual delete is rollback-able', afterRollback.entries.skill?.['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb']?.title === 'A skill')
}

console.log('== applyProposalsAndPersist shared pipeline (refactor regression) ==')
{
	// Deterministic stand-in for the /refine + /harness delete persistence loop
	// (which the key-gated e2e exercises against a live LLM): apply on the
	// merged view, record an event, prune, write both files, and return.
	const sId = 'persist-session'
	const localDir = path.join(baseDir, 'session-artifacts', sId, 'harness')
	await mkdir(localDir, { recursive: true })
	await writeHarnessState(harnessStatePath(baseDir, sId), { schema: 1, entries: {}, refinements: [] })

	const snapDir = path.join(path.dirname(harnessStatePath(baseDir, sId)), 'refinements')
	const persisted = await applyProposalsAndPersist(
		baseDir, sId,
		[{ kind: 'memory', action: 'upsert', title: 'persisted', content: 'x', evidence: 'unit' }],
		snapDir, 10, '/refine',
	)
	check('pipeline applied and returned an event id', persisted.applied && persisted.eventId.length > 0 && persisted.changes.length === 1)
	check('pipeline wrote the entry to the local file', (await readHarnessState(harnessStatePath(baseDir, sId))).entries.memory?.[Object.keys((await readHarnessState(harnessStatePath(baseDir, sId))).entries.memory ?? {})[0]!]?.title === 'persisted')
	const evt = (await readHarnessState(harnessStatePath(baseDir, sId))).refinements.find((e) => e.id === persisted.eventId)
	check('pipeline recorded a RefinementEvent', evt !== undefined && evt.trigger === '/refine')

	// A second call with no-op proposals reports applied:false (no dupes).
	const noop = await applyProposalsAndPersist(
		baseDir, sId,
		[{ kind: 'memory', action: 'delete', id: '00000000-0000-4000-8000-000000000000', title: 'missing', content: '', evidence: 'unit' }],
		snapDir, 10, '/refine',
	)
	check('pipeline reports applied:false for no changes', !noop.applied)
}

console.log('== prompt overview mtime cache (item-11) ==')
{
	// Isolated base dir: earlier blocks wrote global memories that would leak
	// into the merged-view count this test measures.
	const cacheBaseDir = path.join(baseDir, 'cache-isolated')
	const countRender = (state: HarnessStateFile) => String(Object.keys(state.entries.memory ?? {}).length)
	const cache = createHarnessOverviewCache({
		globalStatePath: (b) => globalHarnessStatePath(b),
		localStatePath: (b, s) => harnessStatePath(b, s),
		readMerged: (b, s) => mergeHarnessStates(readHarnessStateSync(globalHarnessStatePath(b)), readHarnessStateSync(harnessStatePath(b, s))),
		render: countRender,
		maxEntries: 2,
	})
	const sId = 'cache-session'
	await writeHarnessState(harnessStatePath(cacheBaseDir, sId), {
		schema: 1,
		entries: { memory: { m1: makeEntry('memory', 'm1', 'cached') } },
		refinements: [],
	})
	const first = cache.render(cacheBaseDir, sId)
	const second = cache.render(cacheBaseDir, sId)
	check('unchanged files replay the cached render (same string)', first === second && first === '1', first)

	// Change the local file → the cache must invalidate and re-render.
	const changed = await readHarnessState(harnessStatePath(cacheBaseDir, sId))
	changed.entries.memory!['m2'] = makeEntry('memory', 'm2', 'second')
	await writeHarnessState(harnessStatePath(cacheBaseDir, sId), changed)
	check('changed file re-renders', cache.render(cacheBaseDir, sId) === '2', cache.render(cacheBaseDir, sId))

	// LRU eviction: with maxEntries=2, rendering three sessions evicts the first.
	await writeHarnessState(harnessStatePath(cacheBaseDir, 'cache-a'), { schema: 1, entries: { memory: { a1: makeEntry('memory', 'a1', 'a') } }, refinements: [] })
	await writeHarnessState(harnessStatePath(cacheBaseDir, 'cache-b'), { schema: 1, entries: {}, refinements: [] })
	await writeHarnessState(harnessStatePath(cacheBaseDir, 'cache-c'), { schema: 1, entries: {}, refinements: [] })
	cache.render(cacheBaseDir, 'cache-a') // '1' cached
	cache.render(cacheBaseDir, 'cache-b') // cached
	cache.render(cacheBaseDir, 'cache-c') // cached; 'cache-a' evicted
	const bumped = await readHarnessState(harnessStatePath(cacheBaseDir, 'cache-a'))
	bumped.entries.memory!['a2'] = makeEntry('memory', 'a2', 'a2')
	await writeHarnessState(harnessStatePath(cacheBaseDir, 'cache-a'), bumped)
	check('LRU eviction: evicted session re-reads disk', cache.render(cacheBaseDir, 'cache-a') === '2', cache.render(cacheBaseDir, 'cache-a'))
}

console.log('== writeHarnessState CAS conflict (FIX-7) ==')
{	const base: HarnessStateFile = { schema: 1, entries: {}, refinements: [] }
	await writeHarnessState(statePath, base)
	const { mtimeMs } = await readHarnessStateDetailed(statePath)

	// Simulate a kernel-side write landing between our read and our write.
	// The pause keeps the two writes in distinct mtime ticks — back-to-back
	// renames can land on the same timestamp on coarse-granularity filesystems,
	// which would make the stale expectation accidentally match.
	await new Promise((resolve) => setTimeout(resolve, 20))
	const concurrent: HarnessStateFile = { schema: 1, entries: { memory: { x: makeEntry('memory', 'x', 'other') } }, refinements: [] }
	await writeHarnessState(statePath, concurrent)

	let conflicted = false
	try {
		await writeHarnessState(statePath, base, mtimeMs)
	} catch (error) {
		conflicted = error instanceof HarnessConflictError
	}
	check('stale-mtime write throws HarnessConflictError', conflicted)
	const after = await readHarnessState(statePath)
	check('concurrent write preserved', after.entries.memory?.['x']?.title === 'other')
}

console.log('== writeHarnessStates global-failure rollback (P1-fix) ==')
{
	const rollbackDir = mkdtempSync(path.join(os.tmpdir(), 'dsh-rlm-rollback-test-'))
	const sid = 'rollback-session'
	const localPath = harnessStatePath(rollbackDir, sid)

	// Seed both files so the composite CAS has real expectations to hold.
	const localBase: HarnessStateFile = { schema: 1, entries: { memory: { l1: makeEntry('memory', 'l1', 'local-base') } }, refinements: [] }
	const globalBase: HarnessStateFile = { schema: 1, entries: { memory: { g1: makeEntry('memory', 'g1', 'global-base') } }, refinements: [] }
	await writeHarnessState(localPath, localBase)
	await writeHarnessState(globalHarnessStatePath(rollbackDir), globalBase)

	// A kernel-side global write lands between our observation and our call,
	// so the composite call's global half must conflict. Same mtime-tick guard
	// as the FIX-7 section above.
	const localMeta = await readHarnessStateDetailed(localPath)
	const globalMeta = await readHarnessStateDetailed(globalHarnessStatePath(rollbackDir))
	await new Promise((resolve) => setTimeout(resolve, 20))
	await writeHarnessState(globalHarnessStatePath(rollbackDir), { schema: 1, entries: { memory: { g2: makeEntry('memory', 'g2', 'kernel-won') } }, refinements: [] })

	const nextLocal: HarnessStateFile = { schema: 1, entries: { memory: { l1: makeEntry('memory', 'l1', 'local-new') } }, refinements: [] }
	let threw = false
	try {
		await writeHarnessStates(rollbackDir, sid, { schema: 1, entries: {}, refinements: [] }, nextLocal, { global: globalMeta.mtimeMs, local: localMeta.mtimeMs })
	} catch (error) {
		threw = error instanceof HarnessConflictError
	}
	check('composite write throws when the global half conflicts', threw)

	// The compensating write restores the pre-call local content; without it
	// the next prompt render would see local-new + kernel-global as a torn pair.
	const localAfter = await readHarnessState(localPath)
	check('local rolled back after global failure', localAfter.entries.memory?.['l1']?.title === 'local-base', localAfter.entries.memory?.['l1']?.title ?? '(missing)')
	check('conflicting global winner untouched by rollback', (await readHarnessState(globalHarnessStatePath(rollbackDir))).entries.memory?.['g2']?.title === 'kernel-won')

	// Consistent expectations commit both halves in one call.
	const freshLocalMeta = await readHarnessStateDetailed(localPath)
	const freshGlobalMeta = await readHarnessStateDetailed(globalHarnessStatePath(rollbackDir))
	await writeHarnessStates(rollbackDir, sid, { schema: 1, entries: { memory: { g3: makeEntry('memory', 'g3', 'both-new') } }, refinements: [] }, nextLocal, { global: freshGlobalMeta.mtimeMs, local: freshLocalMeta.mtimeMs })
	const localHappy = await readHarnessState(localPath)
	const globalHappy = await readHarnessState(globalHarnessStatePath(rollbackDir))
	check('consistent composite write lands both files', localHappy.entries.memory?.['l1']?.title === 'local-new' && globalHappy.entries.memory?.['g3']?.title === 'both-new')
}

console.log('== applyProposalsAndPersist conflict retry converges (FIX-7) ==')
{
	const retryDir = mkdtempSync(path.join(os.tmpdir(), 'dsh-rlm-retry-test-'))
	const sid = 'retry-session'
	const snapshotDir = path.join(path.dirname(harnessStatePath(retryDir, sid)), 'refinements')

	// Interference: rewrite both files (read-modify-write) so any in-flight
	// attempt's observed mtimes go stale. Each write CASes against the mtime it
	// just observed — a blind writer here could land AFTER the pipeline's
	// successful write and clobber the landed state, turning a loaded machine
	// into a false failure. Scheduled at 5/35/80ms to bracket fast machines
	// without delaying the happy path meaningfully.
	async function bump(): Promise<void> {
		const lp = harnessStatePath(retryDir, sid)
		const gp = globalHarnessStatePath(retryDir)
		for (const p of [lp, gp]) {
			try {
				const detailed = await readHarnessStateDetailed(p)
				if (detailed.mtimeMs === null) continue // Missing file: nothing to bump yet.
				await writeHarnessState(p, detailed.state, detailed.mtimeMs)
			} catch {
				// Conflict with the pipeline or the sibling bump: this tick's
				// interference is done; the next timer tick re-reads.
			}
		}
	}
	const timers = [5, 35, 80].map((ms) => setTimeout(() => { void bump().catch(() => undefined) }, ms))

	const persisted = await applyProposalsAndPersist(
		retryDir,
		sid,
		[{ action: 'upsert', kind: 'memory', title: 'retry-entry', content: 'landed despite conflict', evidence: 'ev' }] as Parameters<typeof applyProposalsAndPersist>[2],
		snapshotDir,
		100,
		'/refine',
	).finally(() => timers.forEach(clearTimeout))

	check('conflicted refine retries once and lands the proposal', persisted.applied === true && persisted.eventId.length > 0, `eventId='${persisted.eventId}'`)
	const landed = await readHarnessState(harnessStatePath(retryDir, sid))
	const entry = Object.values(landed.entries.memory ?? {}).find((entry) => entry.title === 'retry-entry')
	check('retried proposal content is durable', entry?.content === 'landed despite conflict')
	check('exactly one refinement event recorded', landed.refinements.length === 1, `len=${landed.refinements.length}`)
}

console.log('== corrupt state backup (FIX-11) ==')
{
	const corruptPath = path.join(path.dirname(statePath), 'corrupt_state.json')
	await writeFile(corruptPath, '{ this is not valid json', 'utf8')
	const state = await readHarnessState(corruptPath)
	check('corrupt file reads as empty', Object.keys(state.entries).length === 0)
	const backups = readdirSync(path.dirname(corruptPath)).filter((f) => f.startsWith('corrupt_state.json.corrupt-'))
	check('corrupt file backed up before zeroing', backups.length === 1, backups.join(','))
}

console.log('== renderHarnessOverview char budget (FIX-10) ==')
{
	const state: HarnessStateFile = {
		schema: 1,
		entries: {
			memory: {
				'aaaaaaaaaaaaaaaa': makeEntry('memory', 'aaaaaaaaaaaaaaaa', 't1', 'x'.repeat(2000)),
				'bbbbbbbbbbbbbbbb': makeEntry('memory', 'bbbbbbbbbbbbbbbb', 't2', 'short'),
			},
		},
		refinements: [],
	}
	const rendered = renderHarnessOverview(state, { maxCharsPerEntry: 100 })
	const longLine = rendered.split('\n').find((l) => l.includes('t1'))
	check('per-entry content truncated', longLine?.endsWith('…') ?? false, longLine ?? '')
	check('title still visible after truncation', longLine?.includes('t1') ?? false)

	const tiny = renderHarnessOverview(state, { maxTotalChars: 60 })
	check('total char budget enforced', tiny.length <= 62, `len=${tiny.length}`)
}

console.log('== writeHarnessStates absent-local rollback (2026-08-28) ==')
{
	// The local file does not exist before the composite write: a failed global
	// half must REMOVE the freshly created local file, not skip the rollback —
	// otherwise the next prompt render sees local-new + global-old as a torn pair.
	const absentDir = mkdtempSync(path.join(os.tmpdir(), 'dsh-rlm-rollback-absent-'))
	const absentSid = 'absent-session'
	const absentLocalPath = harnessStatePath(absentDir, absentSid)
	check('precondition: local file absent', !existsSync(absentLocalPath))

	const absentGlobalMeta = await readHarnessStateDetailed(globalHarnessStatePath(absentDir))
	await new Promise((resolve) => setTimeout(resolve, 20))
	await writeHarnessState(
		globalHarnessStatePath(absentDir),
		{ schema: 1, entries: { memory: { g9: makeEntry('memory', 'g9', 'kernel-absent-won') } }, refinements: [] },
	)
	let absentThrew = false
	try {
		await writeHarnessStates(
			absentDir,
			absentSid,
			{ schema: 1, entries: {}, refinements: [] },
			{ schema: 1, entries: { memory: { n1: makeEntry('memory', 'n1', 'local-new') } }, refinements: [] },
			{ global: absentGlobalMeta.mtimeMs, local: null },
		)
	} catch (error) {
		absentThrew = error instanceof HarnessConflictError
	}
	check('absent-local composite write throws on global conflict', absentThrew)
	check('freshly created local file removed on global failure', !existsSync(absentLocalPath))
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
