/**
 * item-7 integration: `warmUpSession` provisions a session's kernel in the
 * background at session creation (no ipython call needed). No LLM key required.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getKernelVenvDir, venvPythonPath } from '../src/vendor/kernel/bootstrap.ts'
import { SessionKernelRegistry, warmUpSession } from '../src/kernels.ts'

// Real kernel required; self-skip when the venv is missing (same pattern as
// kernel-env-runtime.spec.ts).
const venvReady = existsSync(venvPythonPath(getKernelVenvDir()))
const dIt = venvReady ? it : it.skip

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

describe('kernel warmup (item-7)', () => {
  dIt('provisions a kernel for a session without an ipython call', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-rlm-warmup-'))
    roots.push(root)
    const kernels = new SessionKernelRegistry({
      dataDir: root,
      hostHandlers: { 'model.info': async () => ({ provider: 'stub', model: 'warmup' }) },
      idleTimeoutMs: 0, // never reclaim during this test
    })

    warmUpSession(kernels, 'warmup-session')
    const deadline = Date.now() + 60_000
    while (!kernels.hasSession('warmup-session') && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 500))
    }
    expect(kernels.hasSession('warmup-session')).toBe(true)

    // The pre-provisioned kernel is immediately usable.
    const kernel = await kernels.forSession('warmup-session')
    const result = await kernel.execute('1 + 1')
    expect(result.status).toBe('ok')
    expect(String(result.result)).toContain('2')

    await kernels.disposeAll()
  }, 90_000)
})
