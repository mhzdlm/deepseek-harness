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

export interface Config {
  /** Optional JSON score-cache file for incremental re-runs. */
  cacheFile?: string
  /** Verifier model name. Defaults to deepseek-v4-flash (DeepSeek). */
  model?: string
  /** Subagent provider name used by auto_spawn. Defaults to 'spawn'. */
  subagentProvider?: string
  /** Max characters captured from each spawned child's result. Default 20000. */
  maxChildChars?: number
}

export const Config: z<Config> = z.object({
  cacheFile: z.string(),
  model: z.string(),
  subagentProvider: z.string(),
  maxChildChars: z.natural(),
})

export function apply(ctx: Context, config: Config): void {
  const cacheFile = config.cacheFile
    ? path.resolve(config.cacheFile)
    : undefined

  const subagents = ctx.get('subagents')
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
  })

  ctx.effect(
    () => ctx.tools.register(tool),
    'register verify tool',
  )
}
