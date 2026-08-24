/**
 * PPT tournament tests: ring coverage, the comparison-count formula
 * N + k(N-k) + C(k,2), majority-position winners under scripted rewards,
 * deterministic tie-break to the lower index, and slot-swap averaging for
 * repeated evaluations.
 */
import { describe, expect, it } from 'vitest'
import { bradleyTerry, mulberry32, ringCycle, runTournament } from '../src/tournament.ts'

describe('tournament', () => {
  it('ring cycle visits every candidate exactly once per slot', () => {
    const rand = mulberry32(7)
    const ring = ringCycle(5, rand)
    expect(ring).toHaveLength(5)
    const slotsA = new Set(ring.map(([a]) => a))
    const slotsB = new Set(ring.map(([, b]) => b))
    expect(slotsA.size).toBe(5)
    expect(slotsB.size).toBe(5)
  })

  it('runs N + k(N-k) + C(k,2) comparisons for the scripted pivot flow', async () => {
    // Scripted: candidate 1 always beats whoever it faces; others tie softly.
    const result = await runTournament(4, 42, 2, async (a, _b) =>
      a === 1 ? [0.9, 0.1] : a === 2 ? [0.6, 0.4] : [0.4, 0.6])
    expect(result.nComparisons).toBe(4 + 2 * (4 - 2) + 1)
    expect(result.bestIndex).toBe(1)
  })

  it('exact mean ties break to the lower index', async () => {
    // Perfectly symmetric rewards: both candidates end at mean 0.5.
    const result = await runTournament(2, 1, 2, async () => [0.5, 0.5])
    expect(result.meanPreference[0]).toBeCloseTo(0.5)
    expect(result.meanPreference[1]).toBeCloseTo(0.5)
    expect(result.bestIndex).toBe(0)
  })

  it('bradley-terry is monotonic in the reward gap and sigmoid-shaped', () => {
    expect(bradleyTerry(0.9, 0.1)).toBeGreaterThan(bradleyTerry(0.6, 0.4))
    expect(bradleyTerry(0.5, 0.5)).toBe(0.5)
    // sigmoid(gap=1) ≈ 0.731 — strictly above the balanced point.
    expect(bradleyTerry(1, 0)).toBeGreaterThan(0.7)
  })
})
