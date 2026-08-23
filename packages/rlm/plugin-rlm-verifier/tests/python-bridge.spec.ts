/**
 * Unit tests for the verifier's subprocess environment scrub
 * (src/python-bridge.ts buildScrubbedSubprocessEnv).
 *
 * The scrub must match the kernel's credential boundary: same prefix families
 * (imported from the canonical CREDENTIAL_BLOCKLIST_PREFIXES, so no drift is
 * possible), case-insensitive matching on every platform. Sources are injected,
 * so no test mutates the host process.env.
 */
import { describe, expect, it } from 'vitest'
import { buildScrubbedSubprocessEnv, forwardProviderCredentials } from '../src/python-bridge.ts'
import { CREDENTIAL_BLOCKLIST_PREFIXES } from '@deepseek-ai/dsh-plugin-rlm-kernel/src/kernel-env.ts'

describe('buildScrubbedSubprocessEnv', () => {
  it('strips every canonical credential family regardless of casing', () => {
    const source: Record<string, string> = {}
    for (const prefix of CREDENTIAL_BLOCKLIST_PREFIXES) {
      source[prefix + '_KEY'] = 'secret'
    }
    // Mixed-case lookalikes: exact-case matching let these through on Windows.
    source.deepseek_api_key = 'lower'
    source.OpenAi_Key = 'mixed'
    const env = buildScrubbedSubprocessEnv(source)
    for (const key of Object.keys(source)) {
      expect(env[key]).toBeUndefined()
    }
  })

  it('keeps the broad environment a verifier subprocess needs', () => {
    const env = buildScrubbedSubprocessEnv({
      PATH: '/usr/bin',
      HTTPS_PROXY: 'http://proxy:8080',
      XDG_DATA_HOME: '/data',
      MY_RANDOM_CONFIG: 'keep-me',
    })
    expect(env.PATH).toBe('/usr/bin')
    expect(env.HTTPS_PROXY).toBe('http://proxy:8080')
    expect(env.XDG_DATA_HOME).toBe('/data')
    expect(env.MY_RANDOM_CONFIG).toBe('keep-me')
  })

  it('drops entries with undefined values', () => {
    const env = buildScrubbedSubprocessEnv({ MAY_BE_UNDEFINED: undefined, REAL: 'v' })
    expect(env.MAY_BE_UNDEFINED).toBeUndefined()
    expect(env.REAL).toBe('v')
  })

  it('defaults to the live process.env and never leaks credentials from it', () => {
    const env = buildScrubbedSubprocessEnv()
    for (const [key] of Object.entries(env)) {
      expect(CREDENTIAL_BLOCKLIST_PREFIXES.some(prefix => key.toUpperCase().startsWith(prefix))).toBe(false)
    }
  })
})

describe('forwardProviderCredentials', () => {
  it('forwards only the provider variables llm_verifier authenticates with', () => {
    const forwarded = forwardProviderCredentials({ DEEPSEEK_API_KEY: 'sk-real', OPENAI_BASE_URL: 'https://api', ANTHROPIC_API_KEY: 'no', PATH: '/bin' })
    expect(forwarded).toEqual({ DEEPSEEK_API_KEY: 'sk-real', OPENAI_BASE_URL: 'https://api' })
  })

  it('omits absent variables instead of writing undefined values', () => {
    expect(forwardProviderCredentials({})).toEqual({})
  })
})
