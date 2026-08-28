/**
 * item-3 integration: `forSession` must coalesce concurrent provisions for the
 * same session into one kernel — N simultaneous callers share a single
 * in-flight promise, so a burst of ipython calls cannot orphan extra kernel
 * processes. Real kernel required; self-skips when the venv is missing.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isKernelVenvReady } from './venv-gate.ts'
import { SessionKernelRegistry } from '../src/kernels.ts'

const venvReady = isKernelVenvReady()
const dIt = venvReady ? it : it.skip

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

describe('forSession concurrent provision dedup (item-3)', () => {
  dIt('coalesces parallel first calls into a single shared kernel', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-rlm-dedup-'))
    roots.push(root)
    const kernels = new SessionKernelRegistry({
      dataDir: root,
      hostHandlers: {
        'model.info': async () => ({ provider: 'stub', model: 'dedup-test' }),
      },
      idleTimeoutMs: 0,
    })

    // Five racing first calls: without the in-flight dedup each caller would
    // construct its own KernelManager and all but one would leak.
    const [a, b, c, d, e] = await Promise.all([
      kernels.forSession('dedup-session'),
      kernels.forSession('dedup-session'),
      kernels.forSession('dedup-session'),
      kernels.forSession('dedup-session'),
      kernels.forSession('dedup-session'),
    ])

    expect(b).toBe(a)
    expect(c).toBe(a)
    expect(d).toBe(a)
    expect(e).toBe(a)

    // The coalesced kernel actually works.
    const result = await a.execute('1 + 1')
    expect(result.status).toBe('ok')
    expect(String(result.result)).toContain('2')

    await kernels.disposeAll()
  }, 120_000)

  dIt('keeps distinct sessions on distinct kernels', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-rlm-dedup-'))
    roots.push(root)
    const kernels = new SessionKernelRegistry({
      dataDir: root,
      hostHandlers: {
        'model.info': async () => ({ provider: 'stub', model: 'dedup-test' }),
      },
      idleTimeoutMs: 0,
    })

    const [x, y] = await Promise.all([
      kernels.forSession('session-x'),
      kernels.forSession('session-y'),
    ])
    expect(x).not.toBe(y)

    await kernels.disposeAll()
  }, 120_000)
})
