/**
 * T3.2 Phase A unit tests: lease bookkeeping (`pin`/`unpin`), the LRU
 * live-cap eviction order, and the leased-reclaim snapshot-failure protection
 * with its grace-window retry. Pure decision logic is exercised without real
 * kernels — fake managers stand in for KernelManager (only
 * `dispose`/`snapshotState` are touched by these paths); disposal is verified
 * through the registry's map, not a live process.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { IdleTracker, SessionKernelRegistry, type SessionKernelOptions } from '../src/kernels.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function makeRegistry(options: Partial<SessionKernelOptions> = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-rlm-keepalive-'))
  roots.push(root)
  return new SessionKernelRegistry({ dataDir: root, hostHandlers: {}, ...options } as SessionKernelOptions)
}

/** Bypass TS privacy to inspect/seed internal state for unit-level assertions. */
function internals(registry: SessionKernelRegistry) {
  return registry as unknown as {
    kernels: Map<string, unknown>
    idle: IdleTracker
    pinnedSessions(): Set<string>
    markBusy(id: string): void
    markIdle(id: string): void
  }
}

function fakeManager(snapshot: () => Promise<unknown> = async () => ({})) {
  return { dispose: () => undefined, snapshotState: snapshot }
}

describe('IdleTracker.oldest (T3.2 LRU order)', () => {
  it('orders candidates least-recently-used first and honors the exclude set', () => {
    let now = 0
    const tracker = new IdleTracker(0, () => now)
    now = 10; tracker.touch('a')
    now = 20; tracker.touch('b')
    now = 30; tracker.touch('c')

    expect(tracker.oldest(['a', 'b', 'c'], new Set())).toEqual(['a', 'b', 'c'])
    expect(tracker.oldest(['a', 'b', 'c'], new Set(['b']))).toEqual(['a', 'c'])
    expect(tracker.oldest(['a', 'unknown'], new Set())).toEqual(['a'])
    expect(tracker.oldest(['a', 'b', 'c'], new Set(['a', 'b', 'c']))).toEqual([])
  })
})

describe('leases (T3.2)', () => {
  it('counts per reason and clears on dispose', () => {
    const registry = makeRegistry()
    const k = internals(registry)
    registry.pin('s1', 'test')
    registry.pin('s1', 'test')
    registry.pin('s2', 'other')
    expect(k.pinnedSessions()).toEqual(new Set(['s1', 's2']))

    registry.unpin('s1', 'test')
    expect(k.pinnedSessions()).toEqual(new Set(['s1', 's2']))
    registry.unpin('s1', 'test')
    expect(k.pinnedSessions()).toEqual(new Set(['s2']))

    // Unknown/extra unpin is a no-op.
    registry.unpin('never', 'x')
    expect(k.pinnedSessions()).toEqual(new Set(['s2']))

    // Disposal is the terminal event: leases vanish with the session.
    registry.disposeSession('s2')
    expect(k.pinnedSessions()).toEqual(new Set())
  })
})

describe('live-kernel cap with LRU eviction (T3.2)', () => {
  it('evicts the oldest unleased kernel when the cap is exceeded', async () => {
    let now = 0
    const registry = makeRegistry({ maxLiveKernels: 2, now: () => now })
    const k = internals(registry)
    // s1 used at t=10, s2 at t=20, s3 at t=30.
    now = 10; k.markBusy('s1'); k.markIdle('s1')
    now = 20; k.markBusy('s2'); k.markIdle('s2')
    now = 30; k.markBusy('s3'); k.markIdle('s3')
    for (const id of ['s1', 's2', 's3']) k.kernels.set(id, fakeManager())

    now = 100
    const disposed = await registry.disposeIdle()
    expect(disposed).toEqual(['s1'])
    expect([...k.kernels.keys()].sort()).toEqual(['s2', 's3'])
  })

  it('skips leased and busy kernels during cap eviction', async () => {
    let now = 0
    const registry = makeRegistry({ maxLiveKernels: 2, now: () => now })
    const k = internals(registry)
    now = 10; k.markBusy('s1'); k.markIdle('s1')
    now = 20; k.markBusy('s2'); k.markIdle('s2')
    now = 30; k.markBusy('s3'); k.markIdle('s3')
    for (const id of ['s1', 's2', 's3']) k.kernels.set(id, fakeManager())

    // Lease the oldest; busy the newest → only the middle is evictable.
    registry.pin('s1', 'goal')
    now = 50
    k.markBusy('s3')

    now = 100
    const disposed = await registry.disposeIdle()
    expect(disposed).toEqual(['s2'])
    expect([...k.kernels.keys()].sort()).toEqual(['s1', 's3'])
  })
})

describe('leased reclaim with snapshot-failure protection (T3.2)', () => {
  it('skips a leased kernel whose snapshot fails, then reclaims after the grace window', async () => {
    let now = 0
    const snapFail = true
    const registry = makeRegistry({
      idleTimeoutMs: 1_000,
      reclaimSnapshotGraceMs: 100,
      now: () => now,
    })
    const k = internals(registry)
    now = 10; k.markBusy('s1'); k.markIdle('s1')
    k.kernels.set('s1', fakeManager(() => (snapFail ? Promise.resolve(null) : Promise.resolve({}))))
    registry.pin('s1', 'schedule')

    now = 2_000
    // Failed snapshot → skipped, retry scheduled.
    const first = await registry.disposeIdle()
    expect(first).toEqual([])
    expect(k.kernels.has('s1')).toBe(true)

    // Within the grace window the kernel stays untouched (no snapshot hammering).
    now = 2_050
    const second = await registry.disposeIdle()
    expect(second).toEqual([])

    // A failed-snapshot kernel with no lease is still reclaimed as before.
    registry.unpin('s1', 'schedule')
    now = 2_100
    const third = await registry.disposeIdle()
    expect(third).toEqual(['s1'])
    expect(k.kernels.has('s1')).toBe(false)
  })
})
