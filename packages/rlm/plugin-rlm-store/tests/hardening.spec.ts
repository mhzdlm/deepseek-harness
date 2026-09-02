/**
 * Hardening regression (post-Phase-D review batch): the freeze/unfreeze exact
 * restore (B5), the process-local escalation counter (B6), the serialized
 * write path under concurrency (B7), and the F4 invariant checker's positive
 * case (a violation is actually detected).
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RlmStore } from '../src/store.ts'
import type { RlmScope } from '../src/store.ts'
import { withBaseCriteria } from '../src/criteria.ts'

let root: string
const session: RlmScope = { kind: 'session', id: 'hardening' }

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'rlm-hardening-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function newStore(): RlmStore {
  return withBaseCriteria(new RlmStore(root, { densityAlarmActions: 3, internalClockDistance: 1000 }))
}

async function seedBelief(store: RlmStore, content: string, subject: string, basedOn?: string[]): Promise<string> {
  await store.append(session, 'rlm/observation', { kind: 'user-message' })
  await store.judge(session, {
    criterionRef: 'crit/verify-eq31-tournament',
    verdict: 'conclusion',
    belief: { kind: 'declarative', content, subject, ...(basedOn ? { basedOn } : {}) },
    dataSupport: { summary: 'seed' },
    provenance: { eventRange: [1, store.view(session).seq] },
  })
  const belief = store.beliefs(session).at(-1)
  if (!belief) throw new Error('seed failed')
  return belief.id
}

const range = (store: RlmStore) => [1, store.view(session).seq] as const

describe('B5 · freeze/unfreeze restores the exact prior status', () => {
  it('a degraded belief comes back degraded, not revived to active', async () => {
    const store = newStore()
    const id = await seedBelief(store, 'the api token expires hourly', 'api-token')
    await store.judge(session, {
      criterionRef: 'crit/freshness-clock', verdict: 'demotion', target: id,
      dataSupport: { summary: 'stale' }, provenance: { eventRange: range(store) },
    })
    expect(store.getBelief(session, id)?.status).toBe('degraded')

    await store.judge(session, {
      criterionRef: 'crit/audit-freeze', verdict: 'freeze', target: id,
      dataSupport: { summary: 'freeze' }, provenance: { eventRange: range(store) },
    })
    expect(store.getBelief(session, id)?.status).toBe('frozen')
    await store.judge(session, {
      criterionRef: 'crit/audit-release', verdict: 'unfreeze', target: id,
      dataSupport: { summary: 'human release' }, provenance: { eventRange: range(store) },
    })
    expect(store.getBelief(session, id)?.status).toBe('degraded')
    // Rebuild equivalence: the restore must survive a replay.
    await store.rebuild(session)
    expect(store.getBelief(session, id)?.status).toBe('degraded')
  })
})

describe('B6 · escalation counter is process-local, not view state', () => {
  it('the view carries no escalation field; the counter survives a rebuild', async () => {
    const store = newStore()
    for (let i = 0; i < 3; i += 1) await store.append(session, 'rlm/observation', { kind: 'note', n: i })
    expect(store.alarmState(session).escalations).toBe(1)
    expect('escalations' in store.view(session)).toBe(false)
    await store.rebuild(session)
    // Process-local throttle state persists across rebuilds; the view stays
    // fully replayable (append/rebuild equivalence restored).
    expect(store.alarmState(session).escalations).toBe(1)
  })
})

describe('B7 · the write path serializes per scope', () => {
  it('concurrent appends never produce duplicate or skipped seqs', async () => {
    const store = newStore()
    const events = await Promise.all(
      Array.from({ length: 10 }, (_, i) => store.append(session, 'rlm/observation', { kind: 'note', n: i })),
    )
    const seqs = events.map(e => e.seq).sort((a, b) => a - b)
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    // The on-disk stream agrees (rebuild would throw on a gap or duplicate).
    const fresh = withBaseCriteria(new RlmStore(root))
    expect((await fresh.rebuild(session)).seq).toBe(10)
  })
})

describe('F4 · the closure invariant checker has a positive case', () => {
  it('a supersedes revision that strands a dependent is detected, on the live view and after rebuild', async () => {
    const store = newStore()
    const a = await seedBelief(store, 'base fact', 'base')
    const b = await seedBelief(store, 'derived claim', 'derived', [a])
    // A revision of A voids A but does NOT flood A's dependents (supersedes is
    // point replacement; closure flooding belongs to voiding/demotion).
    await store.judge(session, {
      criterionRef: 'crit/verify-eq31-tournament',
      verdict: 'conclusion',
      belief: { kind: 'declarative', content: 'base fact v2', subject: 'base', supersedes: { id: a, reason: 'revision' } },
      dataSupport: { summary: 'revise base' },
      provenance: { eventRange: range(store) },
    })
    const violations = store.checkClosureInvariant(session)
    expect(violations).toEqual([b])
    await store.rebuild(session)
    expect(store.checkClosureInvariant(session)).toEqual([b])
  })
})
