/**
 * Unit tests for the `ipython` tool shell (`createIpythonTool`) over a stubbed
 * kernel registry: option forwarding, output-section composition, restore
 * notices, the interrupt-retry marker, and the owning-session requirement.
 * The character cap itself is enforced inside `kernels.execute`; here we pin
 * that the tool forwards `maxOutputChars` untouched.
 */
import { describe, expect, it } from 'vitest'
import type { SessionKernelRegistry } from '../src/kernels.ts'
import { createIpythonTool } from '../src/ipython-tool.ts'

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
  it('forwards code, signal, and maxOutputChars to the registry untouched', async () => {
    const { registry, calls } = makeRegistry()
    const tool = createIpythonTool(registry, 1_234)

    await tool.execute({ code: 'print(1)' }, exec())

    expect(calls).toHaveLength(1)
    expect(calls[0].sessionId).toBe('sess-tool')
    expect(calls[0].code).toBe('print(1)')
    expect(calls[0].opts.maxOutputChars).toBe(1_234)
    expect(calls[0].opts.signal).toBeInstanceOf(AbortSignal)
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

  it('prefixes the interrupt-retry warning so the model sees double-run risk', async () => {
    const { registry } = makeRegistry({ stdout: 'rerun-output', retried: true })
    const tool = createIpythonTool(registry)
    const value = (await tool.execute({ code: 'side_effect()' }, exec())) as { text: string }

    expect(value.text.startsWith('[⚠️ cell retried after interrupt — side effects may have executed twice]\n\nrerun-output')).toBe(true)
  })

  it('refuses cells without an owning agent session', async () => {
    const { registry } = makeRegistry()
    const tool = createIpythonTool(registry)
    await expect(tool.execute({ code: 'x' }, { signal: new AbortController().signal } as never))
      .rejects.toThrow(/owning agent session/)
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
