/**
 * Loop Engineering plugin: registers the `loop` tool — deterministic auditor
 * header parsing, the clean-audit trust gate, `session/loop-*` process events,
 * and CAS landing of verified progress into the continual-harness state. The
 * joining session stays the Manager; executor/auditor episodes ride the
 * composition-provided delegation tools (see docs/recipes/agent-presets/loop/).
 * @module @deepseek-ai/dsh-plugin-rlm-loop
 */

import { homedir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createLoopTool, type LoopRun } from './loop-tool.ts'

export const name = 'plugin-rlm-loop'
export const inject = ['tools']

export interface Config {
  /**
   * Harness base dir for landing verified progress. Must match
   * plugin-continual-harness's `dataDir` so landed entries reach the injected
   * overview. Defaults to `~/.dsh/rlm`, the family default.
   */
  dataDir?: string
  /** Soft per-run round ceiling; exceeding it warns but never blocks. Default 32. */
  maxRounds?: number
}

export const Config: z<Config> = z.object({
  dataDir: z.string(),
  maxRounds: z.natural(),
})

function expandHome(dir: string): string {
  if (dir === '~' || dir.startsWith('~/') || dir.startsWith('~\\')) {
    return `${homedir()}${dir.slice(1)}`
  }
  return dir
}

export function apply(ctx: Context, config: Config): void {
  const dataDir = expandHome(config.dataDir?.trim() ? config.dataDir : '~/.dsh/rlm')
  const maxRounds = config.maxRounds ?? 32

  // The run map is shared with the tool so session disposal can evict the
  // owning entry — without this, a long-lived desktop host accumulates one
  // LoopRun (task + contract strings) per session forever.
  const runs = new Map<string, LoopRun>()
  ctx.effect(
    () => ctx.tools.register(createLoopTool({ dataDir, maxRounds, runs })),
    'register loop tool',
  )
  ctx.on('session/disposed', (session) => {
    runs.delete(String(session.id))
  })
}
