import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as PluginRlmKernel from '@deepseek-ai/dsh-plugin-rlm-kernel'
import * as PluginContinualHarness from '@deepseek-ai/dsh-plugin-continual-harness'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

async function setup() {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  const root = mkdtempSync(join(tmpdir(), 'dsh-rlm-e2e-'))
  roots.push(root)
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(LlmDeepSeek)
  await ctx.plugin(PluginRlmKernel, { dataDir: root })
  await ctx.plugin(PluginContinualHarness, { dataDir: root })
  return { ctx, root }
}

describe.skipIf(!process.env.DEEPSEEK_API_KEY)('rlm with-key e2e', () => {
  it('drives the ipython tool through a real kernel', async () => {
    const { ctx } = await setup()
    const agent = ctx.agentLoop.create(SessionId('rlm-e2e'), {
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
    })

    agent.followup(createUserMessage({
      content: [{
        type: 'text',
        text: 'Use the ipython tool to execute `print(1+1)` and tell me the result you saw.',
      }],
      source: { kind: 'user' },
    }))
    await waitForIdle(ctx, agent)

    const calls = [...agent.session.events]
      .filter(e => e.type === 'tool/call')
      .map(e => e.data.name)
    expect(calls).toContain('ipython')
  }, 180_000)

  it('spawns a subagent from rlm.run inside the kernel', async () => {
    const { ctx } = await setup()
    const agent = ctx.agentLoop.create(SessionId('rlm-e2e-child'), {
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
    })

    agent.followup(createUserMessage({
      content: [{
        type: 'text',
        text: 'Use the ipython tool to run this Python code, then tell me the child id printed:\n\n'
          + '```python\n'
          + "handle = await rlm.run('do a small child task')\n"
          + "print('CHILD_ID:', handle.rlm_child_id)\n"
          + '```',
      }],
      source: { kind: 'user' },
    }))
    await waitForIdle(ctx, agent)

    const children = await ctx.subagents.listChildren(agent.session.id)
    expect(children.length).toBeGreaterThan(0)
  }, 180_000)
})
