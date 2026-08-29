/**
 * Unit tests for the RLM split-turn compaction summarizer.
 *
 * These assert the RLM-specific summarize hook (1) injects a `## Turn Prefix`
 * section when the condensed region begins mid-assistant-turn, (2) keeps the
 * `## Files Touched` section and parses it back, and (3) never depends on any
 * private symbol from `compaction-basic`.
 */
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { RlmSummarizationInput } from '../src/split-turn-summarizer.ts'
import { buildRlmInstruction, parseRlmSummary, priorFilesTouched, summarizeRlm } from '../src/split-turn-summarizer.ts'
import type { ResolvedCompactionConfig } from '../src/split-turn-summarizer.ts'

function makeAgent(opts: { provider?: string; model?: string } = {}): Agent {
  return {
    session: {
      id: 'rlm-session' as never,
      requestHeader: () => ({ config: { provider: '', model: '', maxTokens: 0 } }),
    },
    options: { provider: opts.provider ?? '', model: opts.model ?? '' },
  } as unknown as Agent
}

function makeCtx(streamText: string): { ctx: Context; lastMessages: () => unknown[] } {
  const chunks = [
    { type: 'text', text: streamText },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  let captured: unknown[] = []
  const ctx = {
    llm: {
      stream: vi.fn((opts: { messages: unknown[] }) => {
        captured = opts.messages
        return (async function* () {
          for (const c of chunks) yield c
        })()
      }),
    },
  } as unknown as Context
  return { ctx, lastMessages: () => captured }
}

describe('buildRlmInstruction', () => {
  it('includes the Turn Prefix section only when mid-turn', () => {
    expect(buildRlmInstruction(false)).not.toContain('## Turn Prefix')
    expect(buildRlmInstruction(true)).toContain('## Turn Prefix')
  })

  it('always includes the eight base sections and Files Touched', () => {
    const text = buildRlmInstruction(false)
    expect(text).toContain('## Primary Request and Intent')
    expect(text).toContain('## Files Touched')
  })

  it('embeds a PREVIOUS FILES TOUCHED hint when prior files exist', () => {
    const text = buildRlmInstruction(false, { read: ['a.ts'], modified: ['b.ts'] })
    expect(text).toContain('PREVIOUS FILES TOUCHED')
    expect(text).toContain('- read: a.ts')
    expect(text).toContain('- modified: b.ts')
  })
})

describe('parseRlmSummary', () => {
  it('parses Files Touched and Turn Prefix sections', () => {
    const text = [
      '## Primary Request and Intent',
      '- do the thing',
      '## Turn Prefix',
      '- the in-progress turn was refactoring the loader',
      '## Files Touched',
      '- read: src/x.ts',
      '- modified: src/y.ts',
    ].join('\n')
    const parsed = parseRlmSummary(text)
    expect(parsed.filesTouched.read).toEqual(['src/x.ts'])
    expect(parsed.filesTouched.modified).toEqual(['src/y.ts'])
    expect(parsed.turnPrefix).toContain('refactoring the loader')
  })
})

describe('summarizeRlm (P1-B + P1-A parity)', () => {
  const config: ResolvedCompactionConfig = {
    summarizationProvider: 'p',
    summarizationModel: 'm',
    maxTokens: 512,
  } as ResolvedCompactionConfig

  it('requests a Turn Prefix when the region starts mid-assistant-turn', async () => {
    const { ctx, lastMessages } = makeCtx('<compacted-summary>\n## Primary Request and Intent\n- x\n</compacted-summary>')
    const input: RlmSummarizationInput = {
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'continuation' }] } as never],
    }
    await summarizeRlm(ctx, config, input, makeAgent({ provider: 'p', model: 'm' }), new AbortController().signal)
    const promptText = JSON.stringify(lastMessages())
    expect(promptText).toContain('## Turn Prefix')
  })

  it('omits Turn Prefix when the region starts at a user message', async () => {
    const { ctx, lastMessages } = makeCtx('<compacted-summary>\n## Primary Request and Intent\n- x\n</compacted-summary>')
    const input: RlmSummarizationInput = {
      messages: [{ role: 'user', content: [{ type: 'text', text: 'request' }] } as never],
    }
    await summarizeRlm(ctx, config, input, makeAgent({ provider: 'p', model: 'm' }), new AbortController().signal)
    const promptText = JSON.stringify(lastMessages())
    expect(promptText).not.toContain('## Turn Prefix')
  })

  it('parses Files Touched from the model output into the result', async () => {
    const { ctx } = makeCtx('<compacted-summary>\n## Primary Request and Intent\n- x\n## Files Touched\n- read: src/z.ts\n</compacted-summary>')
    const input: RlmSummarizationInput = {
      messages: [{ role: 'user', content: [{ type: 'text', text: 'request' }] } as never],
    }
    const result = await summarizeRlm(ctx, config, input, makeAgent({ provider: 'p', model: 'm' }), new AbortController().signal)
    expect(result.filesTouched.read).toEqual(['src/z.ts'])
  })
})

describe('priorFilesTouched (P1-A cross-round carry, RLM-only)', () => {
  const config: ResolvedCompactionConfig = {
    summarizationProvider: 'p',
    summarizationModel: 'm',
    maxTokens: 512,
  } as ResolvedCompactionConfig

  function makeSessionWithSummary(text: string): { events: unknown[] } {
    return {
      events: [
        { type: 'turn/start', data: { turn: 1 } },
        {
          type: 'compaction/summary',
          data: { summary: [{ type: 'text', text }] },
        },
      ],
    }
  }

  it('reads the most recent compaction/summary Files Touched section', () => {
    const prior = priorFilesTouched(
      makeSessionWithSummary('## Primary Request and Intent\n- x\n## Files Touched\n- read: a.ts\n- modified: b.ts\n') as never,
    )
    expect(prior).toEqual({ read: ['a.ts'], modified: ['b.ts'] })
  })

  it('returns undefined when no prior summary records Files Touched', () => {
    const prior = priorFilesTouched(
      makeSessionWithSummary('## Primary Request and Intent\n- x\n') as never,
    )
    expect(prior).toBeUndefined()
  })

  it('injects the prior list as a PREVIOUS FILES TOUCHED hint in the prompt', async () => {
    const { ctx, lastMessages } = makeCtx('<compacted-summary>\n## Primary Request and Intent\n- x\n</compacted-summary>')
    const input: RlmSummarizationInput = {
      messages: [{ role: 'user', content: [{ type: 'text', text: 'request' }] } as never],
      priorFilesTouched: { read: ['a.ts'], modified: ['b.ts'] },
    }
    await summarizeRlm(ctx, config, input, makeAgent({ provider: 'p', model: 'm' }), new AbortController().signal)
    const promptText = JSON.stringify(lastMessages())
    expect(promptText).toContain('PREVIOUS FILES TOUCHED')
    expect(promptText).toContain('- read: a.ts')
    expect(promptText).toContain('- modified: b.ts')
  })
})
