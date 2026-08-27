/**
 * Verbatim TypeScript port of llm_verifier's pairwise judging contract
 * (fine_grained_reward.py / prompts.py): the 20-letter scale, the judge
 * prompt layout, chosen-token logprob location, and Eq 3.1's expected-score
 * extraction with all documented fallbacks. Prompt strings are byte-faithful
 * to the reference implementation so scores remain comparable.
 *
 * @module @deepseek-ai/dsh-plugin-rlm-verifier/scoring
 */

/** Score scale granularity: letters A–T map to 20…1. */
export const GRANULARITY = 20

/** The rating-scale block embedded in every judge prompt. */
export const SCALE_DESCRIPTION =
  'Rate how likely the agent correctly solved the task on a ' +
  '20-point scale using letters A through T:\n' +
  '  A = clearly and completely succeeded with verified output (best)\n' +
  '  B-D = succeeded with only minor issues\n' +
  '  E-G = above average, mostly correct with some issues\n' +
  '  H-J = uncertain, leans toward success\n' +
  '  K-M = uncertain, leans toward failure\n' +
  '  N-P = below average, significant issues remain\n' +
  '  Q-S = failed with some partial progress\n' +
  '  T = clearly and completely failed (worst)'

/** Placeholder the prompt asks the model to replace with one letter. */
export const SCORE_FORMAT = 'LETTER_A_TO_T'

/** Letter (both cases) → numeric score, A/a = 20 … T/t = 1. */
export const VALID_TOKENS: Readonly<Record<string, number>> = Object.freeze({
  ...Object.fromEntries(Array.from({ length: GRANULARITY }, (_, i) => [String.fromCharCode(65 + i), GRANULARITY - i])),
  ...Object.fromEntries(Array.from({ length: GRANULARITY }, (_, i) => [String.fromCharCode(97 + i), GRANULARITY - i])),
})

const MIN_SCORE = 1
const MAX_SCORE = GRANULARITY

/** One evaluation criterion the judge reasons about. */
export interface JudgeCriterion {
  id: string
  name: string
  description: string
}

/**
 * Build the single-criterion pairwise judge prompt. Everything
 * criterion-independent comes first so prefix-caching backends serve the
 * trace-heavy body from cache; the varying criterion stays strictly at the
 * tail (verbatim port of `build_prompt`).
 * @param input the problem, traces, criterion, and optional ground-truth note to embed.
 * @returns the assembled judge prompt string.
 */
export function buildJudgePrompt(input: {
  /** The task description the agent was asked to solve. */
  problem: string
  /** The first agent's trajectory to evaluate. */
  traceA: string
  /** The second agent's trajectory to evaluate. */
  traceB: string
  /** The single criterion the judge reasons about. */
  criterion: JudgeCriterion
  /** Optional note about ground truth prepended to the prompt. */
  groundTruthNote?: string
}): string {
  const { problem, traceA, traceB, criterion } = input
  const note = input.groundTruthNote ?? ''
  return (
    'You are an expert evaluator of AI coding agents. ' +
    'You will see a task description and two agent trajectories, then ' +
    'evaluate them on ONE specific criterion, stated at the end.\n\n' +
    `${note}\n\n` +
    `**Task:**\n${problem}\n\n` +
    '**Trajectory A:**\n' + traceA + '\n\n' +
    '**Trajectory B:**\n' + traceB + '\n\n' +
    `**Rating Scale:**\n${SCALE_DESCRIPTION}\n\n` +
    `**Evaluation Guideline — ${criterion.name}:**\n` +
    `${criterion.description}\n\n` +
    'Score each trajectory ONLY on this specific criterion ' +
    `("${criterion.name}"). Ignore other aspects of the trajectory ` +
    'that are not relevant to it.\n\n' +
    'Reason it through first, then END your reply with exactly these two ' +
    'lines and nothing after them. Replace each placeholder with a single ' +
    'letter A-T, keeping the spaces around the letter exactly as shown:\n' +
    `<score_A> ${SCORE_FORMAT} </score_A>\n` +
    `<score_B> ${SCORE_FORMAT} </score_B>\n\n` +
    'Begin your analysis now.'
  )
}

