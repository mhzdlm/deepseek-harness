/**
 * Unit tests for plugin-continual-harness (no host / no LLM required),
 * migrated from the former hand-rolled `refine-test.mts` to vitest (T7.7):
 *   - harness-file.ts read/write roundtrip, empty-state, atomic write,
 *     corrupt salvage (FIX-11), CAS conflict (FIX-7), Windows EPERM mapping
 *   - writeHarnessStates composite rollback compensation (P1-fix), incl. the
 *     absent-local inverse (2026-08-28 review fix)
 *   - refine.ts applyProposals reverse-snapshot for all shapes
 *   - rollbackRefine roundtrip, bidirectional rollback, concurrent-version
 *     warnings (FIX-5), retention cap (item-10)
 *   - extractProposals / validateProposals (FIX-4), evidence persistence (FIX-8)
 *   - /harness list/show/delete (item-5)
 *   - prompt-overview mtime cache (item-11), render budgets (FIX-2/FIX-10)
 *   - auto-refine scheduler (P0), runRefine non-reasoning (P2-B)
 */
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
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
} from '../src/harness-file.ts'
import {
  applyProposals,
  applyProposalsAndPersist,
  extractProposals,
  pruneRefinements,
  rollbackRefine,
  validateProposals,
  registerAutoRefine,
  reviewAutoRefine,
  runRefine,
} from '../src/refine.ts'
import { deleteHarnessEntry, listHarness, showHarnessEntry } from '../src/harness-cmd.ts'
import { createHarnessOverviewCache } from '../src/prompt-cache.ts'
import { renderHarnessOverview } from '../src/prompt.ts'

const baseDir = mkdtempSync(path.join(os.tmpdir(), 'dsh-rlm-refine-test-'))
const sessionId = 'test-session'
const statePath = harnessStatePath(baseDir, sessionId)
let eventCounter = 0

function makeEntry(kind: HarnessKind, id: string, title: string, content = 'c'): HarnessEntry {
  return {
    id, kind, title, content,
    path: 'general', scope: 'local',
    reference: {}, arguments: {}, metadata: {},
    source: 'agent', created_at: '2026-08-22T00:00:00Z', updated_at: '2026-08-22T00:00:00Z', version: 1,
  }
}

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

describe('harness-file read/write', () => {
  it('missing file reads as empty state', async () => {
    const empty = await readHarnessState(path.join(baseDir, 'does-not-exist.json'))
    expect(empty.schema).toBe(1)
    expect(Object.keys(empty.entries)).toHaveLength(0)
    expect(empty.refinements).toHaveLength(0)
  })

  it('write → read roundtrip, atomic write leaves no .tmp', async () => {
    const state: HarnessStateFile = { schema: 1, entries: { memory: { m1: makeEntry('memory', 'm1', 't1') } }, refinements: [] }
    await writeHarnessState(statePath, state)
    const back = await readHarnessState(statePath)
    expect(back.entries.memory?.['m1']?.title).toBe('t1')
    const tmpFiles = readdirSync(path.dirname(statePath)).filter(f => f.endsWith('.tmp'))
    expect(tmpFiles).toHaveLength(0)
  })
})

describe('applyProposals reverse snapshot', () => {
  it('upsert-new snapshots a null tombstone on the real id', async () => {
    const s1: HarnessStateFile = { schema: 1, entries: {}, refinements: [] }
    const r1 = await applyProposals(s1, [{ kind: 'memory', action: 'upsert', title: 'new', content: 'x', evidence: 'turn 3 says X' }], path.join(path.dirname(statePath), 'refinements'))
    const newId = Object.keys(s1.entries.memory ?? {})[0]!
    expect(s1.entries.memory?.[newId]?.title).toBe('new')
    expect(r1.snapshotPath).not.toBeNull()
    expect(r1.snapshotPath !== null && existsSync(r1.snapshotPath)).toBe(true)
    const snap1 = JSON.parse(readFileSync(r1.snapshotPath!, 'utf8'))
    expect(snap1[`local:memory:${newId}`]).toBeNull()
  })

  it('upsert-global creates a global-scope entry and keys the snapshot by global scope', async () => {
    const s1g: HarnessStateFile = { schema: 1, entries: {}, refinements: [] }
    const r1g = await applyProposals(s1g, [{ kind: 'memory', action: 'upsert', scope: 'global', title: 'g-new', content: 'x', evidence: 'turn 3 says G' }], path.join(path.dirname(statePath), 'refinements'))
    const gId = Object.keys(s1g.entries.memory ?? {})[0]!
    expect(s1g.entries.memory?.[gId]?.scope).toBe('global')
    const snapG = JSON.parse(readFileSync(r1g.snapshotPath!, 'utf8'))
    expect(snapG[`global:memory:${gId}`]).toBeNull()
  })

  it('upsert-update mutates in place; delete-existing removes; delete-missing no-ops', async () => {
    const s2: HarnessStateFile = { schema: 1, entries: { memory: { m1: makeEntry('memory', 'm1', 'old') } }, refinements: [] }
    await applyProposals(s2, [{ kind: 'memory', action: 'upsert', id: 'm1', title: 'new-title', content: 'y', evidence: 'turn 4 says Y' }], path.join(path.dirname(statePath), 'refinements'))
    expect(s2.entries.memory?.['m1']?.title).toBe('new-title')

    const s3: HarnessStateFile = { schema: 1, entries: { memory: { m2: makeEntry('memory', 'm2', 'gone') } }, refinements: [] }
    const r3 = await applyProposals(s3, [
      { kind: 'memory', action: 'delete', id: 'm2', title: 'gone', content: '', evidence: 'turn 5 says G' },
      { kind: 'memory', action: 'delete', id: 'nope', title: 'missing', content: '', evidence: 'turn 5 says M' },
    ], path.join(path.dirname(statePath), 'refinements'))
    expect(s3.entries.memory?.['m2']).toBeUndefined()
    expect(r3.changes).toHaveLength(1)
  })
})

