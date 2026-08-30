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
import { latestUserQuery, renderRecallSection, type SessionLike } from './recall-inject.ts'
// Phase 8 (review round 6): import through the memory package's compiled entry.
// The previous specifier (`@deepseek-ai/dsh-plugin-rlm-memory/src/search.ts`)
// was copied verbatim into this file's lib/ build output, and plain Node
// cannot execute a `.ts` import from node_modules — the built plugin failed to
// load outside tsx/monorepo resolution. The memory package now re-exports
// `search` from its root entry (kernel `redactReferenceText` precedent).
import { search } from '@deepseek-ai/dsh-plugin-rlm-memory'
import { emitRecallInjectEvent } from './events.ts'

// Re-exported so the loop plugin can consume the CAS write path through this
// package's compiled entry instead of a cross-package src/*.ts specifier,
// which plain Node cannot load from node_modules. `globalHarnessStatePath` /
// `readHarnessStateDetailed` serve the kernel package's skill collector (T2.1).
export { HarnessConflictError, globalHarnessStatePath, harnessStatePath, readHarnessStateDetailed, readHarnessStatesDetailed, writeHarnessStates } from './harness-file.ts'
export type { HarnessEntry, HarnessStateFile, RefinementEvent } from './harness-file.ts'
import { deleteHarnessEntry, listHarness, showHarnessEntry } from './harness-cmd.ts'
import { createHarnessOverviewCache } from './prompt-cache.ts'
import { renderHarnessOverview } from './prompt.ts'
import { rollbackRefine, runRefine, registerAutoRefine, DEFAULT_MAX_REFINEMENT_EVENTS, DEFAULT_AUTO_REFINE } from './refine.ts'

export const name = 'plugin-continual-harness'
export const inject = ['systemPrompt', 'commands', 'sessions', 'agents', 'subagents']

/**
 * Configuration for the continual harness plugin: where harness state lives,
 * how much of it renders into the prompt, and how `/refine` behaves.
 */
export interface Config {
  /** Root directory for harness state. Defaults to `~/.dsh/rlm` — must match plugin-rlm-kernel. */
  dataDir?: string
  /**
   * Per-kind cap when rendering the harness overview into the prompt.
   * Defaults to 6, mirroring prime-agent's hints-only injected overview
   * (`DEFAULT_OVERVIEW_ENTRY_LIMIT`): surface routing hints, not the full
   * harness; the model reads underlying entries on demand.
   */
  maxEntriesPerKind?: number
  /**
   * Per-entry content cap when rendering the harness overview (FIX-10).
   * Defaults to 180, mirroring prime-agent's `CONTENT_LIMIT`: truncate each
   * entry to a hint, keeping the id/tag/title visible for reference.
   */
  maxCharsPerEntry?: number
  /**
   * Total character ceiling for the whole harness overview section (FIX-10).
   * Defaults to 6000 — a bounded routing index across the four kinds.
   */
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
  /**
   * Automatic refinement scheduler (P0): trigger `/refine` from root-agent turn
   * completions after a turn-interval and cooldown gate, gated by an independent
   * review LLM. Disabled by default; opt in explicitly.
   */
  autoRefine?: boolean
  /** Minimum root-agent turns between automatic refine reviews. Defaults to 12. */
  autoRefineTurnInterval?: number
  /** Minimum wall-clock gap (ms) between automatic refine reviews. Defaults to 600000. */
  autoRefineCooldownMs?: number
  /**
   * T7.13 (LAYERS.md §3): active recall injection at harness section render.
   * `off` does nothing; `observe` (default) runs the recall and records a
   * `session/memory-recall-inject` event WITHOUT touching the prompt; `enforce`
   * actually injects the top-N recall section. The query is the most recent
   * user message; hits come from the memory package's published store under
   * `<dataDir>/memory`.
   */
  recallInject?: 'off' | 'observe' | 'enforce'
  /** T7.13: how many ranked hits the recall section may carry. Defaults to 3. */
  recallInjectTopN?: number
  /** T7.13: hard budget (chars) for the whole injected recall section. Defaults to 2000. */
  recallInjectBudgetChars?: number
}

