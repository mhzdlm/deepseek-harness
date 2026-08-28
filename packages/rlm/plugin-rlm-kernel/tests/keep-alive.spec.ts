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

function fakeManager(snapshot: () => Promise<unknown> = async () => ({ saved: [], skipped: [], bytes: 0, path: 'p' })) {
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

  it('prefers unleased victims during cap eviction and never forces a leased snapshot while they suffice', async () => {
    let now = 0
    let snapCalls = 0
    const registry = makeRegistry({ maxLiveKernels: 2, now: () => now })
    const k = internals(registry)
    now = 10; k.markBusy('s1'); k.markIdle('s1')
    now = 20; k.markBusy('s2'); k.markIdle('s2')
    now = 30; k.markBusy('s3'); k.markIdle('s3')
    k.kernels.set('s1', fakeManager(() => { snapCalls += 1; return Promise.resolve({}) }))
    k.kernels.set('s2', fakeManager())
    k.kernels.set('s3', fakeManager())

    // Lease the oldest; busy the newest → only the middle is needed.
    registry.pin('s1', 'goal')
    now = 50
    k.markBusy('s3')

    now = 100
    const disposed = await registry.disposeIdle()
    expect(disposed).toEqual(['s2'])
    expect([...k.kernels.keys()].sort()).toEqual(['s1', 's3'])
    // C semantics: the leased kernel was never even probed — the unleased
    // victim freed the slot first, so no forced snapshot may have run.
    expect(snapCalls).toBe(0)
  })

  it('defers cap eviction entirely while every over-cap kernel is busy, then applies it on the next idle cycle', async () => {
    let now = 0
    let snapCalls = 0
    const registry = makeRegistry({ maxLiveKernels: 1, now: () => now })
    const k = internals(registry)
    const snapshot = () => {
      snapCalls += 1
      return Promise.resolve({})
    }
    now = 10; k.markBusy('s1'); k.markIdle('s1')
    now = 20; k.markBusy('s2'); k.markIdle('s2')
    k.kernels.set('s1', fakeManager(snapshot))
    k.kernels.set('s2', fakeManager(snapshot))
    // Both execute again: busy kernels are hard-exempt from cap candidates.
    k.markBusy('s1')
    k.markBusy('s2')

    now = 100
    await expect(registry.disposeIdle()).resolves.toEqual([])
    expect([...k.kernels.keys()].sort()).toEqual(['s1', 's2'])
    // Over-cap pressure must not even probe (force-snapshot) busy kernels.
    expect(snapCalls).toBe(0)

    // The deferred pressure applies on the first cycle with an eligible victim.
    k.markIdle('s1')
    now = 150
    await expect(registry.disposeIdle()).resolves.toEqual(['s1'])
    expect([...k.kernels.keys()]).toEqual(['s2'])
  })
})

