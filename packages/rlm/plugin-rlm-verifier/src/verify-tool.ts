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
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      const problem = typeof args.problem === 'string' ? args.problem : ''
      const raw = args.candidates
      let candidates = Array.isArray(raw)
        ? raw.filter((c): c is string => typeof c === 'string').map(text => ({ text }))
        : []
      if (!problem.trim()) throw new Error('verify: problem is required')

      // auto_spawn: if candidates were not provided and the caller asked for
      // N subagents, dispatch N children against the same task and use their
      // results as the candidate pool.
      const autoSpawn = typeof args.auto_spawn === 'number' && args.auto_spawn > 0 ? Math.floor(args.auto_spawn) : 0
      if (candidates.length === 0 && autoSpawn > 0) {
        const subagents = options.subagents
        if (!subagents) throw new Error('verify: auto_spawn requires the subagent service')
        const owner = exec.agent
        if (!owner) throw new Error('verify: auto_spawn requires an owning agent')
        const maxChars = options.maxChildChars ?? 20_000
        const runs = await Promise.all(
          Array.from({ length: autoSpawn }, async (_, i) => {
            const request: SubagentStartRequest = {
              prompt: [{ type: 'text', text: problem }],
              parent: owner,
              label: `verify-child-${i + 1}`,
              signal: new AbortController().signal,
            }
            const run = await subagents.start(options.subagentProvider ?? 'spawn', request)
            const result = await run.result
            const text = (result.output ?? [])
              .map(block => (block.type === 'text' ? block.text ?? '' : ''))
              .join('\n')
              .trim()
            return { text: text.slice(0, maxChars) }
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
      const program = buildPythonProgram()
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

      let stdout: string
      const kernels = sid ? options.getKernels() : undefined

      if (sid && kernels?.hasSession(sid)) {
        // Kernel path: run the program inside the session's live kernel. The
        // payload rides in an env var the kernel process already carries.
        const result = await kernels.execute(sid, program, { signal: exec.signal })
        stdout = result.stdout || ''
        if (result.status === 'error' && !stdout) {
          const detail = result.error?.evalue ?? result.stderr ?? ''
          throw new Error(`verify: kernel cell failed: ${detail}`)
        }
      } else {
        // Subprocess path: spawn the venv python.
        stdout = await runVerifySubprocess(defaultVenvPython(), program, payload)
      }

      const parsed: VerifyResult = parseResultJson(stdout)
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
