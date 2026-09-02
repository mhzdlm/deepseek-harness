/**
 * Loop tool tests against the unified store (Phase A authority flip): begin /
 * record write action boundaries and check judgments; only clean audits land
 * beliefs; the store view (beliefs + actions) rebuilds exactly.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { withBaseCriteria, RlmStore } from '@deepseek-ai/dsh-plugin-rlm-store'
import { createLoopTool, type LoopToolResult } from '../src/loop-tool.ts'

const CLEAN_REPORT = [
  'Status: complete',
  'Integrity: clean',
  'Contract audit: aligned',
  '',
  'Verified: file exists on disk with expected bytes.',
].join('\n')

const DIRTY_REPORT = [
  'Status: incomplete',
  'Integrity: clean',
  'Contract audit: aligned',
  '',
  'Missing: the report file.',
].join('\n')

let root: string

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'loop-tool-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function fakeExec(sid = 'sess-loop-1') {
  return {
    agent: { session: { id: sid } },
    signal: new AbortController().signal,
  }
}

async function call(
  tool: { execute: unknown },
  args: Record<string, unknown>,
  sid = 'sess-loop-1',
): Promise<LoopToolResult> {
  const execute = tool.execute as unknown as
    (args: Record<string, unknown>, exec: unknown) => Promise<LoopToolResult>
  return execute(args, fakeExec(sid))
}

describe('loop tool (store authority)', () => {
  it('begin appends an action boundary carrying task + contract', async () => {
    const store = withBaseCriteria(new RlmStore(root))
    const tool = createLoopTool({ store, maxRounds: 8 })

    const result = await call(tool, {
      action: 'begin',
      task: 'Write the report file.',
      contract: 'Report exists at report.md with three sections.',
    })

    expect(result.runId).toMatch(/^loop_/)
    expect(result.text).toContain('opened')
    const view = store.view({ kind: 'session', id: 'sess-loop-1' })
    expect(view.seq).toBe(1)
    expect(view.actions).toHaveLength(1)
    expect(view.actions[0]?.payload).toMatchObject({
      action: 'loop-begin',
      runId: result.runId,
      task: 'Write the report file.',
      contract: 'Report exists at report.md with three sections.',
    })
  })

  it('record lands a check judgment; a clean audit with a note becomes a belief', async () => {
    const store = withBaseCriteria(new RlmStore(root))
    const tool = createLoopTool({ store, maxRounds: 8 })
    const begin = await call(tool, { action: 'begin', task: 't', contract: 'c' })

    const good = await call(tool, {
      action: 'record',
      round: 2,
      route: 'cli',
      audit_report: CLEAN_REPORT,
      progress_note: 'report.md exists with the agreed sections.',
    })

    expect(good.accepted).toBe(true)
    expect(good.landed).toBe(true)
    expect(good.status).toBe('complete')

    const scope = { kind: 'session' as const, id: 'sess-loop-1' }
    const beliefs = store.beliefs(scope)
    expect(beliefs).toHaveLength(1)
    expect(beliefs[0]).toMatchObject({
      kind: 'procedural',
      grade: 'provisional',
      status: 'active',
      criterionRef: 'crit/loop-three-line-header',
      content: 'report.md exists with the agreed sections.',
      subject: begin.runId,
      lastVerified: { channel: 'loop-three-line-header' },
    })
    // Provenance anchors the judgment to the run: [begin boundary, record boundary].
    const judgment = store.view(scope).countsByType['rlm/judgment']
    expect(judgment).toBe(1)
    expect(store.view(scope).seq).toBe(3) // begin + record boundary + judgment
    expect(store.view(scope).actions).toHaveLength(2) // begin + record boundaries
  })

  it('a dirty verdict lands check-doubt and never becomes a belief', async () => {
    const store = withBaseCriteria(new RlmStore(root))
    const tool = createLoopTool({ store, maxRounds: 8 })
    await call(tool, { action: 'begin', task: 't', contract: 'c' })

    const result = await call(tool, {
      action: 'record',
      round: 1,
      route: 'cli',
      audit_report: DIRTY_REPORT,
      progress_note: 'should not land',
    })

    expect(result.accepted).toBe(false)
    expect(result.landed).toBe(false)
    expect(result.text).toContain('NOT trusted')
    const scope = { kind: 'session' as const, id: 'sess-loop-1' }
    expect(store.beliefs(scope)).toHaveLength(0)
    // The check-doubt still landed as a judgment event — density accounting
    // never mistakes a rejection for absence.
    expect(store.view(scope).countsByType['rlm/judgment']).toBe(1)
  })

  it('record refuses an unparseable header before writing anything', async () => {
    const store = withBaseCriteria(new RlmStore(root))
    const tool = createLoopTool({ store, maxRounds: 8 })
    await call(tool, { action: 'begin', task: 't' })

    const result = await call(tool, {
      action: 'record',
      round: 1,
      route: 'cli',
      audit_report: 'Looks fine to me!',
      progress_note: 'nope',
    })

    expect(result.accepted).toBe(false)
    expect(result.status).toBe('unparsed')
    expect(result.text).toContain('three-line header')
    // Nothing trusted, nothing written past the begin boundary.
    expect(store.view({ kind: 'session', id: 'sess-loop-1' }).seq).toBe(1)
  })

  it('duplicate rounds are refused without a second judgment', async () => {
    const store = withBaseCriteria(new RlmStore(root))
    const tool = createLoopTool({ store, maxRounds: 8 })
    await call(tool, { action: 'begin', task: 't', contract: 'c' })
    await call(tool, {
      action: 'record', round: 1, route: 'cli', audit_report: CLEAN_REPORT,
      progress_note: 'facts once',
    })

    const again = await call(tool, {
      action: 'record', round: 1, route: 'cli', audit_report: CLEAN_REPORT,
      progress_note: 'facts twice',
    })

    expect(again.status).toBe('duplicate')
    expect(store.beliefs({ kind: 'session', id: 'sess-loop-1' })).toHaveLength(1)
  })

  it('a clean verdict without a note warns that nothing landed', async () => {
    const store = withBaseCriteria(new RlmStore(root))
    const tool = createLoopTool({ store, maxRounds: 8 })
    await call(tool, { action: 'begin', task: 't', contract: 'c' })

    const result = await call(tool, {
      action: 'record', round: 1, route: 'cli', audit_report: CLEAN_REPORT,
    })

    expect(result.accepted).toBe(true)
    expect(result.landed).toBe(false)
    expect(result.text).toContain('no progress_note given')
    // check-pass landed as an event; no belief without a note.
    expect(store.beliefs({ kind: 'session', id: 'sess-loop-1' })).toHaveLength(0)
    expect(store.view({ kind: 'session', id: 'sess-loop-1' }).countsByType['rlm/judgment']).toBe(1)
  })

  it('route done is rejected unless the audit is clean', async () => {
    const store = withBaseCriteria(new RlmStore(root))
    const tool = createLoopTool({ store, maxRounds: 8 })
    await call(tool, { action: 'begin', task: 't', contract: 'c' })

    const done = await call(tool, {
      action: 'record', round: 3, route: 'done',
      audit_report: CLEAN_REPORT.replace('aligned', 'unknown'),
      progress_note: 'ignored',
    })

    expect(done.accepted).toBe(false)
    expect(done.text).toContain('Route done REJECTED')
    expect(done.text).not.toContain('VERIFIED progress')
  })

  it('status summarizes recorded rounds; record before begin throws', async () => {
    const store = withBaseCriteria(new RlmStore(root))
    const tool = createLoopTool({ store, maxRounds: 8 })

    await expect(call(tool, {
      action: 'record', round: 1, route: 'cli', audit_report: CLEAN_REPORT,
    })).rejects.toThrow(/no active run/i)

    await call(tool, { action: 'begin', task: 'Summarize files.', contract: 'c' })
    await call(tool, {
      action: 'record', round: 1, route: 'cli', audit_report: CLEAN_REPORT,
      progress_note: 'ok facts',
    })

    const status = await call(tool, { action: 'status' })
    expect(status.text).toContain('1 recorded rounds')
    expect(status.text).toContain('1 verified')
  })

  it('a second begin replaces the live run; both runs stay in the stream', async () => {
    const store = withBaseCriteria(new RlmStore(root))
    const tool = createLoopTool({ store, maxRounds: 8 })

    const first = await call(tool, { action: 'begin', task: 'first task', contract: 'c1' })
    await call(tool, {
      action: 'record', round: 1, route: 'cli', audit_report: CLEAN_REPORT,
      progress_note: 'round one facts',
    })

    const second = await call(tool, { action: 'begin', task: 'second task', contract: 'c2' })
    expect(second.runId).not.toBe(first.runId)
    expect(second.text).toContain(`Previous run ${first.runId} (1 recorded rounds) is replaced`)

    const status = await call(tool, { action: 'status' })
    expect(status.text).toContain('0 recorded rounds')

    const scope = { kind: 'session' as const, id: 'sess-loop-1' }
    const begins = store.view(scope).actions.filter(a => (a.payload as { action?: string }).action === 'loop-begin')
    expect(begins).toHaveLength(2)
    // The first run's belief stays durable in the stream — replaced runs do
    // not retroactively lose their verified progress.
    expect(store.beliefs(scope)).toHaveLength(1)
    expect(store.beliefs(scope)[0]?.subject).toBe(first.runId)
  })

  it('the store view (beliefs + actions) rebuilds exactly after loop activity', async () => {
    const store = withBaseCriteria(new RlmStore(root))
    const tool = createLoopTool({ store, maxRounds: 8 })
    await call(tool, { action: 'begin', task: 'rebuild me', contract: 'contract text' })
    await call(tool, {
      action: 'record', round: 1, route: 'cli', audit_report: CLEAN_REPORT,
      progress_note: 'durable facts',
    })
    await call(tool, {
      action: 'record', round: 2, route: 'cli', audit_report: DIRTY_REPORT,
      progress_note: 'not trusted',
    })

    const before = store.view({ kind: 'session', id: 'sess-loop-1' })
    const store2 = withBaseCriteria(new RlmStore(root))
    const after = await store2.ensureLoaded({ kind: 'session', id: 'sess-loop-1' })
    expect(after.beliefs).toEqual(before.beliefs)
    expect(after.actions).toEqual(before.actions)
    expect(after.seq).toBe(before.seq)
  })
})
