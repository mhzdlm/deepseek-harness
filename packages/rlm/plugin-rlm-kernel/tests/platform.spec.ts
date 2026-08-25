/**
 * Unit tests for src/util/platform.ts — the Windows-adaptation helpers that
 * vendored kernel code routes all signal/process/filesystem primitives through
 * ([local patch #13]). Platform branches are exercised deterministically by
 * stubbing `process.platform`; external effects are mocked so no real signal,
 * taskkill, or tasklist call ever fires. Filesystem behaviour uses real tmp
 * directories (junction creation needs no elevation on Windows).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as childProcess from 'node:child_process'
import * as nodeFs from 'node:fs'
import { mkdirSync, mkdtempSync, readFileSync, existsSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isPidAlive, killSignalSafe, safeRmDirSync, writeFileSecureSync } from '../src/util/platform.ts'
import { windowsBatchSpawnSpec } from '../src/vendor/kernel/bootstrap.ts'

// ESM namespaces are not configurable, so intercept at module resolution:
// both mocks delegate to the real implementation unless a test overrides them.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) }
})
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, writeFileSync: vi.fn(actual.writeFileSync) }
})

const REAL_PLATFORM = process.platform
const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  Object.defineProperty(process, 'platform', { value: REAL_PLATFORM, configurable: true })
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

/** Deterministically pin `process.platform` for the current test. */
function stubPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

function tmpRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-rlm-platform-'))
  roots.push(root)
  return root
}

describe('killSignalSafe', () => {
  it('on Windows ignores the signal argument and force-kills the tree via taskkill', () => {
    stubPlatform('win32')
    const spawnSync = vi.mocked(childProcess.spawnSync).mockReturnValue({ status: 0 } as never)
    expect(killSignalSafe(4242, 'SIGTERM')).toBe(true)
    expect(killSignalSafe(4242, 'SIGKILL')).toBe(true)
    expect(spawnSync).toHaveBeenCalledWith('taskkill', ['/F', '/PID', '4242', '/T'], expect.anything())
    expect(spawnSync).toHaveBeenCalledTimes(2)
  })

  it('on POSIX sends the requested signal via process.kill', () => {
    stubPlatform('linux')
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    expect(killSignalSafe(4242, 'SIGTERM')).toBe(true)
    expect(killSignalSafe(5151, 'SIGKILL')).toBe(true)
    expect(kill).toHaveBeenCalledWith(4242, 'SIGTERM')
    expect(kill).toHaveBeenCalledWith(5151, 'SIGKILL')
  })

  it('returns false when the POSIX kill fails', () => {
    stubPlatform('linux')
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('no such process'), { code: 'ESRCH' })
    })
    expect(killSignalSafe(9999)).toBe(false)
  })
})

describe('isPidAlive', () => {
  it('POSIX: successful zero-signal probe means alive', () => {
    stubPlatform('linux')
    vi.spyOn(process, 'kill').mockImplementation(() => true)
    expect(isPidAlive(4242)).toBe(true)
  })

  it('POSIX: EPERM still means alive', () => {
    stubPlatform('linux')
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('permission denied'), { code: 'EPERM' })
    })
    expect(isPidAlive(4242)).toBe(true)
  })

  it('POSIX: ESRCH means dead', () => {
    stubPlatform('linux')
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('no such process'), { code: 'ESRCH' })
    })
    expect(isPidAlive(4242)).toBe(false)
  })

  it('Windows: ambiguous probe falls back to tasklist and reports alive on a CSV match', () => {
    stubPlatform('win32')
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('access denied'), { code: 'EPERM' })
    })
    const spawnSync = vi
      .mocked(childProcess.spawnSync)
      .mockReturnValue({ stdout: '"python.exe","4242","Console","1","12,345 K"\n' } as never)
    expect(isPidAlive(4242)).toBe(true)
    expect(spawnSync).toHaveBeenCalledWith(
      'tasklist',
      ['/FI', 'PID eq 4242', '/NH', '/FO', 'CSV'],
      expect.objectContaining({ encoding: 'utf8' }),
    )
  })

  it('Windows: tasklist "INFO: No tasks" marker means dead', () => {
    stubPlatform('win32')
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('invalid'), { code: 'EINVAL' })
    })
    vi.mocked(childProcess.spawnSync).mockReturnValue({
      stdout: 'INFO: No tasks are running which match the specified criteria.\n',
    } as never)
    expect(isPidAlive(4242)).toBe(false)
  })
})

