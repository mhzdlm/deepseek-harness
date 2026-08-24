/**
 * Pure fusion-math tests for multi-judge verification: Borda points primary,
 * mean min-max normalized score tiebreak, failed judges excluded, and
 * deterministic ordering under ties.
 */
import { describe, expect, it } from 'vitest'
import { fuseJudgeOutcomes } from '../src/fusion.ts'

describe('fuseJudgeOutcomes', () => {
  it('fuses two agreeing judges into their shared order', () => {
    const fused = fuseJudgeOutcomes([
      { model: 'a', status: 'ok', scores: [0.9, 0.5], ranking: [0, 1] },
      { model: 'b', status: 'ok', scores: [0.8, 0.4], ranking: [0, 1] },
    ], 2)
    expect(fused.fusedRanking).toEqual([0, 1])
    expect(fused.bestIndex).toBe(0)
    expect(fused.failedJudges).toEqual([])
  })

  it('Borda points resolve disagreement by majority position', () => {
    // Judge A prefers candidate 0; judges B and C prefer candidate 1.
    const fused = fuseJudgeOutcomes([
      { model: 'a', status: 'ok', ranking: [0, 1, 2] },
      { model: 'b', status: 'ok', ranking: [1, 0, 2] },
      { model: 'c', status: 'ok', ranking: [1, 2, 0] },
    ], 3)
    expect(fused.bestIndex).toBe(1)
    expect(fused.fusedRanking).toEqual([1, 0, 2])
  })

  it('normalized-score mean breaks Borda ties deterministically', () => {
    // J1 and J2 reverse each other (equal Borda, mirrored norms); J3 breaks the
    // tie with a stronger normalized margin for candidate 1.
    const fused = fuseJudgeOutcomes([
      { model: 'a', status: 'ok', scores: [1, 0.5], ranking: [0, 1] },
      { model: 'b', status: 'ok', scores: [0.5, 1], ranking: [1, 0] },
      { model: 'c', status: 'ok', scores: [0, 1], ranking: [1, 0] },
    ], 2)
    expect(fused.bestIndex).toBe(1)
  })

  it('failed judges are excluded and reported', () => {
    const fused = fuseJudgeOutcomes([
      { model: 'dead', status: 'failed' },
      { model: 'alive', status: 'ok', ranking: [1, 0] },
    ], 2)
    expect(fused.failedJudges).toEqual(['dead'])
    expect(fused.fusedRanking).toEqual([1, 0])
  })

  it('all-failed input yields an empty best with -1 sentinel', () => {
    const fused = fuseJudgeOutcomes([{ model: 'x', status: 'failed' }], 3)
    expect(fused.fusedRanking).toHaveLength(3)
    expect(fused.bestIndex).toBe(-1)
  })
})
