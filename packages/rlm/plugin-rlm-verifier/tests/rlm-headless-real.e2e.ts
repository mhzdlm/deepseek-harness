/**
 * Headless e2e for the `rlm` agent preset against the real DeepSeek provider.
 *
 * Verifies three capabilities assembled into the rlm recipe
 * (docs/recipes/agent-presets/rlm/agent.cordis.yml):
 *
 *   1. compaction preserves the rlm kernel's Python state (dill snapshot is
 *      independent of the compacted conversation transcript),
 *   2. schedule re-enters the session at its due time,
 *   3. goal drives persistent same-session autonomous continuation.
 *
 * Each `it` is independent and guarded by `skipIf(!process.env.DEEPSEEK_API_KEY)`.
 * Real model calls set generous timeouts; a single failure does not block the others.
 */
import { rmSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// The test:e2e vitest config loads the repo-root `.env` (DEEPSEEK_API_KEY)
// before this module is evaluated, so the skipIf guard below sees the key.
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Group from '@deepseek-ai/cordis-plugin-group'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import AgentPresets from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-agent-presets/types'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import Goal from '@deepseek-ai/dsh-goal'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as SessionCheckpointPolicy from '@deepseek-ai/dsh-session-checkpoint-policy'
import * as GoalRoundDriver from '@deepseek-ai/dsh-goal-round-driver'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

// Ensure the repo-root .env (DEEPSEEK_API_KEY) is visible. The test:e2e vitest
// config also calls process.loadEnvFile, but fall back to manual parsing so the
// skipIf guard below always sees a locally-present key regardless of platform
// pathname quirks. Never print the value.
{
  const envPath = join(process.cwd(), '.env')
  if (!process.env.DEEPSEEK_API_KEY && existsSync(envPath)) {
    const text = readFileSync(envPath, 'utf8')
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
      const key = m?.[1]
      const value = m?.[2]
      if (key !== undefined && value !== undefined && process.env[key] === undefined) {
        process.env[key] = value.replace(/^["']|["']$/g, '')
      }
    }
  }
}

// The rlm preset composition lives under docs/recipes (dev-mode assembly recipe).
const RLM_PRESET_ROOT = join(
  fileURLToPath(import.meta.url),
  '..', '..', '..', '..', '..', 'docs', 'recipes', 'agent-presets',
)
const HARNESS_ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..')
const COMPACT_CONTEXT_WINDOW = 6000

const disposers: Array<() => void> = []
afterEach(() => {
  while (disposers.length) {
    const d = disposers.pop()!
    try { d() } catch { /* best-effort */ }
  }
})

/** Resolve one idle/running boundary for an agent. */
function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
    if (agent.status === 'idle') {
      dispose()
      resolve()
    }
  })
}

async function setup(): Promise<{ ctx: Context; workdir: string }> {
  const workdir = join(process.cwd(), '.tmp-rlm-headless-e2e-' + process.pid + '-' + Date.now())
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
  // Durable JSONL persistence: schedule preflight flush needs sessionPersistence.
  // The abstract @deepseek-ai/dsh-session-persistence service is provided by the
  // concrete JSONL backend below; loading both would double-register it.
  await ctx.plugin(JsonlSessionPersistence, { root: join(workdir, '.sessions') })
  await ctx.plugin(SessionCheckpointPolicy)
  await ctx.plugin(Goal)
  // Real DeepSeek adapter with a small context window so compaction pressure fires.
  await ctx.plugin(LlmDeepSeek, {
    models: [{ id: 'deepseek-v4-flash', contextWindow: COMPACT_CONTEXT_WINDOW }],
  })
  // Goal-round driver: automatic same-session continuation (not in the recipe).
  await ctx.plugin(GoalRoundDriver)
  await ctx.plugin(AgentPresets, {
    default: 'standard',
    roots: [{ path: RLM_PRESET_ROOT, trust: 'system' }],
    includeUserRoot: false,
    includeShippedRoot: false,
    resolveModule: async (name: string) => {
      try {
        await import(name)
        return true
      } catch {
        return false
      }
    },
  })
  disposers.push(() => {
    try { rmSync(workdir, { recursive: true, force: true }) } catch { /* ignore */ }
  })
  return { ctx, workdir }
}

/** Create one rlm agent mounting the `rlm` preset on the given session id. */
async function createRlmAgent(
  ctx: Context,
  sessionId: string,
  _workdir: string,
): Promise<AgentHandle> {
  const handle = await ctx.agentLoop.createAgent(ctx, {
    sessionId: SessionId(sessionId),
    agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    setup: async (agentCtx: Context) => {
      await ctx.agentPresets.mount(agentCtx, 'rlm')
    },
  })
  return handle
}

function hasType(events: readonly SessionEvent[], type: string): boolean {
  return events.some(e => e.type === type)
}

