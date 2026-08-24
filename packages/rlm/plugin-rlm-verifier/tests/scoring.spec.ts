/**
 * Contract tests for the ported judge scoring: tag location in streamed
 * token lists (including tokenizer fusion and split-tag accumulation, and
 * the last-match rule), Eq 3.1 expectation with case-merged max-prob, the
 * flat-band 0.5 path, and the literal-text fallback.
 */
import { describe, expect, it } from 'vitest'
import { extractScore, findTagLogprobs, type PositionAlternatives } from '../src/scoring.ts'

const TAG = '<score_A>'

describe('findTagLogprobs', () => {
  it('returns the alternatives of the position following the tag', () => {
    const positions: PositionAlternatives[] = [
      [['x', -1]],
      [['A', -0.05]],
    ]
    const alts = findTagLogprobs([TAG, 'A'], positions, TAG)
    expect(alts).toEqual([['A', -0.05]])
  })

  it('matches a split tag via cumulative text (tokenizer split the literal)', () => {
    const tokens = ['<score', '_A>', 'B']
    const positions: PositionAlternatives[] = [
      [['<score', -2]],
      [['_A>', -0.01]],
      [['B', -0.9], ['C', -1.1]],
    ]
    expect(findTagLogprobs(tokens, positions, TAG)).toEqual([['B', -0.9], ['C', -1.1]])
  })

  it('takes the LAST match over an earlier format quotation', () => {
    const tokens = [TAG, 'A', 'then', TAG, 'T']
    const positions: PositionAlternatives[] = [
      [['A-first', -1]],
      [['quoted', -1]],
      [['mid', -1]],
      [['mid2', -1]],
      [['T-last', -0.4]],
    ]
    const alts = findTagLogprobs(tokens, positions, TAG)
    expect(alts).toEqual([['T-last', -0.4]])
  })

  it('returns null when the tag never appears', () => {
    expect(findTagLogprobs(['plain'], [[['plain', 0]]], TAG)).toBeNull()
    expect(findTagLogprobs([], [], TAG)).toBeNull()
  })
})

describe('extractScore', () => {
  it('computes the normalized expectation, merging case variants by max prob', () => {
    // 'A' and 'a' both map to value 20; max-prob wins per value.
    const score = extractScore(
      '',
      [TAG, 'a', 'A'],
      [
        [['x', -3]],
        [['a', -0.7]],
        [['A', -0.2]],
      ],
      TAG,
    )
    // p(a)=e^-0.7 vs p(A)=e^-0.2 → both carry value 20 → expectation = 20 → 1.0.
    expect(score).toBe(1.0)
  })

  it('strips the fused ">" prefix from DeepSeek letter tokens', () => {
    const score = extractScore(
      '',
      [TAG, '>C'],
      [
        [['y', -1]],
        [['>C', -0.3]],
      ],
      TAG,
    )
    // C maps to 18 → (18 - 1) / 19.
    expect(score).toBeCloseTo(17 / 19, 6)
  })

  it('falls back to parsing the literal score block from text', () => {
    const text = 'analysis…\n<score_A> M </score_A>\n<score_B> T </score_B>'
    // Letters map A→20 … T→1: M = 8, T = 1 → (v − 1) / 19.
    expect(extractScore(text, [], [], '<score_A>')).toBeCloseTo(7 / 19, 6)
    expect(extractScore(text, [], [], '<score_B>')).toBeCloseTo(0 / 19, 6)
  })

  it('scores a flat distribution band at 0.5 via the neutral fallback', () => {
    // Letters outside the A–T vocabulary are ignored; no valid mass means the
    // reference returns 0.5.
    expect(extractScore('', [TAG, 'zz'], [[['q', -1]], [['zz', -0.5]]], TAG)).toBe(0.5)
  })
})
