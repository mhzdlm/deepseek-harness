/**
 * LLM-as-a-Verifier plugin: `verify` tool for best-of-N selection.
 *
 * Scores N candidate trajectories with a fine-grained continuous reward
 * (expectation over scoring-token logprobs, Eq 3.1) and ranks them with a
 * Probabilistic Pivot Tournament (O(Nk) comparisons). The heavy lifting runs
 * in Python (`llm_verifier`); this plugin drives it through the session's
 * persistent IPython kernel when one is live, else a venv python subprocess.
 *
 * Pairs with `@deepseek-ai/dsh-plugin-rlm-kernel` (which provides the
 * `rlm.kernels` registry this plugin reuses).
 * @module @deepseek-ai/dsh-plugin-rlm-verifier
 */

import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { KernelExecutor } from './python-bridge.ts'
import { createVerifyTool } from './verify-tool.ts'

export const name = 'plugin-rlm-verifier'
export const inject = ['tools', 'subagents', 'sessions', 'agents']

export interface JudgeProfileConfig {
  model?: string
  baseUrl?: string
  keyEnv?: string
  extraEnv?: string[]
}

export interface Config {
  /** Optional JSON score-cache file for incremental re-runs. */
  cacheFile?: string
  /** Verifier model name. Defaults to deepseek-v4-flash (DeepSeek). */
  model?: string
  /** Subagent provider name used by auto_spawn. Defaults to 'spawn'. */
  subagentProvider?: string
  /** Max characters captured from each spawned child's result. Default 20000. */
  maxChildChars?: number
  /**
   * `''` (off), `'display'` (render judge provenance), or `'full'` (also mask
   * credential/PII material in candidate text before scoring prompts).
   */
  privacyFilter?: string
  /** Named multi-judge profiles addressable via the tool's `judges` argument. */
  judgeProfiles?: Record<string, JudgeProfileConfig>
}

export const Config: z<Config> = z.object({
  cacheFile: z.string(),
  model: z.string(),
  subagentProvider: z.string(),
  maxChildChars: z.natural(),
  privacyFilter: z.string(),
  judgeProfiles: z.dict(z.object({
    model: z.string(),
    baseUrl: z.string(),
    keyEnv: z.string(),
    extraEnv: z.array(z.string()),
  })),
})

export function apply(ctx: Context, config: Config): void {
  const cacheFile = config.cacheFile
    ? path.resolve(config.cacheFile)
    : undefined

  // P1-fix: per-session auto_spawn verify controllers (same pattern as
  // host-handlers.ts abortSession for rlm.run). Aborted on session disposal
  // so verify children cannot outlive their parent session.
  const sessionControllers = new Map<string, Set<AbortController>>()
  const abortVerifySession = (sessionId: string): void => {
    const controllers = sessionControllers.get(sessionId)
    if (controllers) {
      for (const controller of [...controllers]) controller.abort()
      sessionControllers.delete(sessionId)
    }
  }

  const subagents = ctx.get('subagents')
  const privacyFilter = config.privacyFilter === 'display' || config.privacyFilter === 'full' ? config.privacyFilter : ''
  const judgeProfiles: Record<string, { model: string; baseUrl?: string; keyEnv?: string; extraEnv?: string[] }> = {}
  for (const [name, profile] of Object.entries(config.judgeProfiles ?? {})) {
    if (profile.model !== undefined) judgeProfiles[name] = { ...profile, model: profile.model }
  }
  const tool = createVerifyTool({
    // Lazily resolve the kernel registry from plugin-rlm-kernel. Optional:
    // when the sibling plugin is absent or un-provisioned, falls back to the
    // venv python subprocess path.
    getKernels: () => ctx.get('rlm.kernels') as KernelExecutor | undefined,
    ...(cacheFile !== undefined ? { cacheFile } : {}),
    ...(config.model !== undefined ? { model: config.model } : {}),
    ...(subagents !== undefined ? { subagents } : {}),
    ...(config.subagentProvider !== undefined ? { subagentProvider: config.subagentProvider } : {}),
    ...(config.maxChildChars !== undefined ? { maxChildChars: config.maxChildChars } : {}),
    privacyFilter,
    ...(Object.keys(judgeProfiles).length > 0 ? { judgeProfiles } : {}),
    // P1-fix: register auto_spawn controllers for session-tracked abort.
    trackController: (sessionId, controller) => {
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
    },
  })

  // P1-fix: abort outstanding verify auto_spawn children on session disposal.
  ctx.on('session/disposed', (session) => {
    abortVerifySession(String(session.id))
  })

  ctx.effect(
    () => ctx.tools.register(tool),
    'register verify tool',
  )
}
