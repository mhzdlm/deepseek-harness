import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjection from '@deepseek-ai/dsh-session-projection'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { SessionId } from '@deepseek-ai/dsh-session'
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
  // alpha.3: agent-loop/agent-presets inject sessionProjections now.
  await ctx.plugin(SessionProjection)
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

  it('registers the /harness management command (item-5)', async () => {
    const { ctx } = await setup()
    const agent = ctx.agentLoop.create(SessionId('cmd-probe'), { provider: 'probe', model: 'probe' })
    expect(ctx.commands.find(agent, 'harness')?.name).toBe('harness')
    expect(ctx.commands.find(agent, 'refine')?.name).toBe('refine')
    // Phase A: /refine-rollback died with the reverse-snapshot pipeline (the
    // local harness file is a store projection now); /refine stays, frozen.
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

  it('renders global-scope entries from the cross-session store (P0 regression)', async () => {
    const { ctx, root } = await setup()
    // A prior session's kernel wrote a global_=True memory into the global
    // store via RLM_GLOBAL_HARNESS_STATE_DIR; a brand-new session (no local
    // file) must still see it in its prompt.
    const globalDir = join(root, 'global', 'harness')
    mkdirSync(globalDir, { recursive: true })
    writeFileSync(
      join(globalDir, 'harness_state.json'),
      JSON.stringify({
        schema: 1,
        entries: {
          memory: {
            gm1: {
              id: 'gm1', kind: 'memory', title: 'Global fact', content: 'The sky is teal',
              path: 'general', scope: 'global', reference: {}, arguments: {}, metadata: {},
              source: 'agent', created_at: '2026-08-22T00:00:00Z', updated_at: '2026-08-22T00:00:00Z', version: 1,
            },
          },
        },
        refinements: [],
      }),
    )

    const sessionId = 'fresh-session-no-local-state'
    const assembly = await ctx.systemPrompt.assemble({ scope: { session: { id: sessionId } } })
    const text = renderPrompt(assembly)
    expect(text).toContain('Memories')
    expect(text).toContain('[global]')
    expect(text).toContain('Global fact [global]: The sky is teal')
  })

  it('merges global and local entries into one overview (P0 regression)', async () => {
    const { ctx, root } = await setup()
    const sessionId = 'merge-session'
    const globalDir = join(root, 'global', 'harness')
    const localDir = join(root, 'session-artifacts', sessionId, 'harness')
    mkdirSync(globalDir, { recursive: true })
    mkdirSync(localDir, { recursive: true })
    writeFileSync(
      join(globalDir, 'harness_state.json'),
      JSON.stringify({
        schema: 1,
        entries: {
          memory: {
            gm1: {
              id: 'gm1', kind: 'memory', title: 'Global fact', content: 'The sky is teal',
              path: 'general', scope: 'global', reference: {}, arguments: {}, metadata: {},
              source: 'agent', created_at: '2026-08-22T00:00:00Z', updated_at: '2026-08-22T00:00:00Z', version: 1,
            },
          },
        },
        refinements: [],
      }),
    )
    writeFileSync(
      join(localDir, 'harness_state.json'),
      JSON.stringify({
        schema: 1,
        entries: {
          memory: {
            lm1: {
              id: 'lm1', kind: 'memory', title: 'Local fact', content: 'Tea is hot',
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
    expect(text).toContain('Global fact [global]: The sky is teal')
    expect(text).toContain('Local fact: Tea is hot')
  })

  it('emits session/created when an agent is created (item-7 warmup hook)', async () => {
    const { ctx } = await setup()
    // The warmup listener (config.gated) subscribes to this event; verify the
    // hook point actually fires on agent creation. Combined with warmup.spec
    // (which proves warmUpSession provisions the kernel), this covers the
    // plugin-level wiring end to end.
    const created: string[] = []
    const dispose = ctx.on('session/created', session => created.push(String(session.id)))
    const agent = ctx.agentLoop.create(SessionId('warmup-probe'), { provider: 'probe', model: 'probe' })
    dispose()
    expect(created).toContain(String(agent.session.id))
  })

  it('disposes the session kernel when the session is disposed (FIX-6 wiring)', async () => {
    const { ctx } = await setup()
    const kernels = ctx.get('rlm.kernels')
    expect(kernels).toBeDefined()

    // Record which sessions the disposal sweep reclaims. The abort half of the
    // same listener (outstanding rlm.run children) is pinned behaviorally in
    // host-handlers.spec.ts; here we prove the plugin forwards the event to
    // both halves by observing the kernel-teardown side on the live registry.
    const disposed: string[] = []
    const registry = kernels as unknown as { disposeSession: (sid: string) => void }
    const original = registry.disposeSession.bind(registry)
    registry.disposeSession = (sid: string) => {
      disposed.push(sid)
      original(sid)
    }

    const agent = ctx.agentLoop.create(SessionId('dispose-probe'), { provider: 'probe', model: 'probe' })
    ctx.emit('session/disposed', agent.session)
    expect(disposed).toEqual([String(agent.session.id)])
  })
})
