/**
 * Source-path Loader smoke for the JSON-RPC demo bin.
 *
 * The bin is a thin wrapper: it resolves an external `cordis.yml` (from
 * `DSH_CORDIS_CONFIG` or argv[2]) and boots it, owning process exit. This test
 * pins the bin's OWN contract — the config-resolution and usage-message path —
 * without depending on a model or a full agent spine (those belong to the
 * external configuration the deployment supplies).
 *
 * @module @deepseek-ai/dsh-sdk-jsonrpc-demo/tests
 */

import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const binScript = fileURLToPath(new URL('../src/bin.ts', import.meta.url))
// On Windows `--import` requires a file:// URL, not a raw C:\ path.
const tsxLoader = pathToFileURL(resolve(fileURLToPath(import.meta.resolve('tsx')))).href
const repoTsconfig = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))

let workdir: string | undefined

afterEach(async () => {
  if (workdir !== undefined) {
    await rm(workdir, { recursive: true, force: true })
    workdir = undefined
  }
})

/** Spawn the bin with the given env, returning the child and collected stderr. */
function spawnBin(env: NodeJS.ProcessEnv, args: string[] = []): import('node:child_process').ChildProcessWithoutNullStreams {
  return spawn(
    process.execPath,
    ['--import', tsxLoader, binScript, ...args],
    {
      cwd: workdir ?? process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        TSX_TSCONFIG_PATH: repoTsconfig,
        DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY ?? 'sk-test-dummy',
        ...env,
      },
    },
  ) as import('node:child_process').ChildProcessWithoutNullStreams
}

describe('jsonrpc-demo bin config resolution', () => {
  it('prints a usage message and exits 1 when no config is supplied', async () => {
    workdir = await mkdtemp(join(tmpdir(), 'jsonrpc-demo-usage-'))
    const child = spawnBin({})

    const stderr: string[] = []
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => stderr.push(chunk))

    const exitCode = await new Promise<number | null>((resolve) => {
      child.on('exit', code => resolve(code))
      // Fallback: do not hang the suite if the process misbehaves.
      setTimeout(() => resolve(null), 15_000)
    })

    expect(exitCode).toBe(1)
    expect(stderr.join('')).toContain('usage')
  }, 20_000)

  it('exits 1 when the configured path does not exist', async () => {
    workdir = await mkdtemp(join(tmpdir(), 'jsonrpc-demo-missing-'))
    const missing = join(workdir, 'does-not-exist.cordis.yml')
    const child = spawnBin({ DSH_CORDIS_CONFIG: missing })

    const stderr: string[] = []
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => stderr.push(chunk))

    const exitCode = await new Promise<number | null>((resolve) => {
      child.on('exit', code => resolve(code))
      setTimeout(() => resolve(null), 15_000)
    })

    expect(exitCode).toBe(1)
    expect(stderr.join('')).toContain('usage')
  }, 20_000)
})
