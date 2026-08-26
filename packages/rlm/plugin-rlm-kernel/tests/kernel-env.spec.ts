/**
 * [local patch #14] unit tests for the shared kernel-env builders
 * (src/kernel-env.ts): the default-deny allowlist for kernel processes and the
 * deny-only credential scrub for bootstrap helper children.
 *
 * Both builders accept an injected source env, so every case regime (Windows
 * case-insensitive vs POSIX exact-case) is exercised deterministically on any
 * host — a worker thread's process.env may uppercase names, which would
 * otherwise pin the observable casing to the host. No LLM key, no venv.
 */
import { describe, expect, it } from 'vitest'
import { buildKernelEnv, buildScrubbedEnv } from '../src/kernel-env.ts'

/** Case-insensitive value lookup: the builder preserves source key casing. */
function pick(env: Record<string, string>, name: string): string | undefined {
  const entry = Object.entries(env).find(([k]) => k.toLowerCase() === name.toLowerCase())
  return entry?.[1]
}

describe('buildKernelEnv', () => {
  it('blocks credential-shaped variables before any allowlist check', () => {
    const env = buildKernelEnv(undefined, 'linux', {
      DEEPSEEK_API_KEY: 'sk-x',
      OPENAI_API_KEY: 'sk-y',
      ANTHROPIC_API_KEY: 'sk-z',
      DSH_SECRET_TOKEN: 't',
      PRIME_AGENT_LEGACY: 'l',
      CLAUDE_CODE_KEY: 'c',
    })
    expect(env.DEEPSEEK_API_KEY).toBeUndefined()
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.DSH_SECRET_TOKEN).toBeUndefined()
    expect(env.PRIME_AGENT_LEGACY).toBeUndefined()
    expect(env.CLAUDE_CODE_KEY).toBeUndefined()
  })

  it('keeps allowlisted runtime variables', () => {
    const env = buildKernelEnv(undefined, 'linux', {
      PATH: '/usr/bin',
      HOME: '/home/u',
      LANG: 'en_US.UTF-8',
      PYTHONPATH: '/opt/py',
    })
    expect(env.PATH).toBe('/usr/bin')
    expect(env.HOME).toBe('/home/u')
    expect(env.LANG).toBe('en_US.UTF-8')
    expect(env.PYTHONPATH).toBe('/opt/py')
  })

  it('drops unknown variables that are neither allowlisted nor blocked', () => {
    const env = buildKernelEnv(undefined, 'linux', { TOTALLY_UNRELATED_VAR: 'v' })
    expect(env.TOTALLY_UNRELATED_VAR).toBeUndefined()
  })

  it('does not admit credential-bearing tool namespaces via allowlist prefixes', () => {
    // UV_* and npm_config_* look like innocuous tool configuration but carry
    // secret variants; the kernel process must never receive them (uv itself
    // runs on the host side through buildScrubbedEnv).
    const env = buildKernelEnv(undefined, 'linux', {
      UV_PUBLISH_TOKEN: 'pypi-token',
      UV_CACHE_DIR: '/tmp/uvcache',
      npm_config__auth: 'base64-auth',
      NPM_CONFIG_REGISTRY: 'https://registry.example.com',
    })
    expect(env.UV_PUBLISH_TOKEN).toBeUndefined()
    expect(env.UV_CACHE_DIR).toBeUndefined()
    expect(env.npm_config__auth).toBeUndefined()
    expect(env.NPM_CONFIG_REGISTRY).toBeUndefined()
  })

  it('blocks tool-namespace credentials case-insensitively on Windows', () => {
    const env = buildKernelEnv(undefined, 'win32', { Uv_Publish_Token: 'pypi-token' })
    expect(pick(env, 'uv_publish_token')).toBeUndefined()
  })

  it('merges overrides without re-screening them', () => {
    const env = buildKernelEnv({ RLM_SESSION_DIR: '/tmp/artifacts' }, 'linux', {})
    expect(env.RLM_SESSION_DIR).toBe('/tmp/artifacts')
  })

  it('matches Windows names case-insensitively and keeps the original casing', () => {
    const env = buildKernelEnv(undefined, 'win32', {
      Path: 'C:\\Windows\\system32',
      SystemRoot: 'C:\\Windows',
      windir: 'C:\\Windows',
      ProgramFiles: 'C:\\Program Files',
      comspec: 'cmd.exe',
    })
    // Mixed-case Windows reality: PATH/SystemRoot/windir/ProgramFiles must all
    // survive regardless of the casing they carry in the source env.
    expect(pick(env, 'path')).toBe('C:\\Windows\\system32')
    expect(pick(env, 'systemroot')).toBe('C:\\Windows')
    expect(pick(env, 'windir')).toBe('C:\\Windows')
    expect(pick(env, 'programfiles')).toBe('C:\\Program Files')
    expect(pick(env, 'comspec')).toBe('cmd.exe')
    // Original key casing is preserved into the child environment.
    expect(env.Path).toBeDefined()
    expect(env.windir).toBeDefined()
  })

  it('blocks credential variables case-insensitively on Windows', () => {
    const env = buildKernelEnv(undefined, 'win32', { deepseek_api_key: 'sk-x', OpenAi_Key: 'sk-y' })
    expect(pick(env, 'deepseek_api_key')).toBeUndefined()
    expect(pick(env, 'openai_key')).toBeUndefined()
  })

  it('preserves POSIX exact-case semantics', () => {
    const env = buildKernelEnv(undefined, 'linux', {
      Path: '/mixed/case',
      DEEPSEEK_API_KEY: 'sk-upper',
      deepseek_api_key: 'sk-lower',
    })
    // 'Path' does not start with the allowlist prefix 'PATH' under exact-case
    // matching and is dropped. The lowercase credential lookalike evades the
    // case-sensitive blocklist prefixes but still dies at the default-deny
    // allowlist — defense in depth covers POSIX casing gaps.
    expect(env.Path).toBeUndefined()
    expect(env.PATH).toBeUndefined()
    expect(env.DEEPSEEK_API_KEY).toBeUndefined()
    expect(env.deepseek_api_key).toBeUndefined()
  })

  it('defaults platform and source to the running host when omitted', () => {
    // Smoke through the production call shape: whatever this host's regime is,
    // credentials never survive and PATH-family vars do (when present).
    const env = buildKernelEnv({ RLM_SESSION_DIR: '/tmp/x' })
    expect(env.RLM_SESSION_DIR).toBe('/tmp/x')
    for (const [key] of Object.entries(env)) {
      expect(key.toUpperCase().startsWith('DEEPSEEK_')).toBe(false)
    }
  })
})

describe('buildScrubbedEnv', () => {
  it('strips credential-shaped variables but keeps everything else', () => {
    const env = buildScrubbedEnv('linux', {
      DEEPSEEK_API_KEY: 'sk-x',
      AWS_SECRET_ACCESS_KEY: 's',
      PATH: '/usr/bin',
      MY_RANDOM_CONFIG: 'keep-me',
      UV_CACHE_DIR: '/tmp/uvcache',
      npm_config_registry: 'https://registry.example.com',
    })
    expect(env.DEEPSEEK_API_KEY).toBeUndefined()
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined()
    expect(env.PATH).toBe('/usr/bin')
    expect(env.MY_RANDOM_CONFIG).toBe('keep-me')
    // Helper children (uv installer, bootstrap steps) keep their tool config.
    expect(env.UV_CACHE_DIR).toBe('/tmp/uvcache')
    expect(env.npm_config_registry).toBe('https://registry.example.com')
  })

  it('scrubs case-insensitively on Windows', () => {
    const env = buildScrubbedEnv('win32', { Deepseek_Api_Key: 'sk-x', KeepMe: 'v' })
    expect(pick(env, 'deepseek_api_key')).toBeUndefined()
    expect(env.KeepMe).toBe('v')
  })
})
