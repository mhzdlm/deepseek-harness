/**
 * `verify` tool — LLM-as-a-Verifier best-of-N selection, hosted entirely on
 * the harness LLM seam.
 *
 * Scoring contract is the TypeScript port in `scoring.ts` (20-letter scale,
 * pairwise judge prompt, Eq 3.1 expectation over the token distribution at the
 * verdict position) and the selection loop is the Probabilistic Pivot
 * Tournament in `tournament.ts` — O(Nk) directed comparisons instead of O(N²).
 *
 * The v1 LLM seam surfaces only chosen-token logprobs (no top-k variants), so
 * every verdict position carries a single alternative and the Eq 3.1
 * expectation reduces to the chosen letter's scale value. The
 * multi-alternative machinery stays intact for a seam that exposes variants;
 * `scripts/calibrate-judge.mts` consumes real top-20 data over raw HTTP.
 *
 * Failure semantics follow the reference `on_error: "tie"`: a failed scoring
 * call contributes a 0.5/0.5 tie for that comparison instead of failing the
 * run; the panel only fails when every call in a phase fails hard enough
 * that no comparison could be scored at all.
 *
 * @module @deepseek-ai/dsh-plugin-rlm-verifier/verify-tool
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { SubagentRuntime, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import type { TokenLogprob } from '@deepseek-ai/dsh-llm'
import { buildJudgePrompt, extractScore, type JudgeCriterion } from './scoring.ts'
import { runTournament } from './tournament.ts'
import { emitVerifyEvent } from './events.ts'
/** One teed bypass scoring call, archived in the run's detail file (T2.6). */
export interface VerifyCallRecord {
  model: string
  userText: string
  rawText: string
  chosenLogprobs: Array<{ token: string; logprob: number }>
}

/** A named judge entry for multi-judge panels. */
export interface JudgeProfile {
  /** Verifier model id. */
  model: string
}

/** Transport-agnostic scoring invocation injected from the plugin wiring. */
export type VerifyCallModel = (request: {
  route: { provider: string; model: string }
  system?: string
  userText: string
  maxTokens: number
  signal: AbortSignal
}) => Promise<{ text: string; logprobs: TokenLogprob[] }>

export interface VerifyToolOptions {
  /** Resolves the LLM transport; injected so orchestration is unit-testable. */
  callModel: VerifyCallModel
  /** Default provider route for the scoring model. */
  provider: string
  /** Default verifier model when neither args nor config name one. */
  model?: string
  /** Optional subagent runtime enabling `auto_spawn` candidate generation. */
  subagents?: SubagentRuntime
  /** Subagent provider name used by auto_spawn. */
  subagentProvider?: string
  /** Max characters captured from each spawned child's result. */
  maxChildChars?: number
  /**
   * Callback to register an auto_spawn controller for session-tracked abort.
   * Returns an unregister function.
   */
  trackController?: (sessionId: string, controller: AbortController) => () => void
  /**
   * `display` annotates rendered output with per-judge provenance; `full`
   * masks candidate text before scoring prompts.
   */
  privacyFilter?: '' | 'display' | 'full'
  /**
   * T2.6: `<dataDir>/session-artifacts` root. When set, each run writes a
   * full-detail JSON (masked candidates, per-call raw judge outputs and
   * chosen-token logprobs) under `<artifactRoot>/<sessionId>/verify/`, and
   * the result event carries the path. Best-effort: write failures drop the
   * file, never the verification.
   */
  artifactRoot?: string
  /**
   * Full-privacy archiver (T2.6 fix): masks credential/PII material in the
   * DETAIL ARCHIVE ONLY — `calls[].userText` and candidate copies under
   * `<artifactRoot>/<sessionId>/verify/`. Scoring prompts themselves stay
   * verbatim by design ("masks digests, not scoring prompts"). Injected from
   * the shared kernel-package redactor when `privacyFilter === 'full'`;
   * absent, archives fall back to the legacy key-shaped pattern.
   */
  redactReference?: (text: string) => string
  /** Named judge profiles addressable via the `judges` argument. */
  judgeProfiles?: Record<string, { model: string; provider?: string }>
  /** Max output tokens per scoring call (reference default 4096). */
  maxTokens?: number
}

