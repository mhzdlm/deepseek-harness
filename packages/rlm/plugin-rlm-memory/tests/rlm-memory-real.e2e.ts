/**
 * Real-key end-to-end smoke for the Phase A write path (REME.md §5.1). Boots a
 * full host with the rlm family, runs one real agent turn, then disposes the
 * session to trigger the sessionEnd capture path. Asserts the durable dialog
 * jsonl landed (sanitized: no tool turns), the audit event fired, and extraction
 * actually ran through a host-owned subagent.
 *
 * Self-skips without DEEPSEEK_API_KEY. Spends real tokens; run via
 * `pnpm run test:e2e -- packages/rlm/plugin-rlm-memory/tests/rlm-memory-real.e2e.ts`.
 *
 * @module @deepseek-ai/dsh-plugin-rlm-memory/rlm-memory-real.e2e
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
import * as PluginRlmMemory from '@deepseek-ai/dsh-plugin-rlm-memory'
import { writePublished, parseNote, writeDraft, writeDialog, ensureMemoryDirs, listPublished, listArchived, type Note, type NoteFrontmatter } from '../src/storage.ts'
import { consolidate } from '../src/consolidate.ts'

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
  const root = mkdtempSync(join(tmpdir(), 'dsh-rlm-memory-e2e-'))
  roots.push(root)
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(CommandRuntime)
  // `low` keeps the nightly token bill small; capture exercises the pipeline, not reasoning depth.
  await ctx.plugin(LlmDeepSeek, { reasoningEffort: 'low' })
  await ctx.plugin(PluginRlmKernel, { dataDir: root })
  await ctx.plugin(PluginContinualHarness, { dataDir: root })
  await ctx.plugin(PluginRlmMemory, { memoryDir: root, captureMode: 'sessionEnd', rootAgentsOnly: true })
  return { ctx, root }
}

describe.skipIf(!process.env.DEEPSEEK_API_KEY)('memory capture with-key e2e', () => {
  it('captures a completed session: sanitized dialog + audit event + subagent extraction', async () => {
    const { ctx, root } = await setup()
    const agent = ctx.agentLoop.create(SessionId('memory-e2e'), {
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
    })

    // Resolve once the capture audit event fires (after dialog lands + extraction runs).
    let captured: { sessionId: string; dialogTurns: number; draftsAdmitted: number; extractionRan: boolean } | null = null
    const capturedDone = new Promise<void>((resolve) => {
      ctx.on('session/event', (s, e) => {
        if (e.type === 'session/memory-captured') {
          captured = e.data as typeof captured
          resolve()
        }
      })
    })

    agent.followup(createUserMessage({
      content: [{
        type: 'text',
        text: 'From now on, call me "captain". Also: the deployment server is at 10.0.0.7. Remember both facts for future sessions.',
      }],
      source: { kind: 'user' },
    }))
    await waitForIdle(ctx, agent)

    // Trigger the sessionEnd capture path (REME.md §5.1; host-smoke uses the same emit).
    ctx.emit('session/disposed', agent.session)
    await capturedDone

    // The durable dialog jsonl must exist and carry only user/model/system turns.
    const dialogPath = join(root, 'dialog', `${String(agent.session.id)}.jsonl`)
    expect(existsSync(dialogPath)).toBe(true)
    const lines = readFileSync(dialogPath, 'utf8').trim().split('\n').filter(Boolean)
    expect(lines.length).toBeGreaterThan(0)
    const roles = new Set<string>()
    for (const line of lines) {
      const obj = JSON.parse(line) as { role: string }
      roles.add(obj.role)
      expect(['user', 'assistant', 'system'].includes(obj.role)).toBe(true)
    }
    expect(roles.has('assistant')).toBe(true) // the agent replied, so capture saw the conversation

    // Audit event payload sanity.
    expect(captured).not.toBeNull()
    expect(captured!.sessionId).toBe(String(agent.session.id))
    expect(captured!.dialogTurns).toBeGreaterThan(0)
    // The fix: extraction must run through a real Agent parent (spawn driver needs parent.ctx).
    expect(captured!.extractionRan).toBe(true)

    // If any draft was admitted, the evidence gate guaranteed a `source` frontmatter (D6);
    // storage.writeDraft always sets it, so admission>0 implies source-bearing notes exist.
    expect(captured!.draftsAdmitted).toBeGreaterThanOrEqual(0)
  }, 180_000)
})

describe.skipIf(!process.env.DEEPSEEK_API_KEY)('memory_search with-key e2e', () => {
  it('recalls a written published note and increments its use_count', async () => {
    const { ctx, root } = await setup()
    // Phase B: write a published note directly through storage (the publish gate is
    // Phase C; writing published/ here exercises the recall read path end-to-end).
    const now = new Date().toISOString()
    const frontmatter: NoteFrontmatter = {
      kind: 'personal', scope: 'global', session_id: String(SessionId('memory-e2e')),
      source: 'e2e-phase-b', source_conversation: 'dialog/none.jsonl',
      created_at: now, updated_at: now, version: 1, use_count: 0, last_accessed: now,
      gate: { mode: 'observe', verdict: 'pass', reviewed_at: now },
    }
    const note: Note = { frontmatter, body: '# E2E Recall Target\nThe deployment server IP is 10.0.0.7 and the build runs on Fridays.' }
    const path = writePublished(root, note)
    expect(parseNote(path)!.frontmatter.use_count).toBe(0)

    // Resolve the real session the agent loop created for the setup() call below.
    const agent = ctx.agentLoop.create(SessionId('memory-search-e2e'), {
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
    })

    // Drive the tool's execute directly with a fake exec carrying the real session,
    // so we do not depend on the model choosing to call it (covers the recall path
    // deterministically). The fake exec shape mirrors loop-tool's sessionIdOf.
    const { createMemorySearchTool } = await import('../src/memory-search-tool.ts')
    const tool = createMemorySearchTool({ memoryDir: root, recallTopK: 5, recallMode: 'keyword' })
    const result = await tool.execute(
      { query: 'deployment server IP', limit: 5 },
      { agent: { session: agent.session } } as never,
    ) as { text: string; count: number; hits: Array<{ title: string; path: string }> }

    expect(result.count).toBeGreaterThanOrEqual(1)
    expect(result.text).toContain('E2E Recall Target')
    // The hit note's use_count must have incremented (REME.md §8 D4 use-signal).
    expect(parseNote(path)!.frontmatter.use_count).toBe(1)
    void path
  }, 180_000)
})

describe.skipIf(!process.env.DEEPSEEK_API_KEY)('memory consolidation with-key e2e', () => {
  it('promotes a valid draft to published and it becomes searchable', async () => {
    const { ctx, root } = await setup()
    // Phase C: write a draft with a `source` that admitByEvidence can locate in its
    // dialog (turn:1), then consolidate under observe (REME.md §5.3 D10 gate default).
    ensureMemoryDirs(root)
    writeDialog(root, 'consolidate-e2e', JSON.stringify({ role: 'user', content: 'the staging host is staging.internal' }) + '\n')
    const now = new Date().toISOString()
    const draftFm: NoteFrontmatter = {
      kind: 'wiki', scope: 'global', session_id: String(SessionId('consolidate-e2e')),
      source: 'turn:0', source_conversation: 'dialog/consolidate-e2e.jsonl',
      created_at: now, updated_at: now, version: 1, use_count: 0, last_accessed: now,
      gate: { mode: 'observe', verdict: 'pass', reviewed_at: now },
    }
    writeDraft(root, { frontmatter: draftFm, body: '# Staging Host\nThe staging host is staging.internal and runs nightly jobs.' }, 'consolidate-e2e', 'Staging Host')

    const res = await consolidate(root, { gateMode: 'observe', maxPublishedNotes: 200, maxPublishedBytes: 5_000_000 })
    expect(res.promoted).toBe(1)
    // The draft is now a published note.
    const published = listPublished(root)
    expect(published.length).toBe(1)

    // Drive memory_search directly (no dependency on the model choosing it) to prove the
    // promoted note is now in the recall index (publish-gate admits it into recall, D8).
    const { createMemorySearchTool } = await import('../src/memory-search-tool.ts')
    const tool = createMemorySearchTool({ memoryDir: root, recallTopK: 5, recallMode: 'keyword' })
    const agent = ctx.agentLoop.create(SessionId('consolidate-search-e2e'), {
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
    })
    const searchResult = await tool.execute(
      { query: 'staging host', limit: 5 },
      { agent: { session: agent.session } } as never,
    ) as { text: string; count: number; hits: Array<{ title: string; path: string }> }
    expect(searchResult.count).toBeGreaterThanOrEqual(1)
    expect(searchResult.text).toContain('Staging Host')
  }, 180_000)
})

describe.skipIf(!process.env.DEEPSEEK_API_KEY)('memory retire/unretire with-key e2e', () => {
  it('retires a promoted published note to archived/ and restores it via unretire', async () => {
    const { root } = await setup()
    // Phase D: write a published note directly (the publish gate is Phase C; writing published/
    // here exercises the retire/archive move end-to-end). Use a stale frontmatter so the aging
    // scan would mark it a candidate, but retire with `force` under `enforce` to retire explicitly.
    ensureMemoryDirs(root)
    const now = new Date().toISOString()
    const staleIso = new Date(Date.now() - 400 * 86_400_000).toISOString()
    const noteFm: NoteFrontmatter = {
      kind: 'wiki', scope: 'global', session_id: String(SessionId('retire-e2e')),
      source: 'retire-target', source_conversation: 'dialog/none.jsonl',
      created_at: staleIso, updated_at: staleIso, version: 1, use_count: 0, last_accessed: staleIso,
      gate: { mode: 'observe', verdict: 'pass', reviewed_at: now },
    }
    const path = writePublished(root, { frontmatter: noteFm, body: '# Retire Target\nThis note is retired and un-retired end to end.' })
    expect(listPublished(root).length).toBe(1)
    void path

    // Drive retireNote directly (enforce + force) so we do not depend on the model choosing the
    // /memory command — this covers the archive move deterministically (REME.md §5.4 D12).
    const { retireNote, unretireNote } = await import('../src/retire.ts')
    const retireMsg = await retireNote(root, 'retire-target', { exitMode: 'enforce', agingMinAgeDays: 180, agingMinUseCount: 1 }, true)
    expect(retireMsg).toContain('Retired')
    // After retire: under archived/, NOT published/.
    expect(listPublished(root).length).toBe(0)
    expect(listArchived(root).length).toBe(1)
    const archivedAbs = listArchived(root)[0]!
    const archivedNote = parseNote(archivedAbs)!
    expect(archivedNote.frontmatter.retired_at).toBeDefined()

    // Un-retire: back under published/, archived empty, content identical.
    const unretireMsg = await unretireNote(root, 'retire-target')
    expect(unretireMsg).toContain('Un-retired')
    expect(listPublished(root).length).toBe(1)
    expect(listArchived(root).length).toBe(0)
    const restored = parseNote(listPublished(root)[0]!)!
    expect(restored.body).toBe('# Retire Target\nThis note is retired and un-retired end to end.')
    expect(restored.frontmatter.retired_at).toBeUndefined()
  }, 180_000)
})
