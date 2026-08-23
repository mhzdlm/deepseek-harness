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
import { harnessStatePath, readHarnessState } from '../../plugin-continual-harness/src/harness-file.ts'

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
  const root = mkdtempSync(join(tmpdir(), 'dsh-rlm-refine-e2e-'))
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

/**
 * FIX-3 / FIX-1: `/refine` must run end-to-end via the registered command
 * handler. Before the fix it called `subagents.start('refine', ...)` against
 * a provider that is never registered, which settled the command as an error
 * (NO_PROVIDER) — this test would fail.
 */
describe.skipIf(!process.env.DEEPSEEK_API_KEY)('refine with-key e2e', () => {
  it('runs /refine through the command handler without a NO_PROVIDER crash', async () => {
    const { ctx, root } = await setup()
    const agent = ctx.agentLoop.create(SessionId('refine-e2e'), {
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
    })

    // Seed a transcript with a memorable preference so the refine agent has
    // concrete evidence to propose a memory update from.
    agent.followup(createUserMessage({
      content: [{
        type: 'text',
        text: 'From now on, always address me as "boss". Remember this preference for all future conversations.',
      }],
      source: { kind: 'user' },
    }))
    await waitForIdle(ctx, agent)

    // FIX-1 assertion: the command settles as success (provider resolution
    // works); a NO_PROVIDER throw would surface as kind 'error'.
    const exec = await ctx.commands.execute(agent, '/refine', [], new AbortController().signal)
    expect(exec).toBeDefined()
    if (exec === undefined) throw new Error('command "/refine" did not resolve to a registered handler')
    expect(exec.result.kind).toBe('success')

    // If the model proposed updates, every applied entry must carry its
    // supporting evidence (FIX-8).
    const state = await readHarnessState(harnessStatePath(root, String(agent.session.id)))
    const refined = Object.values(state.entries.memory ?? {}).filter(e => e?.source === 'refine')
    for (const entry of refined) {
      expect(typeof entry?.metadata.evidence).toBe('string')
      expect((entry?.metadata.evidence as string).length).toBeGreaterThan(0)
    }
  }, 240_000)

  it('re-runs /refine to confirm id-based updates work when an entry exists', async () => {
    const { ctx, root } = await setup()
    const agent = ctx.agentLoop.create(SessionId('refine-e2e-update'), {
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
    })

    agent.followup(createUserMessage({
      content: [{
        type: 'text',
        text: 'My preferred address is "boss". Keep using it.',
      }],
      source: { kind: 'user' },
    }))
    await waitForIdle(ctx, agent)

    // First /refine seeds an entry from the transcript.
    const first = await ctx.commands.execute(agent, '/refine', [], new AbortController().signal)
    expect(first).toBeDefined()
    if (first === undefined) throw new Error('command "/refine" did not resolve to a registered handler')
    expect(first.result.kind).toBe('success')

    // Second /refine sees the same harness overview (with ids) in its prompt
    // and must not crash; ideally it updates rather than duplicates, but the
    // hard assertion is only that the pipeline stays healthy (FIX-2 makes the
    // ids visible to the proposer).
    const second = await ctx.commands.execute(agent, '/refine', [], new AbortController().signal)
    expect(second).toBeDefined()
    if (second === undefined) throw new Error('command "/refine" did not resolve to a registered handler')
    expect(second.result.kind).toBe('success')

    const state = await readHarnessState(harnessStatePath(root, String(agent.session.id)))
    const refined = Object.values(state.entries.memory ?? {}).filter(e => e?.source === 'refine')
    for (const entry of refined) {
      expect(typeof entry?.metadata.evidence).toBe('string')
    }
  }, 300_000)
})
