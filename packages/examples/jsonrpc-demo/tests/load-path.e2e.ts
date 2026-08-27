/**
 * Source-path Loader smoke for the JSON-RPC demo bin, covering the config
 * resolution path and the `unwrapExports` shape. The bin requires an external
 * `cordis.yml` — this test provides a minimal one and verifies it boots.
 *
 * @module @deepseek-ai/dsh-sdk-jsonrpc-demo/tests
 */

import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const binScript = fileURLToPath(new URL('../src/bin.ts', import.meta.url))
const tsxLoader = fileURLToPath(import.meta.resolve('tsx'))
const repoTsconfig = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))

// A minimal cordis.yml that boots the JSON-RPC server with a mock LLM adapter.
// The server initializes and waits for stdin; we verify it starts by sending
// a valid JSON-RPC request and checking for a response.
const CORDIS_YML = `
- id: llm-deepseek
  name: '@deepseek-ai/dsh-llm-deepseek'
- id: subprocess
  name: '@deepseek-ai/dsh-subprocess-local'
- id: jsonrpc-server
  name: '@deepseek-ai/dsh-sdk-jsonrpc-server'
  config:
    provider: deepseek-official
    model: deepseek-v4-flash
`

let workdir: string | undefined

afterEach(async () => {
  if (workdir !== undefined) {
    await rm(workdir, { recursive: true, force: true })
    workdir = undefined
  }
})

async function boot(): Promise<{ child: import('node:child_process').ChildProcessWithoutNullStreams; cwd: string }> {
  workdir = await mkdtemp(join(tmpdir(), 'jsonrpc-demo-pkg-'))
  const cwd = workdir
  const configPath = join(cwd, 'cordis.yml')
  await writeFile(configPath, CORDIS_YML)

  const child = spawn(
    process.execPath,
    [
      '--import', tsxLoader,
      '--experimental-loader', tsxLoader,
      '--tsconfig', repoTsconfig,
      binScript,
      configPath,
    ],
    {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, DEEPSEEK_API_KEY: 'sk-test-dummy' },
    },
  )

  return { child, cwd }
}

describe('jsonrpc-demo Loader path', () => {
  it('boots the bin and responds to a JSON-RPC initialize request', async () => {
    const { child } = await boot()
    const stderr: string[] = []

    child.stderr.on('data', (chunk: Buffer) => {
      stderr.push(chunk.toString())
    })

    // Send a valid JSON-RPC initialize request
    const initializeRequest = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '0.1.0',
        capabilities: {},
        clientInfo: { name: 'dsh-test', version: '0.0.1' },
      },
    }) + '\n'

    const response = new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Timeout waiting for JSON-RPC response'))
      }, 15_000)

      let buffer = ''
      child.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString()
        // Look for a complete JSON-RPC response line
        if (buffer.includes('\n')) {
          clearTimeout(timeout)
          resolve(buffer)
        }
      })

      child.on('error', (err) => {
        clearTimeout(timeout)
        reject(err)
      })
    })

    child.stdin.write(initializeRequest)
    child.stdin.end()

    const output = await response
    expect(output).toContain('"jsonrpc"')
    expect(output).toContain('"id"')

    // Kill the child
    child.kill('SIGKILL')
  }, 20_000)

  it('exits with usage message when no config is provided', async () => {
    workdir = await mkdtemp(join(tmpdir(), 'jsonrpc-demo-usage-'))
    const cwd = workdir

    const child = spawn(
      process.execPath,
      [
        '--import', tsxLoader,
        '--experimental-loader', tsxLoader,
        '--tsconfig', repoTsconfig,
        binScript,
      ],
      {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, DEEPSEEK_API_KEY: 'sk-test-dummy' },
      },
    )

    const stderr: string[] = []
    child.stderr.on('data', (chunk: Buffer) => { stderr.push(chunk.toString()) })

    const exitCode = await new Promise<number | null>((resolve) => {
      child.on('exit', code => resolve(code))
      // Timeout fallback
      setTimeout(() => resolve(null), 10_000)
    })

    expect(exitCode).toBe(1)
    expect(stderr.join('')).toContain('usage')
  }, 15_000)
})