describe('rollbackRefine roundtrip', () => {
  it('rollback of an upsert-new removes the fresh entry', async () => {
    const s1: HarnessStateFile = { schema: 1, entries: {}, refinements: [] }
    const p1 = await applyAndPersist(s1, [{ kind: 'memory', action: 'upsert', title: 'new', content: 'x', evidence: 'turn 3 says X' }])
    const after1 = await readHarnessState(statePath)
    const createdId = Object.keys(after1.entries.memory ?? {})[0]!
    expect(after1.entries.memory?.[createdId]).toBeDefined()
    await rollbackRefine(baseDir, sessionId, p1.eventId)
    const rolled1 = await readHarnessState(statePath)
    expect(rolled1.entries.memory?.[createdId]).toBeUndefined()
  })

  it('rollback of an upsert-update restores the prior title', async () => {
    const s2: HarnessStateFile = { schema: 1, entries: { memory: { m1: makeEntry('memory', 'm1', 'old') } }, refinements: [] }
    const p2 = await applyAndPersist(s2, [{ kind: 'memory', action: 'upsert', id: 'm1', title: 'new-title', content: 'y', evidence: 'turn 4 says Y' }])
    await rollbackRefine(baseDir, sessionId, p2.eventId)
    const rolled2 = await readHarnessState(statePath)
    expect(rolled2.entries.memory?.['m1']?.title).toBe('old')
  })

  it('rollback of a delete restores the entry', async () => {
    const s3: HarnessStateFile = { schema: 1, entries: { memory: { m2: makeEntry('memory', 'm2', 'gone') } }, refinements: [] }
    const p3 = await applyAndPersist(s3, [{ kind: 'memory', action: 'delete', id: 'm2', title: 'gone', content: '', evidence: 'turn 5 says G' }])
    await rollbackRefine(baseDir, sessionId, p3.eventId)
    const rolled3 = await readHarnessState(statePath)
    expect(rolled3.entries.memory?.['m2']?.title).toBe('gone')
  })
})

describe('global scope merge/split + rollback (P0-fix)', () => {
  it('merge surfaces global+local; split routes by scope and preserves global refinements', () => {
    const gEntry = { ...makeEntry('memory', 'gm1', 'g-title'), scope: 'global' as const }
    const lEntry = makeEntry('memory', 'lm1', 'l-title')
    const globalState: HarnessStateFile = {
      schema: 1,
      entries: { memory: { gm1: gEntry } },
      refinements: [{ id: 'g-evt', trigger: '/refine', changes: ['upsert global:memory:g-title'], evidence: '', outcome: 'applied' }],
    }
    const localState: HarnessStateFile = { schema: 1, entries: { memory: { lm1: lEntry } }, refinements: [] }
    const merged = mergeHarnessStates(globalState, localState)
    expect(merged.entries.memory?.['gm1']?.title).toBe('g-title')
    expect(merged.entries.memory?.['lm1']?.title).toBe('l-title')
    const split = splitHarnessStateByScope(merged, globalState.refinements)
    expect(split.global.entries.memory?.['gm1']).toBeDefined()
    expect(split.local.entries.memory?.['lm1']).toBeDefined()
    expect(split.global.refinements).toHaveLength(1)
  })

  it('rollback of a global-scope refine restores the global file', async () => {
    const gEntry = { ...makeEntry('memory', 'gm1', 'g-title'), scope: 'global' as const }
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
    expect(gAfter.entries.memory?.['gm1']?.title).toBe('g-title')
  })
})

