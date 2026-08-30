/**
 * LLM-as-a-Verifier plugin: registers the `verify` tool — a Probabilistic
 * Pivot Tournament over candidate trajectories, scored through this context's
 * LLM seam via chosen-token logprobs (Eq 3.1 expectation; with the v1
 * chosen-token-only seam each verdict position carries a single alternative,
 * so the expectation equals the chosen letter's scale value). Pairs with the
 * other RLM plugins.
 * @module @deepseek-ai/dsh-plugin-rlm-verifier
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import { redactReferenceText } from '@deepseek-ai/dsh-plugin-rlm-kernel'
import type {} from '@deepseek-ai/dsh-subagent'
import z from '@deepseek-ai/schemastery'
import { createVerifyTool, type VerifyCallModel } from './verify-tool.ts'

export const name = 'plugin-rlm-verifier'
export const inject = ['tools', 'llm', 'subagents']

/** A named judge entry for multi-judge panels. */
export interface JudgeProfileConfig {
  /** Verifier model id. */
  model?: string
  /** Provider route; defaults to the plugin-level provider. */
  provider?: string
}

/**
 * Configuration for the RLM verifier plugin: provider/model routing, session
 * artifact storage, multi-judge panels, and the privacy redaction tier.
 */
export interface Config {
  /**
   * Default provider route for scoring calls. Defaults to
   * `deepseek-official` (the harness's own DeepSeek adapter).
   */
  provider?: string
  /** Verifier model name. Defaults to deepseek-v4-flash. */
  model?: string
  /** Subagent provider name used by auto_spawn. Defaults to 'spawn'. */
  subagentProvider?: string
  /** Max characters captured from each spawned child's result. Default 20000. */
  maxChildChars?: number
  /**
   * `''` (off), `'display'` (render judge provenance), or `'full'` (mask
   * credential/PII material in candidate digests and text before scoring).
   */
  privacyFilter?: string
  /** Named multi-judge profiles addressable via the tool's `judges` argument. */
  judgeProfiles?: Record<string, JudgeProfileConfig>
  /**
   * T2.6: root directory for session artifacts. When set, every verify run
   * writes a full-detail JSON under `<dataDir>/session-artifacts/<sid>/verify/`
   * and the result event carries the path. Defaults to `~/.dsh/rlm`.
   */
  dataDir?: string
  /**
   * Phase 8 (review round 6): hard cap on the candidate pool per verify call.
   * Defaults to 24; larger lists fail loud naming the knob.
   */
  maxCandidates?: number
  /** Phase 8: cap on `n_evaluations` (scoring passes per pair). Defaults to 8. */
  maxEvaluations?: number
  /** Phase 8: cap on the `auto_spawn` child count. Defaults to 8. */
  maxAutoSpawn?: number
  /**
   * Phase 8: whole-verify wall-clock budget in ms — a hanging judge endpoint
   * must not pin the turn forever. Defaults to 600000.
   */
  verifyTimeoutMs?: number
}

export const Config: z<Config> = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  subagentProvider: z.string().min(1),
  maxChildChars: z.natural().min(1),
  privacyFilter: z.string(),
  dataDir: z.string().min(1),
  maxCandidates: z.natural().min(1),
  maxEvaluations: z.natural().min(1),
  maxAutoSpawn: z.natural().min(1),
  verifyTimeoutMs: z.natural().min(1),
  judgeProfiles: z.dict(z.object({
    model: z.string().required(),
    provider: z.string(),
  })),
})

/**
 * Run one scoring call through the context's LLM seam with chosen-token
 * logprobs opted in, reducing the stream to text plus the logprob stream.
 */