describe.skipIf(!process.env.DEEPSEEK_API_KEY)('rlm headless e2e (real deepseek-official)', () => {
  it('compaction preserves the rlm kernel Python state across a real session', async () => {
    const { ctx, workdir } = await setup()
    disposers.push(() => { void ctx.fiber.dispose() })
    const handle = await createRlmAgent(ctx, 'e2e-compaction-kernel', workdir)
    const agent = handle.agent

    // 1) Seed kernel state through the persistent IPython kernel.
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Use the ipython tool to run exactly: x = 42; print(x)' }],
      source: { kind: 'user' },
    }))
    await waitForIdle(ctx, agent)
    const kernelUsed = hasType(agent.session.events, 'session/kernel-snapshot')
      || agent.session.events.some(e => e.type === 'tool/call' && (e.data as { name?: string }).name === 'ipython')
    expect(kernelUsed).toBe(true)

    // 2) Grow the transcript with large ipython outputs until the automatic
    //    pressure compaction fires (compaction-basic watches agent/pre-step).
    //    The kernel's dill snapshot is independent of this transcript, so the
    //    seeded `x` must survive regardless.
    let compactionStarted = false
    for (let i = 0; i < 4 && !compactionStarted; i++) {
      agent.followup(createUserMessage({
        content: [{
          type: 'text',
          text: 'Use the ipython tool to print a large block of text (at least 4000 lines, e.g. '
            + 'print("\\n".join(f"line {n}" for n in range(4000)))). This is just to grow the '
            + 'transcript; do not assign x.',
        }],
        source: { kind: 'user' },
      }))
      await waitForIdle(ctx, agent)
      compactionStarted = agent.session.events.some(e => e.type === 'compaction/start')
    }

    // 3) Read kernel state AFTER compaction; it must survive independent of the transcript.
    agent.followup(createUserMessage({
      content: [{
        type: 'text',
        text: 'Use the ipython tool to run exactly: print("x is", x). Do not reassign x; just read it.',
      }],
      source: { kind: 'user' },
    }))
    await waitForIdle(ctx, agent)

    const events = [...agent.session.events]
    // A compaction pair must have occurred in this session.
    const starts = events.filter(e => e.type === 'compaction/start')
    const ends = events.filter(e => e.type === 'compaction/end')
    expect(starts.length).toBeGreaterThan(0)
    expect(ends.length).toBe(starts.length)

    // The kernel must still report x == 42 after compaction.
    const ipythonResults = events.filter(e => e.type === 'tool/result')
    const merged = ipythonResults
      .map(e => JSON.stringify((e.data as { result?: unknown }).result ?? e.data))
      .join('\n')
    expect(merged).toMatch(/x is[^\n]*42/)
    await handle.dispose()
  }, 240_000)

  it('schedule re-enters the rlm session at its due time', async () => {
    const { ctx, workdir } = await setup()
    disposers.push(() => { void ctx.fiber.dispose() })
    const handle = await createRlmAgent(ctx, 'e2e-schedule', workdir)
    const agent = handle.agent

    // Ask the model to register a short one-shot reminder.
    agent.followup(createUserMessage({
      content: [{
        type: 'text',
        text: 'Call schedule_create with after_seconds=15 and prompt "say: schedule fired". '
          + 'Then stop; do not keep the turn open. When the reminder fires, reply with the reminder text.',
      }],
      source: { kind: 'user' },
    }))
    await waitForIdle(ctx, agent)

    const created = agent.session.events.some(
      e => e.type === 'schedule/change' && (e.data as { operation?: string }).operation === 'create',
    )
    expect(created).toBe(true)

    // Wait (poll) for the runtime to re-enter the session at the due time.
    // The schedule runtime dispatches a `schedule/change` with operation 'dispatch'
    // (and re-follows up the agent) once the one-shot fires.
    const deadline = Date.now() + 40_000
    let dispatched = false
    while (Date.now() < deadline) {
      if (agent.session.events.some(
        e => e.type === 'schedule/change' && (e.data as { operation?: string }).operation === 'dispatch',
      )) {
        dispatched = true
        break
      }
      await new Promise(r => setTimeout(r, 1000))
    }
    expect(dispatched).toBe(true)
    await handle.dispose()
  }, 120_000)

  it('goal drives persistent same-session autonomous continuation', async () => {
    const { ctx, workdir } = await setup()
    disposers.push(() => { void ctx.fiber.dispose() })
    const handle = await createRlmAgent(ctx, 'e2e-goal', workdir)
    const agent = handle.agent

    // Ask the model to create a goal that keeps the session working.
    agent.followup(createUserMessage({
      content: [{
        type: 'text',
        text: 'Create one same-session goal: "Count up from 1, and on each autonomous continuation print the '
          + 'next integer, stopping after you have printed 3." Use create_goal, then begin by printing 1. '
          + 'The goal-round driver will continue you automatically.',
      }],
      source: { kind: 'user' },
    }))
    await waitForIdle(ctx, agent)

    const goalCreated = agent.session.events.some(
      e => e.type === 'goal/change' && (e.data as { operation?: string }).operation === 'create',
    )
    expect(goalCreated).toBe(true)

    // The goal-round driver should arm and follow up additional rounds. Detect a
    // user/message injected with a goal continuation source (kind === 'goal').
    const deadline = Date.now() + 60_000
    let continued: SessionEvent | undefined
    while (Date.now() < deadline) {
      continued = agent.session.events.find((e) => {
        if (e.type !== 'user/message') return false
        const src = (e.data as { source?: { kind?: string; round?: number } }).source
        return src?.kind === 'goal' && (src.round ?? 0) > 0
      })
      if (continued !== undefined) break
      await new Promise(r => setTimeout(r, 1000))
    }
    expect(continued).toBeDefined()
    const src = (continued?.data as { source?: { kind?: string; round?: number } }).source
    expect(src?.kind).toBe('goal')
    await handle.dispose()
  }, 120_000)
})
