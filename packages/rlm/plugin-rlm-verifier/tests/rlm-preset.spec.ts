import { afterEach, describe, expect, it } from 'vitest'
import { rmSync } from 'node:fs'
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
import type {} from '@deepseek-ai/dsh-agent-presets/types'

// The rlm preset composition lives under docs/recipes (dev-mode assembly
// recipe, deliberately outside the shipped app config roster).
const RLM_PRESET_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'docs', 'recipes', 'agent-presets')
// base for bare specifier resolution: the harness repo root.
const HARNESS_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..')

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

async function setup() {
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(HARNESS_ROOT).href + '/'
  await ctx.plugin(Loader)
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
  await ctx.plugin(AgentPresets, {
    default: 'standard',
    roots: [{ path: RLM_PRESET_ROOT, trust: 'system' }],
    includeUserRoot: false,
  })
  return { ctx }
}

describe('rlm preset', () => {
  it('discovers the rlm preset in the shipped roster', async () => {
    const { ctx } = await setup()
    const roster = await ctx.agentPresets.list()
    const rlm = roster.find(p => p.id === 'rlm')
    expect(rlm).toBeDefined()
    expect(rlm?.name).toBe('RLM 融合模式')
  })

  it('mounts rlm preset and registers ipython + verify tools', async () => {
    const { ctx } = await setup()
    const handle = await ctx.agents.create({
      sessionId: SessionId('sess-rlm'),
      setup: async (agentCtx: Context) => void await ctx.agentPresets.mount(agentCtx, 'rlm'),
    })
    const schemas = ctx.tools.schemas(handle.agent).map(s => s.name).sort()
    expect(schemas).toContain('ipython')
    expect(schemas).toContain('verify')
    expect(schemas).toContain('moa')
    await handle.dispose()
  })
})