const DEFAULT_CRITERIA: Array<JudgeCriterion> = [
  { id: 'Specification', name: 'Specification', description: 'Does the trajectory satisfy all task requirements (exact paths, formats, constraints)?' },
  { id: 'Output', name: 'Output', description: 'Does the final output match the expected result?' },
  { id: 'Errors', name: 'Errors', description: 'Is the trajectory free of unresolved failure signals (errors, tracebacks, nonzero exits)?' },
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Resolve the `criteria` argument (a JSON object mapping criterion name to
 * description) into the ordered judge-criterion list, falling back to the
 * bundled tri-criteria when absent or malformed.
 */
function resolveCriteria(raw: unknown): Array<JudgeCriterion> {
  if (typeof raw === 'string' && raw.trim() !== '') {
    try {
      const parsed = JSON.parse(raw) as unknown
      if (isRecord(parsed)) {
        const entries = Object.entries(parsed)
          .filter(([, v]) => typeof v === 'string')
          .map(([id, description]) => ({ id, name: id, description: description as string }))
        if (entries.length > 0) return entries
      }
    } catch {
      // Fall back to defaults on malformed criteria JSON.
    }
  }
  return DEFAULT_CRITERIA.map(criterion => ({ ...criterion }))
}

/** Build the `verify` tool around the injected transport. */
export function createVerifyTool(options: VerifyToolOptions) {
  const maxCallTokens = options.maxTokens ?? 4_096
  // T2.6 fix: one masking policy for every DURABLE byte of a run (detail-file
  // candidates, per-call prompts). Transport requests are forwarded verbatim.
  const maskForArchive = (text: string): string =>
    options.privacyFilter === 'full'
      ? (options.redactReference ?? ((raw: string) => maskCandidateText(raw, 'full')))(text)
      : text
  return defineTool({
    name: 'verify',
    description:
      'Score N candidate solutions/trajectories for a task with an LLM verifier panel ' +
      '(pairwise judged rankings from a Probabilistic Pivot Tournament; verdict letters are ' +
      'read from the chosen-token logprob stream) and return the best one. ' +
      'Pass the task as `problem` and each candidate as an element of `candidates`.',
    parameters: {
      problem: {
        type: 'string',
        required: true,
        description: 'The task instruction the candidates are solutions to',
      },
      candidates: {
        type: 'array',
        items: { type: 'string' },
        required: true,
        description: 'Candidate trajectories / solutions to rank (at least 2 recommended)',
      },
      criteria: {
        type: 'string',
        description:
          'Optional JSON object mapping criterion name to description, e.g. ' +
          '{"Correctness":"does the code work?"}. Defaults to specification/output/errors.',
      },
      n_evaluations: {
        type: 'integer',
        description: 'Repeated verifications K per criterion (default 4)',
      },
      pivots: {
        type: 'integer',
        description: 'Number of PPT pivots k (default 2, clamped to N)',
      },
      seed: {
        type: 'integer',
        description: 'Seed for the ring pass (default 0)',
      },
      model: {
        type: 'string',
        description: 'Verifier model name (default deepseek-v4-flash)',
      },
      judges: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Named judge profiles: run one independent verification per profile and fuse the rankings.',
      },
      auto_spawn: {
        type: 'integer',
        description:
          'If >0 and candidates is empty, spawn this many subagents to solve the task and verify their results (best-of-N)',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          index: { type: 'integer', required: true },
          scores: { type: 'array', items: { type: 'number' }, required: true },
          ranking: { type: 'array', items: { type: 'integer' }, required: true },
          nComparisons: { type: 'integer', required: true },
          judges: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                model: { type: 'string', required: true },
                status: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const lines: string[] = []
        if (options.privacyFilter === 'display' && Array.isArray(value.judges)) {
          lines.push(`verify panel (${value.judges.length} judges)`)
          for (const judge of value.judges as Array<{ model: string; status: string }>) {
            lines.push(`  ${judge.status === 'ok' ? '✓' : '✗'} ${judge.model}`)
          }
          lines.push('')
        }
        lines.push(value.text)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const problem = typeof args.problem === 'string' ? args.problem : ''
      if (!problem.trim()) throw new Error('verify: problem is required')
      const raw = args.candidates
      let candidates: string[] = Array.isArray(raw)
        ? raw.filter((c): c is string => typeof c === 'string')
        : []

      const childSessionIds: string[] = []
      // auto_spawn: dispatch N children against the task and use their results
      // as the candidate pool. Controllers register before start so disposal
      // during startup still aborts pending spawns (host-handlers pattern).
      const autoSpawn = typeof args.auto_spawn === 'number' && args.auto_spawn > 0 ? Math.floor(args.auto_spawn) : 0
      if (candidates.length === 0 && autoSpawn > 0) {
        const subagents = options.subagents
        if (!subagents) throw new Error('verify: auto_spawn requires the subagent service')
        const owner = exec.agent
        if (!owner) throw new Error('verify: auto_spawn requires an owning agent')
        const sid = owner.session?.id !== undefined ? String(owner.session.id) : undefined
        const maxChars = options.maxChildChars ?? 20_000
        const results = await Promise.all(
          Array.from({ length: autoSpawn }, async (_, i) => {
            const controller = new AbortController()
            const unregister = sid !== undefined && options.trackController
              ? options.trackController(sid, controller)
              : undefined
            const request: SubagentStartRequest = {
              prompt: [{ type: 'text', text: problem }],
              parent: owner,
              label: `verify-child-${i + 1}`,
              signal: controller.signal,
            }
            try {
              const run = await subagents.start(options.subagentProvider ?? 'spawn', request)
              childSessionIds.push(String(run.id))
              const result = await run.result
              const text = (result.output ?? [])
                .map(block => (block.type === 'text' ? (block.text ?? '') : ''))
                .join('\n')
                .trim()
              return text.slice(0, maxChars)
            } finally {
              unregister?.()
            }
          }),
        )
        candidates = results.filter(text => text.length > 0)
      }

      if (candidates.length < 2) {
        throw new Error(`verify: need at least 2 candidates, got ${candidates.length}`)
      }

      const criteria = resolveCriteria(args.criteria)
      const nEvaluations = typeof args.n_evaluations === 'number' && args.n_evaluations > 0
        ? Math.floor(args.n_evaluations)
        : 4
      const pivotsArg = typeof args.pivots === 'number' && args.pivots > 0 ? Math.floor(args.pivots) : 2
      const seed = typeof args.seed === 'number' && Number.isFinite(args.seed) ? Math.floor(args.seed) : 0
      const session = exec.agent?.session ?? null
      const startedAt = Date.now()
      // T2.6: tee every bypass scoring call so the durable detail file can
      // answer "what did each judge actually say" — raw text plus the
      // chosen-token logprob stream, in call order.
      const calls: VerifyCallRecord[] = []
      const callModelTee: VerifyCallModel = async (request) => {
        const out = await options.callModel(request)
        calls.push({
          model: request.route.model,
          // Archive copy only — the live scoring request above stays verbatim.
          userText: maskForArchive(request.userText),
          rawText: out.text,
          chosenLogprobs: out.logprobs,
        })
        return out
      }
      const sessionIdForDetail = session ? String((session as unknown as { id: string }).id) : undefined
      const writeDetail = (extra: Record<string, unknown>): string | undefined =>
        writeVerifyDetail(options.artifactRoot, sessionIdForDetail, {
          ts: new Date(startedAt).toISOString(),
          problem,
          criteria,
          candidates: candidates.map(maskForArchive),
          ...extra,
          calls,
        })

      // Multi-judge: one independent seam tournament per named profile, then
      // Borda fusion over their rankings.
      const judgeNames = Array.isArray(args.judges) ? args.judges.filter((j): j is string => typeof j === 'string') : []
      if (judgeNames.length > 0) {
        const profiles = options.judgeProfiles ?? {}
        const selected: Array<{ name: string; profile: { model: string; provider?: string } }> = []
        for (const name of judgeNames) {
          const profile = profiles[name]
          if (profile === undefined) continue
          selected.push({ name, profile })
        }
        const unknown = judgeNames.filter(name => !selected.some(s => s.name === name))
        if (unknown.length > 0) {
          throw new Error(
            `verify: unknown judge profile(s) '${unknown.join(', ')}'. Available: ${Object.keys(profiles).join(', ') || '(none)'}`,
          )
        }

        emitVerifyEvent(session, 'session/verify-request', {
          engine: 'seam',
          models: selected.map(s => s.profile.model),
          criteria: Object.fromEntries(criteria.map(c => [c.id, c.description])),
          candidateCount: candidates.length,
          candidatesDigest: digestCandidates(candidates, options.privacyFilter, options.redactReference),
          judgeProfiles: judgeNames,
        })

        const outcomes = await Promise.all(selected.map(async ({ name, profile }) => {
          try {
            const scored = await runTournament(candidates.length, seed, pivotsArg, async (a, b) =>
              scorePairOnSeam(callModelTee, {
                provider: profile.provider ?? options.provider ?? 'deepseek-official',
                model: profile.model,
              }, problem, candidates[a] ?? '', candidates[b] ?? '', criteria, nEvaluations, exec.signal, maxCallTokens))
            return { name, model: profile.model, status: 'ok' as const, ...scored }
          } catch {
            return { name, model: profile.model, status: 'failed' as const, bestIndex: -1, meanPreference: [], nComparisons: 0 }
          }
        }))
        const okOutcomes = outcomes.filter(o => o.status === 'ok')
        if (okOutcomes.length === 0) {
          throw new Error(`verify: all ${outcomes.length} judges failed (${outcomes.map(o => o.model).join(', ')})`)
        }
        const fused = fuseMeanPreferences(okOutcomes.map(o => ({ model: o.model, status: o.status, meanPreference: o.meanPreference })))
        const baseScores = okOutcomes[0]?.meanPreference ?? []
        const bestScores = fused.fusedRanking.map(i => baseScores[i] ?? 0)

        const judgeOutcomes = outcomes.map(o => ({
          model: o.model,
          status: o.status,
          meanPreference: o.meanPreference,
          nComparisons: o.nComparisons,
        }))
        const detailPath = writeDetail({
          childSessionIds,
          judges: judgeOutcomes,
          fused,
        })

        emitVerifyEvent(session, 'session/verify-result', {
          engine: 'seam',
          models: selected.map(s => s.profile.model),
          index: fused.bestIndex,
          scores: bestScores,
          ranking: fused.fusedRanking,
          nComparisons: okOutcomes.reduce((sum, o) => sum + o.nComparisons, 0),
          durationMs: Date.now() - startedAt,
          judges: judgeOutcomes,
          ...(childSessionIds.length > 0 ? { childSessionIds } : {}),
          ...(detailPath !== undefined ? { detailPath } : {}),
        })

        return {
          text: renderFused(fused, candidates, okOutcomes.length),
          index: fused.bestIndex,
          scores: bestScores,
          ranking: fused.fusedRanking,
          nComparisons: okOutcomes.reduce((sum, o) => sum + o.nComparisons, 0),
          judges: outcomes.map(o => ({ model: o.model, status: o.status })),
        }
      }

      // Single-judge seam tournament.
      const model = typeof args.model === 'string' && args.model.trim() ? args.model.trim() : options.model ?? 'deepseek-v4-flash'
      const route = { provider: options.provider ?? 'deepseek-official', model }
      emitVerifyEvent(session, 'session/verify-request', {
        engine: 'seam',
        models: [model],
        criteria: Object.fromEntries(criteria.map(c => [c.id, c.description])),
        candidateCount: candidates.length,
        candidatesDigest: digestCandidates(candidates, options.privacyFilter, options.redactReference),
      })
      const startedSingle = Date.now()
      const tournament = await runTournament(candidates.length, seed, Math.min(pivotsArg, candidates.length), async (a, b) =>
        scorePairOnSeam(callModelTee, route, problem, candidates[a] ?? '', candidates[b] ?? '', criteria, nEvaluations, exec.signal, maxCallTokens))
      const detailPathSingle = writeDetail({
        childSessionIds,
        judges: [{ model, status: 'ok', meanPreference: tournament.meanPreference, nComparisons: tournament.nComparisons }],
      })
      emitVerifyEvent(session, 'session/verify-result', {
        engine: 'seam',
        models: [model],
        index: tournament.bestIndex,
        scores: tournament.meanPreference,
        ranking: rankByMean(tournament.meanPreference),
        nComparisons: tournament.nComparisons,
        durationMs: Date.now() - startedSingle,
        judges: [{ model, status: 'ok' as const, meanPreference: tournament.meanPreference, nComparisons: tournament.nComparisons }],
        ...(childSessionIds.length > 0 ? { childSessionIds } : {}),
        ...(detailPathSingle !== undefined ? { detailPath: detailPathSingle } : {}),
      })

      const best = candidates[tournament.bestIndex] ?? ''
      const scores = tournament.meanPreference
      const ranking = rankByMean(scores)
      const lines = [
        `best = candidate[${tournament.bestIndex}] (${scores[tournament.bestIndex]?.toFixed(3)})`,
        `ranking: ${ranking.join(' > ')}`,
        `scores: [${scores.map(s => s.toFixed(3)).join(', ')}]`,
        `comparisons: ${tournament.nComparisons}, criteria: ${criteria.map(c => c.id).join('+')}`,
        '',
        best,
      ]
      return {
        text: lines.join('\n'),
        index: tournament.bestIndex,
        scores,
        ranking,
        nComparisons: tournament.nComparisons,
      }
    },
  })
}

function renderFused(
  fused: { bestIndex: number; fusedRanking: number[] },
  candidates: string[],
  judgeCount: number,
): string {
  return [
    `fused best = candidate[${fused.bestIndex}] over ${judgeCount} judge(s)`,
    `ranking: ${fused.fusedRanking.join(' > ')}`,
    '',
    candidates[fused.bestIndex] ?? '',
  ].join('\n')
}

function fuseMeanPreferences(
  outcomes: Array<{ model: string; status: string; meanPreference: number[] }>,
): { bestIndex: number; fusedRanking: number[] } {
  const n = outcomes[0]?.meanPreference.length ?? 0
  const borda = new Array<number>(n).fill(0)
  for (const outcome of outcomes) {
    const order = outcome.meanPreference
      .map((score, index) => ({ index, score }))
      .sort((x, y) => y.score - x.score || x.index - y.index)
    order.forEach((entry, position) => {
      borda[entry.index] = (borda[entry.index] ?? 0) + n - position
    })
  }
  const fusedRanking = borda
    .map((points, index) => ({ index, points: points ?? 0 }))
    .sort((a, b) => b.points - a.points || a.index - b.index)
    .map(entry => entry.index)
  return { bestIndex: fusedRanking[0] ?? -1, fusedRanking }
}

function rankByMean(meanPreference: readonly number[]): number[] {
  return meanPreference
    .map((score, index) => ({ index, score }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(entry => entry.index)
}

function digestCandidates(
  candidates: readonly string[],
  privacyFilter: string | undefined,
  redactReference?: (text: string) => string,
): string[] {
  return candidates.map((text) => {
    const masked = privacyFilter === 'full'
      ? (redactReference ?? ((raw: string) => maskCandidateText(raw, 'full')))(text)
      : text
    return masked.slice(0, 120)
  })
}

/** Legacy fallback pattern when no shared redactor is injected (mask ≠ truncate). */
function maskCandidateText(text: string, privacyFilter: string | undefined): string {
  return privacyFilter === 'full' ? text.replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}\b/g, '[redacted key]') : text
}

/**
 * T2.6: persist one run's full detail (masked candidates, per-call raw judge
 * outputs with chosen-token logprobs, fusion inputs) under the session's
 * artifacts directory. Best-effort — a write failure returns `undefined` and
 * the run proceeds without the pointer.
 */
function writeVerifyDetail(
  artifactRoot: string | undefined,
  sessionId: string | undefined,
  payload: Record<string, unknown>,
): string | undefined {
  if (!artifactRoot || !sessionId) return undefined
  try {
    const dir = path.join(artifactRoot, sessionId, 'verify')
    mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `${Date.now()}.json`)
    writeFileSync(file, JSON.stringify(payload), 'utf8')
    return file
  } catch {
    return undefined
  }
}

