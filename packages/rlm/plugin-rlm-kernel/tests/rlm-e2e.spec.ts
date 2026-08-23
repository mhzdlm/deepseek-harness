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
import SubagentRuntime, { type SubagentRunEndInfo } from '@deepseek-ai/dsh-subagent'
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

  it('recurses rlm.run two levels deep (grandchild spawned from a child)', async () => {
    const { ctx } = await setup()
    const agent = ctx.agentLoop.create(SessionId('rlm-e2e-recursive'), {
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
    })

    // The parent spawns a child whose task is to itself recurse via rlm.run.
    // This is the "R" in RLM: recursive subagent depth, currently untested.
    // The child's instruction is embedded with JSON.stringify so it arrives as
    // a correctly-quoted literal in BOTH the Python the parent runs and the
    // prompt the child receives (hand-escaped quotes were reliably mangled by
    // the model, making this test flaky without exercising the recursion).
    const grandchildCode =
      'import rlm as _r\n' +
      "h = await _r.rlm.run('reply with exactly OK')\n" +
      "print('GRANDCHILD_ID:', h.rlm_child_id)"
    const childPrompt =
      'Use the ipython tool to run exactly this Python code, then print the GRANDCHILD_ID:\n\n' +
      '```python\n' + grandchildCode + '\n```'

    agent.followup(createUserMessage({
      content: [{
        type: 'text',
        text:
          'Use the ipython tool to run exactly this Python code, then report the CHILD_ID it printed:\n\n'
          + '```python\n'
          + `h1 = await rlm.run(${JSON.stringify(childPrompt)})\n`
          + "print('CHILD_ID:', h1.rlm_child_id)\n"
          + '```',
      }],
      source: { kind: 'user' },
    }))

    // Collect terminal events from the start (a subagent may end before we get
    // around to waiting on it, so a late-registered listener would miss it).
    // The event is 'subagent/end'; its payload is a flat SubagentRunEndInfo
    // whose child-session id field is `.id` (not `.sessionId`).
    const ended = new Map<string, SubagentRunEndInfo>()
    ctx.on('subagent/end', (info) => {
      ended.set(String(info.id), info)
    })

    const waitForEnd = async (id: string, ms: number, what: string) => {
      const deadline = Date.now() + ms
      while (Date.now() < deadline) {
        if (ended.has(id)) return ended.get(id)
        await new Promise(resolve => setTimeout(resolve, 2_000))
      }
      throw new Error(`${what} did not end in time`)
    }

    await waitForIdle(ctx, agent)

    // The parent idles as soon as its rlm.run handle returns; the intermediate
    // agent then runs asynchronously (its kernel provision + nested rlm.run
    // take real time). Poll the descendant tree until the grandchild appears,
    // so a slow-but-correct recursion is not mistaken for a missing one.
    // SubagentDescendantListEntry's session-id field is `.id` (not `.sessionId`).
    let grandchildren: { id: string }[] = []
    const deadline = Date.now() + 90_000
    while (Date.now() < deadline) {
      const descendants = await ctx.subagents.listDescendants(agent.session.id)
      grandchildren = descendants.filter(d => d.kind === 'child' && d.depth >= 2) as { id: string }[]
      if (grandchildren.length > 0) break
      await new Promise(resolve => setTimeout(resolve, 2_000))
    }
    expect(grandchildren.length).toBeGreaterThan(0)

    // Verify result back-flow: the grandchild must end with a result, and the
    // child must receive the subagent-end notice (i.e., the recursion's
    // "async send-back" actually worked, not just that the handle was created).
    const grandchildId = grandchildren[0]!.id
    const grandchildSession = ctx.sessions.get(grandchildId)
    expect(grandchildSession).toBeDefined()
    const grandchildEnd = await waitForEnd(grandchildId, 120_000, 'grandchild')
    expect(grandchildEnd).toBeDefined()

    // The child should also end (after receiving the grandchild's result).
    const children = await ctx.subagents.listChildren(agent.session.id)
    expect(children.length).toBeGreaterThan(0)
    const childId = children[0]!.id
    const childEnd = await waitForEnd(childId, 60_000, 'child')
    expect(childEnd).toBeDefined()
  }, 300_000)
})
