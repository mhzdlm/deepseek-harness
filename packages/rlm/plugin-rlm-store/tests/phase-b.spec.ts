/**
 * Phase B escort mechanisms, end to end — this file doubles as the exit
 * demonstration (BUILD.md Phase B exit):
 * 1. stale construction → mechanical demotion → closure propagation;
 * 2. conflict observation → trigger ⑥ nomination (hard + soft);
 * 3. density alarm → evidenced promotion locked, provisional release;
 * 4. rollback verdict → closure void + re-read key report + reconciliation.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RlmStore } from '../src/store.ts'
import type { RlmScope, RlmStoreOptions } from '../src/store.ts'
import { withBaseCriteria } from '../src/criteria.ts'

let root: string
const session: RlmScope = { kind: 'session', id: 'phase-b' }

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'rlm-phase-b-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function newStore(options: RlmStoreOptions = {}): RlmStore {
  return withBaseCriteria(new RlmStore(root, { densityAlarmActions: 3, internalClockDistance: 5, ...options }))
}

describe('Phase B · freshness (stale → demotion → propagation)', () => {
  it('an external checkpoint change demotes the belief and floods dependents', async () => {
    const store = newStore()
    // The observation carries the touch — mechanical derivation needs no declared edge.
    await store.append(session, 'rlm/observation', {
      kind: 'user-message',
      touches: [{ key: 'report.md', checkpoint: 'rev-1' }],
    })
    await store.judge(session, {
      criterionRef: 'crit/verify-eq31-tournament',
      verdict: 'conclusion',
      belief: { kind: 'declarative', content: 'report.md states the deadline is Friday', subject: 'deadline' },
      dataSupport: { summary: 'read from report.md' },
      provenance: { eventRange: [1, store.view(session).seq] },
    })
    // A dependent belief derives from it (declared edge drives *propagation*).
    await store.judge(session, {
      criterionRef: 'crit/moa-aggregator',
      verdict: 'merge',
      belief: {
        kind: 'declarative',
        content: 'plan assumes the Friday deadline',
        subject: 'plan',
        basedOn: [store.beliefs(session)[0]!.id],
      },
      dataSupport: { summary: 'synthesis over the deadline reading' },
      provenance: { eventRange: [1, store.view(session).seq] },
    })

    // Fresh before the world moves.
    expect(store.evaluateFreshness(session).every(v => !v.stale)).toBe(true)

    // The world moves: reconciliation reports the new checkpoint.
    await store.recordWorldReconciliation(session, [{ key: 'report.md', checkpoint: 'rev-2' }], 'periodic re-read')

    const verdicts = store.evaluateFreshness(session)
    const deadline = verdicts.find(v => v.beliefId === store.beliefs(session)[0]?.id)
    const plan = verdicts.find(v => v.beliefId === store.beliefs(session)[1]?.id)
    expect(deadline?.clock).toBe('external')
    expect(deadline?.stale).toBe(true)
    expect(deadline?.reasons[0]).toContain('report.md')
    // Pessimistic mix: the plan inherits the external clock through basedOn.
    expect(plan?.clock).toBe('external')
    expect(plan?.stale).toBe(true)

    // Mechanical enforcement: one demotion floods the dependent closure —
    // the plan degrades by propagation, not by a second judgment.
    const acted = await store.enforceFreshness(session)
    expect(acted).toHaveLength(1)
    expect(store.beliefs(session)).toHaveLength(0) // everything degraded
    const nodes = store.view(session).beliefs
    expect(nodes.map(b => b.status)).toEqual(['degraded', 'degraded'])
    expect(nodes.every(b => b.grade === 'provisional')).toBe(true)
  })

  it('the internal clock ages experience beliefs; analytic beliefs never age', async () => {
    const store = newStore()
    await store.append(session, 'rlm/observation', { n: 0 })
    await store.judge(session, {
      criterionRef: 'crit/loop-three-line-header',
      verdict: 'check-pass',
      belief: { kind: 'procedural', content: 'experience: cachewarm loops help here', lastVerified: { channel: 'loop', eventPos: 1 } },
      dataSupport: { summary: 'audited experience' },
      provenance: { eventRange: [1, store.view(session).seq] },
    })
    await store.append(session, 'rlm/observation', { content: 'an untethered analytic statement for testing' })
    await store.judge(session, {
      criterionRef: 'crit/moa-aggregator',
      verdict: 'conclusion',
      belief: { kind: 'declarative', content: '2+2 remains 4 in this scope', lastVerified: { channel: 'analytic', eventPos: 2 } },
      dataSupport: { summary: 'arithmetic' },
      provenance: { eventRange: [1, store.view(session).seq] },
    })

    // Age the stream past the internal clock distance.
    for (let i = 0; i < 7; i++) await store.append(session, 'rlm/mechanical', { i })

    const verdicts = store.evaluateFreshness(session)
    const byId = new Map(verdicts.map(v => [v.beliefId, v]))
    const experience = store.view(session).beliefs[0]!
    const analytic = store.view(session).beliefs[1]!
    expect(byId.get(experience.id)).toMatchObject({ clock: 'internal', stale: true })
    expect(byId.get(analytic.id)).toMatchObject({ clock: 'analytic', stale: false })
  })
})

describe('Phase B · closure invariant (F4)', () => {
  it('voiding floods the closure; no active belief rests on a voided one', async () => {
    const store = newStore()
    await store.append(session, 'rlm/observation', { n: 0 })
    await store.judge(session, {
      criterionRef: 'crit/moa-aggregator',
      verdict: 'conclusion',
      belief: { kind: 'declarative', content: 'A: the base fact', subject: 'A' },
      dataSupport: { summary: 'observed' },
      provenance: { eventRange: [1, store.view(session).seq] },
    })
    const a = store.beliefs(session)[0]!.id
    await store.judge(session, {
      criterionRef: 'crit/moa-aggregator',
      verdict: 'conclusion',
      belief: { kind: 'declarative', content: 'B: derived from A', subject: 'B', basedOn: [a] },
      dataSupport: { summary: 'derived' },
      provenance: { eventRange: [1, store.view(session).seq] },
    })
    const b = store.beliefs(session).find(x => x.subject === 'B')!.id
    await store.judge(session, {
      criterionRef: 'crit/moa-aggregator',
      verdict: 'conclusion',
      belief: { kind: 'declarative', content: 'C: derived from B', subject: 'C', basedOn: [b] },
      dataSupport: { summary: 'derived again' },
      provenance: { eventRange: [1, store.view(session).seq] },
    })

    await store.judge(session, {
      criterionRef: 'crit/freshness-clock',
      verdict: 'voiding',
      target: a,
      dataSupport: { summary: 'the base fact was retracted' },
      provenance: { eventRange: [1, store.view(session).seq] },
    })

    expect(store.beliefs(session)).toHaveLength(0)
    expect(store.view(session).beliefs.map(x => x.status)).toEqual(['voided', 'voided', 'voided'])
    expect(store.checkClosureInvariant(session)).toEqual([])
  })
})

describe('Phase B · judgment-density alarm (lock the gate, not the engine)', () => {
  it('locks evidenced promotion, releases on a check, escalates on the chain', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = newStore() // densityAlarmActions: 3, internalClockDistance: 5
    const seed = async () => {
      await store.append(session, 'rlm/observation', { n: 1 })
      await store.judge(session, {
        criterionRef: 'crit/verify-eq31-tournament',
        verdict: 'selection',
        belief: { kind: 'declarative', content: `selection ${store.view(session).seq}` },
        dataSupport: { summary: 'tournament' },
        provenance: { eventRange: [1, store.view(session).seq] },
      })
    }
    await seed()
    const belief = store.beliefs(session)[0]!

    // Three non-judgment actions: the alarm arms.
    for (let i = 0; i < 3; i++) await store.append(session, 'rlm/mechanical', { i })
    expect(store.alarmState(session)).toMatchObject({ active: true, actionsSinceJudgment: 3 })

    // Promotion is locked.
    await expect(store.judge(session, {
      criterionRef: 'crit/verify-eq31-tournament',
      verdict: 'promotion',
      belief: { kind: 'declarative', content: 'promote attempt under alarm' },
      dataSupport: { summary: 'x' },
      provenance: { eventRange: [1, store.view(session).seq] },
    })).rejects.toThrow(/promotion locked by the judgment-density alarm/)

    // Provisional-level work continues.
    const landed = await store.judge(session, {
      criterionRef: 'crit/verify-eq31-tournament',
      verdict: 'check-pass',
      belief: { kind: 'declarative', content: 'provisional finding under alarm' },
      dataSupport: { summary: 'still allowed' },
      provenance: { eventRange: [1, store.view(session).seq] },
    })
    expect(landed.type).toBe('rlm/judgment')
    expect(store.alarmState(session).active).toBe(false)

    // Escalation: accrue another full threshold of non-judgment actions.
    for (let i = 0; i < 3; i++) await store.append(session, 'rlm/mechanical', { i })
    expect(store.alarmState(session).escalations).toBeGreaterThanOrEqual(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('judgment-density escalation'))

    // A real check releases the alarm again...
    await store.judge(session, {
      criterionRef: 'crit/verify-eq31-tournament',
      verdict: 'check-pass',
      belief: { kind: 'declarative', content: 'releasing check after escalation' },
      dataSupport: { summary: 'gate re-opened' },
      provenance: { eventRange: [1, store.view(session).seq] },
    })

    // ...and a promotion released by a real check goes through.
    await store.judge(session, {
      criterionRef: 'crit/verify-eq31-tournament',
      verdict: 'promotion',
      belief: { kind: 'declarative', content: 'promote after the alarm released' },
      dataSupport: { summary: 'gate open' },
      provenance: { eventRange: [1, store.view(session).seq] },
    })
    expect(store.beliefs(session).some(b => b.grade === 'evidenced')).toBe(true)
    void belief
    warn.mockRestore()
  })
})

describe('Phase B · trigger ⑥ conflict surfacing', () => {
  it('hard (subject) and soft (lexical) nominations are raised mechanically', async () => {
    const store = newStore()
    await store.append(session, 'rlm/observation', { n: 0 })
    await store.judge(session, {
      criterionRef: 'crit/moa-aggregator',
      verdict: 'conclusion',
      belief: {
        kind: 'declarative',
        content: 'the deployment pipeline deploys every Friday afternoon',
        subject: 'deploy-schedule',
      },
      dataSupport: { summary: 'stated by the operator' },
      provenance: { eventRange: [1, store.view(session).seq] },
    })

    // Hard: an observation about the same subject.
    await store.append(session, 'rlm/observation', { subject: 'deploy-schedule', content: 'the operator says schedules changed' })
    // Soft: an observation lexically overlapping the belief content (observe grade).
    await store.append(session, 'rlm/observation', { content: 'does the deployment pipeline really deploy every Friday afternoon?' })
    // Unrelated: no nomination.
    await store.append(session, 'rlm/observation', { content: 'quantum chromodynamics governs quarks' })

    const nominations = store.view(session).pendingChecks
    expect(nominations.some(x => x.kind === 'hard' && x.beliefIds.length > 0)).toBe(true)
    expect(nominations.some(x => x.kind === 'soft' && x.beliefIds.length > 0)).toBe(true)
    expect(nominations).toHaveLength(2)
  })
})

describe('Phase B · rollback verdict (three-step protocol)', () => {
  it('voids the closure, reports re-read keys, and the reconciliation closes the loop', async () => {
    const store = newStore()
    await store.append(session, 'rlm/observation', {
      kind: 'user-message',
      touches: [{ key: 'spec.md', checkpoint: 'r1' }],
    })
    await store.judge(session, {
      criterionRef: 'crit/verify-eq31-tournament',
      verdict: 'selection',
      belief: { kind: 'declarative', content: 'the spec requires oauth1', subject: 'auth' },
      dataSupport: { summary: 'read from spec.md' },
      provenance: { eventRange: [1, store.view(session).seq] },
    })
    const auth = store.beliefs(session)[0]!.id
    await store.judge(session, {
      criterionRef: 'crit/moa-aggregator',
      verdict: 'merge',
      belief: { kind: 'declarative', content: 'plan built on oauth1 reading', subject: 'auth-plan', basedOn: [auth] },
      dataSupport: { summary: 'synthesis' },
      provenance: { eventRange: [1, store.view(session).seq] },
    })

    // Rollback the oauth1 reading.
    const report = await store.executeRollback(session, auth, 'the oauth1 reading was a misparse')
    expect(report.voidedIds).toContain(auth)
    expect(report.voidedIds.length).toBeGreaterThanOrEqual(2)
    expect(report.reReadKeys).toContain('spec.md')

    // No active belief rests on the retracted foundation.
    expect(store.checkClosureInvariant(session)).toEqual([])

    // The caller re-reads spec.md and injects the delta as a new observation:
    // the world is never rolled back — the difference re-enters state.
    await store.recordWorldReconciliation(session, [{ key: 'spec.md', checkpoint: 'r1' }], 're-read after rollback: actually oauth2')
    await store.judge(session, {
      criterionRef: 'crit/verify-eq31-tournament',
      verdict: 'conclusion',
      belief: { kind: 'declarative', content: 'the spec requires oauth2', subject: 'auth' },
      dataSupport: { summary: 're-read of spec.md after rollback' },
      provenance: { eventRange: [report.seq, store.view(session).seq] },
    })
    expect(store.beliefs(session).map(b => b.subject)).toContain('auth')
  })

  it('rebuild reproduces the whole Phase B view (ledger, beliefs, propagation)', async () => {
    const store = newStore()
    await store.append(session, 'rlm/observation', { touches: [{ key: 'k', checkpoint: 'c1' }], content: 'seed observation tokens alpha beta gamma' })
    await store.judge(session, {
      criterionRef: 'crit/verify-eq31-tournament',
      verdict: 'conclusion',
      belief: { kind: 'declarative', content: 'a derived claim tokens alpha beta gamma', subject: 's' },
      dataSupport: { summary: 'x' },
      provenance: { eventRange: [1, store.view(session).seq] },
    })
    const id = store.beliefs(session)[0]!.id
    await store.judge(session, {
      criterionRef: 'crit/freshness-clock',
      verdict: 'demotion',
      target: id,
      dataSupport: { summary: 'external clock moved' },
      provenance: { eventRange: [1, store.view(session).seq] },
    })

    const store2 = newStore()
    const after = await store2.ensureLoaded(session)
    const before = store.view(session)
    expect(after.beliefs).toEqual(before.beliefs)
    expect(after.touchLedger).toEqual(before.touchLedger)
    expect(after.pendingChecks).toEqual(before.pendingChecks)
    expect(after.actionsSinceJudgment).toBe(before.actionsSinceJudgment)
    expect(store2.checkClosureInvariant(session)).toEqual([])
  })
})
