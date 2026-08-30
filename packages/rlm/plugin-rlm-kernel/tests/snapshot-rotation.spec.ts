/**
 * T4.1 (snapshot history rotation) and T4.2 (log-only `session/kernel-snapshot`
 * event) are observable only through a running kernel; these unit tests drive
 * the registry's private flush/rotate path with a stubbed `KernelManager` and a
 * temp artifact dir so the shifting and emission logic is asserted without a
 * Python venv.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Session } from '@deepseek-ai/dsh-session'
import { SessionKernelRegistry } from '../src/kernels.ts'
import type { SessionKernelOptions } from '../src/kernels.ts'
import { KERNEL_SNAPSHOT_EVENT_TYPES } from '../src/events.ts'
import { snapshotPathIn } from '../src/vendor/kernel/state-snapshot.ts'

function buildKernels(root: string, options: Partial<SessionKernelOptions> = {}): SessionKernelRegistry {
  return new SessionKernelRegistry({ dataDir: root, hostHandlers: {}, ...options } as SessionKernelOptions)
}

function capturedSession(): { session: Session; events: Record<string, unknown>[] } {
  const events: Record<string, unknown>[] = []
  const session = {
    append(name: string, payload: unknown) {
      events.push({ name, ...(payload as object) })
    },
  } as unknown as Session
  return { session, events }
}

const roots: string[] = []
function tmpRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'rlm-snapshot-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots.length = 0
})

describe('T4.1 snapshot history rotation', () => {
  it('shifts older copies outward and keeps the newest at slot 1', async () => {
    const root = tmpRoot()
    const dir = path.join(root, 'session-artifacts', 's1')
    mkdirSync(dir, { recursive: true })
    const kernels = buildKernels(root)
    writeFileSync(path.join(dir, 'kernel-state.1.dill'), 'v2')
    writeFileSync(path.join(dir, 'kernel-state.2.dill'), 'v1')
    writeFileSync(snapshotPathIn(dir), 'v3')

    await (kernels as unknown as { rotateSnapshot(dir: string): Promise<void> }).rotateSnapshot(dir)

    expect(readdirSync(dir).sort()).toEqual([
      'kernel-state.1.dill',
      'kernel-state.2.dill',
      'kernel-state.3.dill',
      'kernel-state.dill',
    ])
    expect(readFileSync(path.join(dir, 'kernel-state.1.dill'), 'utf8')).toBe('v3')
    expect(readFileSync(path.join(dir, 'kernel-state.2.dill'), 'utf8')).toBe('v2')
    expect(readFileSync(path.join(dir, 'kernel-state.3.dill'), 'utf8')).toBe('v1')
  })

  it('drops the oldest beyond the cap on the next flush', async () => {
    const root = tmpRoot()
    const dir = path.join(root, 'session-artifacts', 's2')
    mkdirSync(dir, { recursive: true })
    const kernels = buildKernels(root, { snapshotHistory: 3 })
    writeFileSync(path.join(dir, 'kernel-state.1.dill'), 'v3')
    writeFileSync(path.join(dir, 'kernel-state.2.dill'), 'v2')
    writeFileSync(path.join(dir, 'kernel-state.3.dill'), 'v1')
    writeFileSync(snapshotPathIn(dir), 'v4')

    await (kernels as unknown as { rotateSnapshot(dir: string): Promise<void> }).rotateSnapshot(dir)

    expect(readdirSync(dir).sort()).toEqual([
      'kernel-state.1.dill',
      'kernel-state.2.dill',
      'kernel-state.3.dill',
      'kernel-state.dill',
    ])
    expect(readFileSync(path.join(dir, 'kernel-state.3.dill'), 'utf8')).toBe('v2')
  })

  it('writes no history copies when snapshotHistory is 0', async () => {
    const root = tmpRoot()
    const dir = path.join(root, 'session-artifacts', 's3')
    mkdirSync(dir, { recursive: true })
    const kernels = buildKernels(root, { snapshotHistory: 0 })
    writeFileSync(snapshotPathIn(dir), 'live')

    await (kernels as unknown as { rotateSnapshot(dir: string): Promise<void> }).rotateSnapshot(dir)

    expect(readdirSync(dir)).toEqual(['kernel-state.dill'])
  })

  it('prunes stale numbered files left beyond a shrunk snapshotHistory', async () => {
    const root = tmpRoot()
    const dir = path.join(root, 'session-artifacts', 's6')
    mkdirSync(dir, { recursive: true })
    const kernels = buildKernels(root, { snapshotHistory: 2 })
    // .3/.4 predate a snapshotHistory reduction; the cap must self-heal.
    for (const n of [1, 2, 3, 4]) writeFileSync(path.join(dir, `kernel-state.${n}.dill`), `v${n}`)
    writeFileSync(snapshotPathIn(dir), 'live')

    await (kernels as unknown as { rotateSnapshot(dir: string): Promise<void> }).rotateSnapshot(dir)

    expect(readdirSync(dir).sort()).toEqual([
      'kernel-state.1.dill',
      'kernel-state.2.dill',
      'kernel-state.dill',
    ])
  })
})

describe('flush scheduling (debounce, mid-cell cancellation)', () => {
  it('cancels an armed flush when a new cell starts and collapses bursts into one flush', async () => {
    const root = tmpRoot()
    const kernels = buildKernels(root, { snapshotDebounceMs: 5 })
    let calls = 0
    ;(kernels as unknown as { kernels: Map<string, unknown> }).kernels.set('s7', {
      dispose: async () => undefined,
      snapshotState: async () => {
        calls += 1
        return null
      },
    })
    const k = kernels as unknown as {
      scheduleSnapshot(sid: string): void
      cancelScheduledFlush(sid: string): void
    }

    // Cell N succeeded → flush armed; cell N+1 starts before the debounce fires:
    // the busy namespace is never snapshotted mid-execution.
    k.scheduleSnapshot('s7')
    k.cancelScheduledFlush('s7')
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(calls).toBe(0)

    // Two back-to-back successes inside one window re-arm to a single flush.
    k.scheduleSnapshot('s7')
    k.scheduleSnapshot('s7')
    await new Promise(resolve => setTimeout(resolve, 25))
    expect(calls).toBe(1)
  })

  it('disposal cancels the armed flush so no event is emitted after teardown', async () => {
    const root = tmpRoot()
    const kernels = buildKernels(root, { snapshotDebounceMs: 5 })
    let calls = 0
    ;(kernels as unknown as { kernels: Map<string, unknown> }).kernels.set('s8', {
      dispose: async () => undefined,
      snapshotState: async () => {
        calls += 1
        return null
      },
    })
    ;(kernels as unknown as { scheduleSnapshot(sid: string): void }).scheduleSnapshot('s8')
    kernels.disposeSession('s8')
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(calls).toBe(0)
  })

  it('suppresses the event when the session is disposed during the snapshot await', async () => {
    const root = tmpRoot()
    const { session, events } = capturedSession()
    const kernels = buildKernels(root, { resolveSession: () => session })
    // The snapshot rejects (the manager is being torn down mid-await); the
    // session is gone by the time flushSnapshot resumes — the failure belongs
    // to the disposal, not to the namespace, so nothing reaches the log.
    ;(kernels as unknown as { kernels: Map<string, unknown> }).kernels.set('s9', {
      snapshotState: async () => {
        ;(kernels as unknown as { kernels: Map<string, unknown> }).kernels.delete('s9')
        throw new Error('disposed kernel rejected')
      },
    })

    const ok = await (
      kernels as unknown as { flushSnapshot(sid: string, reason: 'cell' | 'reclaim'): Promise<boolean> }
    ).flushSnapshot('s9', 'cell')

    expect(ok).toBe(false)
    expect(events).toHaveLength(0)
  })
})

describe('T4.2 kernel-snapshot event emission', () => {
  it('emits ok:true with the snapshot result and rotates on success', async () => {
    const root = tmpRoot()
    const dir = path.join(root, 'session-artifacts', 's4')
    mkdirSync(dir, { recursive: true })
    const { session, events } = capturedSession()
    const kernels = buildKernels(root, { snapshotHistory: 2, resolveSession: () => session })
    const fakeManager = {
      snapshotState: async () => ({
        saved: ['a', 'b'],
        skipped: [{ name: 'c', reason: 'unpicklable' }],
        pruned: ['d'],
        bytes: 42,
        path: snapshotPathIn(dir),
      }),
    }
    ;(kernels as unknown as { kernels: Map<string, unknown> }).kernels.set('s4', fakeManager)
    writeFileSync(snapshotPathIn(dir), 'live')

    const ok = await (
      kernels as unknown as { flushSnapshot(sid: string, reason: 'cell' | 'reclaim'): Promise<boolean> }
    ).flushSnapshot('s4', 'cell')

    expect(ok).toBe(true)
    expect(events).toHaveLength(1)
    const event = events[0] as Record<string, unknown>
    expect(event.name).toBe('session/kernel-snapshot')
    expect(event.ok).toBe(true)
    expect(event.vars).toBe(2)
    expect(event.bytes).toBe(42)
    expect(event.skipped).toEqual(['c'])
    expect(event.pruned).toEqual(['d'])
    expect(event.reason).toBe('cell')
    expect(typeof event.ms).toBe('number')
    expect(readdirSync(dir)).toContain('kernel-state.1.dill')
  })

  it('emits ok:false carrying the real error text, and keeps no new history on snapshot failure', async () => {
    const root = tmpRoot()
    const dir = path.join(root, 'session-artifacts', 's5')
    mkdirSync(dir, { recursive: true })
    const { session, events } = capturedSession()
    const kernels = buildKernels(root, { snapshotHistory: 2, resolveSession: () => session })
    const fakeManager = { snapshotState: async () => { throw new Error('dill pickle error: cannot serialize <lambda>') } }
    ;(kernels as unknown as { kernels: Map<string, unknown> }).kernels.set('s5', fakeManager)

    const ok = await (
      kernels as unknown as { flushSnapshot(sid: string, reason: 'cell' | 'reclaim'): Promise<boolean> }
    ).flushSnapshot('s5', 'reclaim')

    expect(ok).toBe(false)
    expect(events).toHaveLength(1)
    const event = events[0] as Record<string, unknown>
    expect(event.ok).toBe(false)
    expect(event.error).toBe('dill pickle error: cannot serialize <lambda>')
    expect(event.reason).toBe('reclaim')
    expect(readdirSync(dir)).not.toContain('kernel-state.1.dill')
  })

  it('declares the kernel event set (snapshot + subcall-query)', () => {
    expect([...KERNEL_SNAPSHOT_EVENT_TYPES]).toEqual(['session/kernel-snapshot', 'session/subcall-query'])
  })
})
