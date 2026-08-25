/**
 * Unit coverage for the `host.request` handler table (`createHostHandlers`):
 * every bridge type the vendored Python runtime can call, plus the FIX-6
 * disposal contract (controllers registered before `subagents.start`, aborted
 * on session disposal). Services are structurally faked — the handlers only
 * touch `ctx.agents`, `ctx.subagents`, and `ctx.llm`.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SubagentListEntry, SubagentRun, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { createHostHandlers } from '../src/host-handlers.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

function newDataDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-rlm-hh-'))
  roots.push(root)
  return root
}

function fakeParent(options: { provider?: string; model?: string } = {}) {
  return {
    session: { id: 'sess-parent' },
    options: { provider: options.provider ?? 'deepseek-official', model: options.model ?? 'deepseek-v4-flash' },
  }
}

interface StartCapture {
  provider: string
  request: SubagentStartRequest
}

interface RunStub {
  id: string
  result: Promise<unknown>
  dispose: () => Promise<void>
}

type RunFactory = (request: SubagentStartRequest) => RunStub

/**
 * Fake subagent provider: records each start, yields one microtask so the
 * caller can abort inside the real registration window, then honors a
 * pre-set signal the way real providers do (reject the startup).
 */
function makeCtx(
  parent: ReturnType<typeof fakeParent> | undefined,
  starts: StartCapture[],
  runFactory?: RunFactory,
): Context & { __children: SubagentListEntry[]; __failListModels: () => void } {
  let failListModels = false
  const children: SubagentListEntry[] = []

  async function start(provider: string, request: SubagentStartRequest): Promise<SubagentRun> {
    starts.push({ provider, request })
    await Promise.resolve()
    if (request.signal.aborted) throw new Error('simulated provider rejected the aborted start')
    const run = runFactory?.(request) ?? {
      id: 'run-1',
      result: Promise.resolve({ ok: true }),
      dispose: async () => undefined,
    }
    return run as unknown as SubagentRun
  }

  const ctx = {
    agents: { currentInitiator: () => parent },
    subagents: { start, listChildren: async (): Promise<SubagentListEntry[]> => children },
    llm: {
      listModels: async () => {
        if (failListModels) throw new Error('catalog unavailable')
        return [
          { id: 'deepseek-v4-flash', name: 'DeepSeek v4 Flash' },
          { id: 'deepseek-v4-pro', name: 'DeepSeek v4 Pro' },
        ]
      },
    },
    __children: children,
    __failListModels: () => {
      failListModels = true
    },
  }
  return ctx as typeof ctx & Context
}

function pendingRun(id: string, onDispose?: () => void): RunStub {
  return {
    id,
    // Never settles within the test; cleanup paths must not depend on it.
    result: new Promise(() => undefined),
    dispose: async () => {
      onDispose?.()
    },
  }
}

