/**
 * Phase A item 4: the moa synthesis lands as an observation + merge judgment
 * when a store is assembled (driven by a fake callModel — no LLM seam).
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RlmStore, withBaseCriteria } from '@deepseek-ai/dsh-plugin-rlm-store'
import type { MoaResolvedPreset } from '../src/presets.ts'
import { createMoaTool } from '../src/moa-tool.ts'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'moa-landing-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const SCOPE = { kind: 'session' as const, id: 'sess-moa-1' }

function panelPreset(): MoaResolvedPreset {
  return {
    name: 'panel',
    references: [
      { provider: 'p-a', model: 'model-a', label: 'model-a@p-a', mode: 'llm', providerFromDefault: false },
    ],
    aggregator: { provider: 'p-agg', model: 'agg', label: 'agg@p-agg', mode: 'llm', providerFromDefault: false },
    referenceMaxTokens: 512,
    referenceTimeoutMs: 120_000,
    aggregatorTimeoutMs: 300_000,
    degradedPolicy: 'loud',
  }
}

function fakeExec() {
  return { agent: { session: { id: 'sess-moa-1' } }, signal: new AbortController().signal }
}

async function call(tool: { execute: unknown }, args: Record<string, unknown>): Promise<{ synthesis?: string }> {
  const execute = tool.execute as unknown as
    (args: Record<string, unknown>, exec: unknown) => Promise<{ synthesis?: string }>
  return execute(args, fakeExec())
}

function buildTool(store: RlmStore | undefined): { execute: unknown } {
  const preset = panelPreset()
  return createMoaTool({
    store,
    callModel: async slot => ({
      text: slot.label === 'agg@p-agg' ? 'the synthesized best answer' : 'reference answer',
      truncated: false,
    }),
    resolvePreset: (name?: string) => {
      if (name !== undefined && name !== preset.name) throw new Error(`moa: unknown preset '${name}'`)
      return preset
    },
    availablePresets: () => [preset.name],
    privacyFilter: '',
  })
}

describe('moa → store landing', () => {
  it('lands an observation + merge judgment with the four requirements locatable', async () => {
    const store = withBaseCriteria(new RlmStore(path.join(root, 'store')))
    const tool = buildTool(store)

    const result = await call(tool, { problem: 'What is the capital of France?' })
    expect(result.synthesis).toBe('the synthesized best answer')

    const view = store.view(SCOPE)
    // one observation + one judgment
    expect(view.countsByType['rlm/observation']).toBe(1)
    expect(view.countsByType['rlm/judgment']).toBe(1)
    const beliefs = store.beliefs(SCOPE)
    expect(beliefs).toHaveLength(1)
    // open-tier criterion → provisional (never evidenced)
    expect(beliefs[0]).toMatchObject({
      grade: 'provisional',
      criterionRef: 'crit/moa-aggregator',
      content: 'the synthesized best answer',
      lastVerified: { channel: 'moa-aggregator', eventPos: 1 },
    })
    // provenance locatable: the anchor position exists in the stream
    expect(view.seq).toBeGreaterThanOrEqual(beliefs[0]!.lastVerified!.eventPos)
  })

  it('absent store degrades to no landing without failing the tool', async () => {
    const tool = buildTool(undefined)
    const result = await call(tool, { problem: 'q' })
    expect(result.synthesis).toBe('the synthesized best answer')
  })
})
