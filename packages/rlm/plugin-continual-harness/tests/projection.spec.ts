/**
 * The Phase A vertical slice, end to end: loop tool writes the store, the
 * projection listener re-renders harness_state.json, and the projected file
 * is a pure function of the store view (rebuild + one listener fire
 * reproduces it byte-for-byte).
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RlmStore, withBaseCriteria } from '@deepseek-ai/dsh-plugin-rlm-store'
import { harnessStatePath, readHarnessState } from '../src/harness-file.ts'
import { registerStoreProjection, renderSessionProjection } from '../src/projection.ts'

const CLEAN_REPORT = ['Status: complete', 'Integrity: clean', 'Contract audit: aligned'].join('\n')

let root: string

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'harness-projection-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

// The projection write is fire-and-forget (latest-wins); tests await a macro
// tick so the listener's write lands before asserting.
async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 50))
}

describe('store → harness projection', () => {
  it('loop activity renders contracts and titled beliefs into the projected file', async () => {
    const store = withBaseCriteria(new RlmStore(path.join(root, 'store')))
    registerStoreProjection(store, root)

    const { createLoopTool } = await import('@deepseek-ai/dsh-plugin-rlm-loop')
    const tool = createLoopTool({ store, maxRounds: 8 })
    const exec = { agent: { session: { id: 'sess-proj-1' } }, signal: new AbortController().signal }
    const execute = tool.execute as unknown as
      (args: Record<string, unknown>, exec: unknown) => Promise<{ runId?: string; landed?: boolean }>

    const begin = await execute({ action: 'begin', task: 'Ship it.', contract: 'It ships cleanly.' }, exec)
    await execute({
      action: 'record', round: 1, route: 'cli', audit_report: CLEAN_REPORT,
      progress_note: 'the thing shipped with green tests',
    }, exec)
    await settle()

    const state = await readHarnessState(harnessStatePath(root, 'sess-proj-1'))
    const entries = Object.values(state.entries.memory ?? {})
    const byId = new Map(entries.map(e => [e.id, e]))

    const contract = byId.get(`${begin.runId}/contract`)
    expect(contract).toBeDefined()
    expect(contract?.content).toContain('It ships cleanly.')
    expect(contract?.source).toBe('rlm-store')

    const progress = entries.find(e => e.id !== `${begin.runId}/contract`)
    expect(progress).toBeDefined()
    expect(progress?.content).toBe('the thing shipped with green tests')
    expect(progress?.source).toBe('rlm-store:crit/loop-three-line-header')
    expect(progress?.scope).toBe('local')
    expect(progress?.kind).toBe('memory')
  })

  it('the projected file is rebuild-equivalent: a fresh store replay re-renders identical bytes', async () => {
    const storeDir = path.join(root, 'store')
    const store = withBaseCriteria(new RlmStore(storeDir))
    registerStoreProjection(store, root)

    const { createLoopTool } = await import('@deepseek-ai/dsh-plugin-rlm-loop')
    const tool = createLoopTool({ store, maxRounds: 8 })
    const exec = { agent: { session: { id: 'sess-rebuild' } }, signal: new AbortController().signal }
    const execute = tool.execute as unknown as
      (args: Record<string, unknown>, exec: unknown) => Promise<unknown>

    await execute({ action: 'begin', task: 't', contract: 'c' }, exec)
    await execute({
      action: 'record', round: 1, route: 'cli', audit_report: CLEAN_REPORT,
      progress_note: 'durable progress facts',
    }, exec)
    await settle()

    const livePath = harnessStatePath(root, 'sess-rebuild')
    const before = await readFile(livePath, 'utf8')

    // Rebuild from the stream in a fresh store instance, then re-render —
    // the projection must be identical (pure function of the view).
    const store2 = withBaseCriteria(new RlmStore(storeDir))
    const view = await store2.ensureLoaded({ kind: 'session', id: 'sess-rebuild' })
    const rendered = renderSessionProjection(view)
    expect(JSON.stringify(rendered, null, 2)).toBe(before)
  })

  it('untitled judgments (verify-style selections) stay out of the projection', async () => {
    const store = withBaseCriteria(new RlmStore(path.join(root, 'store')))
    registerStoreProjection(store, root)
    const scope = { kind: 'session' as const, id: 'sess-untitled' }

    await store.append(scope, 'rlm/observation', { kind: 'user-message' })
    await store.judge(scope, {
      criterionRef: 'crit/verify-eq31-tournament',
      verdict: 'selection',
      belief: { kind: 'declarative', content: 'candidate B wins (no title — not an overview entry)' },
      dataSupport: { summary: 'tournament winner' },
      provenance: { eventRange: [1, 1] },
    })
    await settle()

    const state = await readHarnessState(harnessStatePath(root, 'sess-untitled'))
    expect(Object.keys(state.entries.memory ?? {})).toHaveLength(0)
  })
})