describe('host.request handler table', () => {
  it('rlm.run spawns a tracked child and reports its handle (FIX-9)', async () => {
    const parent = fakeParent()
    const starts: StartCapture[] = []
    const ctx = makeCtx(parent, starts)
    const dataDir = newDataDir()
    const { handlers } = createHostHandlers(ctx, 'spawn', dataDir)

    const result = await handlers['rlm.run']({ prompt: 'solve this', kwargs: { name: 'worker-a' } })

    expect(starts).toHaveLength(1)
    expect(starts[0].provider).toBe('spawn')
    expect(starts[0].request.label).toBe('worker-a')
    expect(starts[0].request.prompt).toEqual([{ type: 'text', text: 'solve this' }])
    expect(starts[0].request.signal).toBeInstanceOf(AbortSignal)
    expect(result.rlm_child_id).toBe('run-1')
    expect(result.name).toBe('worker-a')
    expect(result.session_dir).toBe(join(dataDir, 'session-artifacts', 'run-1'))
    // Falls back to the owning agent's model while the child has none.
    expect(result.model).toBe('deepseek-v4-flash')
  })

  it('rlm.run without an owning agent refuses loudly and spawns nothing', async () => {
    const starts: StartCapture[] = []
    const ctx = makeCtx(undefined, starts)
    const { handlers } = createHostHandlers(ctx, 'spawn', 'unused')
    await expect(handlers['rlm.run']({ prompt: 'x' })).rejects.toThrow(/owning agent/)
    expect(starts).toHaveLength(0)
  })

  it('aborting the session during an in-flight start still cancels the spawn (FIX-6/NEW-4)', async () => {
    const parent = fakeParent()
    const starts: StartCapture[] = []
    const ctx = makeCtx(parent, starts)
    const { handlers, abortSession } = createHostHandlers(ctx, 'spawn', 'unused')

    const pending = handlers['rlm.run']({ prompt: 'long spawn' })
    expect(starts).toHaveLength(1)
    expect(starts[0].request.signal.aborted).toBe(false)

    abortSession('sess-parent')
    expect(starts[0].request.signal.aborted).toBe(true)
    await expect(pending).rejects.toThrow(/aborted start/)
  })

  it('rlm.list_subagents projects one-shot children into the RLM schema', async () => {
    const parent = fakeParent()
    const starts: StartCapture[] = []
    const ctx = makeCtx(parent, starts)
    const dataDir = newDataDir()
    const { handlers } = createHostHandlers(ctx, 'spawn', dataDir)
    ctx.__children.push(
      { kind: 'child', mode: 'one-shot', id: 'child-a', label: 'Auditor', activity: 'running' },
      { kind: 'child', mode: 'continuable', id: 'child-cont', label: 'Helper', activity: 'idle' },
      { kind: 'self', mode: 'one-shot', id: 'self', activity: 'running' },
    )

    const result = await handlers['rlm.list_subagents']({})
    const subagents = result.subagents as Array<Record<string, unknown>>

    expect(subagents).toHaveLength(1)
    expect(subagents[0].rlm_child_id).toBe('child-a')
    expect(subagents[0].session_name).toBe('Auditor')
    expect(subagents[0].status).toBe('running')
    expect(subagents[0].active_session_id).toBe('child-a')
    expect(subagents[0].session_dir).toBe(join(dataDir, 'session-artifacts', 'child-a'))
  })

  it('rlm.delete_subagent aborts and disposes the named active child once', async () => {
    const parent = fakeParent()
    const starts: StartCapture[] = []
    let disposeCount = 0
    const ctx = makeCtx(parent, starts, () => pendingRun('run-del', () => {
      disposeCount += 1
    }))
    const { handlers } = createHostHandlers(ctx, 'spawn', 'unused')

    await expect(handlers['rlm.delete_subagent']({ target: '' })).rejects.toThrow(/non-empty target/)
    await expect(handlers['rlm.delete_subagent']({ target: 'ghost' })).rejects.toThrow(/no active rlm child/)

    const spawned = await handlers['rlm.run']({ prompt: 'work', kwargs: { name: 'doomed' } })
    expect(starts[0].request.signal.aborted).toBe(false)

    const result = await handlers['rlm.delete_subagent']({ target: spawned.rlm_child_id as string })
    expect(starts[0].request.signal.aborted).toBe(true)
    expect(disposeCount).toBe(1)
    // A deleted child projects as completed/inactive: no live session, kept for the kernel's listing.
    const descriptor = result.subagent as Record<string, unknown>
    expect(descriptor.status).toBe('completed')
    expect(descriptor.active_session_id).toBeNull()

    await expect(handlers['rlm.delete_subagent']({ target: spawned.rlm_child_id as string })).rejects.toThrow(/no active rlm child/)
    expect(disposeCount).toBe(1)
  })

  it('rlm.find_models filters case-insensitively, caps results, and degrades to empty', async () => {
    const parent = fakeParent({ provider: 'deepseek-official' })
    const starts: StartCapture[] = []
    const ctx = makeCtx(parent, starts)
    const { handlers } = createHostHandlers(ctx, 'spawn', 'unused')

    const hit = await handlers['rlm.find_models']({ query: 'V4 PRO', limit: 5 })
    expect(hit.models).toEqual([
      { provider: 'deepseek-official', id: 'deepseek-v4-pro', name: 'DeepSeek v4 Pro', selector: 'deepseek-official/deepseek-v4-pro' },
    ])

    expect((await handlers['rlm.find_models']({ limit: 1 })).models).toHaveLength(1)
    // A non-finite limit floors at one instead of crashing Math.floor.
    expect(((await handlers['rlm.find_models']({ limit: Number.NaN })).models as unknown[]).length).toBeGreaterThan(0)

    ctx.__failListModels()
    await expect(handlers['rlm.find_models']({})).resolves.toEqual({ models: [] })
  })

  it('model.info mirrors the owning agent options and keeps input empty', async () => {
    const starts: StartCapture[] = []
    const { handlers } = createHostHandlers(makeCtx(fakeParent({ provider: 'p1', model: 'm1' }), starts), 'spawn', 'unused')
    await expect(handlers['model.info']({})).resolves.toEqual({ id: 'm1', provider: 'p1', input: [] })

    const bare = createHostHandlers(makeCtx(undefined, starts), 'spawn', 'unused')
    await expect(bare.handlers['model.info']({})).resolves.toEqual({ id: null, provider: null, input: [] })
  })

  it('abortSession disposes every outstanding run of the session exactly once', async () => {
    const parent = fakeParent()
    const starts: StartCapture[] = []
    let disposeCount = 0
    let runSeq = 0
    const ctx = makeCtx(parent, starts, () => pendingRun(`run-orphan-${++runSeq}`, () => {
      disposeCount += 1
    }))
    const { handlers, abortSession } = createHostHandlers(ctx, 'spawn', 'unused')

    await handlers['rlm.run']({ prompt: 'a' })
    await handlers['rlm.run']({ prompt: 'b', kwargs: { name: 'b' } })
    expect(starts).toHaveLength(2)

    abortSession('sess-parent')
    expect(disposeCount).toBe(2)
    expect(starts.every(s => s.request.signal.aborted)).toBe(true)

    abortSession('sess-parent')
    expect(disposeCount).toBe(2)
  })

  it('settled children leave the tracking table so a later delete refuses', async () => {
    const parent = fakeParent()
    const starts: StartCapture[] = []
    const ctx = makeCtx(parent, starts)
    const { handlers } = createHostHandlers(ctx, 'spawn', 'unused')

    const spawned = await handlers['rlm.run']({ prompt: 'quick' })
    await new Promise(resolve => setTimeout(resolve, 0))
    await expect(handlers['rlm.delete_subagent']({ target: spawned.rlm_child_id as string })).rejects.toThrow(/no active rlm child/)
  })
})
