/**
 * Cross-judge ranking fusion for multi-model verification. Each successful
 * judge independently produces `llm_verifier`'s ranking + normalized scores
 * over the same candidate pool; fusion combines them into one ordering via
 * Borda points (position-based, rank-order robust) with mean min-max
 * normalized score as a deterministic tiebreak.
 *
 * @module @deepseek-ai/dsh-plugin-rlm-verifier/fusion
 */

/** One judge's per-candidate outcome, aligned by candidate index. */
export interface JudgeOutcome {
  /** Judge display identity (profile name or model@route). */
  model: string
  status: 'ok' | 'failed'
  scores?: number[]
  ranking?: number[]
}

export interface FusedRanking {
  fusedRanking: number[]
  bestIndex: number
  fusedScores: number[]
  failedJudges: string[]
}

/**
 * Fuse multiple judges' outcomes into one candidate ordering.
 * @param outcomes - one entry per judge; failed entries contribute nothing.
 * @param candidateCount - pool size every judge ranked.
 * @returns Borda-fused ranking (best first); when every judge failed the
 *   candidates keep their natural order and `bestIndex` is `-1`.
 */
export function fuseJudgeOutcomes(outcomes: JudgeOutcome[], candidateCount: number): FusedRanking {
  const ok = outcomes.filter(o => o.status === 'ok' && Array.isArray(o.ranking) && o.ranking.length > 0)
  const failedJudges = outcomes.filter(o => o.status !== 'ok').map(o => o.model)

  const naturalOrder = Array.from({ length: candidateCount }, (_, index) => index)
  if (ok.length === 0 || candidateCount <= 0) {
    return { fusedRanking: naturalOrder, bestIndex: -1, fusedScores: new Array<number>(candidateCount).fill(0), failedJudges }
  }

  const borda = new Array<number>(candidateCount).fill(0)
  const normSum = new Array<number>(candidateCount).fill(0)
  const normCount = new Array<number>(candidateCount).fill(0)

  for (const judge of ok) {
    // Borda: earlier position earns more points; out-of-range entries earn zero.
    ;(judge.ranking as number[]).forEach((candidateIndex, position) => {
      if (candidateIndex >= 0 && candidateIndex < candidateCount) {
        borda[candidateIndex] = (borda[candidateIndex] ?? 0) + (candidateCount - position)
      }
    })
    if (Array.isArray(judge.scores) && judge.scores.length === candidateCount) {
      const min = Math.min(...judge.scores)
      const max = Math.max(...judge.scores)
      const span = max - min
      for (let i = 0; i < candidateCount; i++) {
        // A flat score band contributes a neutral full point to every candidate.
        const contribution = span > 0 ? ((judge.scores[i] ?? min) - min) / span : 1
        normSum[i] = (normSum[i] ?? 0) + contribution
        normCount[i] = (normCount[i] ?? 0) + 1
      }
    }
  }

  const fusedScores = borda.map((points, i) => {
    const count = normCount[i] ?? 0
    const sum = normSum[i] ?? 0
    return points + (count > 0 ? sum / count : 0)
  })

  const fusedRanking = fusedScores
    .map((score, index) => ({ index, score }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(entry => entry.index)

  return { fusedRanking, bestIndex: fusedRanking[0] ?? -1, fusedScores, failedJudges }
}
