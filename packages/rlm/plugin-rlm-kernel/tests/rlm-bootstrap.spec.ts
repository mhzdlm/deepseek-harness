/**
 * Unit tests for the Python bootstrap injected into every fresh kernel
 * (`buildRlmBootstrapCode`): the base runtime import with its loud missing-
 * runtime fallback, and the deduplicated callable-skill wrapper section.
 */
import { describe, expect, it } from 'vitest'
import { buildRlmBootstrapCode } from '../src/rlm-bootstrap.ts'

describe('rlm bootstrap code', () => {
  it('base code wires the RLM runtime and fails loud when it is missing', () => {
    const code = buildRlmBootstrapCode()
    expect(code).toContain('rlm = _prime_agent_rlm_module.rlm')
    expect(code).toContain('_PrimeAgentMissingRlm')
    expect(code).toContain('DSH_RLM_KERNEL_PYTHON')
    // No skills → the wrapper section must be absent entirely.
    expect(code).not.toContain('_prime_agent_skill_name')
  })

  it('appends one import loop per unique skill import name', () => {
    const code = buildRlmBootstrapCode([
      { importName: 'weather' },
      { importName: 'calc' },
    ] as never)
    expect(code).toContain('for _prime_agent_skill_name in ["weather","calc"]:')
    expect(code).toContain('_prime_agent_wrap_skill_module')
  })

  it('deduplicates repeated skill import names', () => {
    const code = buildRlmBootstrapCode([
      { importName: 'weather' },
      { importName: 'weather' },
    ] as never)
    expect(code.match(/"weather"/g)).toHaveLength(1)
  })

  it('injects the transcript object backed by the session.query bridge', () => {
    const code = buildRlmBootstrapCode()
    expect(code).toContain('class _PrimeAgentTranscript')
    expect(code).toContain('transcript = _PrimeAgentTranscript()')
    expect(code).toContain('host_request("session.query", payload)')
    expect(code).toContain('async def tail(self, n=20, max_chars=2000):')
    expect(code).toContain('async def grep(self, pattern, limit=50, max_chars=2000):')
  })
})