/** Per-position alternatives as served by logprobs-capable providers. */
export type PositionAlternatives = ReadonlyArray<readonly [string, number]>

/**
 * Locate the alternatives for the position following `tag` in the streamed
 * token list. Some tokenizers fuse the closing '>' with the score letter, so
 * the cumulative text is matched against the tag and the tag without its
 * trailing '>' — and the LAST match wins, because the verdict block sits at
 * the end of the reply while the format may be quoted mid-analysis.
 * @param tokens the streamed reply tokens in order.
 * @param positionLogprobs per-position top alternatives from the provider.
 * @param tag the XML-style tag whose following position carries the score letter.
 * @returns the next position's alternatives, or null when absent.
 */
export function findTagLogprobs(
  tokens: readonly string[],
  positionLogprobs: readonly PositionAlternatives[],
  tag: string,
): PositionAlternatives | null {
  if (tokens.length === 0 || positionLogprobs.length === 0) return null
  for (const suffix of [tag, tag.slice(0, -1)]) {
    let found: PositionAlternatives | undefined
    let textSoFar = ''
    for (let i = 0; i < tokens.length; i++) {
      textSoFar += tokens[i]
      if (textSoFar.trimEnd().endsWith(suffix) && i + 1 < positionLogprobs.length) {
        found = positionLogprobs[i + 1]
      }
    }
    if (found !== undefined) return found
  }
  return null
}

function normalizedScore(value: number): number {
  return MAX_SCORE > MIN_SCORE ? (value - MIN_SCORE) / (MAX_SCORE - MIN_SCORE) : 0.5
}

/**
 * Expected score over the judge's token distribution at `tag`, normalized to
 * [0, 1]. Falls back to parsing the literal `<tag> X </tag>` from the text,
 * and finally to 0.5 (verbatim port of `extract_score`, including the
 * tokenizer's fused `>LETTER` stripping and the per-value max-prob rule that
 * merges upper/lowercase variants of the same letter).
 *
 * With the v1 LLM seam every position carries a single alternative, so the
 * expectation reduces to that chosen token's scale value; the distribution
 * math stays for seams that surface top-k variants (the calibration script
 * feeds real top-20 data through here).
 * @param text the full model reply, used for the literal-tag fallback.
 * @param tokens the streamed reply tokens in order.
 * @param positionLogprobs per-position top alternatives from the provider.
 * @param tag the XML-style tag identifying the score position.
 * @returns the normalized expected score in [0, 1].
 */
export function extractScore(
  text: string,
  tokens: readonly string[],
  positionLogprobs: readonly PositionAlternatives[],
  tag: string,
): number {
  const alts = findTagLogprobs(tokens, positionLogprobs, tag)
  const probs = new Map<number, number>()
  if (alts) {
    for (const [rawToken, logprob] of alts) {
      let tok = rawToken.trim()
      if (tok.startsWith('>')) tok = tok.slice(1).trim() // DeepSeek fuses '>' with the letter
      const value = VALID_TOKENS[tok]
      if (value === undefined) continue
      const p = Math.exp(logprob)
      probs.set(value, Math.max(probs.get(value) ?? 0, p))
    }
  }

  if (probs.size > 0) {
    let totalP = 0
    let expected = 0
    for (const [value, p] of probs) {
      expected += value * p
      totalP += p
    }
    return normalizedScore(totalP > 0 ? expected / totalP : 0)
  }

  const tagName = tag.replace(/^<|>$/g, '')
  const pattern = new RegExp(`<${tagName}>\\s*(.+?)\\s*</${tagName}>`, 'gi')
  const matches = [...text.matchAll(pattern)]
  const last = matches.at(-1)
  const literal = last?.[1]
  if (literal !== undefined && literal !== '') {
    const tok = literal.trim()
    let raw = VALID_TOKENS[tok]
    if (raw === undefined) {
      const lowered = tok.toLowerCase()
      for (const [variant, value] of Object.entries(VALID_TOKENS)) {
        if (lowered === variant.toLowerCase()) {
          raw = value
          break
        }
      }
    }
    if (raw !== undefined) return normalizedScore(raw)
  }

  return 0.5
}
