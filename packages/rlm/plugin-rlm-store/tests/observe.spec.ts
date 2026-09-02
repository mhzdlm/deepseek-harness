/**
 * Observe-grade statistics (BUILD.md 收账面): the report must answer the three
 * calibration questions with exact numbers — density rhythm vs threshold,
 * ⑥ nomination frequency and disposition (full history, not the 64-capped
 * view), and the freshness enforce-would-demote snapshot.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { observeReport, renderObserveReport } from '../src/observe.ts'
import { RlmStore, withBaseCriteria } from '../src/index.ts'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'observe-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

describe('observe · density rhythm', () => {
  it('recomputes escalations with the writer rule and reports the gap distribution', async () => {
    // Threshold 5: five non-judgment events between judgments ⇒ one escalation.
    const store = withBaseCriteria(new RlmStore(join(root, 'store'), { densityAlarmActions: 5 }))
    const scope = { kind: 'session' as const, id: 'rhythm' }
    for (let i = 0; i < 6; i += 1) {
      await store.append(scope, 'rlm/observation', { kind: 'note', content: `observation ${String(i)}` })
    }
    await store.judge(scope, {
      criterionRef: 'crit/freshness-clock', verdict: 'check-pass',
      dataSupport: { summary: 'clean check' }, provenance: { eventRange: [1, store.view(scope).seq] },
    })
    for (let i = 0; i < 3; i += 1) {
      await store.append(scope, 'rlm/observation', { kind: 'note', content: `tail ${String(i)}` })
    }
    const report = await observeReport(join(root, 'store'), { densityAlarmActions: 5 })
    const s = report.scopes.find(x => x.scope === 'session/rhythm')
    expect(s).toBeDefined()
    expect(s?.density.events).toBe(10)
    expect(s?.density.judgments).toBe(1)
    // Six non-judgment events before the judgment: the counter crossed 5 once.
    expect(s?.density.escalations).toBe(1)
    expect(s?.density.escalationMarks).toEqual([{ seq: 5, actions: 5 }])
    // One closed gap (6, the distance to the first judgment) + open tail (3).
    expect(s?.density.gaps.max).toBe(6)
    expect(s?.density.gaps.open).toBe(3)
    expect(s?.density.judgmentRatio).toBeCloseTo(1 / 10)
  })
})

describe('observe · ⑥ nominations', () => {
  it('replays the FULL nomination history (beyond the 64-cap) and associates dispositions', async () => {
    const store = withBaseCriteria(new RlmStore(join(root, 'store'), { densityAlarmActions: 1000 }))
    const scope = { kind: 'session' as const, id: 'triggers' }
    // One belief to collide with.
    await store.append(scope, 'rlm/observation', { kind: 'note', content: 'seed belief about the deploy window schedule' })
    await store.judge(scope, {
      criterionRef: 'crit/refine-whitelist', verdict: 'conclusion',
      belief: { kind: 'declarative', content: 'The deploy window is Sunday 02:00 UTC.', subject: 'deploy-window' },
      dataSupport: { summary: 'operator statement' }, provenance: { eventRange: [1, store.view(scope).seq] },
    })
    // One hard nomination (subject collision) + one soft (lexical overlap ≥ 3).
    await store.append(scope, 'rlm/observation', { kind: 'note', subject: 'deploy-window', content: 'someone mentioned the deploy window again' })
    await store.append(scope, 'rlm/observation', { kind: 'note', content: 'the deploy window sunday schedule changed' })
    const nominations = await store.replayNominations(scope)
    expect(nominations).toHaveLength(2)
    expect(nominations.filter(n => n.kind === 'hard')).toHaveLength(1)
    expect(nominations.filter(n => n.kind === 'soft')).toHaveLength(1)

    // Dispose the hard nomination: a check-pass naming the belief (cleared).
    const belief = store.beliefs(scope)[0]
    expect(belief).toBeDefined()
    await store.judge(scope, {
      criterionRef: 'crit/freshness-clock', verdict: 'check-pass', target: belief?.id ?? '',
      dataSupport: { summary: 'checked the schedule, still holds' }, provenance: { eventRange: [1, store.view(scope).seq] },
    })

    const report = await observeReport(join(root, 'store'), { densityAlarmActions: 1000 })
    const s = report.scopes.find(x => x.scope === 'session/triggers')
    expect(s?.nominations.hard).toBe(1)
    expect(s?.nominations.soft).toBe(1)
    // Both nominations collide on the SAME belief, and dispositions associate
    // by belief — one check-pass clears both triggering records at once.
    expect(s?.nominations.cleared).toBe(2)
    expect(s?.nominations.confirmed).toBe(0)
    expect(s?.nominations.unchecked).toBe(0)
    // The soft one was cleared ⇒ rate 1 (all cleared, no confirmation).
    expect(s?.nominations.softClearedRate).toBe(1)
    expect(s?.nominations.targetlessChecks).toBe(0)
  })

  it('computes the soft cleared rate once soft nominations are dispositioned', async () => {
    const store = withBaseCriteria(new RlmStore(join(root, 'store'), { densityAlarmActions: 1000 }))
    const scope = { kind: 'session' as const, id: 'softrate' }
    await store.append(scope, 'rlm/observation', { kind: 'note', content: 'alpha beta gamma delta note' })
    await store.judge(scope, {
      criterionRef: 'crit/refine-whitelist', verdict: 'conclusion',
      belief: { kind: 'declarative', content: 'alpha beta gamma delta belief' },
      dataSupport: { summary: 'seed' }, provenance: { eventRange: [1, store.view(scope).seq] },
    })
    // Soft nomination (lexical overlap ≥ 3 tokens).
    await store.append(scope, 'rlm/observation', { kind: 'note', content: 'alpha beta gamma epsilon elsewhere' })
    const belief = store.beliefs(scope)[0]
    await store.judge(scope, {
      criterionRef: 'crit/freshness-clock', verdict: 'check-pass', target: belief?.id ?? '',
      dataSupport: { summary: 'cleared' }, provenance: { eventRange: [1, store.view(scope).seq] },
    })
    const report = await observeReport(join(root, 'store'))
    const s = report.scopes.find(x => x.scope === 'session/softrate')
    expect(s?.nominations.soft).toBe(1)
    expect(s?.nominations.cleared).toBe(1)
    expect(s?.nominations.softClearedRate).toBe(1)
  })
})

describe('observe · freshness snapshot', () => {
  it('lists exactly the beliefs enforceFreshness would demote right now', async () => {
    const store = withBaseCriteria(new RlmStore(join(root, 'store'), { internalClockDistance: 10, densityAlarmActions: 1000 }))
    const scope = { kind: 'session' as const, id: 'stale' }
    await store.append(scope, 'rlm/observation', { kind: 'note', content: 'context before the aging belief' })
    await store.judge(scope, {
      criterionRef: 'crit/refine-whitelist', verdict: 'conclusion',
      belief: { kind: 'declarative', content: 'an experience belief that will age out', subject: 'aging' },
      dataSupport: { summary: 'seed' }, provenance: { eventRange: [1, store.view(scope).seq] },
    })
    // Push the internal clock past the distance (10) without a judgment.
    for (let i = 0; i < 12; i += 1) {
      await store.append(scope, 'rlm/observation', { kind: 'note', content: `noise ${String(i)} filler` })
    }
    const report = await observeReport(join(root, 'store'), { densityAlarmActions: 1000, internalClockDistance: 10 })
    const s = report.scopes.find(x => x.scope === 'session/stale')
    expect(s?.freshness.active).toBe(1)
    expect(s?.freshness.stale).toHaveLength(1)
    expect(s?.freshness.stale[0]?.subject).toBe('aging')
    expect(s?.freshness.stale[0]?.reasons.length).toBeGreaterThan(0)
  })
})

describe('observe · mailbox numbers', () => {
  it('counts publishes, pickups, revisions, and pending criterion proposals', async () => {
    const store = withBaseCriteria(new RlmStore(join(root, 'store')))
    // Build mailbox traffic directly (the store package must not depend on memory).
    const sessionA = { kind: 'session' as const, id: 'a' }
    await store.append({ kind: 'mailbox' }, 'rlm/handoff', { action: 'publish', sessionId: 'a', subject: 's1', title: 't', content: 'c', evidence: 'e' })
    await store.judge({ kind: 'mailbox' }, {
      criterionRef: 'crit/refine-whitelist', verdict: 'conclusion',
      belief: { kind: 'declarative', content: 'c', title: 't', subject: 's1' },
      dataSupport: { summary: 'e' }, provenance: { eventRange: [1, store.view({ kind: 'mailbox' }).seq] },
    })
    await store.append(sessionA, 'rlm/handoff', { action: 'decide-handover', sessionId: 'a', subjects: ['s1'] })
    await store.append({ kind: 'mailbox' }, 'rlm/human-revision', { action: 'upsert', subject: 's1', title: 't', content: 'edited by human' })
    await store.append({ kind: 'mailbox' }, 'rlm/handoff', { action: 'criterion-proposal', sessionId: 'a', criterion: 'crit/x', tier: 'structured', reason: 'r' })
    await store.judge({ kind: 'mailbox' }, {
      criterionRef: 'crit/refine-whitelist', verdict: 'conclusion',
      belief: { kind: 'procedural', content: 'Proposed criterion crit/x', title: '[criterion-proposal] crit/x', subject: 'criterion:crit/x' },
      dataSupport: { summary: 'r' }, provenance: { eventRange: [1, store.view({ kind: 'mailbox' }).seq] },
    })

    const report = await observeReport(join(root, 'store'))
    expect(report.mailbox.publishes).toBe(1)
    expect(report.mailbox.decisions).toBe(1)
    expect(report.mailbox.upserts).toBe(1)
    expect(report.mailbox.proposals).toBe(1)
    expect(report.mailbox.approvals).toBe(0)
    // The unapproved criterion belief is pending; s1 is not.
    expect(report.mailbox.pendingProposals).toBe(1)
    expect(report.mailbox.activeBeliefs).toBe(2)
    // Text rendering stays command-surface compact.
    const text = renderObserveReport(report)
    expect(text).toContain('mailbox: 1 publishes')
    expect(text).toContain('(note)')
  })
})

describe('observe · audit section', () => {
  it('counts audit judgments and the pending-review queue depth', async () => {
    const store = withBaseCriteria(new RlmStore(join(root, 'store')))
    const scope = { kind: 'session' as const, id: 'audited' }
    await store.append(scope, 'rlm/observation', { kind: 'note', content: 'seed' })
    await store.judge(scope, {
      criterionRef: 'crit/verify-eq31-tournament', verdict: 'conclusion',
      belief: { kind: 'declarative', content: 'belief under audit', subject: 'auditee' },
      dataSupport: { summary: 'seeded' }, provenance: { eventRange: [1, store.view(scope).seq] },
    })
    const belief = store.beliefs(scope).at(-1)
    if (!belief) throw new Error('seed failed')
    const range = () => [1, store.view(scope).seq] as const
    // One clean audit pass, then a freeze (arbiter rejection), then a release, then a freeze again.
    await store.judge(scope, {
      criterionRef: 'crit/audit-pass', verdict: 'check-pass',
      dataSupport: { summary: 'audit pass: critic model-b raised no objection' },
      provenance: { eventRange: range() },
    })
    await store.judge(scope, {
      criterionRef: 'crit/audit-freeze', verdict: 'freeze', target: belief.id,
      dataSupport: { summary: 'audit freeze: arbiter rejected the criticism — no refs' },
      provenance: { eventRange: range() },
    })
    await store.judge(scope, {
      criterionRef: 'crit/audit-release', verdict: 'unfreeze', target: belief.id,
      dataSupport: { summary: 'audit release (human review): noise objection' },
      provenance: { eventRange: range() },
    })
    await store.judge(scope, {
      criterionRef: 'crit/audit-freeze', verdict: 'freeze', target: belief.id,
      dataSupport: { summary: 'audit freeze: second rejection' },
      provenance: { eventRange: range() },
    })

    const report = await observeReport(join(root, 'store'))
    const s = report.scopes.find(x => x.scope === 'session/audited')
    expect(s?.audit).toEqual({ passes: 1, objectionsAccepted: 0, freezes: 2, releases: 1, frozenPending: 1 })
    const text = renderObserveReport(report)
    expect(text).toContain('audit: 1 pass / 0 objection(s) accepted / 2 freeze(s), 1 released; 1 pending review')
  })
})
