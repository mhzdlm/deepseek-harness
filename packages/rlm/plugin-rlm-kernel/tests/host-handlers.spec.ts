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
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentListEntry, SubagentRun, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import type { HostRequestHandlers } from '../src/vendor/kernel/index.ts'
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

/** Index the handler map loudly: a missing bridge type must fail here, not as `undefined is not a function`. */
function requireHandler(
  handlers: HostRequestHandlers,
  name: string,
): (payload: Record<string, unknown>) => Promise<Record<string, unknown>> {
  const handler = handlers[name]
  if (!handler) throw new Error(`missing host handler: ${name}`)
  return handler
}

function fakeParent(options: { provider?: string; model?: string } = {}) {
  return {
    session: { id: SessionId('sess-parent') },
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

interface ContinuableCapture {
  provider: string
  label: string
  request: { prompt: Array<{ type: string; text: string }>; persona?: string; maxDepth?: number }
}

interface FollowupCapture {
  childId: string
  message: string
}

/**
 * Fake subagent provider: records each start, yields one microtask so the
 * caller can abort inside the real registration window, then honors a
 * pre-set signal the way real providers do (reject the startup).
 */
function makeCtx(
  parent: ReturnType<typeof fakeParent> | undefined,
  starts: StartCapture[],
  runFactory?: RunFactory,
): Context & {
  __children: SubagentListEntry[]
  __failListModels: () => void
  __continuables: ContinuableCapture[]
  __followups: FollowupCapture[]
} {
  let failListModels = false
  const children: SubagentListEntry[] = []
  const continuables: ContinuableCapture[] = []
  const followups: FollowupCapture[] = []
  const llm = {
    listModels: async () => {
      if (failListModels) throw new Error('catalog unavailable')
      return [
        { id: 'deepseek-v4-flash', name: 'DeepSeek v4 Flash' },
        { id: 'deepseek-v4-pro', name: 'DeepSeek v4 Pro' },
      ]
    },
  }

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

  async function startContinuable(spec: { provider: string; label: string; request: ContinuableCapture['request'] }) {
    continuables.push({ provider: spec.provider, label: spec.label, request: spec.request })
    const childId = `cont-${continuables.length}`
    return { childId, messageId: 'inbox-1' }
  }

  async function followup(_parent: unknown, childId: string, content: Array<{ type: string; text?: string }>) {
    followups.push({ childId, message: content.map(block => block.text ?? '').join('') })
    return 'msg-1'
  }

  const ctx = {
    agents: { currentInitiator: () => parent },
    subagents: { start, listChildren: async (): Promise<SubagentListEntry[]> => children, startContinuable, followup },
    // Optional services resolve through ctx.get (topology-safe), matching the
    // handler's production read path.
    get: (name: string) => (name === 'llm' ? llm : undefined),
    llm,
    __children: children,
    __failListModels: () => {
      failListModels = true
    },
    __continuables: continuables,
    __followups: followups,
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

    const result = await requireHandler(handlers, 'rlm.run')({ prompt: 'solve this', kwargs: { name: 'worker-a' } })

    expect(starts).toHaveLength(1)
    expect(starts[0]!.provider).toBe('spawn')
    expect(starts[0]!.request.label).toBe('worker-a')
    expect(starts[0]!.request.prompt).toEqual([{ type: 'text', text: 'solve this' }])
    expect(starts[0]!.request.signal).toBeInstanceOf(AbortSignal)
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
    await expect(requireHandler(handlers, 'rlm.run')({ prompt: 'x' })).rejects.toThrow(/owning agent/)
    expect(starts).toHaveLength(0)
  })

  it('aborting the session during an in-flight start still cancels the spawn (FIX-6/NEW-4)', async () => {
    const parent = fakeParent()
    const starts: StartCapture[] = []
    const ctx = makeCtx(parent, starts)
    const { handlers, abortSession } = createHostHandlers(ctx, 'spawn', 'unused')

    const pending = requireHandler(handlers, 'rlm.run')({ prompt: 'long spawn' })
    expect(starts).toHaveLength(1)
    expect(starts[0]!.request.signal.aborted).toBe(false)

    abortSession('sess-parent')
    expect(starts[0]!.request.signal.aborted).toBe(true)
    await expect(pending).rejects.toThrow(/aborted start/)
  })

  it('rlm.list_subagents projects one-shot children into the RLM schema', async () => {
    const parent = fakeParent()
    const starts: StartCapture[] = []
    const ctx = makeCtx(parent, starts)
    const dataDir = newDataDir()
    const { handlers } = createHostHandlers(ctx, 'spawn', dataDir)
    // Both child modes project (retained rows carry retained=true so the
    // kernel can tell follow-up-able children apart); diagnostic rows never do.
    ctx.__children.push(
      {
        kind: 'child',
        mode: 'one-shot',
        id: SessionId('child-a'),
        label: 'Auditor',
        activity: 'running',
        hasChildren: false,
      },
      {
        kind: 'child',
        mode: 'continuable',
        id: SessionId('child-cont'),
        label: 'Helper',
        activity: 'inactive',
        hasChildren: false,
      },
      { kind: 'diagnostic', id: SessionId('diag-row') } as unknown as SubagentListEntry,
    )

    const result = await requireHandler(handlers, 'rlm.list_subagents')({})
    const subagents = result.subagents as Array<Record<string, unknown>>

    expect(subagents).toHaveLength(2)
    expect(subagents[0]!.rlm_child_id).toBe('child-a')
    expect(subagents[0]!.session_name).toBe('Auditor')
    expect(subagents[0]!.status).toBe('running')
    expect(subagents[0]!.active_session_id).toBe('child-a')
    expect(subagents[0]!.session_dir).toBe(join(dataDir, 'session-artifacts', 'child-a'))
    expect(subagents[0]!.retained).toBe(false)
    expect(subagents[1]!.rlm_child_id).toBe('child-cont')
    expect(subagents[1]!.retained).toBe(true)
    expect(subagents[1]!.status).toBe('completed')
  })

  it('rlm.delete_subagent aborts and disposes the named active child once', async () => {
    const parent = fakeParent()
    const starts: StartCapture[] = []
    let disposeCount = 0
    const ctx = makeCtx(parent, starts, () => pendingRun('run-del', () => {
      disposeCount += 1
    }))
    const { handlers } = createHostHandlers(ctx, 'spawn', 'unused')

    await expect(requireHandler(handlers, 'rlm.delete_subagent')({ target: '' })).rejects.toThrow(/non-empty target/)
    await expect(requireHandler(handlers, 'rlm.delete_subagent')({ target: 'ghost' })).rejects.toThrow(/no active rlm child/)

    const spawned = await requireHandler(handlers, 'rlm.run')({ prompt: 'work', kwargs: { name: 'doomed' } })
    expect(starts[0]!.request.signal.aborted).toBe(false)
    const childId = spawned.rlm_child_id as string

    const result = await requireHandler(handlers, 'rlm.delete_subagent')({ target: childId })
    expect(starts[0]!.request.signal.aborted).toBe(true)
    expect(disposeCount).toBe(1)
    // A deleted child projects as completed/inactive: no live session, kept for the kernel's listing.
    const descriptor = result.subagent as Record<string, unknown>
    expect(descriptor.status).toBe('completed')
    expect(descriptor.active_session_id).toBeNull()

    await expect(requireHandler(handlers, 'rlm.delete_subagent')({ target: childId })).rejects.toThrow(/no active rlm child/)
    expect(disposeCount).toBe(1)
  })

  it('rlm.find_models filters case-insensitively, caps results, and degrades to empty', async () => {
    const parent = fakeParent({ provider: 'deepseek-official' })
    const starts: StartCapture[] = []
    const ctx = makeCtx(parent, starts)
    const { handlers } = createHostHandlers(ctx, 'spawn', 'unused')

    const hit = await requireHandler(handlers, 'rlm.find_models')({ query: 'V4 PRO', limit: 5 })
    expect(hit.models).toEqual([
      { provider: 'deepseek-official', id: 'deepseek-v4-pro', name: 'DeepSeek v4 Pro', selector: 'deepseek-official/deepseek-v4-pro' },
    ])

    const capped = await requireHandler(handlers, 'rlm.find_models')({ limit: 1 })
    expect(capped.models).toHaveLength(1)
    // A non-finite limit floors at one instead of crashing Math.floor.
    const badLimit = await requireHandler(handlers, 'rlm.find_models')({ limit: Number.NaN })
    expect((badLimit.models as unknown[]).length).toBeGreaterThan(0)

    ctx.__failListModels()
    await expect(requireHandler(handlers, 'rlm.find_models')({})).resolves.toEqual({ models: [] })
  })

  it('model.info mirrors the owning agent options and keeps input empty', async () => {
    const starts: StartCapture[] = []
    const mounted = createHostHandlers(makeCtx(fakeParent({ provider: 'p1', model: 'm1' }), starts), 'spawn', 'unused')
    await expect(requireHandler(mounted.handlers, 'model.info')({})).resolves.toEqual({ id: 'm1', provider: 'p1', input: [] })

    const bare = createHostHandlers(makeCtx(undefined, starts), 'spawn', 'unused')
    await expect(requireHandler(bare.handlers, 'model.info')({})).resolves.toEqual({ id: null, provider: null, input: [] })
  })

  it('rlm.run retained=true starts a continuable child registered for follow-ups (T1.2)', async () => {
    const parent = fakeParent()
    const starts: StartCapture[] = []
    const ctx = makeCtx(parent, starts)
    const { handlers } = createHostHandlers(ctx, 'spawn', 'unused')

    const result = await requireHandler(handlers, 'rlm.run')({
      prompt: 'own the auth review',
      kwargs: { name: 'auth-reviewer', retained: true },
    })

    expect(ctx.__continuables).toHaveLength(1)
    expect(ctx.__continuables[0]!.provider).toBe('spawn')
    expect(ctx.__continuables[0]!.label).toBe('auth-reviewer')
    expect(result.retained).toBe(true)
    // The durable child id is the continuation manager's reserved session id.
    expect(String(result.rlm_child_id)).toMatch(/^cont-/)

    // The registry keeps retained children even though there is no run to await.
    await expect(requireHandler(handlers, 'rlm.message')({
      target: 'auth-reviewer',
      message: 'check the new regression test',
    })).resolves.toMatchObject({ child_id: result.rlm_child_id })
  })

  it('rlm.message routes by child id or label and acknowledges delivery (T1.2)', async () => {
    const parent = fakeParent()
    const starts: StartCapture[] = []
    const { handlers } = createHostHandlers(makeCtx(parent, starts), 'spawn', 'unused')

    await requireHandler(handlers, 'rlm.run')({
      prompt: 'a', kwargs: { name: 'reviewer-a', retained: true },
    })
    await requireHandler(handlers, 'rlm.run')({
      prompt: 'b', kwargs: { name: 'reviewer-b', retained: true },
    })

    const byName = await requireHandler(handlers, 'rlm.message')({
      target: 'reviewer-b', message: 'focus on tests',
    })
    expect(byName.child_id).toBe('cont-2')
    const byId = await requireHandler(handlers, 'rlm.message')({
      target: 'cont-1', message: 'focus on api',
    })
    expect(byId.child_id).toBe('cont-1')
    // Omitted target defaults to the most recently spawned retained child.
    const defaulted = await requireHandler(handlers, 'rlm.message')({ message: 'again' })
    expect(defaulted.child_id).toBe('cont-2')

    await expect(requireHandler(handlers, 'rlm.message')({ message: 'x', target: 'ghost' }))
      .rejects.toThrow(/no retained child matching/)
  })

  it('rlm.message refuses one-shot children surfaced by the service listing', async () => {
    const parent = fakeParent()
    const starts: StartCapture[] = []
    const ctx = makeCtx(parent, starts)
    // A child from an earlier host process: the service lists it, but only
    // continuable rows are follow-up targets.
    ctx.__children.push({
      kind: 'child',
      mode: 'one-shot',
      id: 'run-old',
      label: 'old-runner',
    } as unknown as SubagentListEntry)
    const { handlers } = createHostHandlers(ctx, 'spawn', 'unused')

    await expect(requireHandler(handlers, 'rlm.message')({ message: 'hi', target: 'run-old' }))
      .rejects.toThrow(/no retained child matching/)
    await expect(requireHandler(handlers, 'rlm.message')({ message: 'hi', target: 'old-runner' }))
      .rejects.toThrow(/no retained child matching/)
  })

  it('rlm.run enforces prompt-size and outstanding-children governors', async () => {
    const parent = fakeParent()
    const starts: StartCapture[] = []
    const ctx = makeCtx(parent, starts)
    const { handlers } = createHostHandlers(ctx, 'spawn', 'unused', { maxRunPromptChars: 10, maxChildrenPerSession: 1 })

    await expect(requireHandler(handlers, 'rlm.run')({ prompt: '0123456789012' }))
      .rejects.toThrow(/over the 10-character cap/)

    await requireHandler(handlers, 'rlm.run')({ prompt: 'short' })
    await expect(requireHandler(handlers, 'rlm.run')({ prompt: 'another' }))
      .rejects.toThrow(/maxChildrenPerSession=1/)

    // Retained children are exempt from the outstanding cap.
    await expect(requireHandler(handlers, 'rlm.run')({ prompt: 'keep', kwargs: { retained: true } }))
      .resolves.toBeDefined()
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

    await requireHandler(handlers, 'rlm.run')({ prompt: 'a' })
    await requireHandler(handlers, 'rlm.run')({ prompt: 'b', kwargs: { name: 'b' } })
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

    const spawned = await requireHandler(handlers, 'rlm.run')({ prompt: 'quick' })
    await new Promise(resolve => setTimeout(resolve, 0))
    await expect(requireHandler(handlers, 'rlm.delete_subagent')({ target: spawned.rlm_child_id as string }))
      .rejects.toThrow(/no active rlm child/)
  })
})
