/**
 * Keyed end-to-end for multi-judge verification on the host seam: two DeepSeek
 * models score the same tiny candidate pool through real `ctx.llm.stream()`
 * calls that carry chosen-token logprobs, exercising per-judge routes and
 * Borda fusion against live provider responses. Self-skips without
 * `DEEPSEEK_API_KEY`.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import { createVerifyTool } from '../src/verify-tool.ts'
import type { VerifyCallModel } from '../src/verify-tool.ts'

const hasKey = Boolean(process.env.DEEPSEEK_API_KEY)
const dIt = hasKey ? it : it.skip

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

/**
 * Live seam transport: reduce one `ctx.llm.stream()` call to its text plus
 * chosen-token logprobs, exactly as the plugin's `callSeamModel` does.
 */
async function liveSeam(): Promise<VerifyCallModel> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LlmDeepSeek, {})
  return async (request) => {
    const assembler = new BlockAssembler()
    const options: GenerateOptions = {
      provider: request.route.provider,
      model: request.route.model,
      messages: [
        createUserMessage({
          content: [{ type: 'text', text: request.userText }],
          source: { kind: 'plugin', plugin: 'dsh-plugin-rlm-verifier' },
        }),
      ],
      maxTokens: request.maxTokens,
      logprobs: { topLogprobs: 20 },
      signal: request.signal,
    }
    for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk)
    const finish = assembler.finish
    if (finish.kind === 'error') throw new Error(`verify scoring failed: ${finish.failure.message}`)
    if (finish.kind === 'aborted') throw new Error('verify scoring aborted')
    const text = assembler
      .blocks()
      .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
      .map(block => block.text)
      .join('')
    return { text, logprobs: [...assembler.logprobs] }
  }
}

describe('multi-judge verification (real providers, host seam)', () => {
  dIt('fuses two deepseek judges over a trivial pool', async () => {
    const tool = createVerifyTool({
      callModel: await liveSeam(),
      provider: 'deepseek-official',
      privacyFilter: '',
      judgeProfiles: {
        flash: { model: 'deepseek-v4-flash', provider: 'deepseek-official' },
        pro: { model: 'deepseek-v4-pro', provider: 'deepseek-official' },
      },
    })
    const value = (await tool.execute(
      {
        problem: 'Which answer is correct?',
        candidates: ['2+2 = 4', '2+2 = 5'],
        judges: ['flash', 'pro'],
        n_evaluations: 1,
        pivots: 1,
      },
      { signal: new AbortController().signal } as never,
    )) as {
      index: number
      ranking: number[]
      nComparisons: number
      judges: Array<{ model: string; status: string }>
    }

    expect(value.judges.map(j => j.status)).toEqual(['ok', 'ok'])
    expect(value.nComparisons).toBeGreaterThanOrEqual(1)
    expect(value.index).toBeGreaterThanOrEqual(0)
    expect(value.index).toBeLessThan(2)
    // The mathematically correct candidate must win with both judges voting.
    expect(value.ranking[0]).toBe(0)
  }, 240_000)

  dIt('single-model path still works against the live provider', async () => {
    const tool = createVerifyTool({
      callModel: await liveSeam(),
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      privacyFilter: '',
    })
    const value = (await tool.execute(
      { problem: 'Which is correct?', candidates: ['capital of France is Paris', 'capital of France is London'] },
      { signal: new AbortController().signal } as never,
    )) as { index: number }
    expect([0, 1]).toContain(value.index)
  }, 240_000)
})