async function scorePairOnSeam(
  callModel: VerifyCallModel,
  route: { provider: string; model: string },
  problem: string,
  traceA: string,
  traceB: string,
  criteria: JudgeCriterion[],
  nEvaluations: number,
  signal: AbortSignal,
  maxTokens: number,
): Promise<[number, number]> {
  let raSum = 0
  let rbSum = 0
  let count = 0
  for (let rep = 0; rep < nEvaluations; rep++) {
    // Odd repetitions swap the prompt slots so the verifier's slot bias cancels;
    // rewards are mapped back so score_A always means candidate a.
    const swapped = rep % 2 === 1
    for (const criterion of criteria) {
      const prompt = buildJudgePrompt({
        problem,
        traceA: swapped ? traceB : traceA,
        traceB: swapped ? traceA : traceB,
        criterion,
      })
      let ra: number
      let rb: number
      try {
        const out = await callModel({
          route,
          userText: prompt,
          maxTokens,
          signal,
        })
        const tokens = out.logprobs.map(entry => entry.token)
        // v1 seam: chosen-token only, so each verdict position gets exactly one
        // alternative and extractScore's expectation equals that letter's value.
        const positions = out.logprobs.map(entry => [[entry.token, entry.logprob]] as const)
        ra = extractScore(out.text, tokens, positions, '<score_A>')
        rb = extractScore(out.text, tokens, positions, '<score_B>')
      } catch {
        // on_error "tie": a failed call contributes a neutral 0.5/0.5 for this
        // repetition instead of failing the whole comparison.
        ra = 0.5
        rb = 0.5
      }
      if (swapped) [ra, rb] = [rb, ra]
      raSum += ra
      rbSum += rb
      count += 1
    }
  }
  if (count === 0) return [0.5, 0.5]
  return [raSum / count, rbSum / count]
}
