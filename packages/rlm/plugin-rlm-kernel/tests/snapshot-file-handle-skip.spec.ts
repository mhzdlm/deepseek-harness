/**
 * Regression for the dill file-handle hazard: a live write-mode handle in the
 * kernel namespace used to be serialized as reopen-instructions (path + mode),
 * so any later `dill.loads` of the payload — session restore or off-session
 * analysis — silently truncated the target file. The snapshot now skips
 * `io.IOBase` values with a reported reason; this spec proves the target file
 * survives the exact consumer pattern that caused the loss. Gated on `uv`
 * because the kernel venv provides python + dill.
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterAll, describe, expect, it } from 'vitest'
import { ensureKernelPython } from '../src/vendor/kernel/bootstrap.ts'
import { buildSnapshotCode, manifestPathIn, snapshotPathIn } from '../src/vendor/kernel/state-snapshot.ts'

const run = promisify(execFile)

const VICTIM_TEXT = 'survives-snapshot'

function hasUv(): boolean {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const candidate = path.join(dir, process.platform === 'win32' ? 'uv.exe' : 'uv')
    if (existsSync(candidate)) return true
  }
  return false
}

describe('snapshot skips live file handles (io.IOBase)', () => {
  if (!hasUv()) {
    it.skip('requires uv on PATH', () => undefined)
    return
  }

  let root: string | undefined
  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  })

  it('reports the handle as skipped and the target file survives a full payload loads', async () => {
    root = mkdtempSync(path.join(tmpdir(), 'rlm-snapshot-handle-'))
    const victim = path.join(root, 'victim.txt')
    const outPath = snapshotPathIn(path.join(root, 'artifacts'))
    const manifestPath = manifestPathIn(path.join(root, 'artifacts'))
    const codePath = path.join(root, 'snapshot-code.py')
    writeFileSync(codePath, buildSnapshotCode(outPath, manifestPath, 8 * 1024 * 1024), 'utf8')

    // The driver seeds a live 'wb' handle whose file already has content, runs
    // the generated snapshot code against its own globals, then replays the
    // consumer pattern that caused the original loss: dill.load the payload and
    // dill.loads every blob.
    const driver = `
import io, json, os, sys
victim = ${JSON.stringify(victim)}
code_path = ${JSON.stringify(codePath)}
fh = open(victim, "wb")
fh.write(${JSON.stringify(VICTIM_TEXT)}.encode("utf-8"))
fh.flush()
keep = {"answer": 42}
exec(compile(open(code_path, encoding="utf-8").read(), "snapshot", "exec"), globals())
import dill
payload = dill.load(open(${JSON.stringify(outPath)}, "rb"))
for name, blob in list(payload.items()):
    dill.loads(blob)
with open(victim, "rb") as check:
    content = check.read()
print("PROBE" + json.dumps({"victim": content.decode("utf-8", "replace")}))
`
    const driverPath = path.join(root, 'driver.py')
    writeFileSync(driverPath, driver, 'utf8')

    const python = await ensureKernelPython()
    await run(python, [driverPath], { timeout: 120_000 })

    expect(existsSync(manifestPath)).toBe(true)
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      savedNames: string[]
      skipped: { name: string; reason: string }[]
    }
    expect(manifest.savedNames).toContain('keep')
    expect(manifest.savedNames).not.toContain('fh')
    const fhSkip = manifest.skipped.find(entry => entry.name === 'fh')
    expect(fhSkip?.reason).toContain('io.IOBase')

    // The core regression: the target file must still hold the bytes written
    // through the handle (pre-fix, the loads loop truncated it to empty).
    expect(readFileSync(victim, 'utf8')).toBe(VICTIM_TEXT)
  }, 240_000)
})
