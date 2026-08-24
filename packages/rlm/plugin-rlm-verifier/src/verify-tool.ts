/**
 * `verify` tool: LLM-as-a-Verifier best-of-N selection.
 *
 * Given a task problem and N candidate trajectories, scores every needed
 * directed pair with the fine-grained reward (Eq 3.1 expectation over
 * scoring-token logprobs), ranks candidates with a Probabilistic Pivot
 * Tournament (O(Nk) comparisons), and returns the best trajectory.
 *
 * Execution paths, in order:
 *   1. Kernel path — if the session already has a live IPython kernel, the
 *      `llm_verifier` call runs inside it (reuses the provisioned venv).
 *   2. Subprocess path — otherwise a venv python subprocess runs the same code.
 * @module @deepseek-ai/dsh-plugin-rlm-verifier
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { buildPythonProgram, defaultVenvPython, parseResultJson, runVerifySubprocess } from './python-bridge.ts'
import type { KernelExecutor, VerifyRequest, VerifyResult } from './python-bridge.ts'
import type { SubagentRuntime, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import type { JudgeOutcome } from './fusion.ts'
import { fuseJudgeOutcomes } from './fusion.ts'
import { emitVerifyEvent } from './events.ts'
import { redactReferenceText } from '@deepseek-ai/dsh-plugin-rlm-kernel/src/redact.ts'

/** A named judge profile: which model to score with and how to authenticate. */
export interface JudgeProfile {
  /** Verifier model id passed to `llm_verifier.select`. */
  model: string
  /** Optional OpenAI-compatible endpoint override (non-secret). */
  baseUrl?: string
  /** Environment variable holding this vendor's API key. */
  keyEnv?: string
  /** Additional environment variables forwarded alongside `keyEnv`. */
  extraEnv?: string[]
}

/** Default criteria when the caller names none (Sec 4.3 tri-criteria). */
export const DEFAULT_CRITERIA: Record<string, string> = {
  Specification: 'Does the trajectory satisfy all task requirements (exact paths, formats, constraints)?',
  Output: 'Does the final output match the expected result?',
  Errors: 'Is the trajectory free of unresolved failure signals (errors, tracebacks, nonzero exits)?',
}

