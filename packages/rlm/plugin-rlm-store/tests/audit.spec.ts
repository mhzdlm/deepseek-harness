/**
 * Phase D reverse-filtering audit (BUILD.md Phase D exit demonstration):
 * 1. freeze/unfreeze mechanics + the trust-gate lock (no promotion/merge
 *    through a frozen belief; voiding stays legal);
 * 2. audit pass → check-pass judgment;
 * 3. accepted objection → demotion/voiding on the cited criterion;
 * 4. rejected objection (form failures, unparseable reply) → freeze + the
 *    batch-review queue + human release;
 * 5. the independence hard constraint (critic model ≠ producer model).
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RlmStore } from '../src/store.ts'
import type { RlmScope } from '../src/store.ts'
import { withBaseCriteria } from '../src/criteria.ts'
import { listFrozenForReview, releaseAuditFreeze, runAudit } from '../src/audit.ts'

let root: string
const session: RlmScope = { kind: 'session', id: 'phase-d' }

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'rlm-phase-d-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function newStore(): RlmStore {
  return withBaseCriteria(new RlmStore(root))
}

/** Seed one provisional belief and return its id. */
async function seedBelief(store: RlmStore, content = 'the deploy window is sunday'): Promise<string> {
  await store.append(session, 'rlm/observation', { kind: 'user-message' })
  await store.judge(session, {
    criterionRef: 'crit/verify-eq31-tournament',
    verdict: 'conclusion',
    belief: { kind: 'declarative', content, subject: 'deploy-window' },
    dataSupport: { summary: 'user stated the deploy window' },
    provenance: { eventRange: [1, store.view(session).seq] },
  })
  const belief = store.beliefs(session).at(-1)
  if (!belief) throw new Error('seed failed')
  return belief.id
}

const critic = (reply: unknown) => async () => ({ text: JSON.stringify(reply) })

describe('Phase D · freeze mechanics and the trust-gate lock', () => {
  it('freeze locks promotion and merge through the belief; voiding stays legal', async () => {
    const store = newStore()
    const id = await seedBelief(store)
    const range = [1, store.view(session).seq] as const

    await store.judge(session, {
      criterionRef: 'crit/audit-freeze',
      verdict: 'freeze',
      target: id,
      dataSupport: { summary: 'arbiter rejected a malformed objection' },
      provenance: { eventRange: range },
    })
    expect(store.getBelief(session, id)?.status).toBe('frozen')

    // No promotion through a frozen belief.
    await expect(store.judge(session, {
      criterionRef: 'crit/verify-eq31-tournament',
      verdict: 'promotion',
      belief: {
        kind: 'declarative',
        content: 'the deploy window is sunday',
        subject: 'deploy-window',
        supersedes: { id, reason: 're-verify' },
      },
      dataSupport: { summary: 'attempted re-verification' },
      provenance: { eventRange: [1, store.view(session).seq] },
    })).rejects.toThrow(/frozen pending audit review/)

    // No merge deriving from a frozen belief.
    await expect(store.judge(session, {
      criterionRef: 'crit/moa-aggregator',
      verdict: 'merge',
      belief: { kind: 'declarative', content: 'plan around the frozen fact', basedOn: [id] },
      dataSupport: { summary: 'attempted synthesis' },
      provenance: { eventRange: [1, store.view(session).seq] },
    })).rejects.toThrow(/frozen pending audit review/)

    // A freeze is not a shield against voiding — the audit found a real error.
    await store.judge(session, {
      criterionRef: 'crit/audit-objection',
      verdict: 'voiding',
      target: id,
      dataSupport: { summary: 'objection accepted: the fact is wrong' },
      provenance: { eventRange: [1, store.view(session).seq] },
    })
    expect(store.getBelief(session, id)?.status).toBe('voided')
  })

  it('illegal freeze transitions are refused at the gate', async () => {
    const store = newStore()
    const id = await seedBelief(store)
    const range = () => [1, store.view(session).seq] as const
    await expect(store.judge(session, {
      criterionRef: 'crit/audit-release',
      verdict: 'unfreeze',
      target: id,
      dataSupport: { summary: 'not frozen yet' },
      provenance: { eventRange: range() },
    })).rejects.toThrow(/unfreeze requires a frozen target/)
    await store.judge(session, {
      criterionRef: 'crit/audit-freeze',
      verdict: 'freeze',
      target: id,
      dataSupport: { summary: 'freeze it' },
      provenance: { eventRange: range() },
    })
    await expect(store.judge(session, {
      criterionRef: 'crit/audit-freeze',
      verdict: 'freeze',
      target: id,
      dataSupport: { summary: 'freeze twice' },
      provenance: { eventRange: range() },
    })).rejects.toThrow(/freeze requires a live target/)
    // Release restores the active state.
    await store.judge(session, {
      criterionRef: 'crit/audit-release',
      verdict: 'unfreeze',
      target: id,
      dataSupport: { summary: 'human reviewed and cleared' },
      provenance: { eventRange: range() },
    })
    expect(store.getBelief(session, id)?.status).toBe('active')
  })
})

