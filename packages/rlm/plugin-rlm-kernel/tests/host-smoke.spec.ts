import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import * as PluginRlmKernel from '@deepseek-ai/dsh-plugin-rlm-kernel'
import * as PluginContinualHarness from '@deepseek-ai/dsh-plugin-continual-harness'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

async function setup() {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  const root = mkdtempSync(join(tmpdir(), 'dsh-rlm-host-'))
  roots.push(root)
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(PluginRlmKernel, { dataDir: root })
  await ctx.plugin(PluginContinualHarness, { dataDir: root })
  return { ctx, root }
}

describe('rlm plugin host mount', () => {
  it('mounts both plugins and registers the ipython tool', async () => {
    const { ctx } = await setup()
    expect(ctx.tools.get('ipython')).toBeDefined()
  })

  it('injects the harness overview into the assembled system prompt', async () => {
    const { ctx, root } = await setup()
    const sessionId = 'test-session'
    const harnessDir = join(root, 'session-artifacts', sessionId, 'harness')
    mkdirSync(harnessDir, { recursive: true })
    writeFileSync(
      join(harnessDir, 'harness_state.json'),
      JSON.stringify({
        schema: 1,
        entries: {
          memory: {
            m1: {
              id: 'm1', kind: 'memory', title: 'Remember X', content: 'X is important',
              path: 'general', scope: 'local', reference: {}, arguments: {}, metadata: {},
              source: 'agent', created_at: '2026-08-22T00:00:00Z', updated_at: '2026-08-22T00:00:00Z', version: 1,
            },
          },
        },
        refinements: [],
      }),
    )

    const assembly = await ctx.systemPrompt.assemble({ scope: { session: { id: sessionId } } })
    const text = renderPrompt(assembly)
    expect(text).toContain('Memories')
    expect(text).toContain('Remember X: X is important')
  })
})
