/**
 * Belief-node semantics (BUILD.md Phase A item 1): verdict → node effects,
 * edges written at judgment time, target verdicts, event-only verdicts,
 * rebuild equivalence of the belief graph, and change listeners.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RlmJudgmentError, RlmStore } from '../src/store.ts'
import type { RlmScope } from '../src/store.ts'
import { withBaseCriteria } from '../src/criteria.ts'

let root: string
const session: RlmScope = { kind: 'session', id: 'beliefs-1' }

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'rlm-beliefs-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function newStore(): RlmStore {
  return withBaseCriteria(new RlmStore(root))
}

async function seedObservation(store: RlmStore): Promise<number> {
  const event = await store.append(session, 'rlm/observation', { kind: 'user-message' })
  return event.seq
}

describe('belief nodes', () => {
  it('creating verdicts insert nodes with edges and verification bookkeeping', async () => {
    const store = newStore()
    const seq = await seedObservation(store)
    await store.judge(session, {
      criterionRef: 'crit/loop-three-line-header',
      verdict: 'check-pass',
      belief: {
        kind: 'procedural',
        content: 'round 1 verified: contract target reached',
        title: 'loop progress',
        subject: 'loop_run_1',
        basedOn: [],
        lastVerified: { channel: 'loop-three-line-header', eventPos: seq },
      },
      dataSupport: { summary: 'complete/clean/aligned' },
      provenance: { eventRange: [seq, seq] },
    })
    const beliefs = store.beliefs(session)
    expect(beliefs).toHaveLength(1)
    expect(beliefs[0]).toMatchObject({
      kind: 'procedural',
      grade: 'provisional',
      status: 'active',
      criterionRef: 'crit/loop-three-line-header',
      subject: 'loop_run_1',
      createdAt: 2,
      lastVerified: { channel: 'loop-three-line-header', eventPos: 1 },
    })
    expect(beliefs[0]?.id).toHaveLength(16)
  })

  it('demotion degrades; voiding voids; both require an existing target', async () => {
    const store = newStore()
    await seedObservation(store)
    await store.judge(session, {
      criterionRef: 'crit/verify-eq31-tournament',
      verdict: 'selection',
      belief: { kind: 'declarative', content: 'candidate B is the best answer', subject: 'q-42' },
      dataSupport: { summary: 'tournament winner' },
      provenance: { eventRange: [1, 1] },
    })
    const id = store.beliefs(session)[0]!.id

    await store.judge(session, {
      criterionRef: 'crit/verify-eq31-tournament',
      verdict: 'demotion',
      target: id,
      dataSupport: { summary: 'winner contradicted by a newer observation' },
      provenance: { eventRange: [1, 2] },
    })
    expect(store.beliefs(session)).toHaveLength(0)
    expect(store.getBelief(session, id)).toMatchObject({ status: 'degraded', grade: 'provisional' })

    await store.judge(session, {
      criterionRef: 'crit/verify-eq31-tournament',
      verdict: 'voiding',
      target: id,
      dataSupport: { summary: 'superseded by re-derivation' },
      provenance: { eventRange: [1, 3] },
    })
    expect(store.getBelief(session, id)).toMatchObject({ status: 'voided' })

    await expect(store.judge(session, {
      criterionRef: 'crit/verify-eq31-tournament',
      verdict: 'voiding',
      target: 'nonexistent',
      dataSupport: { summary: 'x' },
      provenance: { eventRange: [1, 3] },
    })).rejects.toBeInstanceOf(RlmJudgmentError)
  })

  it('supersedes and basedOn edges are recorded at judgment time', async () => {
    const store = newStore()
    const seq = await seedObservation(store)
    await store.judge(session, {
      criterionRef: 'crit/moa-aggregator',
      verdict: 'merge',
      belief: { kind: 'declarative', content: 'synthesis v1', subject: 'topic-a' },
      dataSupport: { summary: 'aggregator output' },
      provenance: { eventRange: [seq, seq] },
    })
    const v1 = store.beliefs(session)[0]!
    await store.judge(session, {
      criterionRef: 'crit/moa-aggregator',
      verdict: 'conclusion',
      belief: {
        kind: 'declarative',
        content: 'synthesis v2',
        subject: 'topic-a',
        supersedes: { id: v1.id, reason: 'newer references arrived' },
        basedOn: [v1.id],
      },
      dataSupport: { summary: 'aggregator output v2' },
      provenance: { eventRange: [seq, 2] },
    })
    // v1 was voided by the supersedes edge (mechanical), so only v2 is active.
    const active = store.beliefs(session)
    expect(active).toHaveLength(1)
    const v2 = active[0]!
    expect(v2.id).not.toBe(v1.id)
    expect(store.getBelief(session, v1.id)).toMatchObject({ status: 'voided' })
    expect(v2.supersedes).toEqual({ id: v1.id, reason: 'newer references arrived' })
    expect(v2.basedOn).toEqual([v1.id])
  })

  it('open-tier criteria cannot promote (tier gate reaches belief creation)', async () => {
    const store = newStore()
    const seq = await seedObservation(store)
    await expect(store.judge(session, {
      criterionRef: 'crit/moa-aggregator',
      verdict: 'promotion',
      belief: { kind: 'declarative', content: 'x' },
      dataSupport: { summary: 'x' },
      provenance: { eventRange: [seq, seq] },
    })).rejects.toThrow(/open-tier/)
  })

  it('event-only verdicts touch no node but land as events', async () => {
    const store = newStore()
    const seq = await seedObservation(store)
    const event = await store.judge(session, {
      criterionRef: 'crit/loop-three-line-header',
      verdict: 'check-doubt',
      dataSupport: { summary: 'integrity suspect; nothing trusted' },
      provenance: { eventRange: [seq, seq] },
    })
    expect(event.type).toBe('rlm/judgment')
    expect(store.beliefs(session)).toHaveLength(0)
    expect(store.view(session).countsByType['rlm/judgment']).toBe(1)
  })

  it('rebuild reproduces the belief graph exactly (shared reducer)', async () => {
    const store = newStore()
    const seq = await seedObservation(store)
    await store.judge(session, {
      criterionRef: 'crit/loop-three-line-header',
      verdict: 'check-pass',
      belief: { kind: 'procedural', content: 'progress note A', subject: 'run-1' },
      dataSupport: { summary: 'clean audit' },
      provenance: { eventRange: [seq, seq] },
    })
    const id = store.beliefs(session)[0]!.id
    await store.judge(session, {
      criterionRef: 'crit/verify-eq31-tournament',
      verdict: 'demotion',
      target: id,
      dataSupport: { summary: 'contradicted' },
      provenance: { eventRange: [1, 2] },
    })

    const before = store.view(session)
    const store2 = newStore()
    const after = await store2.ensureLoaded(session)
    expect(after.beliefs).toEqual(before.beliefs)
    expect(after.seq).toBe(before.seq)
    expect(after.countsByType).toEqual(before.countsByType)
  })

  it('onChange fires after writes with the updated view; unsubscribe works', async () => {
    const store = newStore()
    const listener = vi.fn()
    const off = store.onChange(listener)
    const seq = await seedObservation(store)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener.mock.calls[0]?.[1].seq).toBe(seq)
    off()
    await store.append(session, 'rlm/observation', {})
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
