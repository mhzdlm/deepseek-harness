/**
 * apply()-level tests for the memory plugin entry (T7.7): drive the real
 * `src/index.ts` `apply()` through a minimal fake context and the actual
 * event bus shapes it subscribes to, so the mounted path — turn buffering,
 * the `agentsBySession` lifecycle map (T7.5 leak regression net), the
 * captureMode/eligibility early-return branches, and the extraction-failure
 * audit — cannot regress silently behind pure-function suites.
 *
 * The `agentsBySession` map is apply-internal closure state with no read
 * seam, so the leak regression is asserted structurally (dispose fires for
 * every disposed session whatever the branch, and a re-registered agent is
 * what the next capture sees) rather than by inspecting the map.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/index.ts'

interface FakeSession {
  id: string
  header: { parentSession?: string }
  append: ReturnType<typeof vi.fn>
}

function fakeSession(id: string, parentSession?: string): FakeSession {
  return { id, header: parentSession ? { parentSession } : {}, append: vi.fn() }
}

interface FakeAgent {
  session: FakeSession
  inject: ReturnType<typeof vi.fn>
}

function fakeAgent(session: FakeSession): FakeAgent {
  return { session, inject: vi.fn() }
}

interface SubagentsMock {
  spawnCalls: Array<{ provider: string; parent: unknown; prompt: unknown }>
  failStart?: boolean
}

function fakeSubagents(mock: SubagentsMock) {
  return {
    start: async (provider: string, request: { parent: unknown; prompt: unknown }) => {
      mock.spawnCalls.push({ provider, parent: request.parent, prompt: request.prompt })
      if (mock.failStart) throw new Error('spawn failed: provider unavailable')
      return {
        result: Promise.resolve({ output: [] }),
        dispose: async () => undefined,
      }
    },
  }
}

interface Harness {
  memoryDir: string
  toolsRegistered: unknown[]
  commandsRegistered: unknown[]
  warns: string[]
  subagents: SubagentsMock
  emitSessionStart(session: FakeSession, agent: FakeAgent): void
  emitSessionEvent(session: FakeSession, event: { type: string; data?: unknown }): void
  emitDisposed(session: FakeSession): void
}

const createdDirs: string[] = []
afterEach(() => {
  for (const dir of createdDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function makeHarness(config: Record<string, unknown>, subagentsMock?: SubagentsMock): Harness {
  const memoryDir = mkdtempSync(join(tmpdir(), 'dsh-rlm-memory-apply-'))
  createdDirs.push(memoryDir)
  const toolsRegistered: unknown[] = []
  const commandsRegistered: unknown[] = []
  const warns: string[] = []
  const subagents: SubagentsMock = subagentsMock ?? { spawnCalls: [] }
  const listeners = new Map<string, Array<(session: FakeSession, event?: unknown) => void>>()

  const ctx = {
    on: (event: string, handler: (session: FakeSession, event?: unknown) => void) => {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
      return () => undefined
    },
    get: (name: string) =>
      // Only a provided subagentsMock exposes the subagents service; without it
      // the capture path runs extraction-less (extractionRan false).
      name === 'subagents' && subagentsMock ? fakeSubagents(subagentsMock) : undefined,
    effect: (fn: () => unknown) => fn(),
    logger: { warn: (msg: string) => warns.push(msg) },
    tools: {
      register: (definition: unknown) => {
        toolsRegistered.push(definition)
        return () => undefined
      },
    },
    commands: {
      register: (definition: unknown) => {
        commandsRegistered.push(definition)
        return () => undefined
      },
    },
  } as unknown as Context

  apply(ctx, { memoryDir, ...config } as never)

  const fire = (event: string, args: unknown[]) => {
    for (const handler of listeners.get(event) ?? []) (handler as (...a: unknown[]) => void)(...args)
  }

  return {
    memoryDir,
    toolsRegistered,
    commandsRegistered,
    warns,
    subagents,
    emitSessionStart: (_session, agent) => fire('agent/session-start', [{ agent }]),
    emitSessionEvent: (session, event) => fire('session/event', [session, event]),
    emitDisposed: session => fire('session/disposed', [session]),
  }
}

describe('memory plugin apply()', () => {
  it('mounts with the default config and registers one tool and one command', () => {
    const h = makeHarness({})
    expect(h.toolsRegistered).toHaveLength(1)
    expect(h.commandsRegistered).toHaveLength(1)
  })

  it('captureMode off: no buffering, no capture on dispose, agent released', () => {
    const h = makeHarness({ captureMode: 'off' })
    const session = fakeSession('s-off')
    const agent = fakeAgent(session)
    h.emitSessionStart(session, agent)
    h.emitSessionEvent(session, { type: 'user/message', data: { content: 'hello' } })
    h.emitDisposed(session)

    // Guidance injection still happens on session start (independent of capture).
    expect(agent.inject).toHaveBeenCalledTimes(1)
    // Nothing captured: no extraction spawn, no dialog, no audit event.
    expect(h.subagents.spawnCalls).toHaveLength(0)
    expect(existsSync(join(h.memoryDir, 'dialog', 's-off.jsonl'))).toBe(false)
    expect(session.append).not.toHaveBeenCalled()
  })

  it('rootAgentsOnly: child sessions are never captured or buffered', () => {
    const h = makeHarness({})
    const child = fakeSession('s-child', 'root-parent')
    const agent = fakeAgent(child)
    h.emitSessionStart(child, agent)
    h.emitSessionEvent(child, { type: 'user/message', data: { content: 'hello' } })
    h.emitSessionEvent(child, { type: 'assistant/message', data: { message: { content: 'world' } } })
    h.emitDisposed(child)

    expect(h.subagents.spawnCalls).toHaveLength(0)
    expect(existsSync(join(h.memoryDir, 'dialog', 's-child.jsonl'))).toBe(false)
    expect(child.append).not.toHaveBeenCalled()
    // Guidance is per-agent, not per-capture: still injected.
    expect(agent.inject).toHaveBeenCalledTimes(1)
  })

  it('sessionEnd: dispose flushes the buffered dialog and audits the capture event', async () => {
    const h = makeHarness({})
    const session = fakeSession('s-end')
    const agent = fakeAgent(session)
    h.emitSessionStart(session, agent)
    h.emitSessionEvent(session, { type: 'user/message', data: { content: 'hello world' } })
    h.emitSessionEvent(session, { type: 'assistant/message', data: { message: { content: 'greetings' } } })
    // A tool result is buffered as a turn so the sanitizer can strip it.
    h.emitSessionEvent(session, { type: 'tool/result', data: { name: 'bash', message: { content: 'secret output' } } })
    h.emitDisposed(session)

    // runCapture is async (dynamic import inside); wait for the durable dialog.
    await vi.waitFor(() => {
      expect(existsSync(join(h.memoryDir, 'dialog', 's-end.jsonl'))).toBe(true)
    })
    const jsonl = readFileSync(join(h.memoryDir, 'dialog', 's-end.jsonl'), 'utf8')
    expect(jsonl).toContain('hello world')
    expect(jsonl).toContain('greetings')
    // Tool results are stripped (REME.md D5) — sanitized dialog holds user+model only.
    expect(jsonl).not.toContain('secret output')

    // No subagents service → extraction never ran, but the audit event still lands.
    expect(h.subagents.spawnCalls).toHaveLength(0)
    expect(session.append).toHaveBeenCalledTimes(1)
    const [eventType, payload] = session.append.mock.calls[0] as [
      string,
      { dialogTurns: number; draftsAdmitted: number; extractionRan: boolean },
    ]
    expect(eventType).toBe('session/memory-captured')
    expect(payload.dialogTurns).toBe(2)
    expect(payload.draftsAdmitted).toBe(0)
    expect(payload.extractionRan).toBe(false)
  })

  it('extraction failure is audited as extractionRan false, dialog still lands', async () => {
    const subagents: SubagentsMock = { spawnCalls: [], failStart: true }
    const h = makeHarness({}, subagents)
    const session = fakeSession('s-fail')
    const agent = fakeAgent(session)
    h.emitSessionStart(session, agent)
    h.emitSessionEvent(session, { type: 'user/message', data: { content: 'hello' } })
    h.emitDisposed(session)

    await vi.waitFor(() => {
      expect(existsSync(join(h.memoryDir, 'dialog', 's-fail.jsonl'))).toBe(true)
    })
    expect(subagents.spawnCalls).toHaveLength(1)
    // The failure is logged, never silent.
    expect(h.warns.some(w => w.includes('capture extraction failed'))).toBe(true)
    expect(session.append).toHaveBeenCalledTimes(1)
    const [, payload] = session.append.mock.calls[0] as [string, { extractionRan: boolean }]
    expect(payload.extractionRan).toBe(false)
  })

  it('intervalTurns: flushes every captureIntervalTurns turns', async () => {
    const h = makeHarness({ captureMode: 'intervalTurns', captureIntervalTurns: 2 })
    const session = fakeSession('s-interval')
    const agent = fakeAgent(session)
    h.emitSessionStart(session, agent)
    h.emitSessionEvent(session, { type: 'user/message', data: { content: 'first' } })
    // Second buffered turn crosses the interval: flush fires and the buffer clears.
    h.emitSessionEvent(session, { type: 'assistant/message', data: { message: { content: 'second' } } })

    await vi.waitFor(() => {
      expect(existsSync(join(h.memoryDir, 'dialog', 's-interval.jsonl'))).toBe(true)
    })
    const jsonl = readFileSync(join(h.memoryDir, 'dialog', 's-interval.jsonl'), 'utf8')
    expect(jsonl).toContain('first')
    expect(jsonl).toContain('second')

    // A third turn does not re-flush before the next interval boundary.
    h.emitSessionEvent(session, { type: 'user/message', data: { content: 'third' } })
    await vi.waitFor(() => {
      const before = readFileSync(join(h.memoryDir, 'dialog', 's-interval.jsonl'), 'utf8')
      expect(before).not.toContain('third')
    })
  })

  it('re-registered agent after dispose is what the next capture uses (T7.5 lifecycle net)', async () => {
    const subagents: SubagentsMock = { spawnCalls: [] }
    const h = makeHarness({}, subagents)
    const session = fakeSession('s-lifecycle')
    const first = fakeAgent(session)
    h.emitSessionStart(session, first)
    // Dispose with no buffered turns: the first agent is released without capture.
    h.emitDisposed(session)
    expect(h.subagents.spawnCalls).toHaveLength(0)

    // A fresh lifecycle on the same session registers a new agent; the capture
    // that follows must use THAT agent as the extraction parent, not a stale one.
    const second = fakeAgent(session)
    h.emitSessionStart(session, second)
    h.emitSessionEvent(session, { type: 'user/message', data: { content: 'hello' } })
    h.emitDisposed(session)
    await vi.waitFor(() => {
      expect(h.subagents.spawnCalls).toHaveLength(1)
    })
    expect(h.subagents.spawnCalls[0]!.parent).toBe(second)
  })
})
