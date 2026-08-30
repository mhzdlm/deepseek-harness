/**
 * `ipython` tool definition: the model's single primary tool. Every call is
 * executed in the owning session's persistent kernel; variables/imports and
 * the dill snapshot all live behind this one seam.
 * @module @deepseek-ai/dsh-plugin-rlm-kernel
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { DEFAULT_FULL_OUTPUT_CAP, type SessionKernelRegistry } from './kernels.ts'

const MAX_OUTPUT_CHARS = 65_536

/**
 * T2.6: archive one overflowing cell output verbatim under the session's
 * artifacts and return the pointer line appended to the truncated view.
 * Best-effort — an archive failure degrades to the plain truncation notice.
 */
function writeToolResultArchive(artifactDir: string, length: number, fullText: string): string {
  try {
    const dir = path.join(artifactDir, 'tool-results')
    mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `${Date.now()}-${randomUUID().slice(0, 8)}.log`)
    writeFileSync(file, fullText, 'utf8')
    return `\n[... output truncated at ${MAX_OUTPUT_CHARS} chars; full ${length} chars archived at ${file} — read it in slices from the kernel or fs tools]`
  } catch {
    return `\n[... output truncated at ${MAX_OUTPUT_CHARS} chars ...]`
  }
}

/**
 * Build the `ipython` tool. The tool is registered by the plugin's apply fiber;
 * the registry is shared across every session the plugin manages.
 * item-13: `maxOutputChars` caps the cell output text returned to the model.
 * @param kernels - shared session kernel registry used to execute cells and recover busy/idle state.
 * @param maxOutputChars - cap on cell output text returned to the model; overflow is archived beside the session artifacts.
 * @returns the registered `ipython` tool definition.
 */
export function createIpythonTool(kernels: SessionKernelRegistry, maxOutputChars = MAX_OUTPUT_CHARS): ReturnType<typeof defineTool> {
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

        // item-4: keep the idle sweep away from a kernel that is executing.
        // item-6: `kernels.execute` also recovers a kernel that refused
        // to be interrupted (Windows blocking-C-call case).
        kernels.markBusy(sid)
        try {
          // T2.6: request the vendor's hard backstop window (10MB) so the full
          // output reaches the plugin layer; the model-facing view is capped
          // here and the overflow is archived under the session's artifacts.
          const result = await kernels.execute(sid, code, {
            signal: exec.signal,
            maxOutputChars: DEFAULT_FULL_OUTPUT_CAP,
          })

          let text = result.stdout
          if (result.stderr) text += (text ? '\n' : '') + result.stderr
          if (result.result) text += (text ? '\n' : '') + result.result
          if (result.status === 'error' && result.error) {
            text += (text ? '\n' : '') + result.error.traceback.join('\n')
          }

          // T2.6: archive-then-truncate. The transcript view keeps the model-
          // facing cap; anything beyond it is preserved verbatim beside the
          // session's other artifacts, with a pointer handed to the model.
          if (text.length > maxOutputChars) {
            const pointer = writeToolResultArchive(kernels.sessionArtifactDir(sid), text.length, text)
            text = text.slice(0, maxOutputChars) + pointer
          }

          // Surface a kernel-restart restore notice as a prefix on the next result.
          const notice = kernels.consumeRestoreNotice(sid)
          if (notice) {
            const parts: string[] = []
            if (notice.restored.length > 0) parts.push(`[kernel restored: ${notice.restored.join(', ')}]`)
            if (notice.failed.length > 0) {
              parts.push(`[lost: ${notice.failed.map(f => f.name).join(', ')}]`)
            }
            if (parts.length > 0) text = parts.join(' ') + (text ? '\n\n' + text : '')
          }

          // P1-fix + P2-fix: surface interrupt-recovery retry so the model knows
          // this cell may have executed twice AND that the namespace was rolled
          // back to the last snapshot — changes made by the interrupted attempt
          // may be absent even though the cell "ran".
          if (result.retried) {
            text =
              '[⚠️ cell retried after interrupt — it may have executed twice, and the namespace was restored from the last snapshot, so changes made by the interrupted attempt may be absent]'
              + (text ? '\n\n' + text : '')
          }

          return { text, status: result.status, durationMs: result.durationMs }
        } finally {
          kernels.markIdle(sid)
        }
      })()
    },
  })
}
