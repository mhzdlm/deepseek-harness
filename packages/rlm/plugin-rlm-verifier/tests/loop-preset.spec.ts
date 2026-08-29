import { describe, expect, it } from 'vitest'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Group from '@deepseek-ai/cordis-plugin-group'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import AgentPresets from '@deepseek-ai/dsh-agent-presets'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import SessionPersistence from '@deepseek-ai/dsh-session-persistence'
import Goal from '@deepseek-ai/dsh-goal'

// Mirrors rlm-preset.spec.ts but targets the `loop` preset (MODE B), asserting
// it discovers and mounts: rlm kernel + loop tool + read-only auditor subagent.
const RLM_PRESET_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'docs', 'recipes', 'agent-presets')
const HARNESS_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..')

async function setup() {
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(HARNESS_ROOT).href + '/'
  await ctx.plugin(Loader)
  const internal = ctx.loader.internal
  if (internal) {
    const wrapped = Object.create(internal) as typeof internal
    wrapped.import = async (specifier: string, base: string) => {
      if (specifier.startsWith('@deepseek-ai/')) {
        try {
          return await internal.import(specifier, base, {})
        } catch {
          return import(specifier)
        }
      }
      return internal.import(specifier, base, {})
    }
    ctx.loader.internal = wrapped
  }
  ctx.loader.builtins.include = Include
  ctx.loader.builtins.group = Group
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(TokenMeter)
  await ctx.plugin(SessionPersistence, [])
  await ctx.plugin(Goal)
  await ctx.plugin(AgentPresets, {
    default: 'standard',
    roots: [{ path: RLM_PRESET_ROOT, trust: 'system' }],
    includeUserRoot: false,
    includeShippedRoot: false,
    resolveModule: async (name: string) => {
      try { await import(name); return true } catch { return false }
    },
  })
  return { ctx }
}

describe('loop preset (MODE B)', () => {
  it('discovers the loop preset', async () => {
    const { ctx } = await setup()
    const roster = await ctx.agentPresets.list()
    const loop = roster.find(p => p.id === 'loop')
    expect(loop).toBeDefined()
    expect(loop?.name).toContain('Loop')
  })

  it('mounts loop preset and registers ipython + loop + auditor', async () => {
    const { ctx } = await setup()
    const handle = await ctx.agents.create({
      sessionId: SessionId('sess-loop'),
      setup: async (agentCtx: Context) => {
        await ctx.agentPresets.mount(agentCtx, 'loop')
      },
    })
    const schemas = ctx.tools.schemas(handle.agent).map(s => s.name).sort()
    expect(schemas).toContain('ipython')
    expect(schemas).toContain('loop')
    expect(schemas).toContain('verify')
    expect(schemas).toContain('moa')
    // auditor is a named subagent delegation tool
    expect(schemas).toContain('auditor')
    await handle.dispose()
  })

  it('loop persona routes the manager to call rlm() and auditor', async () => {
    const presetPath = join(RLM_PRESET_ROOT, 'loop', 'agent.cordis.yml')
    const text = (await import('node:fs')).readFileSync(presetPath, 'utf8')
    expect(text).toContain('calling `rlm()`')
    expect(text).toContain('PERIODIC COMPACTION')
    expect(text).toContain('toolFilter')
    expect(text).toContain('GATHER information')
    expect(text).toContain('AUDITING (auditor, OPTIONAL')
    expect(text).toContain('RESULT:')
    expect(text).toContain('subagent-settled')
  })
})