describe('extractProposals (FIX-4)', () => {
  it('parses plain/fenced JSON, flags prose and malformed output', () => {
    const plain = extractProposals('{"proposals":[{"kind":"memory","action":"upsert","title":"t","content":"c","evidence":"e"}]}')
    expect(plain.proposals).toHaveLength(1)
    expect(plain.parseError).toBeUndefined()

    const fenced = extractProposals('```json\n{"proposals":[]}\n```')
    expect(Array.isArray(fenced.proposals)).toBe(true)
    expect(fenced.parseError).toBeUndefined()

    const prose = extractProposals('Here is my analysis of the trajectory. Nothing to change.')
    expect(prose.proposals).toHaveLength(0)
    expect(prose.parseError).toBeDefined()

    const broken = extractProposals('{"proposals": [{"kind": "memory"')
    expect(broken.proposals).toHaveLength(0)
    expect(broken.parseError).toBeDefined()

    const noArray = extractProposals('{"result": "nothing"}')
    expect(noArray.proposals).toHaveLength(0)
    expect(noArray.parseError).toBeDefined()

    const structured = extractProposals({ structured: { proposals: [{ kind: 'memory', action: 'upsert', title: 't', content: 'c', evidence: 'e' }] } })
    expect(structured.proposals).toHaveLength(1)
  })
})

describe('validateProposals (FIX-4)', () => {
  it('rejects bad kinds/actions/ids/missing evidence and dedupes duplicate titles', () => {
    const good = validateProposals([
      { kind: 'memory', action: 'upsert', title: 't', content: 'c', evidence: 'turn 1 says t' },
      { kind: 'skill', action: 'delete', id: '550e8400-e29b-41d4-a716-446655440000', title: 'old', content: '', evidence: 'turn 2 says old' },
    ])
    expect(good.valid).toHaveLength(2)
    expect(good.rejected).toHaveLength(0)

    const bad = validateProposals([
      { kind: 'bogus', action: 'upsert', title: 't', content: 'c', evidence: 'e' },
      { kind: 'memory', action: 'noop', title: 't', content: 'c', evidence: 'e' },
      { kind: 'memory', action: 'upsert', title: 't', content: 'c', id: '__proto__', evidence: 'e' },
      { kind: 'memory', action: 'upsert', title: 't', content: 'c' },
      { kind: 'memory', action: 'delete', title: 'no-id-delete', content: '', evidence: 'e' },
      { kind: 'memory', action: 'upsert', title: 'dup', content: '1', evidence: 'e' },
      { kind: 'memory', action: 'upsert', title: 'dup', content: '2', evidence: 'e' },
    ])
    expect(bad.rejected.some(r => r.includes('invalid kind "bogus"'))).toBe(true)
    expect(bad.rejected.some(r => r.includes('invalid action "noop"'))).toBe(true)
    expect(bad.rejected.some(r => r.includes('__proto__') && r.includes('id'))).toBe(true)
    expect(bad.rejected.some(r => r.includes('evidence is required'))).toBe(true)
    expect(bad.rejected.some(r => r.includes('delete requires an existing id'))).toBe(true)
    expect(bad.valid).toHaveLength(1)
  })

  it('tolerates known slug ids when knownIds are supplied, rejects unknowns and __proto__', () => {
    const known = new Set([
      'memory:loop_ab12cd34/round_001',
      'skill:loop-audit',
      'memory:550e8400-e29b-41d4-a716-446655440000',
    ])

    const ok = validateProposals([
      { kind: 'memory', action: 'delete', id: 'loop_ab12cd34/round_001', title: 'verified progress', content: '', evidence: 'turn 3' },
      { kind: 'skill', action: 'upsert', id: 'loop-audit', title: 'loop-audit', content: 'desc', evidence: 'turn 4' },
    ], { knownIds: known })
    expect(ok.valid).toHaveLength(2)
    expect(ok.rejected).toHaveLength(0)

    const unknownSlug = validateProposals([
      { kind: 'memory', action: 'delete', id: 'not_in_set/slug', title: 'x', content: '', evidence: 'e' },
    ], { knownIds: known })
    expect(unknownSlug.rejected.some(r => r.includes('unknown or malformed id'))).toBe(true)

    const dangerous = validateProposals([
      { kind: 'memory', action: 'delete', id: '__proto__', title: 'x', content: '', evidence: 'e' },
    ], { knownIds: new Set(['memory:__proto__']) })
    expect(dangerous.rejected.some(r => r.includes('__proto__'))).toBe(true)

    const legacy = validateProposals([
      { kind: 'memory', action: 'delete', id: 'loop_ab12cd34/round_001', title: 'x', content: '', evidence: 'e' },
    ])
    expect(legacy.rejected.some(r => r.includes('unknown or malformed id'))).toBe(true)

    const hexOk = validateProposals([
      { kind: 'memory', action: 'delete', id: '550e8400-e29b-41d4-a716-446655440000', title: 'x', content: '', evidence: 'e' },
    ], { knownIds: new Set() })
    expect(hexOk.valid).toHaveLength(1)
  })
})

describe('applyProposals evidence persistence (FIX-8)', () => {
  it('evidence lands in metadata', async () => {
    const s: HarnessStateFile = { schema: 1, entries: {}, refinements: [] }
    await applyProposals(s, [{ kind: 'memory', action: 'upsert', title: 'ev', content: 'x', evidence: 'turn 9 quote…' }], path.join(path.dirname(statePath), 'refinements'))
    const entry = Object.values(s.entries.memory ?? {})[0]!
    expect(entry.metadata.evidence).toBe('turn 9 quote…')
  })
})

