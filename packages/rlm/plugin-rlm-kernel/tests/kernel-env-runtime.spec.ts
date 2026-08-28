/**
 * [local patch #14] end-to-end proof that the kernel child process actually
 * receives the scrubbed environment: a credential planted in the host
 * process.env must NOT appear inside the running IPython kernel, while an
 * allowlisted runtime variable must.
 *
 * Needs the kernel venv (like cancel.spec.ts); self-skips when it is missing,
 * so machines without the venv stay green in the default suite. No LLM key.
 */
import { describe, expect, it } from 'vitest'
import { isKernelVenvReady } from './venv-gate.ts'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KernelManager } from '../src/vendor/kernel/index.ts'

const venvReady = isKernelVenvReady()
const dIt = venvReady ? it : it.skip

let planted: string | undefined

describe('kernel child env boundary (end-to-end, #14)', () => {
  dIt('credential planted on the host does not reach the kernel process', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-rlm-env-'))
    const sid = 'kernel-env-session'
    const artifactDir = join(root, 'session-artifacts', sid)
    mkdirSync(artifactDir, { recursive: true })

    // Plant a canary variable that carries a credential-blocklist prefix
    // (DSH_ is default-denied) without touching any real provider key name.
    planted = process.env.DSH_RLM_TEST_CREDENTIAL
    process.env.DSH_RLM_TEST_CREDENTIAL = 'e2e-canary-must-not-leak'

    const kernel = new KernelManager({
      cwd: process.cwd(),
      env: {
        RLM_SESSION_DIR: artifactDir,
        RLM_HARNESS_STATE_DIR: join(artifactDir, 'harness'),
        RLM_GLOBAL_HARNESS_STATE_DIR: join(root, 'global', 'harness'),
      },
      sessionId: sid,
      hostHandlers: { 'model.info': async () => ({ provider: 'stub', model: 'env-test' }) },
      snapshot: {
        path: join(artifactDir, 'state.dill'),
        manifestPath: join(artifactDir, 'state.manifest.json'),
      },
      username: 'dsh-agent',
    })
    try {
      await kernel.start()
      // os.environ is captured at interpreter start; reading it now reflects
      // exactly what the spawn handed the child. The cell's final expression
      // is the result value (print() output does not reach `.result`).
      const probe = await kernel.execute(
        "import os\n(int('DSH_RLM_TEST_CREDENTIAL' in os.environ), int(bool(os.environ.get('PATH') or os.environ.get('Path'))))",
      )
      expect(probe.status).toBe('ok')
      const match = /\((\d+),\s*(\d+)\)/.exec(String(probe.result))
      expect(match, `unexpected probe result: ${String(probe.result)!}`).not.toBeNull()
      const [leaked, hasPath] = match!.slice(1).map(Number)
      expect(leaked).toBe(0)
      expect(hasPath).toBe(1)
    } finally {
      if (planted === undefined) delete process.env.DSH_RLM_TEST_CREDENTIAL
      else process.env.DSH_RLM_TEST_CREDENTIAL = planted
      await kernel.dispose()
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  }, 120_000)
})
