/**
 * item-6: prove that aborting a cell actually interrupts the running kernel
 * (control-channel `interrupt_request`), rather than just abandoning the wait.
 *
 * A long-running cell is aborted mid-flight; the execute settles `aborted`, and
 * a following quick cell must complete fast — if the kernel were still stuck on
 * the sleep, the reuse path would either block or throw KernelBusyAfterInterrupt.
 * No LLM key required; needs the kernel venv.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KernelManager } from '../src/vendor/kernel/index.ts'
import { getKernelVenvDir, venvPythonPath } from '../src/vendor/kernel/bootstrap.ts'
import { SessionKernelRegistry } from '../src/kernels.ts'

// Real kernel required; self-skip when the venv is missing so machines
// without it stay green in the default suite (same pattern as
// kernel-env-runtime.spec.ts).
const venvReady = existsSync(venvPythonPath(getKernelVenvDir()))
const dIt = venvReady ? it : it.skip

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

async function makeKernel(root: string, sid: string): Promise<KernelManager> {
  const artifactDir = join(root, 'session-artifacts', sid)
  const { mkdirSync } = await import('node:fs')
  mkdirSync(artifactDir, { recursive: true })
  return new KernelManager({
    cwd: process.cwd(),
    env: {
      RLM_SESSION_DIR: artifactDir,
      RLM_HARNESS_STATE_DIR: join(artifactDir, 'harness'),
      RLM_GLOBAL_HARNESS_STATE_DIR: join(root, 'global', 'harness'),
    },
    sessionId: sid,
    hostHandlers: { 'model.info': async () => ({ provider: 'stub', model: 'cancel-test' }) },
    snapshot: {
      path: join(artifactDir, 'state.dill'),
      manifestPath: join(artifactDir, 'state.manifest.json'),
    },
    username: 'dsh-agent',
  })
}

describe('ipython cancellation (item-6)', () => {
  dIt('abort interrupts a running CPU-bound cell; the kernel stays immediately usable', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-rlm-cancel-'))
    roots.push(root)
    const kernel = await makeKernel(root, 'cancel-session')
    await kernel.start()

    // CPU-bound loop: executes bytecodes continuously, so the control-channel
    // interrupt_main() can raise KeyboardInterrupt between them. (Blocking C
    // calls like time.sleep() are NOT interruptible on Windows — see docs.)
    const controller = new AbortController()
    const running = kernel.execute('for _ in range(200_000_000): pass', { signal: controller.signal })

    // Let the cell actually start running, then abort mid-flight.
    await new Promise(resolve => setTimeout(resolve, 2_000))
    const abortAt = Date.now()
    controller.abort()

    const result = await running
    expect(result.status).toBe('aborted')
    // Abort + 1s grace must settle long before the loop would finish.
    expect(Date.now() - abortAt).toBeLessThan(15_000)

    // If the interrupt truly cancelled the loop, the kernel is free: a quick
    // cell returns immediately (the busy-reuse path would otherwise block up
    // to 5s or throw KernelBusyAfterInterruptError).
    const quickStart = Date.now()
    const quick = await kernel.execute('1 + 1')
    expect(quick.status).toBe('ok')
    expect(String(quick.result)).toContain('2')
    expect(Date.now() - quickStart).toBeLessThan(10_000)

    await kernel.dispose()
  }, 90_000)

  dIt('recovers a kernel stuck on an uninterruptible blocking cell (item-6 recovery)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-rlm-cancel-recover-'))
    roots.push(root)
    const kernels = new SessionKernelRegistry({
      dataDir: root,
      hostHandlers: { 'model.info': async () => ({ provider: 'stub', model: 'cancel-recover' }) },
      idleTimeoutMs: 0, // never reclaim during this test
    })

    // time.sleep() is a blocking C call: on Windows the control-channel
    // interrupt cannot stop it, so the kernel stays busy after the abort.
    const controller = new AbortController()
    const running = kernels.execute('recover-session', 'import time; time.sleep(30)', { signal: controller.signal })
    await new Promise(resolve => setTimeout(resolve, 2_000))
    controller.abort()
    const aborted = await running
    expect(aborted.status).toBe('aborted')

    // The next execute must recover by recreating the kernel from its dill
    // snapshot instead of surfacing KernelBusyAfterInterruptError.
    const quick = await kernels.execute('recover-session', '1 + 1', {})
    expect(quick.status).toBe('ok')
    expect(String(quick.result)).toContain('2')

    await kernels.disposeAll()
  }, 90_000)
})
