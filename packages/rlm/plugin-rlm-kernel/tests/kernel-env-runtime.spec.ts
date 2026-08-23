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
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KernelManager } from '../src/vendor/kernel/index.ts'
import { getKernelVenvDir, venvPythonPath } from '../src/vendor/kernel/bootstrap.ts'

const venvPython = venvPythonPath(getKernelVenvDir())
const venvReady = existsSync(venvPython)
const dIt = venvReady ? it : it.skip

let planted: string | undefined

describe('kernel child env boundary (end-to-end, #14)', () => {
  dIt('credential planted on the host does not reach the kernel process', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-rlm-env-'))
    const sid = 'kernel-env-session'
    const artifactDir = join(root, 'session-artifacts', sid)
    mkdirSync(artifactDir, { recursive: true })

    // Plant a credential exactly where a leaked host env would carry it.
    planted = process.env.DEEPSEEK_API_KEY
    process.env.DEEPSEEK_API_KEY = 'sk-e2e-canary-must-not-leak'

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
        "import os\n(int('DEEPSEEK_API_KEY' in os.environ), int(bool(os.environ.get('PATH') or os.environ.get('Path'))))",
      )
      expect(probe.status).toBe('ok')
      const match = /\((\d+),\s*(\d+)\)/.exec(String(probe.result))
      expect(match, `unexpected probe result: ${String(probe.result)!}`).not.toBeNull()
      const [leaked, hasPath] = match!.slice(1).map(Number)
      expect(leaked).toBe(0)
      expect(hasPath).toBe(1)
    } finally {
      if (planted === undefined) delete process.env.DEEPSEEK_API_KEY
      else process.env.DEEPSEEK_API_KEY = planted
      await kernel.dispose()
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  }, 120_000)
})
