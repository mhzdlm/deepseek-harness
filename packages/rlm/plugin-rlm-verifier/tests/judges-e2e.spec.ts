/**
 * Keyed end-to-end for multi-judge verification: two DeepSeek models score the
 * same tiny candidate pool through real subprocesses, exercising the
 * per-judge credential forwarding (`keyEnv`) and Borda fusion against live
 * provider responses. Self-skips without `DEEPSEEK_API_KEY`.
 */
import { describe, expect, it } from 'vitest'
import { createVerifyTool } from '../src/verify-tool.ts'
import type { KernelExecutor } from '../src/python-bridge.ts'

const hasKey = Boolean(process.env.DEEPSEEK_API_KEY)
const dIt = hasKey ? it : it.skip

describe('multi-judge verification (real providers)', () => {
  dIt('fuses two deepseek judges over a trivial pool', async () => {
    const tool = createVerifyTool({
      getKernels: () => undefined,
      privacyFilter: '',
      judgeProfiles: {
        flash: { model: 'deepseek-v4-flash', keyEnv: 'DEEPSEEK_API_KEY' },
        pro: { model: 'deepseek-v4-pro', keyEnv: 'DEEPSEEK_API_KEY' },
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
      failedJudges?: string[]
      judges: Array<{ model: string; status: string }>
      fusedRanking: number[]
    }

    expect(value.judges.map(j => j.status)).toEqual(['ok', 'ok'])
    expect(value.failedJudges ?? []).toEqual([])
    expect(value.fusedRanking).toHaveLength(2)
    expect(value.index).toBeGreaterThanOrEqual(0)
    expect(value.index).toBeLessThan(2)
    // The mathematically correct candidate must win with both judges voting.
    expect(value.ranking[0]).toBe(0)
  }, 240_000)

  dIt('kernel-less single-model path still works against the live provider', async () => {
    const kernels: KernelExecutor | undefined = undefined
    const tool = createVerifyTool({
      getKernels: () => kernels,
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