describe('live-kernel cap eviction of leased kernels (T3.2 C semantics)', () => {
  it('evicts an over-cap leased kernel once its forced snapshot succeeds', async () => {
    let now = 0
    const registry = makeRegistry({ maxLiveKernels: 1, now: () => now })
    const k = internals(registry)
    now = 10; k.markBusy('s1'); k.markIdle('s1')
    now = 20; k.markBusy('s2'); k.markIdle('s2')
    now = 30; k.markBusy('s3'); k.markIdle('s3')
    for (const id of ['s1', 's2', 's3']) k.kernels.set(id, fakeManager())
    registry.pin('s1', 'goal')
    registry.pin('s2', 'schedule')

    now = 100
    // excess=2: unleased s3 goes first, then the OLDEST leased (s1) passes its
    // forced snapshot and is evicted to WARM; newer leased s2 survives.
    const disposed = await registry.disposeIdle()
    expect(disposed).toEqual(['s3', 's1'])
    expect([...k.kernels.keys()]).toEqual(['s2'])
  })

  it('a leased kernel whose forced snapshot fails stays HOT while unleased peers free the cap', async () => {
    let now = 0
    const registry = makeRegistry({ maxLiveKernels: 1, reclaimSnapshotGraceMs: 500, now: () => now })
    const k = internals(registry)
    now = 10; k.markBusy('s1'); k.markIdle('s1')
    now = 20; k.markBusy('s2'); k.markIdle('s2')
    now = 30; k.markBusy('s3'); k.markIdle('s3')
    k.kernels.set('s1', fakeManager(() => Promise.resolve(null))) // dill keeps failing
    k.kernels.set('s2', fakeManager())
    k.kernels.set('s3', fakeManager())
    registry.pin('s1', 'schedule')

    now = 100
    // Unleased s2/s3 (LRU order) free the cap; the failing-snapshot lease is
    // never torn down.
    const disposed = await registry.disposeIdle()
    expect(disposed).toEqual(['s2', 's3'])
    expect([...k.kernels.keys()]).toEqual(['s1'])
  })

  it('the eviction gate honors the grace window before re-forcing a snapshot', async () => {
    let now = 0
    let calls = 0
    let healthy = false
    const registry = makeRegistry({ reclaimSnapshotGraceMs: 400, now: () => now })
    const k = internals(registry)
    k.kernels.set('s1', fakeManager(() => { calls += 1; return healthy ? Promise.resolve({ saved: [], skipped: [], bytes: 0, path: 'p' }) : Promise.resolve(null) }))
    registry.pin('s1', 'schedule')

    const gate = registry as unknown as {
      canSafelyEvictLeased(sessionId: string, nowMs: number): Promise<boolean>
    }

    now = 1_000
    expect(await gate.canSafelyEvictLeased('s1', now)).toBe(false)
    expect(calls).toBe(1)

    // Inside the grace window: skipped WITHOUT hammering the snapshot again.
    now = 1_200
    expect(await gate.canSafelyEvictLeased('s1', now)).toBe(false)
    expect(calls).toBe(1)

    // Past the grace window with a recovered dill: eviction allowed, retry cleared.
    now = 2_000
    healthy = true
    expect(await gate.canSafelyEvictLeased('s1', now)).toBe(true)
    expect(calls).toBe(2)
  })
})

/**
 * Real-kernel integration (mirrors idle-reclaim.spec): a pinned kernel must
 * survive the idle sweep while an unpinned sibling is reclaimed; after unpin,
 * the same sweep reclaims it and the namespace still revives from the dill
 * snapshot. Self-skips when the shared venv is missing.
 */
import { join } from 'node:path'
import { isKernelVenvReady } from './venv-gate.ts'

const venvReady = isKernelVenvReady()
const rIt = venvReady ? it : it.skip

describe('pinned kernel vs real idle sweep', () => {
  rIt('keeps a pinned kernel HOT through the sweep, then reclaims normally after unpin', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-rlm-pin-'))
    roots.push(root)
    let now = 1_000_000
    const kernels = new SessionKernelRegistry({
      dataDir: root,
      hostHandlers: {
        'model.info': async () => ({ provider: 'stub', model: 'pin-test' }),
      },
      idleTimeoutMs: 1_000,
      now: () => now,
    })

    const pinned = await kernels.forSession('pin-session')
    await pinned.execute('y = 7')
    await kernels.forSession('free-session')

    // Both past idle timeout; pin-session holds a lease.
    now += 5_000
    kernels.pin('pin-session', 'schedule')
    const first = await kernels.disposeIdle()
    expect(first).toContain('free-session')
    expect(first).not.toContain('pin-session')
    expect(kernels.hasSession('pin-session')).toBe(true)

    // Unpin → the next sweep reclaims it; the variable survives via snapshot.
    kernels.unpin('pin-session', 'schedule')
    now += 5_000
    const second = await kernels.disposeIdle()
    expect(second).toContain('pin-session')

    const revived = await kernels.forSession('pin-session')
    const result = await revived.execute('y + 1')
    expect(result.status).toBe('ok')
    expect(String(result.result)).toContain('8')
    expect(kernels.consumeRestoreNotice('pin-session')).toBeDefined()

    await kernels.disposeAll()
  }, 180_000)
})
