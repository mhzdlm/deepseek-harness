/**
 * item-4 integration: the full reclamation loop on a real kernel — a kernel
 * idle past the timeout is disposed, and the next ipython call re-provisions
 * from the dill snapshot (variable survives, restore notice is emitted).
 * No LLM key required; needs the kernel venv (bootstrap happens once).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionKernelRegistry } from '../src/kernels.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

describe('idle kernel reclamation (real kernel)', () => {
  it('disposes an idle kernel and restores its namespace from the dill snapshot', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-rlm-idle-'))
    roots.push(root)
    let now = 1_000_000
    const kernels = new SessionKernelRegistry({
      dataDir: root,
      hostHandlers: {
        'model.info': async () => ({ provider: 'stub', model: 'idle-test' }),
      },
      idleTimeoutMs: 1_000,
      now: () => now,
    })

    const k1 = await kernels.forSession('idle-session')
    await k1.execute('x = 41')

    // Advance the clock past the idle timeout; the sweep must reclaim the kernel.
    now += 5_000
    const disposed = kernels.disposeIdle()
    expect(disposed).toContain('idle-session')

    // Next use re-provisions from the snapshot: the variable survives and a
    // restore notice is produced for the model.
    const k2 = await kernels.forSession('idle-session')
    const result = await k2.execute('x + 1')
    expect(result.status).toBe('ok')
    expect(String(result.result)).toContain('42')
    expect(kernels.consumeRestoreNotice('idle-session')).toBeDefined()

    await kernels.disposeAll()
  }, 120_000)
})