describe('safeRmDirSync', () => {
  it('removes a nested tree', async () => {
    const root = tmpRoot()
    const deep = join(root, 'a', 'b', 'c')
    mkdirSync(deep, { recursive: true })
    writeFileSync(join(deep, 'file.txt'), 'x')
    safeRmDirSync(join(root, 'a'))
    // Fresh files can stay briefly handle-locked on Windows; poll briefly.
    const deadline = Date.now() + 5_000
    while (existsSync(join(root, 'a')) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50))
      safeRmDirSync(join(root, 'a'))
    }
    expect(existsSync(join(root, 'a'))).toBe(false)
  }, 20_000)

  it('cuts a symlink/junction instead of recursing into its target', () => {
    const root = tmpRoot()
    const target = join(root, 'outside')
    mkdirSync(target)
    writeFileSync(join(target, 'precious.txt'), 'keep me')

    const tree = join(root, 'tree', 'inner')
    mkdirSync(tree, { recursive: true })
    const link = join(tree, 'link')
    symlinkSync(target, link, 'junction')

    safeRmDirSync(join(root, 'tree'))
    expect(existsSync(link)).toBe(false)
    expect(readFileSync(join(target, 'precious.txt'), 'utf8')).toBe('keep me')
  })

  it('silently no-ops on an already-missing directory', () => {
    const root = tmpRoot()
    expect(() => safeRmDirSync(join(root, 'never-existed'))).not.toThrow()
  })
})

describe('writeFileSecureSync', () => {
  it('applies the POSIX mode on Linux', () => {
    stubPlatform('linux')
    const root = tmpRoot()
    const file = join(root, 'conn.json')
    writeFileSecureSync(file, '{}', 0o600)
    expect(readFileSync(file, 'utf8')).toBe('{}')
  })

  it('on Windows creates the file while ignoring the mode parameter', () => {
    stubPlatform('win32')
    const writeMock = vi.mocked(nodeFs.writeFileSync)
    writeMock.mockClear()
    const root = tmpRoot()
    const file = join(root, 'conn.json')
    writeFileSecureSync(file, '{}', 0o600)
    // Mode argument omitted entirely on the win32 branch.
    expect(writeMock).toHaveBeenCalledWith(file, '{}')
    expect(writeMock).toHaveBeenCalledTimes(1)
  })
})

describe('windowsBatchSpawnSpec (#16)', () => {
  it('passes non-batch commands through untouched', () => {
    stubPlatform('linux')
    expect(windowsBatchSpawnSpec('C:\\venv\\Scripts\\python.exe', ['-c', 'import ipykernel'])).toEqual({
      command: 'C:\\venv\\Scripts\\python.exe',
      args: ['-c', 'import ipykernel'],
      verbatim: false,
    })

    stubPlatform('win32')
    // .exe targets spawn directly even on Windows.
    expect(windowsBatchSpawnSpec('uv.exe', ['pip', 'install'])).toEqual({
      command: 'uv.exe',
      args: ['pip', 'install'],
      verbatim: false,
    })
  })

  it('routes .bat shims through COMSPEC with a verbatim quoted command line', () => {
    stubPlatform('win32')
    const realComspec = process.env.COMSPEC
    process.env.COMSPEC = 'C:\\Windows\\system32\\cmd.exe'
    try {
      const spec = windowsBatchSpawnSpec('C:\\WINDOWS\\system32\\uv.bat', ['python', 'install', '3.11'])
      expect(spec.command).toBe('C:\\Windows\\system32\\cmd.exe')
      expect(spec.args[0]).toBe('/d')
      expect(spec.args[1]).toBe('/s')
      expect(spec.args[2]).toBe('/c')
      // Outer quotes are stripped by /s; the bare path needs no inner quoting.
      expect(spec.args[3]).toBe('"C:\\WINDOWS\\system32\\uv.bat python install 3.11"')
      expect(spec.verbatim).toBe(true)
    } finally {
      process.env.COMSPEC = realComspec
    }
  })

  it('quotes arguments containing spaces and matches batch extensions case-insensitively', () => {
    stubPlatform('win32')
    delete process.env.COMSPEC
    try {
      const spec = windowsBatchSpawnSpec('C:\\Program Files\\tool.CMD', ['--out', 'C:\\my dir\\out.json'])
      expect(spec.command).toBe('cmd.exe')
      // Inner quotes survive cmd's /s outer-pair strip; the spaced path and
      // spaced argument each carry their own pair.
      expect(spec.args[3]).toBe('""C:\\Program Files\\tool.CMD" --out "C:\\my dir\\out.json""')
    } finally {
      process.env.COMSPEC = undefined
    }
  })
})
