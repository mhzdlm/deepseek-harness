/**
 * item-8: the DSH_RLM_* / legacy PRIME_AGENT_* env compatibility shim.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { ENV_CODING_AGENT_DIR, ENV_KERNEL_PYTHON, rlmEnv } from '../src/env.ts'

const saved = new Map<string, string | undefined>()

function setEnv(name: string, value: string | undefined): void {
  if (!saved.has(name)) saved.set(name, process.env[name])
  // oxlint-disable-next-line typescript/no-dynamic-delete -- delete is the only way to remove a real env var
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

afterEach(() => {
  for (const [name, value] of saved) {
    // oxlint-disable-next-line typescript/no-dynamic-delete -- see setEnv
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  saved.clear()
})

describe('rlmEnv (item-8 env renaming)', () => {
  it('prefers the DSH_RLM_* name over the legacy one', () => {
    setEnv('DSH_RLM_KERNEL_PYTHON', '/new')
    setEnv('PRIME_AGENT_KERNEL_PYTHON', '/old')
    expect(rlmEnv(...ENV_KERNEL_PYTHON)).toBe('/new')
  })

  it('falls back to the legacy PRIME_AGENT_* name', () => {
    setEnv('PRIME_AGENT_KERNEL_PYTHON', '/old')
    expect(rlmEnv(...ENV_KERNEL_PYTHON)).toBe('/old')
  })

  it('returns undefined when no name in the chain is set', () => {
    expect(rlmEnv(...ENV_KERNEL_PYTHON)).toBeUndefined()
  })

  it('harness coding-agent-dir chain ends at PI_CODING_AGENT_DIR', () => {
    setEnv('DSH_RLM_CODING_AGENT_DIR', '/dsh')
    setEnv('PRIME_AGENT_CODING_AGENT_DIR', '/prime')
    setEnv('PI_CODING_AGENT_DIR', '/pi')
    expect(rlmEnv(...ENV_CODING_AGENT_DIR)).toBe('/dsh')
    setEnv('DSH_RLM_CODING_AGENT_DIR', undefined)
    expect(rlmEnv(...ENV_CODING_AGENT_DIR)).toBe('/prime')
    setEnv('PRIME_AGENT_CODING_AGENT_DIR', undefined)
    expect(rlmEnv(...ENV_CODING_AGENT_DIR)).toBe('/pi')
  })
})
