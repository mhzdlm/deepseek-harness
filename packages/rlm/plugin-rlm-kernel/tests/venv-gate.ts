/**
 * Shared venv-readiness gate for kernel specs that need a real IPython kernel.
 *
 * `existsSync(venvPythonPath(...))` alone is not a readiness check: the venv
 * directory can exist while the shared bootstrap lock is held and the
 * interpreter is mid-rebuild (first-run, or a concurrent skill install), so a
 * spec gated only on existence would start provisioning against a half-built
 * venv and burn its full deadline (the warmup flake). This helper additionally
 * spawns the interpreter (`--version`) with a short timeout; only an
 * interpreter that actually runs reports ready.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { getKernelVenvDir, venvPythonPath } from '../src/vendor/kernel/bootstrap.ts'

/** Probe timeout (ms); a hung interpreter must fail the gate, not stall the suite. */
const PROBE_TIMEOUT_MS = 5_000

/**
 * Whether the kernel venv interpreter exists AND runs. Self-skip consumers use
 * this so machines without a usable venv stay green in the default suite.
 * @returns true when the venv python executable exists and exits 0 on `--version`.
 */
export function isKernelVenvReady(): boolean {
  const python = venvPythonPath(getKernelVenvDir())
  if (!existsSync(python)) return false
  try {
    const probe = spawnSync(python, ['--version'], { timeout: PROBE_TIMEOUT_MS, encoding: 'utf8' })
    return probe.status === 0
  } catch {
    return false
  }
}
