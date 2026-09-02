/**
 * Phase D wiring: the `rlm_audit` tool resolves critic/producer identities and
 * drives the store-side reverse-filtering pipeline through an injected
 * callModel (no LLM seam). Covers: the end-to-end audit on a seeded belief,
 * the config-missing and identity-unknown loud failures, and the independence
 * hard constraint surfaced through the tool.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RlmStore, withBaseCriteria } from '@deepseek-ai/dsh-plugin-rlm-store'
import type { MoaResolvedSlot } from '../src/presets.ts'
import { createAuditTool } from '../src/audit-tool.ts'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'moa-audit-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const SCOPE = { kind: 'session' as const, id: 'sess-moa-1' }
const CRITIC: MoaResolvedSlot = {
  provider: 'p-b',
  model: 'model-b',
  label: 'model-b@p-b',
  mode: 'llm',
  providerFromDefault: false,
}

function fakeExec() {
  return { agent: { session: { id: SCOPE.id } }, signal: new AbortController().signal }
}

interface AuditReply {
  outcome: string
  beliefId: string
  judgmentSeq: number
  failures: string[]
  criticLabel: string
}

async function call(tool: { execute: unknown }, args: Record<string, unknown>): Promise<AuditReply> {
  const execute = tool.execute as
    (args: Record<string, unknown>, exec: unknown) => Promise<AuditReply>
  return execute(args, fakeExec())
}

function buildTool(
  store: RlmStore | undefined,
  options: { critic?: MoaResolvedSlot; producerModel?: string; reply?: unknown } = {},
): { execute: unknown } {
  return createAuditTool({
    store,
    callModel: async () => ({ text: JSON.stringify(options.reply ?? { objection: false }) }),
    critic: options.critic ?? CRITIC,
    producerModel: options.producerModel ?? 'model-a',
    timeoutMs: 5_000,
  })
}

async function seedBelief(store: RlmStore): Promise<string> {
  await store.append(SCOPE, 'rlm/observation', { kind: 'user-message' })
  await store.judge(SCOPE, {
    criterionRef: 'crit/verify-eq31-tournament',
    verdict: 'conclusion',
    belief: { kind: 'declarative', content: 'the api token expires hourly', subject: 'api-token' },
    dataSupport: { summary: 'user stated the token policy' },
    provenance: { eventRange: [1, store.view(SCOPE).seq] },
  })
  const belief = store.beliefs(SCOPE).at(-1)
  if (!belief) throw new Error('seed failed')
  return belief.id
}

describe('rlm_audit tool wiring', () => {
  it('runs the pipeline end to end: clean critic lands a check-pass judgment', async () => {
    const store = withBaseCriteria(new RlmStore(path.join(root, 'store')))
    const id = await seedBelief(store)
    const tool = buildTool(store)

    const result = await call(tool, { beliefId: id })
    expect(result.outcome).toBe('pass')
    expect(result.criticLabel).toBe('model-b@p-b')
    expect(store.view(SCOPE).countsByType['rlm/judgment']).toBe(2) // seed conclusion + audit check-pass
  })

  it('an accepted objection demotes the belief through the tool', async () => {
    const store = withBaseCriteria(new RlmStore(path.join(root, 'store')))
    const id = await seedBelief(store)
    const tool = buildTool(store, {
      reply: {
        objection: true,
        reason: 'tokens actually expire daily per the config file',
        verdict: 'demotion',
        criterionRef: 'crit/freshness-clock',
        refs: ['seq:1'],
      },
    })
    const result = await call(tool, { beliefId: id })
    expect(result.outcome).toBe('objection-accepted')
    expect(store.getBelief(SCOPE, id)?.status).toBe('degraded')
  })

  it('fails loud without a configured critic', async () => {
    const store = withBaseCriteria(new RlmStore(path.join(root, 'store')))
    const id = await seedBelief(store)
    const tool = createAuditTool({
      store,
      callModel: async () => ({ text: '{}' }),
      producerModel: 'model-a',
      timeoutMs: 5_000,
    })
    await expect(call(tool, { beliefId: id })).rejects.toThrow(/no critic configured/)
  })

  it('fails loud when the producer identity cannot be verified', async () => {
    const store = withBaseCriteria(new RlmStore(path.join(root, 'store')))
    const id = await seedBelief(store)
    const tool = createAuditTool({
      store,
      callModel: async () => ({ text: '{}' }),
      critic: CRITIC,
      timeoutMs: 5_000,
    })
    await expect(call(tool, { beliefId: id })).rejects.toThrow(/producer model is unknown/)
  })

  it('the independence constraint surfaces through the tool (critic == producer)', async () => {
    const store = withBaseCriteria(new RlmStore(path.join(root, 'store')))
    const id = await seedBelief(store)
    const tool = buildTool(store, {
      critic: { ...CRITIC, model: 'model-a' },
      producerModel: 'model-a',
    })
    await expect(call(tool, { beliefId: id })).rejects.toThrow(/hard constraint/)
  })

  it('fails loud without the store service', async () => {
    const tool = buildTool(undefined)
    await expect(call(tool, { beliefId: 'anything' })).rejects.toThrow(/rlm.store service is unavailable/)
  })
})
