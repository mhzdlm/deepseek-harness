/**
 * Integration through the real LLM seam: a minimal capture adapter is
 * registered against `LlmRuntime`, and the moa orchestration runs via the
 * production `callViaLlm` transport. Pins purpose attribution, session-id
 * forwarding, per-slot routing, and signal propagation end-to-end — the
 * pieces the injected-transport unit tests cannot see.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, LlmRuntime, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createMoaTool } from '../src/moa-tool.ts'
import { callViaLlm } from '../src/index.ts'

class CaptureAdapter extends LlmAdapter {
  readonly seen: GenerateOptions[] = []

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.seen.push(options)
    yield { type: 'text-delta', index: 0, text: `answer-for-${options.model}` }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function makeExec(sessionId: string): Parameters<ReturnType<typeof createMoaTool>['execute']>[1] {
  return { signal: new AbortController().signal, agent: { session: { id: SessionId(sessionId) } } } as never
}

describe('moa over the real llm seam', () => {
  it('routes every slot with moa purpose, session id, and live signals', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const adapter = new CaptureAdapter()
    ctx.llm.registerAdapter(['p-a', 'p-b', 'p-agg'], adapter)

    const preset = {
      name: 'panel',
      references: [
        { provider: 'p-a', model: 'ref-a', label: 'ref-a@p-a', mode: 'llm' as const, providerFromDefault: false },
        { provider: 'p-b', model: 'ref-b', label: 'ref-b@p-b', mode: 'llm' as const, providerFromDefault: false },
      ],
      aggregator: { provider: 'p-agg', model: 'aggregator', label: 'aggregator@p-agg', mode: 'llm' as const, providerFromDefault: false },
      referenceMaxTokens: 256,
      referenceTimeoutMs: 30_000,
      degradedPolicy: 'loud' as const,
    }
    const tool = createMoaTool({
      resolvePreset: (name) => {
        if (name !== undefined && name !== 'panel') throw new Error(`unknown preset '${name}'`)
        return preset
      },
      availablePresets: () => ['panel'],
      privacyFilter: '',
      callModel: (slot, request, signal, maxTokens, sessionId) =>
        callViaLlm(ctx.llm, slot, request, signal, maxTokens, sessionId),
    })

    const value = (await tool.execute({ problem: 'hard problem' }, makeExec('sess-moa'))) as {
      synthesis: string
      failedLabels: string[]
    }

    expect(value.failedLabels).toEqual([])
    expect(value.synthesis).toContain('answer-for-aggregator')
    expect(adapter.seen.length).toBe(3)
    for (const options of adapter.seen) {
      expect(options.purpose).toBe('moa')
      expect(String(options.sessionId)).toBe('sess-moa')
      expect(options.signal).toBeInstanceOf(AbortSignal)
      expect(options.messages.length).toBe(1)
    }
    expect(adapter.seen.map(o => o.model)).toEqual(['ref-a', 'ref-b', 'aggregator'])
    // Reference cap applies to references only; the aggregator stays uncapped.
    expect(adapter.seen[0].maxTokens).toBe(256)
    expect(adapter.seen[2].maxTokens).toBeUndefined()
  })
})