describe('renderHarnessOverview id prefix (FIX-2)', () => {
  it('shows a short id prefix in the overview', () => {
    const state: HarnessStateFile = { schema: 1, entries: { memory: { '0123456789abcdef': makeEntry('memory', '0123456789abcdef', 't1') } }, refinements: [] }
    const rendered = renderHarnessOverview(state)
    expect(rendered).toContain('[01234567]')
  })
})

describe('rollbackRefine bidirectional (FIX-5)', () => {
  it('a rollback is itself reversible', async () => {
    const s: HarnessStateFile = { schema: 1, entries: {}, refinements: [] }
    const p = await applyAndPersist(s, [{ kind: 'memory', action: 'upsert', title: 'temp', content: 'x', evidence: 'e' }])
    const createdId = Object.keys((await readHarnessState(statePath)).entries.memory ?? {})[0]!

    await rollbackRefine(baseDir, sessionId, p.eventId)
    const afterRollback = await readHarnessState(statePath)
    expect(afterRollback.entries.memory?.[createdId]).toBeUndefined()

    const rollbackEvent = afterRollback.refinements.find(e => e.trigger === 'rollback')
    expect(rollbackEvent?.snapshot?.path).not.toBeNull()
    expect(rollbackEvent?.after).not.toBeNull()
    await rollbackRefine(baseDir, sessionId, rollbackEvent!.id)
    const restored = await readHarnessState(statePath)
    expect(restored.entries.memory?.[createdId]?.title).toBe('temp')
  })
})

describe('rollbackRefine concurrent-version warning (FIX-5)', () => {
  it('warns when a key was modified after the refine applied', async () => {
    const s: HarnessStateFile = { schema: 1, entries: { memory: { m1: makeEntry('memory', 'm1', 'old') } }, refinements: [] }
    const p = await applyAndPersist(s, [{ kind: 'memory', action: 'upsert', id: 'm1', title: 'new-title', content: 'y', evidence: 'e' }])

    // Simulate a concurrent edit after the refine applied: bump the version.
    const state = await readHarnessState(statePath)
    state.entries.memory!['m1']!.version += 10
    await writeHarnessState(statePath, state)

    const summary = await rollbackRefine(baseDir, sessionId, p.eventId)
    expect(summary).toContain('Warnings')
    expect(summary).toContain('version')
  })
})

describe('duplicate-title upsert (item-9)', () => {
  it('updates the matching entry instead of duplicating; a new title still creates', async () => {
    const s: HarnessStateFile = {
      schema: 1,
      entries: { memory: { m1: makeEntry('memory', 'm1', 'same-title', 'old content') } },
      refinements: [],
    }
    const beforeCount = Object.keys(s.entries.memory ?? {}).length
    await applyProposals(s, [{ kind: 'memory', action: 'upsert', title: 'same-title', content: 'new content', evidence: 'turn 5 says update' }], path.join(path.dirname(statePath), 'refinements'))
    expect(Object.keys(s.entries.memory ?? {})).toHaveLength(beforeCount)
    expect(s.entries.memory?.['m1']?.content).toBe('new content')
    expect(s.entries.memory?.['m1']?.version).toBe(2)

    const s2: HarnessStateFile = { schema: 1, entries: {}, refinements: [] }
    await applyProposals(s2, [{ kind: 'memory', action: 'upsert', title: 'brand-new', content: 'x', evidence: 'e' }], path.join(path.dirname(statePath), 'refinements'))
    expect(Object.keys(s2.entries.memory ?? {})).toHaveLength(1)
  })
})

describe('pruneRefinements retention (item-10)', () => {
  it('keeps the newest maxEvents entries and deletes their pruned snapshot files', async () => {
    const snapDir = path.join(path.dirname(statePath), 'refinements')
    await mkdir(snapDir, { recursive: true })
    const snapPaths: string[] = []
    const events: Array<Record<string, unknown>> = []
    for (let i = 0; i < 5; i++) {
      const snap = path.join(snapDir, `prune-${i}.snapshot.json`)
      await writeFile(snap, '{}', 'utf8')
      snapPaths.push(snap)
      events.push({ id: `evt-${i}`, trigger: '/refine', changes: [], evidence: '', outcome: 'applied', snapshot: { path: snap }, after: {} })
    }
    await pruneRefinements(events as unknown as Parameters<typeof pruneRefinements>[0], 2)
    expect(events).toHaveLength(2)
    expect((events[0] as { id: string }).id).toBe('evt-3')
    expect(existsSync(snapPaths[0]!)).toBe(false)
    expect(existsSync(snapPaths[1]!)).toBe(false)
    expect(existsSync(snapPaths[2]!)).toBe(false)
    expect(existsSync(snapPaths[3]!)).toBe(true)
    expect(existsSync(snapPaths[4]!)).toBe(true)
  })
})

