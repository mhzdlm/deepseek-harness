/**
 * Phase B item 6: /refine lands through the judgment channel. The whitelist
 * criterion is deterministic (evidence locatable in the transcript); a
 * revised subject supersedes the old belief (mechanically voided), so the
 * projection renders only the latest revision.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { RlmStore, withBaseCriteria } from '@deepseek-ai/dsh-plugin-rlm-store'
import type { RlmScope } from '@deepseek-ai/dsh-plugin-rlm-store'
import { renderSessionProjection } from '../src/projection.ts'
import { runRefineChannelized } from '../src/refine.ts'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'refine-channel-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const TRANSCRIPT = [
  '[user] Remember that the quarterly report deadline moved to the 28th.',
  '[assistant] Noted — the deadline is the 28th, I will plan around it.',
].join('\n')

function fakeAgent() {
  return {
    session: {
      id: 'refine-session',
      deriveMessages: () => [
        { role: 'user', content: TRANSCRIPT.split('\n')[0] },
        { role: 'assistant', content: TRANSCRIPT.split('\n')[1] },
      ],
    },
  } as unknown as Parameters<typeof runRefineChannelized>[3]
}

describe('/refine through the judgment channel', () => {
  it('lands only evidence-locatable proposals; revision supersedes the old belief', async () => {
    const store = withBaseCriteria(new RlmStore(path.join(root, 'store')))
    const scope: RlmScope = { kind: 'session', id: 'refine-session' }
    const agent = fakeAgent()
    const signal = new AbortController().signal

    const proposals = [
      { kind: 'memory', title: 'Report deadline', content: 'The quarterly report deadline is the 28th.', evidence: 'deadline moved to the 28th' },
      { kind: 'memory', title: 'Hallucinated', content: 'The deadline is never.', evidence: 'this text appears nowhere in the transcript at all' },
    ]
    const ctx = {
      get: () => store,
      subagents: {
        start: async () => ({ result: Promise.resolve(JSON.stringify(proposals)) }),
      },
    } as unknown as Context

    const first = await runRefineChannelized(ctx, store, 'refine-session', agent, 'spawn', signal)
    expect(first.landed).toBe(1)
    expect(first.rejected).toBe(1)
    expect(first.text).toContain('rejected: evidence not locatable')
    const v1 = store.beliefs(scope)[0]!
    expect(v1.subject).toBe('harness:memory:report-deadline')
    expect(v1.criterionRef).toBe('crit/refine-whitelist')

    // A revised proposal on the same subject supersedes v1 mechanically.
    const revised = [
      { kind: 'memory', title: 'Report deadline', content: 'Deadline reaffirmed: the 28th, hard cutoff at noon.', evidence: 'deadline moved to the 28th' },
    ]
    const ctx2 = {
      get: () => store,
      subagents: { start: async () => ({ result: Promise.resolve(JSON.stringify(revised)) }) },
    } as unknown as Context
    const second = await runRefineChannelized(ctx2, store, 'refine-session', agent, 'spawn', signal)
    expect(second.landed).toBe(1)

    const active = store.beliefs(scope)
    expect(active).toHaveLength(1)
    expect(active[0]?.content).toContain('hard cutoff at noon')
    expect(store.getBelief(scope, v1.id)).toMatchObject({ status: 'voided' })

    // The projection renders only the latest revision.
    const projected = renderSessionProjection(store.view(scope))
    const entries = Object.values(projected.entries.memory ?? {})
    expect(entries.filter(e => e.title.includes('Report deadline'))).toHaveLength(1)
    expect(store.checkClosureInvariant(scope)).toEqual([])
  })

  it('an extractor that returns no JSON lands nothing', async () => {
    const store = withBaseCriteria(new RlmStore(path.join(root, 'store')))
    const ctx = {
      get: () => store,
      subagents: { start: async () => ({ result: Promise.resolve('I found nothing worth keeping.') }) },
    } as unknown as Context
    const outcome = await runRefineChannelized(ctx, store, 'refine-session', fakeAgent(), 'spawn', new AbortController().signal)
    expect(outcome.landed).toBe(0)
    expect(store.beliefs({ kind: 'session', id: 'refine-session' })).toHaveLength(0)
  })
})