async function callSeamModel(
  ctx: Context,
  request: Parameters<VerifyCallModel>[0],
): Promise<{ text: string; logprobs: Array<{ token: string; logprob: number }> }> {
  const assembler = new BlockAssembler()
  const options: GenerateOptions = {
    provider: request.route.provider,
    model: request.route.model,
    messages: [
      createUserMessage({
        content: [{ type: 'text', text: request.userText }],
        source: { kind: 'plugin', plugin: 'dsh-plugin-rlm-verifier' },
      }),
    ],
    maxTokens: request.maxTokens,
    logprobs: { topLogprobs: 20 },
    signal: request.signal,
  }
  for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk)
  const finish = assembler.finish
  if (finish.kind === 'error') throw new Error(`verify scoring failed: ${finish.failure.message}`)
  if (finish.kind === 'aborted') throw new Error('verify scoring aborted')
  const text = assembler
    .blocks()
    .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
  return { text, logprobs: [...assembler.logprobs] }
}

export function apply(ctx: Context, config: Config): void {
  const privacyFilter = config.privacyFilter === 'display' || config.privacyFilter === 'full' ? config.privacyFilter : ''
  const provider = config.provider ?? 'deepseek-official'

  // auto_spawn controllers register before start (host-handlers pattern) and
  // abort on session disposal so spawned children cannot outlive the session.
  const sessionControllers = new Map<string, Set<AbortController>>()
  const trackController = (sessionId: string, controller: AbortController): (() => void) => {
    let controllers = sessionControllers.get(sessionId)
    if (!controllers) {
      controllers = new Set<AbortController>()
      sessionControllers.set(sessionId, controllers)
    }
    controllers.add(controller)
    return () => {
      controllers?.delete(controller)
      if (controllers?.size === 0) sessionControllers.delete(sessionId)
    }
  }
  ctx.on('session/disposed', (session) => {
    const controllers = sessionControllers.get(String(session.id))
    if (controllers) {
      for (const controller of [...controllers]) controller.abort()
      sessionControllers.delete(String(session.id))
    }
  })

  const subagents = ctx.get('subagents')

  const judgeProfiles: Record<string, { model: string; provider?: string }> = {}
  for (const [name, profile] of Object.entries(config.judgeProfiles ?? {})) {
    if (profile.model === undefined) continue
    judgeProfiles[name] = profile.provider !== undefined
      ? { model: profile.model, provider: profile.provider }
      : { model: profile.model }
  }

  const tool = createVerifyTool({
    callModel: request => callSeamModel(ctx, request),
    provider,
    // T2.6: session artifacts root for per-run detail files.
    artifactRoot: join(config.dataDir ?? join(homedir(), '.dsh', 'rlm'), 'session-artifacts'),
    ...(config.model !== undefined ? { model: config.model } : {}),
    ...(subagents !== undefined ? { subagents } : {}),
    ...(config.subagentProvider !== undefined ? { subagentProvider: config.subagentProvider } : {}),
    ...(config.maxChildChars !== undefined ? { maxChildChars: config.maxChildChars } : {}),
    // Phase 8 (review round 6): fan-out governors — the comparison count
    // scales with the pool, so an unbounded verify call was an unbounded bill.
    ...(config.maxCandidates !== undefined ? { maxCandidates: config.maxCandidates } : {}),
    ...(config.maxEvaluations !== undefined ? { maxEvaluations: config.maxEvaluations } : {}),
    ...(config.maxAutoSpawn !== undefined ? { maxAutoSpawn: config.maxAutoSpawn } : {}),
    ...(config.verifyTimeoutMs !== undefined ? { verifyTimeoutMs: config.verifyTimeoutMs } : {}),
    privacyFilter,
    // T2.6 fix: full-spectrum credential/PII masking for the durable detail
    // archive under `full` privacy (shared kernel-package redactor).
    ...(privacyFilter === 'full' ? { redactReference: redactReferenceText } : {}),
    trackController,
    ...(Object.keys(judgeProfiles).length > 0 ? { judgeProfiles } : {}),
    maxTokens: 4_096,
  })

  ctx.effect(
    () => ctx.tools.register(tool),
    'register verify tool',
  )
}
