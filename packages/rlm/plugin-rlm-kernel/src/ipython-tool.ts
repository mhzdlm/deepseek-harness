/**
 * `ipython` tool definition: the model's single primary tool. Every call is
 * executed in the owning session's persistent kernel; variables/imports and
 * the dill snapshot all live behind this one seam.
 * @module @deepseek-ai/dsh-plugin-rlm-kernel
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { SessionKernelRegistry } from './kernels.ts'

const MAX_OUTPUT_CHARS = 65_536

/**
 * Build the `ipython` tool. The tool is registered by the plugin's apply fiber;
 * the registry is shared across every session the plugin manages.
 */
export function createIpythonTool(kernels: SessionKernelRegistry) {
	return defineTool({
		name: 'ipython',
		description:
			'Execute Python in a persistent REPL. Variables and imports survive across calls; ' +
			'write expensive or long-lived data to disk to persist it. The kernel can await ' +
			'host services via `rlm` (e.g. `await rlm("sub-task")`).',
		parameters: {
			code: {
				type: 'string',
				required: true,
				description: 'Python scratchpad code to execute in the persistent kernel',
			},
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					text: { type: 'string', required: true },
					status: { type: 'string', required: true },
					durationMs: { type: 'integer', required: true },
				},
			},
			render: (_args, value) => [{ type: 'text', text: value.text }],
		},
		execute({ code }, exec) {
			return (async () => {
				const sessionId = exec.agent?.session.id
				if (!sessionId) throw new Error('ipython requires an owning agent session')
				const sid = String(sessionId)

				const kernel = await kernels.forSession(sid)
				const result = await kernel.execute(code, {
					signal: exec.signal,
					maxOutputChars: MAX_OUTPUT_CHARS,
				})

				let text = result.stdout
				if (result.stderr) text += (text ? '\n' : '') + result.stderr
				if (result.result) text += (text ? '\n' : '') + result.result
				if (result.status === 'error' && result.error) {
					text += (text ? '\n' : '') + result.error.traceback.join('\n')
				}

				// Surface a kernel-restart restore notice as a prefix on the next result.
				const notice = kernels.consumeRestoreNotice(sid)
				if (notice) {
					const parts: string[] = []
					if (notice.restored.length > 0) parts.push(`[kernel restored: ${notice.restored.join(', ')}]`)
					if (notice.failed.length > 0) {
						parts.push(`[lost: ${notice.failed.map((f) => f.name).join(', ')}]`)
					}
					if (parts.length > 0) text = parts.join(' ') + (text ? '\n\n' + text : '')
				}

				return { text, status: result.status, durationMs: result.durationMs }
			})()
		},
	})
}