export interface VerifyToolOptions {
  /** Kernel registry from plugin-rlm-kernel; undefined means subprocess-only. */
  getKernels: () => KernelExecutor | undefined
  /** Optional score-cache file (JSON) for incremental re-runs. */
  cacheFile?: string
  /** Verifier model; default deepseek-v4-flash. */
  model?: string
  /** Subagent runtime for auto_spawn; undefined disables auto_spawn. */
  subagents?: SubagentRuntime
  /** Subagent provider name used by auto_spawn. Default 'spawn'. */
  subagentProvider?: string
  /** Max characters captured from each spawned child's result. Default 20000. */
  maxChildChars?: number
  /**
   * P1-fix: callback to register an auto_spawn controller for session-tracked
   * abort. Returns an unregister function. When provided, auto_spawn children
   * are aborted on session disposal (mirrors host-handlers.ts abortSession).
   */
  trackController?: (sessionId: string, controller: AbortController) => () => void
  /**
   * `display` annotates rendered output with per-judge provenance; `full`
   * masks credential/PII material in candidate text before scoring prompts.
   */
  privacyFilter?: '' | 'display' | 'full'
  /** Named judge profiles addressable via the `judges` argument. */
  judgeProfiles?: Record<string, JudgeProfile>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Build the `verify` tool. Registered by the plugin's apply fiber; resolves
 * the kernel registry lazily so the tool works even before plugin-rlm-kernel
 * has provisioned anything.
 */
export function createVerifyTool(options: VerifyToolOptions) {
  return defineTool({
    name: 'verify',
    description:
      'Score N candidate solutions/trajectories for a task with an LLM verifier and return the best one. ' +
      'Uses a fine-grained continuous reward over scoring-token logprobs and a Probabilistic Pivot Tournament. ' +
      'Pass the task as `problem` and each candidate solution as an element of `candidates`.',
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
        description: 'Random seed for the ring pass (default 0)',
      },
      model: {
        type: 'string',
        description: 'Verifier model name (default deepseek-v4-flash)',
      },
      judges: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Named judge profiles: run one independent verification per profile and fuse the rankings. Requires judgeProfiles in plugin config.',
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
          fusedRanking: { type: 'array', items: { type: 'integer' } },
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
      const raw = args.candidates
      let candidates = Array.isArray(raw)
        ? raw.filter((c): c is string => typeof c === 'string').map(text => ({ text }))
        : []
      if (!problem.trim()) throw new Error('verify: problem is required')
      // `full` privacy mode masks credential/PII material in candidate text
      // before it enters any scoring prompt.
      if (options.privacyFilter === 'full') {
        candidates = candidates.map(c => ({ text: redactReferenceText(c.text) }))
      }

      // auto_spawn: if candidates were not provided and the caller asked for
      // N subagents, dispatch N children against the same task and use their
      // results as the candidate pool.
      // P1-fix: controllers are registered for session-tracked abort (mirrors
      // host-handlers.ts abortSession), so children cannot outlive their parent.
      const autoSpawn = typeof args.auto_spawn === 'number' && args.auto_spawn > 0 ? Math.floor(args.auto_spawn) : 0
      if (candidates.length === 0 && autoSpawn > 0) {
        const subagents = options.subagents
        if (!subagents) throw new Error('verify: auto_spawn requires the subagent service')
        const owner = exec.agent
        if (!owner) throw new Error('verify: auto_spawn requires an owning agent')
        const maxChars = options.maxChildChars ?? 20_000
        const sid = exec.agent?.session.id ? String(exec.agent.session.id) : undefined
        const runs = await Promise.all(
          Array.from({ length: autoSpawn }, async (_, i) => {
            const controller = new AbortController()
            // P1-fix: register controller BEFORE start so disposal during startup
            // still aborts the pending spawn (same pattern as host-handlers.ts).
            const unregister = sid && options.trackController
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
              const result = await run.result
              const text = (result.output ?? [])
                .map(block => (block.type === 'text' ? block.text ?? '' : ''))
                .join('\n')
                .trim()
              return { text: text.slice(0, maxChars) }
            } finally {
              unregister?.()
            }
          }),
        )
        candidates = runs
      }

      if (candidates.length < 2) {
        throw new Error(`verify: need at least 2 candidates, got ${candidates.length}`)
      }

      // Criteria: default tri-criteria unless the caller overrides.
      let criteria = DEFAULT_CRITERIA
      if (typeof args.criteria === 'string' && args.criteria.trim()) {
        try {
          const parsed = JSON.parse(args.criteria)
          if (isRecord(parsed)) {
            const entries = Object.entries(parsed)
              .filter(([, v]) => typeof v === 'string')
              .map(([k, v]) => [k, v as string])
            if (entries.length > 0) criteria = Object.fromEntries(entries)
          }
        } catch {
          // Fall back to defaults on malformed criteria JSON.
        }
      }

      const nEvaluations = typeof args.n_evaluations === 'number' && args.n_evaluations > 0 ? Math.floor(args.n_evaluations) : 4
      const pivots = typeof args.pivots === 'number' && args.pivots > 0 ? Math.floor(args.pivots) : 2
      const seed = typeof args.seed === 'number' && Number.isFinite(args.seed) ? Math.floor(args.seed) : 0
      const model = typeof args.model === 'string' && args.model.trim() ? args.model : options.model ?? 'deepseek-v4-flash'

      const sessionId = exec.agent?.session.id
      const sid = sessionId ? String(sessionId) : undefined
      const payload: VerifyRequest = {
        problem,
        candidates,
        criteria,
        nEvaluations,
        pivots,
        seed,
        model,
        ...(options.cacheFile !== undefined ? { cache: options.cacheFile } : {}),
      }
      const payloadBase = { ...payload }
      delete (payloadBase as { model?: string }).model

      const kernels = sid ? options.getKernels() : undefined
      const session = exec.agent?.session ?? null
      const startedAt = Date.now()

      // Multi-judge mode: one independent subprocess per named profile, each
      // authenticated only with that profile's variables, then Borda fusion.
      // Subprocess-forced by design: the kernel's env whitelist cannot carry
      // arbitrary vendor credentials (known limitation).
      const judgeNames = Array.isArray(args.judges) ? args.judges.filter((j): j is string => typeof j === 'string') : []
      if (judgeNames.length > 0) {
        const profiles = options.judgeProfiles ?? {}
        const available = Object.keys(profiles)
        const selected = judgeNames.map(name => ({ name, profile: profiles[name] }))
        const unknown = selected.filter(s => s.profile === undefined).map(s => s.name)
        if (unknown.length > 0) {
          throw new Error(`verify: unknown judge profile(s) '${unknown.join(', ')}'. Available: ${available.join(', ') || '(none)'}`)
        }
        const validJudges = selected as Array<{ name: string; profile: JudgeProfile }>
        emitVerifyEvent(session, 'session/verify-request', {
          mode: 'subprocess',
          models: validJudges.map(j => j.profile.model),
          criteria,
          candidateCount: candidates.length,
          candidatesDigest: candidates.map(c => c.text.slice(0, 120)),
          judgeProfiles: judgeNames,
        })
        type JudgeRun = JudgeOutcome & { scores?: number[]; ranking?: number[]; index?: number; nComparisons?: number }
        const outcomes: JudgeRun[] = await Promise.all(
          validJudges.map(async ({ name, profile }) => {
            try {
              const payload: VerifyRequest = { ...payloadBase, model: profile.model }
              const judgeStdout = await runVerifySubprocess(defaultVenvPython(), buildPythonProgram(), payload, {
                signal: exec.signal,
                ...(profile.baseUrl !== undefined ? { envOverrides: { OPENAI_BASE_URL: profile.baseUrl } } : {}),
                forwardEnvNames: [profile.keyEnv, ...(profile.extraEnv ?? [])].filter((n): n is string => Boolean(n)),
              })
              const parsed = parseResultJson(judgeStdout)
              return { model: name, status: 'ok' as const, scores: parsed.scores, ranking: parsed.ranking, index: parsed.index, nComparisons: parsed.nComparisons }
            } catch {
              return { model: name, status: 'failed' as const }
            }
          }),
        )
        if (!outcomes.some(o => o.status === 'ok')) {
          throw new Error(`verify: all ${outcomes.length} judges failed (${outcomes.map(o => o.model).join(', ')})`)
        }
        const fusion = fuseJudgeOutcomes(outcomes, candidates.length)
        const bestScores = fusion.fusedScores
        const text = [
          `fused best = candidate[${fusion.bestIndex}] over ${outcomes.filter(o => o.status === 'ok').length} judge(s)`,
          `ranking: ${fusion.fusedRanking.join(' > ')}`,
          `fused scores: [${bestScores.map(s => s.toFixed(3)).join(', ')}]`,
          '',
          candidates[fusion.bestIndex]?.text ?? '',
        ].join('\n')
        emitVerifyEvent(session, 'session/verify-result', {
          models: judgeNames,
          index: fusion.bestIndex,
          scores: bestScores,
          ranking: fusion.fusedRanking,
          nComparisons: outcomes.reduce((sum, o) => sum + (o.nComparisons ?? 0), 0),
          ...(fusion.failedJudges.length > 0 ? { failedJudges: fusion.failedJudges } : {}),
          fusedRanking: fusion.fusedRanking,
          durationMs: Date.now() - startedAt,
        })
        return {
          text,
          index: fusion.bestIndex,
          scores: bestScores,
          ranking: fusion.fusedRanking,
          nComparisons: outcomes.reduce((sum, o) => sum + (o.nComparisons ?? 0), 0),
          judges: outcomes.map(o => ({ model: o.model, status: o.status })),
          fusedRanking: fusion.fusedRanking,
        }
      }

      emitVerifyEvent(session, 'session/verify-request', {
        mode: sid && kernels?.hasSession(sid) ? 'kernel' : 'subprocess',
        models: [model],
        criteria,
        candidateCount: candidates.length,
        candidatesDigest: candidates.map(c => c.text.slice(0, 120)),
      })

      let stdout: string

      if (sid && kernels?.hasSession(sid)) {
        // Kernel path: run the program inside the session's live kernel. The
        // payload is embedded base64 in the program source: the kernel process
        // was spawned with its own env snapshot, so a `PY_VERIFY_PAYLOAD` env
        // var set here would never reach `os.environ` inside it — and a shared
        // mutable env var would also race between concurrent verify calls.
        const program = buildPythonProgram(payload)
        const result = await kernels.execute(sid, program, { signal: exec.signal })
        stdout = result.stdout || ''
        // The program prints `VERIFY_ERROR {...}` and exits nonzero on failure;
        // without this check the error JSON would be mis-parsed as a result.
        if (stdout.includes('VERIFY_ERROR')) {
          throw new Error(`verify: kernel cell failed: ${stdout.slice(0, 1000)}`)
        }
        if (result.status === 'error' && !stdout) {
          const detail = result.error?.evalue ?? result.stderr ?? ''
          // If the kernel's venv lacks llm-verifier, fall back to subprocess
          // which uses the canonical venv path.
          if (/ModuleNotFoundError|ImportError/.test(detail)) {
            stdout = await runVerifySubprocess(defaultVenvPython(), program, payload, { signal: exec.signal })
          } else {
            throw new Error(`verify: kernel cell failed: ${detail}`)
          }
        }
      } else {
        // Subprocess path: spawn the venv python (payload via env var).
        // P1-fix: pass signal so cancelling verify also terminates the subprocess.
        stdout = await runVerifySubprocess(defaultVenvPython(), buildPythonProgram(), payload, { signal: exec.signal })
      }

      const parsed: VerifyResult = parseResultJson(stdout)
      emitVerifyEvent(session, 'session/verify-result', {
        models: [model],
        index: parsed.index,
        scores: parsed.scores,
        ranking: parsed.ranking,
        nComparisons: parsed.nComparisons,
        durationMs: Date.now() - startedAt,
      })
      const best = candidates[parsed.index]?.text ?? ''
      const lines = [
        `best = candidate[${parsed.index}] (${parsed.scores[parsed.index]?.toFixed(3)})`,
        `ranking: ${parsed.ranking.join(' > ')}`,
        `scores: [${parsed.scores.map(s => s.toFixed(3)).join(', ')}]`,
        `comparisons: ${parsed.nComparisons}, criteria: ${parsed.criteria.join('+')}`,
        '',
        best,
      ]
      return {
        text: lines.join('\n'),
        index: parsed.index,
        scores: parsed.scores,
        ranking: parsed.ranking,
        nComparisons: parsed.nComparisons,
      }
    },
  })
}
