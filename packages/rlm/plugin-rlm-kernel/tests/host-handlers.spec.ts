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
  const subcallEvents: Array<{ type: string; payload: Record<string, unknown> }> = []
  const session = {
    id: SessionId('sess-parent'),
    // llm.query audit events land on the owning session's durable log.
    append: (type: string, payload: Record<string, unknown>) => {
      subcallEvents.push({ type, payload })
    },
  }
  return {
    session,
    options: { provider: options.provider ?? 'deepseek-official', model: options.model ?? 'deepseek-v4-flash' },
    __subcallEvents: subcallEvents,
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

/** One recorded `llm.stream` invocation (llm.query bridge tests). */
export interface LlmStreamCapture {
  options: { model: string; provider?: string; prompt: string; purpose?: string }
  calls: number
}

/** Response chooser for the fake llm seam: map prompt text to generated text. */
type StreamTextFn = (prompt: string) => string | readonly string[]

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
  continuableFactory?: () => Promise<{ childId: string; messageId: string }>,
  streamText?: StreamTextFn,
  streamGate?: () => Promise<void>,
): Context & {
  __children: SubagentListEntry[]
  __failListModels: () => void
  __continuables: ContinuableCapture[]
  __followups: FollowupCapture[]
  __llmStreams: LlmStreamCapture[]
} {
  let failListModels = false
  const children: SubagentListEntry[] = []
  const continuables: ContinuableCapture[] = []
  const followups: FollowupCapture[] = []
  const llmStreams: LlmStreamCapture[] = []
  const llm = {
    listModels: async () => {
      if (failListModels) throw new Error('catalog unavailable')
      return [
        { id: 'deepseek-v4-flash', name: 'DeepSeek v4 Flash' },
        { id: 'deepseek-v4-pro', name: 'DeepSeek v4 Pro' },
      ]
    },
    stream: async function* (options: Record<string, unknown>) {
      const prompt = String((options.messages as Array<{ content?: Array<{ text?: unknown }> }>)[0]?.content?.[0]?.text ?? '')
      const seen = llmStreams.find(item => item.options.prompt === prompt)
      if (seen) {
        seen.calls += 1
      } else {
        llmStreams.push({
          options: { model: String(options.model), provider: options.provider as string, prompt, purpose: options.purpose as string },
          calls: 1,
        })
      }
      if (streamGate) await streamGate()
      // Phase 8: the real seam honors the request signal; mirror that so the
      // disposal test exercises the actual abort path.
      if ((options as { signal?: AbortSignal }).signal?.aborted) throw new Error('simulated stream aborted after signal')
      const chunks = streamText ? streamText(prompt) : `answer to ${prompt}`
      if (chunks === '') return
      // Emit the real StreamChunk sequence the BlockAssembler understands.
      const text = typeof chunks === 'string' ? chunks : chunks.join('')
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
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
    return continuableFactory ? continuableFactory() : { childId, messageId: 'inbox-1' }
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
    __llmStreams: llmStreams,
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

  it('rlm.run enforces prompt-size and live-children governors (retained included)', async () => {
    const parent = fakeParent()
    const starts: StartCapture[] = []
    // A never-settling one-shot result keeps its record live, so the cap slot
    // stays occupied across the subsequent calls (an immediately-resolving run
    // self-cleans via its finally before the next call).
    const ctx = makeCtx(parent, starts, () => pendingRun('run-hold'))
    const { handlers } = createHostHandlers(ctx, 'spawn', 'unused', { maxRunPromptChars: 10, maxChildrenPerSession: 1 })

    await expect(requireHandler(handlers, 'rlm.run')({ prompt: '0123456789012' }))
      .rejects.toThrow(/over the 10-character cap/)

    await requireHandler(handlers, 'rlm.run')({ prompt: 'short' })
    await expect(requireHandler(handlers, 'rlm.run')({ prompt: 'another' }))
      .rejects.toThrow(/maxChildrenPerSession=1/)

    // Retained children count toward the same live-children cap (T7.6): a
    // looping model cannot spawn unlimited durable continuable children.
    await expect(requireHandler(handlers, 'rlm.run')({ prompt: 'keep', kwargs: { retained: true } }))
      .rejects.toThrow(/maxChildrenPerSession=1/)
  })

  it('counts in-flight retained spawns toward the cap before their records land (T7.6)', async () => {
    const parent = fakeParent()
    const starts: StartCapture[] = []
    // startContinuable never settles: the first spawn is stuck in the
    // in-flight window (its sessionRuns record only lands after the await).
    const ctx = makeCtx(parent, starts, undefined, () => new Promise(() => undefined))
    const { handlers } = createHostHandlers(ctx, 'spawn', 'unused', { maxChildrenPerSession: 1 })

    const first = requireHandler(handlers, 'rlm.run')({ prompt: 'a', kwargs: { retained: true } })
    // The first spawn is still in flight and must already occupy the cap slot.
    await expect(requireHandler(handlers, 'rlm.run')({ prompt: 'b', kwargs: { retained: true } }))
      .rejects.toThrow(/maxChildrenPerSession=1/)
    void first
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

describe('llm.query bridge (T7.10)', () => {
  interface LlmQueryResult {
    answers: string[]
    model: string
    degenerate: boolean
    truncated: boolean[]
    retries: number
    durationMs: number
  }

  async function queryLlm(handlers: HostRequestHandlers, payload: Record<string, unknown>): Promise<LlmQueryResult> {
    return (await requireHandler(handlers, 'llm.query')(payload)) as unknown as LlmQueryResult
  }

  it('answers a single prompt through the llm seam with rlm-subcall attribution', async () => {
    const parent = fakeParent()
    const starts: StartCapture[] = []
    const ctx = makeCtx(parent, starts)
    const { handlers } = createHostHandlers(ctx, 'spawn', 'unused')

    const result = await queryLlm(handlers, { prompt: 'summarize the diff' })

    expect(result.answers).toEqual(['answer to summarize the diff'])
    expect(result.model).toBe('deepseek-v4-flash')
    expect(result.degenerate).toBe(false)
    expect(result.truncated).toEqual([false])
    // Attribution purpose reaches the seam; the audit event lands on the log.
    expect(ctx.__llmStreams[0]!.options.purpose).toBe('rlm-subcall')
    const event = parent.__subcallEvents[0]!
    expect(event.type).toBe('session/subcall-query')
    expect(event.payload.batchSize).toBe(1)
    expect(event.payload.model).toBe('deepseek-v4-flash')
    expect(event.payload.answerChars).toEqual([result.answers[0]!.length])
    expect(event.payload.degenerate).toBe(false)
  })

  it('answers a batch of prompts and reports batch metrics', async () => {
    const parent = fakeParent()
    const ctx = makeCtx(parent, [])
    const { handlers } = createHostHandlers(ctx, 'spawn', 'unused')

    const result = await queryLlm(handlers, { prompts: ['a', 'b', 'c'] })

    expect(result.answers).toHaveLength(3)
    expect(ctx.__llmStreams).toHaveLength(3)
    const event = parent.__subcallEvents[0]!
    expect(event.payload.batchSize).toBe(3)
    expect(event.payload.answerChars).toEqual([11, 11, 11])
  })

  it('an empty payload and an empty prompts array are refused', async () => {
    const parent = fakeParent()
    const ctx = makeCtx(parent, [])
    const { handlers } = createHostHandlers(ctx, 'spawn', 'unused')

    await expect(requireHandler(handlers, 'llm.query')({})).rejects.toThrow(/requires a non-empty prompt or prompts/)
    await expect(requireHandler(handlers, 'llm.query')({ prompts: [] })).rejects.toThrow(/requires a non-empty prompt or prompts/)
  })

  it('a batch over the length cap fails loud naming its key', async () => {
    const parent = fakeParent()
    const ctx = makeCtx(parent, [])
    const { handlers } = createHostHandlers(ctx, 'spawn', 'unused', { maxSubcallBatch: 2 })

    await expect(requireHandler(handlers, 'llm.query')({ prompts: ['a', 'b', 'c'] }))
      .rejects.toThrow(/maxSubcallBatch=2/)
  })

  it('per-session in-flight quota fails loud and releases on settlement', async () => {
    const parent = fakeParent()
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const ctx = makeCtx(parent, [], undefined, undefined, undefined, () => gate)
    const { handlers } = createHostHandlers(ctx, 'spawn', 'unused', { maxInFlightSubcalls: 1 })

    const first = requireHandler(handlers, 'llm.query')({ prompt: 'hold' })
    // The first subcall is still in flight; the second must be refused loudly.
    await expect(requireHandler(handlers, 'llm.query')({ prompt: 'second' }))
      .rejects.toThrow(/maxInFlightSubcalls=1/)
    // Release and settle; the quota slot is free again.
    release()
    expect((await first).answers).toEqual(['answer to hold'])
    await expect(queryLlm(handlers, { prompt: 'third' })).resolves.toMatchObject({ model: 'deepseek-v4-flash' })
  })

  it('a degenerate answer is retried once and recovers without the flag', async () => {
    const parent = fakeParent()
    const texts = new Map<string, number>()
    const ctx = makeCtx(parent, [], undefined, undefined, (prompt) => {
      const seen = texts.get(prompt) ?? 0
      texts.set(prompt, seen + 1)
      // First generation degenerates (self-repeating); the retry answers properly.
      return seen === 0 ? 'yes yes yes' : 'the real answer'
    })
    const { handlers } = createHostHandlers(ctx, 'spawn', 'unused')

    const result = await queryLlm(handlers, { prompt: 'q' })

    expect(ctx.__llmStreams[0]!.calls).toBe(2)
    expect(result.answers).toEqual(['the real answer'])
    expect(result.degenerate).toBe(false)
    expect(result.retries).toBe(1)
    expect(parent.__subcallEvents[0]!.payload.retries).toBe(1)
  })

  it('an answer degenerate after its retry is flagged for the kernel caller', async () => {
    const parent = fakeParent()
    const ctx = makeCtx(parent, [], undefined, undefined, () => 'yes yes yes')
    const { handlers } = createHostHandlers(ctx, 'spawn', 'unused')

    const result = await queryLlm(handlers, { prompt: 'q' })

    expect(result.retries).toBe(1)
    expect(result.degenerate).toBe(true)
    // The failing text is still returned (flagged) so the kernel can chunk.
    expect(result.answers).toEqual(['yes yes yes'])
  })

  it('truncates over-cap answers and marks them', async () => {
    const parent = fakeParent()
    const ctx = makeCtx(parent, [], undefined, undefined, () => 'x'.repeat(200))
    const { handlers } = createHostHandlers(ctx, 'spawn', 'unused', { maxSubcallAnswerChars: 10 })

    const result = await queryLlm(handlers, { prompt: 'q' })

    expect(result.answers[0]).toHaveLength(10)
    expect(result.truncated).toEqual([true])
    expect(parent.__subcallEvents[0]!.payload.answerChars).toEqual([10])
    expect(parent.__subcallEvents[0]!.payload.truncated).toEqual([true])
  })

  it('resolves the model as request → route selector → owning agent', async () => {
    const parent = fakeParent()
    const ctx = makeCtx(parent, [])
    const { handlers } = createHostHandlers(ctx, 'spawn', 'unused', {}, { subcallModel: 'deepseek-v4-flash' })

    // Request-named model wins over the route selector.
    const requested = await queryLlm(handlers, { prompt: 'a', model: 'deepseek-v4-pro' })
    expect(requested.model).toBe('deepseek-v4-pro')
    // Route selector downgrades when no request model is given.
    const routed = await queryLlm(handlers, { prompt: 'b' })
    expect(routed.model).toBe('deepseek-v4-flash')
  })

  it('fails loud when the host has no llm service mounted', async () => {
    const parent = fakeParent()
    const ctx = {
      agents: { currentInitiator: () => parent },
      get: () => undefined,
    } as unknown as Context
    const { handlers } = createHostHandlers(ctx, 'spawn', 'unused')

    await expect(requireHandler(handlers, 'llm.query')({ prompt: 'a' }))
      .rejects.toThrow(/requires the host-side llm service/)
  })

  it('an over-cap subcall prompt fails loud naming its key (Phase 8)', async () => {
    const parent = fakeParent()
    const ctx = makeCtx(parent, [])
    const { handlers } = createHostHandlers(ctx, 'spawn', 'unused', { maxSubcallPromptChars: 10 })

    await expect(requireHandler(handlers, 'llm.query')({ prompt: 'a'.repeat(11) }))
      .rejects.toThrow(/maxSubcallPromptChars=10/)
    // A batch is rejected as a whole; nothing reaches the seam.
    expect(ctx.__llmStreams).toHaveLength(0)
  })

  it('session disposal aborts an in-flight subcall batch instead of orphaning it (Phase 8)', async () => {
    const parent = fakeParent()
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const ctx = makeCtx(parent, [], undefined, undefined, undefined, () => gate)
    const { handlers, abortSession } = createHostHandlers(ctx, 'spawn', 'unused')

    const inFlight = requireHandler(handlers, 'llm.query')({ prompts: ['hold-1', 'hold-2'] })
    // Wait until the first subcall is parked inside the fake stream, then
    // dispose the owning session: the batch must abort, not keep generating.
    await new Promise(resolve => setTimeout(resolve, 0))
    abortSession('sess-parent')
    release()
    await expect(inFlight).rejects.toThrow(/aborted/)
  })
})
