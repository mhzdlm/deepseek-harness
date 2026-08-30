/**
 * T4.11 conversation-level snapshot consistency: drive real multi-cell sessions
 * through the registry (venv-gated), then assert the durable log events and the
 * on-disk dill rotation agree. The registry *is* the conversation here —
 * multiple cells, an evolving namespace, real dill rotation, real log events.
 *
 * The "tool-surface" variant (calling the rlm preset's ipython tool through a
 * mounted REAL-composition) folds the same assertions through the model/tool
 * layer, but needs a real model context this fixture environment cannot supply,
 * so it is deferred. What changes at the tool layer are argument marshalling and
 * the caller loop, not the accounting that these assertions pin.
 */
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, it, expect } from 'vitest'
import type { Session } from '@deepseek-ai/dsh-session'
import { SessionKernelRegistry } from '../src/kernels.ts'
import type { SessionKernelOptions } from '../src/kernels.ts'
import { isKernelVenvReady } from './venv-gate.ts'

const venvReady = isKernelVenvReady()
const rIt = venvReady ? it : it.skip
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * The debounced flush is real-timed (venv snapshot ≈ 57ms on slow machines
 * + 10ms debounce > the old fixed sleep(60)), so tests poll for the expected
 * event instead of sleeping a fixed budget. Deadline failure is the assertion.
 */
async function waitForCellEvents(
  events: Record<string, unknown>[],
  count: number,
  timeoutMs = 5_000,
): Promise<void> {
  const isCellEvent = (e: Record<string, unknown>) =>
    e.name === 'session/kernel-snapshot' && (e.reason as string) === 'cell'
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (events.filter(isCellEvent).length >= count) return
    await sleep(10)
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${count} kernel-snapshot cell event(s); saw ${events.filter(isCellEvent).length}`)
}

function buildKernels(root: string, options: Partial<SessionKernelOptions> = {}) {
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
  const root = mkdtempSync(path.join(tmpdir(), 'rlm-conv-'))
  roots.push(root)
  return root
}

afterEach(() => {
  // Phase 8: best-effort cleanup. These are real-kernel tests — the python
  // child can hold its CWD/temp handle for a while after dispose, and on
  // Windows that makes even retried rmSync fail with EPERM (flake seen only
  // in full-suite runs). A leaked %TEMP% dir is harmless; a red suite is not.
  for (const root of roots) {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    } catch {
      // leave the temp dir behind; the OS temp cleaner owns it now
    }
  }
  roots.length = 0
})

describe('T4.11 conversation-level snapshot accounting', () => {
  rIt('folds back-to-back cells into a single cell-flush', async () => {
    const root = tmpRoot()
    const { session, events } = capturedSession()
    const kernels = buildKernels(root, {
      resolveSession: () => session,
      snapshotHistory: 3,
      snapshotDebounceMs: 10,
    })

    await kernels.execute('conv', 'a = 1', {})
    await kernels.execute('conv', 'b = 2', {})
    await waitForCellEvents(events, 1)

    const cell = events.filter(
      e => e.name === 'session/kernel-snapshot' && (e.reason as string) === 'cell',
    )
    expect(cell).toHaveLength(1)
    expect(cell[0]!.ok).toBe(true)
  })

  rIt('accounts for an error-result cell with a kernel-snapshot event', async () => {
    const root = tmpRoot()
    const { session, events } = capturedSession()
    const kernels = buildKernels(root, {
      resolveSession: () => session,
      snapshotHistory: 3,
      snapshotDebounceMs: 10,
    })

    // An IPython error is returned as a cell result (status=error), not thrown
    // at the registry — yet the partial side effects still get flushed so the
    // log and the dill rotation account for the state.
    await kernels.execute('fail', "raise RuntimeError('boom')", {})
    await waitForCellEvents(events, 1)

    const cell = events.filter(
      e => e.name === 'session/kernel-snapshot' && (e.reason as string) === 'cell',
    )
    expect(cell).toHaveLength(1)
    expect(cell[0]!.ok).toBe(true)
  })

  rIt('disk history rotates in sync with the growing namespace', async () => {
    const root = tmpRoot()
    const { session, events } = capturedSession()
    const kernels = buildKernels(root, {
      resolveSession: () => session,
      snapshotHistory: 2,
      snapshotDebounceMs: 10,
    })

    await kernels.execute('rot', 'p = 1', {})
    await waitForCellEvents(events, 1)
    await kernels.execute('rot', 'q = 2', {})
    await waitForCellEvents(events, 2)
    await kernels.execute('rot', 'r = 3', {})
    await waitForCellEvents(events, 3)

    const dir = path.join(root, 'session-artifacts', 'rot')
    expect(readdirSync(dir)).toContain('kernel-state.1.dill')
    expect(readdirSync(dir)).toContain('kernel-state.2.dill')

    const cell = events.filter(
      e => e.name === 'session/kernel-snapshot' && (e.reason as string) === 'cell',
    )
    expect(cell).toHaveLength(3)
    const vars = cell.map(e => e.vars as number)
    expect(vars.at(-1)!).toBeGreaterThanOrEqual(vars[0]!)
  })

  rIt('does not emit a snapshot event after the session is disposed', async () => {
    const root = tmpRoot()
    const { session, events } = capturedSession()
    const kernels = buildKernels(root, { resolveSession: () => session, snapshotDebounceMs: 10 })

    kernels.disposeSession('nope')
    // Absence assertion: a generous fixed window (no event to poll for) must
    // outlive any late flush from a disposed-before-armed timer.
    await sleep(300)

    expect(events).toHaveLength(0)
  })
})
