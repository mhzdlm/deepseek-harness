/**
 * Probabilistic Pivot Tournament (PPT): O(Nk) best-of-N selection — a
 * faithful TypeScript port of llm_verifier's pivot_tournament.py.
 *
 *  1) Ring pass: score the N adjacent directed pairs of a seeded Hamiltonian
 *     cycle; every candidate visits each prompt slot once, cancelling slot
 *     bias around the ring.
 *  2) Pivot selection: top-k by mean preference w_i / c_i.
 *  3) Pivot rounds: every non-pivot-vs-pivot plus pivot-vs-pivot pair,
 *     aggregated into the same w, c; argmax w_i / c_i wins.
 *
 * Comparisons: N + k(N-k) + C(k,2) — linear in N for fixed k. Rewards feed a
 * Bradley-Terry soft win, p(a beats b) = sigmoid(R_a - R_b).
 *
 * Seeding note: the reference uses Python's Mersenne Twister; this port uses
 * mulberry32, so tournaments are deterministic per seed within TypeScript but
 * sequences are not identical to the Python implementation. Same-seed
 * reproducibility is the contract; cross-language ring equality is not.
 *
 * @module @deepseek-ai/dsh-plugin-rlm-verifier/tournament
 */

export const DEFAULT_PIVOTS = 2

/** Minimal deterministic PRNG (mulberry32); sufficient for ring shuffling. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** The N directed adjacent pairs of a random Hamiltonian cycle over `n`. */
export function ringCycle(n: number, rand: () => number): Array<[number, number]> {
  if (n <= 1) return []
  const perm = Array.from({ length: n }, (_, i) => i)
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    const a = perm[i] ?? i
    const b = perm[j] ?? j
    perm[i] = b
    perm[j] = a
  }
  return perm.map((candidate, t) => [candidate, perm[(t + 1) % n] ?? candidate] as [number, number])
}

/** p(a beats b) under Bradley-Terry on rewards in [0, 1]. */
export function bradleyTerry(ra: number, rb: number): number {
  return 1 / (1 + Math.exp(-(ra - rb)))
}

/**
 * Score each directed pair and aggregate soft wins into `w`/`c` in place.
 * @param pairs - directed comparisons.
 * @param score - returns the fine-grained rewards with `a` in slot A.
 */
export function accumulate(
  pairs: ReadonlyArray<readonly [number, number]>,
  score: (a: number, b: number) => Promise<[number, number]>,
  w: number[],
  c: number[],
): Promise<void> {
  return Promise.all(pairs.map(([a, b]) => score(a, b))).then((results) => {
    for (let index = 0; index < pairs.length; index++) {
      const pair = pairs[index]
      const result = results[index]
      if (pair === undefined || result === undefined) continue
      const [a, b] = pair
      const [ra, rb] = result
      const p = bradleyTerry(ra, rb)
      w[a] = (w[a] ?? 0) + p
      c[a] = (c[a] ?? 0) + 1
      w[b] = (w[b] ?? 0) + (1 - p)
      c[b] = (c[b] ?? 0) + 1
    }
  })
}

/** Top-k candidates by mean preference w/c, ties broken by lower index. */
export function selectPivots(w: readonly number[], c: readonly number[], k: number): number[] {
  const mean = (i: number): number => (w[i] ?? 0) / (c[i] || 1)
  return [...w.keys()]
    .sort((i, j) => (mean(j) - mean(i)) || (i - j))
    .slice(0, Math.min(k, w.length))
}

/** Directed pairs for step 3: non-pivot vs pivot, then pivot vs pivot (lower index takes slot A). */
export function pivotRoundPairs(n: number, pivots: readonly number[]): Array<[number, number]> {
  const pivotSet = new Set(pivots)
  const nonPivots = [...Array(n).keys()].filter(i => !pivotSet.has(i))
  const pairs: Array<[number, number]> = []
  for (const i of nonPivots) {
    for (const p of pivots) pairs.push([i, p])
  }
  const sorted = [...pivots].sort((x, y) => x - y)
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const x = sorted[i]
      const y = sorted[j]
      if (x !== undefined && y !== undefined) pairs.push([x, y])
    }
  }
  return pairs
}

export interface TournamentResult {
  bestIndex: number
  /** Mean preference w/c per candidate; the tool surfaces these as scores. */
  meanPreference: number[]
  nComparisons: number
}

/**
 * Run the full PPT over a directed scoring callback.
 * @param scorePair - returns the averaged fine-grained rewards (R_a, R_b)
 *   with `a` in slot A; called once per directed comparison.
 */
export async function runTournament(
  n: number,
  seed: number,
  pivots: number,
  scorePair: (a: number, b: number) => Promise<[number, number]>,
): Promise<TournamentResult> {
  if (n <= 0) throw new Error('tournament needs at least one candidate')
  const rand = mulberry32(seed)
  const w = new Array<number>(n).fill(0)
  const c = new Array<number>(n).fill(0)

  const ring = ringCycle(n, rand)
  await accumulate(ring, scorePair, w, c)

  const pivotSet = selectPivots(w, c, Math.min(pivots, n))
  const pivotPairs = pivotRoundPairs(n, pivotSet)
  await accumulate(pivotPairs, scorePair, w, c)

  // Reference tie rule: higher mean wins, exact ties fall to the lower index.
  const meanPreference = w.map((wins, i) => wins / (c[i] || 1))
  let bestIndex = 0
  let bestMean = -Infinity
  meanPreference.forEach((mean, i) => {
    if (mean > bestMean) {
      bestMean = mean
      bestIndex = i
    }
  })

  return { bestIndex, meanPreference, nComparisons: ring.length + pivotPairs.length }
}