export const Config: z<Config> = z.object({
  // Phase 8: an empty dataDir used to pass the schema and resolve to the cwd.
  dataDir: z.string().min(1),
  maxEntriesPerKind: z.natural().default(6),
  maxCharsPerEntry: z.natural().default(180),
  maxTotalChars: z.natural().default(6000),
  refineProvider: z.string(),
  maxRefinementEvents: z.natural(),
  autoRefine: z.boolean(),
  autoRefineTurnInterval: z.natural(),
  autoRefineCooldownMs: z.natural(),
  recallInject: z.union(['off', 'observe', 'enforce'] as const),
  recallInjectTopN: z.natural().min(1),
  recallInjectBudgetChars: z.natural().min(1),
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
  // T7.13: the recall-injection suffix rides the same section render — the
  // overview is the time-index channel, the recall is the relevance channel.
  // `observe` (default) records what WOULD be injected without touching the
  // prompt; `enforce` appends the injected section.
  const recallMode: 'off' | 'observe' | 'enforce' =
    config.recallInject === 'off' || config.recallInject === 'enforce' ? config.recallInject : 'observe'
  const recallTopN = config.recallInjectTopN && config.recallInjectTopN > 0 ? config.recallInjectTopN : 3
  const recallBudget = config.recallInjectBudgetChars && config.recallInjectBudgetChars > 0 ? config.recallInjectBudgetChars : 2000
  const memoryDir = path.join(dataDir, 'memory')

  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: 'continual-harness',
        order: -100,
        text: (context) => {
          const sessionId = sessionIdFromAssembleContext(context)
          if (!sessionId) return ''
          const base = overviewCache.render(dataDir, sessionId)
          if (recallMode === 'off') return base
          const agent = context.scope as unknown as { session?: SessionLike } | undefined
          const session = agent?.session
          if (!session || typeof session.deriveMessages !== 'function') return base
          const query = latestUserQuery(session)
          if (!query) return base
          // Phase 8 (review round 6): the search walks every published note
          // with sync reads and no guard — a concurrent delete (ENOENT) or a
          // permission error inside this section callback used to crash EVERY
          // prompt assembly. Recall is advisory: degrade to the base prompt.
          let hits: ReturnType<typeof search>
          try {
            hits = search(memoryDir, query, recallTopN)
          } catch (error) {
            console.warn(`[continual-harness] recall-inject search failed; prompt continues without recall: ${error instanceof Error ? error.message : String(error)}`)
            return base
          }
          const section = renderRecallSection(query, hits, recallBudget)
          emitRecallInjectEvent(session as never, {
            mode: recallMode,
            query,
            hitIds: hits.map(hit => hit.relPath),
            injectedChars: section.length,
          })
          // observe: record what WOULD inject; prompt stays unchanged.
          if (recallMode !== 'enforce') return base
          return section.length > 0 ? `${base}\n\n${section}` : base
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

  // P0: automatic refinement scheduler. Reads the opt-in flags and delegates the
  // turn/idle and root-agent gating to registerAutoRefine, which no-ops when
  // disabled.
  registerAutoRefine(
    ctx,
    dataDir,
    {
      ...(config.refineProvider !== undefined ? { refineProvider: config.refineProvider } : {}),
      ...(config.maxRefinementEvents !== undefined ? { maxRefinementEvents: config.maxRefinementEvents } : {}),
    },
    {
      enabled: config.autoRefine ?? DEFAULT_AUTO_REFINE.enabled,
      // Phase 8: 0 would make the `turns % interval` check NaN and silently
      // disable auto-refine — fall back to the default instead.
      turnInterval: config.autoRefineTurnInterval && config.autoRefineTurnInterval > 0
        ? config.autoRefineTurnInterval
        : DEFAULT_AUTO_REFINE.turnInterval,
      cooldownMs: config.autoRefineCooldownMs ?? DEFAULT_AUTO_REFINE.cooldownMs,
    },
  )
}
