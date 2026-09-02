/**
 * Loop Engineering plugin: registers the `loop` tool — deterministic auditor
 * header parsing, the clean-audit trust gate, `rlm/action-boundary` events and
 * check judgments into the unified store (Phase A authority flip; the harness
 * overview picks up verified progress via the store projection). The joining
 * session stays the Manager; executor/auditor episodes ride the
 * composition-provided delegation tools (see docs/recipes/agent-presets/loop/).
 * @module @deepseek-ai/dsh-plugin-rlm-loop
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { RlmStore } from '@deepseek-ai/dsh-plugin-rlm-store'
import { createLoopTool, type LoopRun } from './loop-tool.ts'

// Re-exported for cross-package consumers (the continual-harness projection
// spec drives the tool directly); plain Node cannot load a src/*.ts specifier
// from node_modules, so the root entry is the only safe import point.
export { createLoopTool }
export type { LoopRun, LoopToolResult } from './loop-tool.ts'

/** Plugin manifest name, matching the npm package identifier. */
export const name = 'plugin-rlm-loop'
/** Cordis services this plugin requires at activation. */
export const inject = ['tools']

/** Plugin configuration for the loop tool: where to land verified progress and the per-run round ceiling. */
export interface Config {
  /**
   * Deprecated since Phase A: the tool writes the unified store, not harness
   * files. Kept for preset compatibility; ignored.
   */
  dataDir?: string
  /** Soft per-run round ceiling; exceeding it warns but never blocks. Default 32. */
  maxRounds?: number
}

/** Schemastery schema validating {@link Config} at plugin load. */
export const Config: z<Config> = z.object({
  dataDir: z.string(),
  maxRounds: z.natural(),
})

/**
 * Activates the plugin: registers the loop tool and evicts its run state on
 * session disposal.
 * @param ctx - Cordis context used to register the tool and subscribe to events.
 * @param config - Resolved plugin configuration.
 * @returns void
 */
export function apply(ctx: Context, config: Config): void {
  const maxRounds = config.maxRounds ?? 32

  // Phase A: the store is the single write path; the tool has no dataDir of
  // its own anymore. Absent store = misassembled preset, fail loud.
  const store: RlmStore | undefined = ctx.get('rlm.store')
  if (!store) {
    throw new Error('[rlm-loop] rlm.store service absent — mount @deepseek-ai/dsh-plugin-rlm-store before plugin-rlm-loop')
  }

  // The run map is shared with the tool so session disposal can evict the
  // owning entry — without this, a long-lived desktop host accumulates one
  // LoopRun (task + contract strings) per session forever.
  const runs = new Map<string, LoopRun>()
  ctx.effect(
    () => ctx.tools.register(createLoopTool({ store, maxRounds, runs })),
    'register loop tool',
  )
  ctx.on('session/disposed', (session) => {
    runs.delete(String(session.id))
  })
}
