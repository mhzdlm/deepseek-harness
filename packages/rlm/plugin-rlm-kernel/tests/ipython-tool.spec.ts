/**
 * Unit tests for the `ipython` tool shell (`createIpythonTool`) over a stubbed
 * kernel registry: option forwarding, output-section composition, restore
 * notices, the interrupt-retry marker, and the owning-session requirement.
 * The character cap itself is enforced inside `kernels.execute`; here we pin
 * that the tool forwards `maxOutputChars` untouched.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionKernelRegistry } from '../src/kernels.ts'
import { createIpythonTool } from '../src/ipython-tool.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

interface ExecuteCall {
  sessionId: string
  code: string
  opts: { signal?: AbortSignal; maxOutputChars?: number }
}

function makeRegistry(result: Partial<ExecuteResultShape> = {}, notice: RestoreNotice | null = null) {
  const calls: ExecuteCall[] = []
  const busy: string[] = []
  const idle: string[] = []
  const registry = {
    markBusy: (sid: string) => busy.push(sid),
    markIdle: (sid: string) => idle.push(sid),
    consumeRestoreNotice: (sid: string) => {
      void sid
      return notice
    },
    execute: async (sessionId: string, code: string, opts: { signal?: AbortSignal; maxOutputChars?: number }) => {
      calls.push({ sessionId, code, opts })
      return {
        stdout: '',
        stderr: '',
        result: undefined,
        status: 'ok',
        durationMs: 1,
        retried: false,
        ...result,
      }
    },
  }
  return { registry: registry as unknown as SessionKernelRegistry, calls, busy, idle }
}

interface ExecuteResultShape {
  stdout: string
  stderr: string
  result: string | undefined
  status: 'ok' | 'error'
  durationMs: number
  retried?: boolean
  error?: { traceback: string[] }
}

interface RestoreNotice {
  restored: string[]
  failed: Array<{ name: string }>
}

const exec = (sessionId = 'sess-tool') =>
  ({ signal: new AbortController().signal, agent: { session: { id: sessionId } } }) as never

describe('ipython tool shell', () => {
  it('forwards code and signal untouched, and requests the full-output backstop window', async () => {
    const { registry, calls } = makeRegistry()
    const tool = createIpythonTool(registry, 1_234)

    await tool.execute({ code: 'print(1)' }, exec())

    const call = calls[0]!
    expect(call.sessionId).toBe('sess-tool')
    expect(call.code).toBe('print(1)')
    // T2.6: the model-facing cap is applied in the tool layer, so the kernel
    // is asked for the much larger backstop window instead of 1234.
    expect(call.opts.maxOutputChars).toBe(10 * 1024 * 1024)
    expect(call.opts.signal).toBeInstanceOf(AbortSignal)
  })

  it('marks the session busy before execution and idle after', async () => {
    const { registry, busy, idle } = makeRegistry()
    const tool = createIpythonTool(registry)
    await tool.execute({ code: 'x' }, exec())
    expect(busy).toEqual(['sess-tool'])
    expect(idle).toEqual(['sess-tool'])
  })

  it('composes stdout, stderr, result repr, and error traceback in order', async () => {
    const { registry } = makeRegistry({
      stdout: 'out',
      stderr: 'warn',
      result: "'repr'",
      status: 'error',
      error: { traceback: ['Traceback…', 'ValueError: boom'] },
    })
    const tool = createIpythonTool(registry)
    const value = (await tool.execute({ code: 'boom' }, exec())) as { text: string; status: string }

    expect(value.status).toBe('error')
    expect(value.text).toBe("out\nwarn\n'repr'\nTraceback…\nValueError: boom")
  })

  it('prefixes the next result with the kernel restore notice', async () => {
    const { registry } = makeRegistry(
      { stdout: 'after-restore' },
      { restored: ['df'], failed: [{ name: 'rlm' }] },
    )
    const tool = createIpythonTool(registry)
    const value = (await tool.execute({ code: 'df' }, exec())) as { text: string }

    expect(value.text.startsWith('[kernel restored: df] [lost: rlm]\n\nafter-restore')).toBe(true)
  })

  it('prefixes the interrupt-retry warning so the model sees double-run and rollback risk', async () => {
    const { registry } = makeRegistry({ stdout: 'rerun-output', retried: true })
    const tool = createIpythonTool(registry)
    const value = (await tool.execute({ code: 'side_effect()' }, exec())) as { text: string }

    expect(value.text.startsWith('[⚠️ cell retried after interrupt — it may have executed twice, and the namespace was restored from the last snapshot, so changes made by the interrupted attempt may be absent]\n\nrerun-output')).toBe(true)
  })

  it('refuses cells without an owning agent session', async () => {
    const { registry } = makeRegistry()
    const tool = createIpythonTool(registry)
    await expect(tool.execute({ code: 'x' }, { signal: new AbortController().signal } as never))
      .rejects.toThrow(/owning agent session/)
  })

  it('archives overflowing output verbatim and hands the model a capped view with a pointer (T2.6)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-rlm-arch-'))
    roots.push(root)
    const longOutput = 'z'.repeat(2_000)
    const artifactDir = join(root, 'session-artifacts', 'sess-tool')
    const registry = {
      markBusy: () => undefined,
      markIdle: () => undefined,
      consumeRestoreNotice: () => null,
      sessionArtifactDir: (sid: string) => join(root, 'session-artifacts', sid),
      execute: async () => ({ stdout: longOutput, stderr: '', result: undefined, status: 'ok' as const, durationMs: 1, retried: false }),
    } as unknown as SessionKernelRegistry
    const tool = createIpythonTool(registry, 500)

    const executed = await tool.execute({ code: 'big' }, exec()) as { text: string }
    const rendered = (tool as unknown as {
      output: { render: (args: unknown, value: { text: string }) => Array<{ type: string; text: string }> }
    }).output.render({}, executed)

    const text = rendered[0]!.text
    expect(text.startsWith('z'.repeat(500))).toBe(true)
    expect(text).toContain(`full ${longOutput.length} chars archived at`)
    const archivedPath = /archived at (.+?) —/.exec(text)![1]!
    expect(existsSync(archivedPath)).toBe(true)
    expect(readFileSync(archivedPath, 'utf8')).toBe(longOutput)
    void artifactDir
  })

  it('does not write an archive when output fits the model-facing cap', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-rlm-arch-'))
    roots.push(root)
    const registry = {
      markBusy: () => undefined,
      markIdle: () => undefined,
      consumeRestoreNotice: () => null,
      sessionArtifactDir: (sid: string) => join(root, 'session-artifacts', sid),
      execute: async () => ({ stdout: 'small', stderr: '', result: undefined, status: 'ok' as const, durationMs: 1, retried: false }),
    } as unknown as SessionKernelRegistry
    const tool = createIpythonTool(registry, 500)

    await tool.execute({ code: 'small' }, exec())
    expect(existsSync(join(root, 'session-artifacts', 'sess-tool', 'tool-results'))).toBe(false)
  })

  it('render projects the composed text verbatim', () => {
    const { registry } = makeRegistry()
    const tool = createIpythonTool(registry)
    const definition = tool as unknown as {
      output: { render: (args: unknown, value: { text: string }) => Array<{ type: string; text: string }> }
    }
    expect(definition.output.render({}, { text: 'plain' })).toEqual([{ type: 'text', text: 'plain' }])
  })
})
