/**
 * Continual harness plugin.
 *
 * Injects the harness overview (persistent instructions / memories / skills /
 * subagents) into every assembled system prompt and provides `/refine` (and
 * `/refine-rollback`) for evidence-backed, reversible harness updates.
 *
 * Harness state is the file written by the kernel runtime
 * (`harness.py`), shared with `@deepseek-ai/dsh-plugin-rlm-kernel` via the
 * same `<dataDir>/session-artifacts/<sessionId>/harness` layout.
 * @module @deepseek-ai/dsh-plugin-continual-harness
 */

import { homedir } from 'node:os'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Importing these packages' types pulls their `declare module '@deepseek-ai/cordis'`
// augmentations into the program, making `ctx.commands`/`ctx.subagents` type-check.
import type { CommandInvocation } from '@deepseek-ai/dsh-commands'
import type { AssembleContext } from '@deepseek-ai/dsh-system-prompt'
import { globalHarnessStatePath, harnessStatePath, mergeHarnessStates, readHarnessStateSync } from './harness-file.ts'

// Re-exported so the loop plugin can consume the CAS write path through this
// package's compiled entry instead of a cross-package src/*.ts specifier,
// which plain Node cannot load from node_modules.
export { HarnessConflictError, readHarnessStatesDetailed, writeHarnessStates } from './harness-file.ts'
export type { HarnessEntry, HarnessStateFile } from './harness-file.ts'
import { deleteHarnessEntry, listHarness, showHarnessEntry } from './harness-cmd.ts'
import { createHarnessOverviewCache } from './prompt-cache.ts'
import { renderHarnessOverview } from './prompt.ts'
import { rollbackRefine, runRefine, DEFAULT_MAX_REFINEMENT_EVENTS } from './refine.ts'

export const name = 'plugin-continual-harness'
export const inject = ['systemPrompt', 'commands', 'sessions', 'agents', 'subagents']

export interface Config {
  /** Root directory for harness state. Defaults to `~/.dsh/rlm` — must match plugin-rlm-kernel. */
  dataDir?: string
  /** Per-kind cap when rendering the harness overview into the prompt. */
  maxEntriesPerKind?: number
  /** Per-entry content cap when rendering the harness overview (FIX-10). */
  maxCharsPerEntry?: number
  /** Total character ceiling for the whole harness overview section (FIX-10). */
  maxTotalChars?: number
  /**
	 * Subagent provider used by `/refine`. Must name a registered provider
	 * (FIX-1: this used to be the hard-coded string `'refine'`, which no
	 * provider is registered under). Defaults to `'spawn'`, matching
	 * plugin-rlm-kernel's `subagentProvider`.
	 */
  refineProvider?: string
  /**
	 * How many `RefinementEvent`s (and their snapshot files) are retained per
	 * session before the oldest are pruned (item-10). Defaults to 100.
	 */
  maxRefinementEvents?: number
}

export const Config: z<Config> = z.object({
  dataDir: z.string(),
  maxEntriesPerKind: z.natural(),
  maxCharsPerEntry: z.natural(),
  maxTotalChars: z.natural(),
  refineProvider: z.string(),
  maxRefinementEvents: z.natural(),
})

function sessionIdFromAssembleContext(context: AssembleContext): string | undefined {
  // assembleContextFor passes `{ agent, scope: agent, signal }` — at runtime
  // the scope is the Agent object, though its static type is `ScopeKey`.
  const agent = context.scope as unknown as { session?: { id?: unknown } } | undefined
  const id = agent?.session?.id
  return typeof id === 'string' ? id : undefined
}

export function apply(ctx: Context, config: Config): void {
  const dataDir = config.dataDir ?? path.join(homedir(), '.dsh', 'rlm')

  // item-11: the overview section re-renders per assemble; cache by file
  // (mtime, size) so unchanged harness state is replayed, not re-read+re-sorted.
  const overviewCache = createHarnessOverviewCache({
    globalStatePath: baseDir => globalHarnessStatePath(baseDir),
    localStatePath: (baseDir, sessionId) => harnessStatePath(baseDir, sessionId),
    readMerged: (baseDir, sessionId) =>
    // P0-fix: merged view so global-scope entries (`[global]`-marked)
    // surface in the prompt, not just the per-session local file.
      mergeHarnessStates(
        readHarnessStateSync(globalHarnessStatePath(baseDir)),
        readHarnessStateSync(harnessStatePath(baseDir, sessionId)),
      ),
    render: state =>
      renderHarnessOverview(state, {
        // exactOptionalPropertyTypes: spread undefined fields away.
        ...(config.maxEntriesPerKind !== undefined ? { maxEntriesPerKind: config.maxEntriesPerKind } : {}),
        ...(config.maxCharsPerEntry !== undefined ? { maxCharsPerEntry: config.maxCharsPerEntry } : {}),
        ...(config.maxTotalChars !== undefined ? { maxTotalChars: config.maxTotalChars } : {}),
      }),
  })

  // Inject harness overview at identity order; base prompt stays untouched.
  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: 'continual-harness',
        order: -100,
        text: (context) => {
          const sessionId = sessionIdFromAssembleContext(context)
          if (!sessionId) return ''
          return overviewCache.render(dataDir, sessionId)
        },
      }),
    'register continual-harness section',
  )

  ctx.commands.register({
    name: 'refine',
    description: 'Review the trajectory and apply small, evidence-backed harness updates',
    handler: async (invocation: CommandInvocation) => {
      const sessionId = invocation.agent.session.id
      const summary = await runRefine(
        ctx,
        sessionId,
        dataDir,
        invocation.agent,
        config.refineProvider ?? 'spawn',
        invocation.signal,
        config.maxRefinementEvents ?? DEFAULT_MAX_REFINEMENT_EVENTS,
      )
      return { kind: 'success', text: summary }
    },
  })

  ctx.commands.register({
    name: 'refine-rollback',
    description: 'Roll back a previous /refine by event id',
    input: { hint: '<eventId>' },
    handler: async (invocation: CommandInvocation) => {
      const sessionId = invocation.agent.session.id
      const eventId = invocation.rawInput.trim()
      if (!eventId) return { kind: 'error', text: 'Usage: /refine-rollback <eventId>' }
      const summary = await rollbackRefine(dataDir, sessionId, eventId, config.maxRefinementEvents ?? DEFAULT_MAX_REFINEMENT_EVENTS)
      return { kind: 'success', text: summary }
    },
  })

  ctx.commands.register({
    name: 'harness',
    description: 'Inspect and manage harness entries: /harness list [kind], /harness show <id>, /harness delete <id>',
    input: { hint: 'list [kind] | show <id> | delete <id>' },
    handler: async (invocation: CommandInvocation) => {
      const sessionId = String(invocation.agent.session.id)
      const [subcommand, arg] = invocation.rawInput.trim().split(/\s+/, 2)
      const maxEvents = config.maxRefinementEvents ?? DEFAULT_MAX_REFINEMENT_EVENTS
      switch (subcommand ?? 'list') {
        case 'list':
          return { kind: 'success', text: listHarness(dataDir, sessionId, arg) }
        case 'show':
          if (!arg) return { kind: 'error', text: 'Usage: /harness show <id>' }
          return { kind: 'success', text: showHarnessEntry(dataDir, sessionId, arg) }
        case 'delete':
          if (!arg) return { kind: 'error', text: 'Usage: /harness delete <id>' }
          return { kind: 'success', text: await deleteHarnessEntry(dataDir, sessionId, arg, maxEvents) }
        default:
          return { kind: 'error', text: `Unknown /harness subcommand "${subcommand}" (list|show|delete)` }
      }
    },
  })
}
