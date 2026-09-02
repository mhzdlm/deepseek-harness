/**
 * Behavior tests for the unified store skeleton (docs 仓 BUILD.md Phase 0 exit):
 * append/rebuild on an empty stream, the judgment channel's four formal
 * requirements, the single-write-path gates, and stream-is-authority
 * (rebuild regenerates the view; the state file is only a cache).
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RlmJudgmentError, RlmStore, RlmStoreFormatError } from '../src/store.ts'
import type { RlmScope } from '../src/store.ts'

let root: string

const session: RlmScope = { kind: 'session', id: 'sess-1' }
const mailbox: RlmScope = { kind: 'mailbox' }

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'rlm-store-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function newStore(): RlmStore {
  return new RlmStore(root)
}

function seedCriterion(store: RlmStore, id = 'crit/test', tier: 'deterministic' | 'structured' | 'open' = 'deterministic'): string {
  store.registerCriterion({ id, tier, title: 'test criterion' })
  return id
}

describe('RlmStore append / rebuild', () => {
  it('appends to an empty stream with 1-based sequence and a readable line', async () => {
    const store = newStore()
    const event = await store.append(session, 'rlm/observation', { kind: 'user-message' })
    expect(event.seq).toBe(1)
    const raw = await readFile(path.join(root, 'session', 'sess-1', 'events.jsonl'), 'utf8')
    const lines = raw.trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]!)).toMatchObject({ seq: 1, type: 'rlm/observation' })
    expect(store.view(session).eventCount).toBe(1)
    expect(store.view(session).countsByType['rlm/observation']).toBe(1)
  })

  it('keeps session and mailbox streams independent', async () => {
    const store = newStore()
    await store.append(session, 'rlm/observation', {})
    await store.append(session, 'rlm/observation', {})
    const mailboxEvent = await store.append(mailbox, 'rlm/handoff', { direction: 'publish' })
    expect(mailboxEvent.seq).toBe(1)
    expect(store.view(session).seq).toBe(2)
    expect(store.view(mailbox).seq).toBe(1)
  })

  it('rebuild reproduces the in-memory view exactly', async () => {
    const store = newStore()
    const crit = seedCriterion(store)
    await store.append(session, 'rlm/observation', { kind: 'user-message' })
    await store.append(session, 'rlm/action-boundary', { action: 'rlm()' })
    await store.judge(session, {
      criterionRef: crit,
      verdict: 'conclusion',
      belief: { kind: 'declarative', content: 'the working hypothesis holds for the observed input' },
      dataSupport: { summary: 'observation supports the working hypothesis' },
      provenance: { eventRange: [1, 2] },
    })
    const before = store.view(session)
    const after = await store.rebuild(session)
    expect(after).toEqual(before)
  })

  it('rebuild is the authority: a deleted state cache changes nothing', async () => {
    const store = newStore()
    await store.append(session, 'rlm/mechanical', { note: 'cell ran' })
    const before = store.view(session)
    await rm(path.join(root, 'session', 'sess-1', 'state.json'), { force: true })
    const store2 = newStore()
    const after = await store2.ensureLoaded(session)
    expect(after.seq).toBe(before.seq)
    expect(after.eventCount).toBe(before.eventCount)
  })

  it('refuses streams with unknown event types or malformed lines', async () => {
    const store = newStore()
    await store.append(session, 'rlm/observation', {})
    const stream = path.join(root, 'session', 'sess-1', 'events.jsonl')
    await writeFile(stream, `${JSON.stringify({ seq: 2, type: 'rlm/from-the-future', time: '', payload: {} })}\n`, 'utf8')
    await expect(newStore().rebuild(session)).rejects.toBeInstanceOf(RlmStoreFormatError)
    await writeFile(stream, 'not-json\n', 'utf8')
    await expect(newStore().rebuild(session)).rejects.toBeInstanceOf(RlmStoreFormatError)
  })
})

describe('RlmStore single-write-path gates', () => {
  it('refuses appending a judgment event directly', async () => {
    const store = newStore()
    await expect(store.append(session, 'rlm/judgment', { verdict: 'conclusion' })).rejects.toBeInstanceOf(RlmStoreFormatError)
  })

  it('refuses human revisions outside the mailbox scope', async () => {
    const store = newStore()
    await expect(store.append(session, 'rlm/human-revision', { note: 'edited by hand' })).rejects.toBeInstanceOf(RlmStoreFormatError)
    await expect(store.append(mailbox, 'rlm/human-revision', { note: 'edited by hand' })).resolves.toMatchObject({ seq: 1 })
  })

  it('refuses invalid session scope ids', async () => {
    const store = newStore()
    await expect(store.append({ kind: 'session', id: '../escape' }, 'rlm/observation', {})).rejects.toBeInstanceOf(RlmStoreFormatError)
  })
})

describe('RlmStore judgment channel (four formal requirements)', () => {
  it('admits a well-formed judgment and records the belief; promotion grades evidenced', async () => {
    const store = newStore()
    const crit = seedCriterion(store, 'crit/loop-three-line-header', 'deterministic')
    await store.append(session, 'rlm/observation', {})
    const event = await store.judge(session, {
      criterionRef: crit,
      verdict: 'promotion',
      belief: { kind: 'procedural', content: 'the run reached its contract target' },
      dataSupport: { summary: 'three-line header parsed clean' },
      provenance: { eventRange: [1, 1] },
    })
    expect(event.type).toBe('rlm/judgment')
    expect(event.seq).toBe(2)
    const beliefs = store.view(session).beliefs
    expect(beliefs).toHaveLength(1)
    expect(beliefs[0]).toMatchObject({ grade: 'evidenced', criterionRef: crit, createdAt: 2, status: 'active' })
  })

  it('non-promotion verdicts land provisional', async () => {
    const store = newStore()
    const crit = seedCriterion(store)
    await store.append(session, 'rlm/observation', {})
    await store.judge(session, {
      criterionRef: crit,
      verdict: 'check-pass',
      belief: { kind: 'declarative', content: 'state self-check passed on the touched files' },
      dataSupport: { summary: 'state self-check passed' },
      provenance: { eventRange: [1, 1] },
    })
    expect(store.view(session).beliefs[0]?.grade).toBe('provisional')
  })

  it('creating verdicts except check-pass require a belief payload', async () => {
    const store = newStore()
    const crit = seedCriterion(store)
    await store.append(session, 'rlm/observation', {})
    await expect(store.judge(session, {
      criterionRef: crit,
      verdict: 'conclusion',
      dataSupport: { summary: 'no belief given' },
      provenance: { eventRange: [1, 1] },
    })).rejects.toThrow(/requires a belief payload/)
  })

  it('fails on unregistered criterion reference (requirement 1)', async () => {
    const store = newStore()
    await expect(store.judge(session, {
      criterionRef: 'crit/unknown',
      verdict: 'conclusion',
      belief: { kind: 'declarative', content: 'x' },
      dataSupport: { summary: 'x' },
      provenance: { eventRange: [1, 1] },
    })).rejects.toBeInstanceOf(RlmJudgmentError)
  })

  it('fails on empty data support (requirement 2)', async () => {
    const store = newStore()
    const crit = seedCriterion(store)
    await expect(store.judge(session, {
      criterionRef: crit,
      verdict: 'conclusion',
      dataSupport: { summary: '   ' },
      provenance: { eventRange: [1, 1] },
    })).rejects.toBeInstanceOf(RlmJudgmentError)
  })

  it('fails on illegal verdict form (requirement 3)', async () => {
    const store = newStore()
    const crit = seedCriterion(store)
    await expect(store.judge(session, {
      criterionRef: crit,
      verdict: 'vibes' as never,
      dataSupport: { summary: 'x' },
      provenance: { eventRange: [1, 1] },
    })).rejects.toBeInstanceOf(RlmJudgmentError)
  })

  it('fails on unlocatable provenance range (requirement 4)', async () => {
    const store = newStore()
    const crit = seedCriterion(store)
    await expect(store.judge(session, {
      criterionRef: crit,
      verdict: 'conclusion',
      belief: { kind: 'declarative', content: 'x' },
      dataSupport: { summary: 'x' },
      provenance: { eventRange: [1, 5] },
    })).rejects.toBeInstanceOf(RlmJudgmentError)
  })

  it('open-tier criteria cannot promote to evidenced', async () => {
    const store = newStore()
    seedCriterion(store, 'crit/open-vibe', 'open')
    await store.append(session, 'rlm/observation', {})
    await expect(store.judge(session, {
      criterionRef: 'crit/open-vibe',
      verdict: 'promotion',
      dataSupport: { summary: 'x' },
      provenance: { eventRange: [1, 1] },
    })).rejects.toThrow(/open-tier/)
  })
})
