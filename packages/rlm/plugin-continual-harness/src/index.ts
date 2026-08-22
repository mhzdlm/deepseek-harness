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
import { harnessStatePath, readHarnessStateSync } from './harness-file.ts'
import { renderHarnessOverview } from './prompt.ts'
import { rollbackRefine, runRefine } from './refine.ts'

export const name = 'plugin-continual-harness'
export const inject = ['systemPrompt', 'commands', 'sessions', 'agents', 'subagents']

export interface Config {
	/** Root directory for harness state. Defaults to `~/.dsh/rlm` — must match plugin-rlm-kernel. */
	dataDir?: string
	/** Per-kind cap when rendering the harness overview into the prompt. */
	maxEntriesPerKind?: number
}

export const Config: z<Config> = z.object({
	dataDir: z.string(),
	maxEntriesPerKind: z.natural(),
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

	// Inject harness overview at identity order; base prompt stays untouched.
	ctx.effect(
		() =>
			ctx.systemPrompt.section({
				name: 'continual-harness',
				order: -100,
				text: (context) => {
					const sessionId = sessionIdFromAssembleContext(context)
					if (!sessionId) return ''
					const state = readHarnessStateSync(harnessStatePath(dataDir, sessionId))
					return renderHarnessOverview(state, {
						// exactOptionalPropertyTypes: spread undefined fields away.
						...(config.maxEntriesPerKind !== undefined ? { maxEntriesPerKind: config.maxEntriesPerKind } : {}),
					})
				},
			}),
		'register continual-harness section',
	)

	ctx.commands.register({
		name: 'refine',
		description: 'Review the trajectory and apply small, evidence-backed harness updates',
		handler: async (invocation: CommandInvocation) => {
			const sessionId = invocation.agent.session.id
			const summary = await runRefine(ctx, sessionId, dataDir, invocation.agent)
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
			const summary = await rollbackRefine(dataDir, sessionId, eventId)
			return { kind: 'success', text: summary }
		},
	})
}