describe('Phase D · reverse-filtering pipeline', () => {
  it('a clean critic reply lands a check-pass judgment', async () => {
    const store = newStore()
    const id = await seedBelief(store)
    const result = await runAudit({
      store,
      scope: session,
      beliefId: id,
      callCritic: critic({ objection: false }),
      producerModel: 'model-a',
      criticModel: 'model-b',
    })
    expect(result.outcome).toBe('pass')
    expect(store.getBelief(session, id)?.status).toBe('active')
    const last = store.view(session)
    expect(result.judgmentSeq).toBe(last.seq)
  })

  it('an accepted objection demotes the belief on the cited criterion', async () => {
    const store = newStore()
    const id = await seedBelief(store)
    const seq = store.view(session).seq
    const result = await runAudit({
      store,
      scope: session,
      beliefId: id,
      callCritic: critic({
        objection: true,
        reason: 'the user later said the window moved to monday',
        verdict: 'demotion',
        criterionRef: 'crit/freshness-clock',
        refs: [`seq:${seq}`],
      }),
      producerModel: 'model-a',
      criticModel: 'model-b',
    })
    expect(result.outcome).toBe('objection-accepted')
    expect(store.getBelief(session, id)?.status).toBe('degraded')
  })

  it('a form-defective objection freezes the belief and queues it for human review', async () => {
    const store = newStore()
    const id = await seedBelief(store)
    const result = await runAudit({
      store,
      scope: session,
      beliefId: id,
      callCritic: critic({
        objection: true,
        reason: 'something is off but I cannot say where',
        criterionRef: 'crit/not-registered',
        refs: ['seq:999'],
      }),
      producerModel: 'model-a',
      criticModel: 'model-b',
    })
    expect(result.outcome).toBe('objection-rejected-frozen')
    expect(result.failures.length).toBeGreaterThan(0)
    expect(store.getBelief(session, id)?.status).toBe('frozen')

    const queue = await listFrozenForReview(store, session)
    expect(queue.map(item => item.id)).toEqual([id])

    // Human batch review releases the freeze.
    const seq = await releaseAuditFreeze(store, session, id, 'reviewed: objection was noise')
    expect(seq).toBe(store.view(session).seq)
    expect(store.getBelief(session, id)?.status).toBe('active')
    expect(await listFrozenForReview(store, session)).toEqual([])
  })

  it('an unparseable critic reply freezes rather than passes', async () => {
    const store = newStore()
    const id = await seedBelief(store)
    const result = await runAudit({
      store,
      scope: session,
      beliefId: id,
      callCritic: async () => ({ text: 'I think this belief is probably fine, hard to say really.' }),
      producerModel: 'model-a',
      criticModel: 'model-b',
    })
    expect(result.outcome).toBe('objection-rejected-frozen')
    expect(store.getBelief(session, id)?.status).toBe('frozen')
  })

  it('the independence hard constraint refuses a same-model critic before any call', async () => {
    const store = newStore()
    const id = await seedBelief(store)
    let called = false
    await expect(runAudit({
      store,
      scope: session,
      beliefId: id,
      callCritic: async () => {
        called = true
        return { text: '{}' }
      },
      producerModel: 'model-a',
      criticModel: 'model-a',
    })).rejects.toThrow(/hard constraint/)
    expect(called).toBe(false)
  })

  it('auditing a frozen or voided belief skips without a judgment', async () => {
    const store = newStore()
    const id = await seedBelief(store)
    await store.judge(session, {
      criterionRef: 'crit/audit-freeze',
      verdict: 'freeze',
      target: id,
      dataSupport: { summary: 'already under review' },
      provenance: { eventRange: [1, store.view(session).seq] },
    })
    const seqBefore = store.view(session).seq
    const result = await runAudit({
      store,
      scope: session,
      beliefId: id,
      callCritic: critic({ objection: false }),
      producerModel: 'model-a',
      criticModel: 'model-b',
    })
    expect(result.outcome).toBe('skipped')
    expect(store.view(session).seq).toBe(seqBefore)
  })
})
