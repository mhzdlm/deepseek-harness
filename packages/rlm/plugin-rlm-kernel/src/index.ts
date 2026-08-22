/**
 * Persistent IPython kernel as the model's primary tool.
 *
 * Registers the `ipython` tool (backed by a per-session `KernelManager`
 * vendored from prime-agent), wires the `host.request` bridge to dsh services
 * (`rlm.run` → `ctx.subagents.start`), and disposes kernels on
 * `session/disposed`.
 * @module @deepseek-ai/dsh-plugin-rlm-kernel
 */

import { homedir } from 'node:os'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createHostHandlers } from './host-handlers.ts'
import { createIpythonTool } from './ipython-tool.ts'
import { SessionKernelRegistry } from './kernels.ts'

export const name = 'plugin-rlm-kernel'
export const inject = ['tools', 'subagents', 'sessions', 'agents']

export interface Config {
	/** Python interpreter with ipykernel + prime-agent-runtime. Omitted → auto-bootstrapped venv. */
	python?: string
	/** Root directory for kernel artifacts. Defaults to `~/.dsh/rlm`. */
	dataDir?: string
}

export const Config: z<Config> = z.object({
	python: z.string(),
	dataDir: z.string(),
})

export function apply(ctx: Context, config: Config): void {
	const dataDir = config.dataDir ?? path.join(homedir(), '.dsh', 'rlm')
	const kernels = new SessionKernelRegistry({
		// exactOptionalPropertyTypes: spread undefined fields away.
		...(config.python !== undefined ? { python: config.python } : {}),
		dataDir,
		hostHandlers: createHostHandlers(ctx),
	})

	ctx.on('session/disposed', (session) => {
		kernels.disposeSession(String(session.id))
	})

	ctx.effect(() => ctx.tools.register(createIpythonTool(kernels)), 'register ipython tool')
	ctx.effect(() => () => kernels.disposeAll(), 'rlm-kernel teardown')
}