describe('rollbackRefine retention cap (item-10)', () => {
  it('rollback with max=1 leaves a single rollback event', async () => {
    const s: HarnessStateFile = { schema: 1, entries: {}, refinements: [] }
    const p = await applyAndPersist(s, [{ kind: 'memory', action: 'upsert', title: 'cap-test', content: 'x', evidence: 'e' }])
    await rollbackRefine(baseDir, sessionId, p.eventId, 1)
    const after = await readHarnessState(statePath)
    expect(after.refinements).toHaveLength(1)
    expect(after.refinements[0]!.trigger).toBe('rollback')
  })
})

describe('/harness command (item-5)', () => {
  it('list / show / delete work and manual delete is rollback-able', async () => {
    const sId = 'harness-cmd-session'
    const localDir = path.join(baseDir, 'session-artifacts', sId, 'harness')
    await mkdir(localDir, { recursive: true })
    const localState: HarnessStateFile = {
      schema: 1,
      entries: {
        memory: { 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa': { ...makeEntry('memory', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Local memory', 'local content') } },
        skill: { 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb': { ...makeEntry('skill', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'A skill'), scope: 'local' } },
      },
      refinements: [],
    }
    await writeHarnessState(harnessStatePath(baseDir, sId), localState)
    const globalState: HarnessStateFile = {
      schema: 1,
      entries: { memory: { 'cccccccc-cccc-4ccc-8ccc-cccccccccccc': { ...makeEntry('memory', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'Global memory', 'global content'), scope: 'global' } } },
      refinements: [],
    }
    await writeHarnessState(globalHarnessStatePath(baseDir), globalState)

    const listed = listHarness(baseDir, sId)
    expect(listed).toContain('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
    expect(listed).toContain('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
    expect(listed).toContain('[global]')
    expect(listed).toContain('Global memory')
    expect(listHarness(baseDir, sId, 'skill')).not.toContain('Global memory')

    const shown = showHarnessEntry(baseDir, sId, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
    expect(shown).toContain('Local memory')
    expect(shown).toContain('local content')
    expect(showHarnessEntry(baseDir, sId, 'aaaaaaaa')).toContain('Local memory')
    expect(showHarnessEntry(baseDir, sId, 'nope')).toContain('No harness entry matches')

    const deleted = await deleteHarnessEntry(baseDir, sId, 'bbbbbbbb')
    expect(deleted).toContain('Deleted skill:A skill')
    const eventId = deleted.split('/refine-rollback ')[1]?.trim() ?? ''
    expect(eventId.length).toBeGreaterThan(0)
    expect((await readHarnessState(harnessStatePath(baseDir, sId))).entries.skill?.['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb']).toBeUndefined()
    await rollbackRefine(baseDir, sId, eventId!)
    expect((await readHarnessState(harnessStatePath(baseDir, sId))).entries.skill?.['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb']?.title).toBe('A skill')
  })
})

describe('applyProposalsAndPersist shared pipeline', () => {
  it('applies, records an event, and reports applied:false for no-op proposals', async () => {
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
    expect(persisted.applied).toBe(true)
    expect(persisted.eventId.length).toBeGreaterThan(0)
    expect(persisted.changes).toHaveLength(1)
    const after = await readHarnessState(harnessStatePath(baseDir, sId))
    const createdId = Object.keys(after.entries.memory ?? {})[0]!
    expect(after.entries.memory?.[createdId]?.title).toBe('persisted')
    const evt = after.refinements.find(e => e.id === persisted.eventId)
    expect(evt?.trigger).toBe('/refine')

    const noop = await applyProposalsAndPersist(
      baseDir, sId,
      [{ kind: 'memory', action: 'delete', id: '00000000-0000-4000-8000-000000000000', title: 'missing', content: '', evidence: 'unit' }],
      snapDir, 10, '/refine',
    )
    expect(noop.applied).toBe(false)
  })
})

describe('prompt overview mtime cache (item-11)', () => {
  it('replays unchanged files, invalidates on change, evicts least-recently-used', async () => {
    const cacheBaseDir = path.join(baseDir, 'cache-isolated')
    const countRender = (state: HarnessStateFile) => String(Object.keys(state.entries.memory ?? {}).length)
    const cache = createHarnessOverviewCache({
      globalStatePath: b => globalHarnessStatePath(b),
      localStatePath: (b, s) => harnessStatePath(b, s),
      readMerged: (b, s) =>
        mergeHarnessStates(readHarnessStateSync(globalHarnessStatePath(b)), readHarnessStateSync(harnessStatePath(b, s))),
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
    expect(first).toBe('1')
    expect(second).toBe(first)

    const changed = await readHarnessState(harnessStatePath(cacheBaseDir, sId))
    changed.entries.memory!['m2'] = makeEntry('memory', 'm2', 'second')
    await writeHarnessState(harnessStatePath(cacheBaseDir, sId), changed)
    expect(cache.render(cacheBaseDir, sId)).toBe('2')

    await writeHarnessState(harnessStatePath(cacheBaseDir, 'cache-a'), { schema: 1, entries: { memory: { a1: makeEntry('memory', 'a1', 'a') } }, refinements: [] })
    await writeHarnessState(harnessStatePath(cacheBaseDir, 'cache-b'), { schema: 1, entries: {}, refinements: [] })
    await writeHarnessState(harnessStatePath(cacheBaseDir, 'cache-c'), { schema: 1, entries: {}, refinements: [] })
    cache.render(cacheBaseDir, 'cache-a')
    cache.render(cacheBaseDir, 'cache-b')
    cache.render(cacheBaseDir, 'cache-c')
    const bumped = await readHarnessState(harnessStatePath(cacheBaseDir, 'cache-a'))
    bumped.entries.memory!['a2'] = makeEntry('memory', 'a2', 'a2')
    await writeHarnessState(harnessStatePath(cacheBaseDir, 'cache-a'), bumped)
    expect(cache.render(cacheBaseDir, 'cache-a')).toBe('2')
  })
})

describe('writeHarnessState CAS conflict (FIX-7)', () => {
  it('a stale-mtime write throws HarnessConflictError and preserves the concurrent write', async () => {
    const base: HarnessStateFile = { schema: 1, entries: {}, refinements: [] }
    await writeHarnessState(statePath, base)
    const { mtimeMs } = await readHarnessStateDetailed(statePath)

    // Simulate a kernel-side write landing between our read and our write. The
    // pause keeps the two writes in distinct mtime ticks.
    await new Promise(resolve => setTimeout(resolve, 20))
    const concurrent: HarnessStateFile = { schema: 1, entries: { memory: { x: makeEntry('memory', 'x', 'other') } }, refinements: [] }
    await writeHarnessState(statePath, concurrent)

    await expect(writeHarnessState(statePath, base, mtimeMs)).rejects.toBeInstanceOf(HarnessConflictError)
    const after = await readHarnessState(statePath)
    expect(after.entries.memory?.['x']?.title).toBe('other')
  })

  it('a null expected mtime matches an absent file; a mismatched absent expectation conflicts', async () => {
    const target = path.join(baseDir, `absent-cas-${Date.now()}.json`)
    // Absent file + null expectation succeeds (fresh create).
    await writeHarnessState(target, { schema: 1, entries: {}, refinements: [] }, null)
    // Absent file + non-null expectation is a conflict.
    await expect(writeHarnessState(target, { schema: 1, entries: {}, refinements: [] }, 123.45))
      .rejects.toBeInstanceOf(HarnessConflictError)
  })
  // Note: the Windows rename sharing-violation branch (EPERM/EBUSY →
  // HarnessConflictError + temp cleanup) is not unit-testable cross-platform:
  // it requires a concurrent writer holding the destination, which cannot be
  // provoked deterministically on Linux/macOS. The mtime-conflict path above
  // covers the same retryable-conflict contract users depend on.
})

describe('writeHarnessStates global-failure rollback compensation (P1-fix)', () => {
  it('a conflicting global half rolls the local half back and leaves the winner untouched', async () => {
    const rollbackDir = mkdtempSync(path.join(os.tmpdir(), 'dsh-rlm-rollback-test-'))
    const sid = 'rollback-session'
    const localPath = harnessStatePath(rollbackDir, sid)

    const localBase: HarnessStateFile = { schema: 1, entries: { memory: { l1: makeEntry('memory', 'l1', 'local-base') } }, refinements: [] }
    const globalBase: HarnessStateFile = { schema: 1, entries: { memory: { g1: makeEntry('memory', 'g1', 'global-base') } }, refinements: [] }
    await writeHarnessState(localPath, localBase)
    await writeHarnessState(globalHarnessStatePath(rollbackDir), globalBase)

    const localMeta = await readHarnessStateDetailed(localPath)
    const globalMeta = await readHarnessStateDetailed(globalHarnessStatePath(rollbackDir))
    await new Promise(resolve => setTimeout(resolve, 20))
    await writeHarnessState(globalHarnessStatePath(rollbackDir), { schema: 1, entries: { memory: { g2: makeEntry('memory', 'g2', 'kernel-won') } }, refinements: [] })

    const nextLocal: HarnessStateFile = { schema: 1, entries: { memory: { l1: makeEntry('memory', 'l1', 'local-new') } }, refinements: [] }
    await expect(
      writeHarnessStates(
        rollbackDir, sid, { schema: 1, entries: {}, refinements: [] }, nextLocal,
        { global: globalMeta.mtimeMs, local: localMeta.mtimeMs }),
    ).rejects.toBeInstanceOf(HarnessConflictError)

    const localAfter = await readHarnessState(localPath)
    expect(localAfter.entries.memory?.['l1']?.title).toBe('local-base')
    expect((await readHarnessState(globalHarnessStatePath(rollbackDir))).entries.memory?.['g2']?.title).toBe('kernel-won')

    // Consistent expectations commit both halves in one call.
    const freshLocalMeta = await readHarnessStateDetailed(localPath)
    const freshGlobalMeta = await readHarnessStateDetailed(globalHarnessStatePath(rollbackDir))
    await writeHarnessStates(rollbackDir, sid, { schema: 1, entries: { memory: { g3: makeEntry('memory', 'g3', 'both-new') } }, refinements: [] }, nextLocal, { global: freshGlobalMeta.mtimeMs, local: freshLocalMeta.mtimeMs })
    const localHappy = await readHarnessState(localPath)
    const globalHappy = await readHarnessState(globalHarnessStatePath(rollbackDir))
    expect(localHappy.entries.memory?.['l1']?.title).toBe('local-new')
    expect(globalHappy.entries.memory?.['g3']?.title).toBe('both-new')
  })

  it('a freshly created local file is REMOVED (not left empty) when the global half conflicts', async () => {
    const absentDir = mkdtempSync(path.join(os.tmpdir(), 'dsh-rlm-rollback-absent-'))
    const absentSid = 'absent-session'
    const absentLocalPath = harnessStatePath(absentDir, absentSid)
    expect(existsSync(absentLocalPath)).toBe(false)

    const absentGlobalMeta = await readHarnessStateDetailed(globalHarnessStatePath(absentDir))
    await new Promise(resolve => setTimeout(resolve, 20))
    await writeHarnessState(
      globalHarnessStatePath(absentDir),
      { schema: 1, entries: { memory: { g9: makeEntry('memory', 'g9', 'kernel-absent-won') } }, refinements: [] },
    )
    await expect(
      writeHarnessStates(
        absentDir,
        absentSid,
        { schema: 1, entries: {}, refinements: [] },
        { schema: 1, entries: { memory: { n1: makeEntry('memory', 'n1', 'local-new') } }, refinements: [] },
        { global: absentGlobalMeta.mtimeMs, local: null },
      ),
    ).rejects.toBeInstanceOf(HarnessConflictError)
    expect(existsSync(absentLocalPath)).toBe(false)
  })
})

describe('applyProposalsAndPersist conflict retry converges (FIX-7)', () => {
  it('a conflicted refine retries once and lands the proposal durably', async () => {
    const retryDir = mkdtempSync(path.join(os.tmpdir(), 'dsh-rlm-retry-test-'))
    const sid = 'retry-session'
    const snapshotDir = path.join(path.dirname(harnessStatePath(retryDir, sid)), 'refinements')

    async function bump(): Promise<void> {
      const lp = harnessStatePath(retryDir, sid)
      const gp = globalHarnessStatePath(retryDir)
      for (const p of [lp, gp]) {
        try {
          const detailed = await readHarnessStateDetailed(p)
          if (detailed.mtimeMs === null) continue
          await writeHarnessState(p, detailed.state, detailed.mtimeMs)
        } catch {
          // Conflict with the pipeline or the sibling bump: this tick's
          // interference is done; the next timer tick re-reads.
        }
      }
    }
    const timers = [5, 35, 80].map(ms => setTimeout(() => { void bump().catch(() => undefined) }, ms))

    const persisted = await applyProposalsAndPersist(
      retryDir,
      sid,
      [{ action: 'upsert', kind: 'memory', title: 'retry-entry', content: 'landed despite conflict', evidence: 'ev' }] as Parameters<typeof applyProposalsAndPersist>[2],
      snapshotDir,
      100,
      '/refine',
    ).finally(() => timers.forEach(clearTimeout))

    expect(persisted.applied).toBe(true)
    expect(persisted.eventId.length).toBeGreaterThan(0)
    const landed = await readHarnessState(harnessStatePath(retryDir, sid))
    const entry = Object.values(landed.entries.memory ?? {}).find(e => e.title === 'retry-entry')
    expect(entry?.content).toBe('landed despite conflict')
    expect(landed.refinements).toHaveLength(1)
  })
})

describe('corrupt state backup (FIX-11)', () => {
  it('a corrupt file reads as empty and is backed up before zeroing', async () => {
    const corruptPath = path.join(path.dirname(statePath), 'corrupt_state.json')
    await writeFile(corruptPath, '{ this is not valid json', 'utf8')
    const state = await readHarnessState(corruptPath)
    expect(Object.keys(state.entries)).toHaveLength(0)
    const backups = readdirSync(path.dirname(corruptPath)).filter(f => f.startsWith('corrupt_state.json.corrupt-'))
    expect(backups).toHaveLength(1)
  })
})

describe('renderHarnessOverview char budget (FIX-10)', () => {
  it('truncates per-entry content and enforces the total char budget', () => {
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
    const longLine = rendered.split('\n').find(l => l.includes('t1'))
    expect(longLine?.endsWith('…') ?? false).toBe(true)
    expect(longLine?.includes('t1') ?? false).toBe(true)

    const tiny = renderHarnessOverview(state, { maxTotalChars: 60 })
    expect(tiny.length).toBeLessThanOrEqual(62)
  })
})

describe('auto-refine scheduler (P0)', () => {
  it('review gate parses shouldRefine true and false decisions', async () => {
    const reviewCtx = {
      subagents: {
        start: async (_provider: string, _req: unknown) => ({
          result: { shouldRefine: true, rationale: 'reusable tactic emerged' },
          dispose: async () => undefined,
        }),
      },
      sessions: { get: () => undefined },
    } as unknown as Context
    const decision = await reviewAutoRefine(reviewCtx, 'rev-session' as SessionId, { id: 'rev-agent' } as never, 'spawn', new AbortController().signal)
    expect(decision.shouldRefine).toBe(true)
    expect(decision.rationale).toContain('reusable')

    const reviewCtx2 = {
      subagents: {
        start: async (_provider: string, _req: unknown) => ({
          result: { shouldRefine: false, rationale: 'nothing reusable' },
          dispose: async () => undefined,
        }),
      },
      sessions: { get: () => undefined },
    } as unknown as Context
    const decision2 = await reviewAutoRefine(reviewCtx2, 'rev-session' as SessionId, { id: 'rev-agent' } as never, 'spawn', new AbortController().signal)
    expect(decision2.shouldRefine).toBe(false)
  })

  it('disabled auto-refine registers no listener; enabled fires after turnInterval root idle events', async () => {
    let registered = false
    const disabledCtx = {
      on: () => { registered = true; return () => undefined },
      agents: { currentInitiator: () => undefined },
      subagents: { start: async () => ({ result: {}, dispose: async () => undefined }) },
      effect: (fn: () => unknown) => fn(),
    } as unknown as Context
    registerAutoRefine(disabledCtx, baseDir, { refineProvider: 'spawn' }, { enabled: false, turnInterval: 1, cooldownMs: 0 })
    expect(registered).toBe(false)

    let refineCalls = 0
    let capturedHandler: ((p: { agent: { id: string }; status: 'idle' | 'running' }) => Promise<void>) | undefined
    const enabledCtx = {
      on: (_event: string, handler: (p: { agent: { id: string }; status: 'idle' | 'running' }) => Promise<void>) => { capturedHandler = handler; return () => undefined },
      agents: { currentInitiator: () => undefined },
      subagents: {
        start: async (_provider: string, req: { outputSchema?: unknown }) => {
          if (req.outputSchema && JSON.stringify(req.outputSchema).includes('shouldRefine')) {
            return { result: { shouldRefine: true, rationale: 'ok' }, dispose: async () => undefined }
          }
          refineCalls++
          return { result: { proposals: [] }, dispose: async () => undefined }
        },
      },
      effect: (fn: () => unknown) => fn(),
      sessions: { get: () => undefined },
    } as unknown as Context
    registerAutoRefine(enabledCtx, baseDir, { refineProvider: 'spawn' }, { enabled: true, turnInterval: 3, cooldownMs: 0 })
    expect(typeof capturedHandler).toBe('function')

    const rootAgent = { id: 'root-agent' }
    for (let i = 1; i <= 3; i++) {
      await capturedHandler!({ agent: rootAgent as never, status: 'idle' })
    }
    expect(refineCalls).toBe(1)
  })

  it('child-agent idle events never trigger refine', async () => {
    let refineCalls = 0
    let capturedHandler: ((p: { agent: { id: string }; status: 'idle' | 'running' }) => Promise<void>) | undefined
    const childCtx = {
      on: (_event: string, handler: (p: { agent: { id: string }; status: 'idle' | 'running' }) => Promise<void>) => { capturedHandler = handler; return () => undefined },
      agents: { currentInitiator: () => ({ id: 'parent' }) },
      subagents: { start: async () => { refineCalls++; return { result: { proposals: [] }, dispose: async () => undefined } } },
      effect: (fn: () => unknown) => fn(),
      sessions: { get: () => undefined },
    } as unknown as Context
    registerAutoRefine(childCtx, baseDir, { refineProvider: 'spawn' }, { enabled: true, turnInterval: 1, cooldownMs: 0 })
    for (let i = 1; i <= 3; i++) {
      await capturedHandler!({ agent: { id: 'child-agent' } as never, status: 'idle' })
    }
    expect(refineCalls).toBe(0)
  })
})

describe('runRefine forces non-reasoning (P2-B)', () => {
  it('requests reasoningEffort none on the extraction child', async () => {
    let captured: unknown = undefined
    const baseDirP2 = mkdtempSync(path.join(os.tmpdir(), 'dsh-rlm-p2b-'))
    const p2Ctx = {
      subagents: {
        start: async (_provider: string, req: unknown) => {
          captured = req
          return { result: { proposals: [] }, dispose: async () => undefined }
        },
      },
      sessions: { get: () => undefined },
    } as unknown as Context
    await runRefine(p2Ctx, 'p2b-session' as SessionId, baseDirP2, { id: 'p2b-agent' } as never, 'spawn', new AbortController().signal)
    const req = captured as { agentOptions?: { reasoningEffort?: string } }
    expect(req?.agentOptions?.reasoningEffort).toBe('none')
  })
})
