import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
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

interface RecordedEvent {
  name: string
  payload: unknown
}

function fakeExec(events: RecordedEvent[]) {
  return {
    agent: {
      session: {
        id: 'sess-loop-1',
        append: (name: string, payload: unknown) => {
          events.push({ name, payload })
        },
      },
    },
    signal: new AbortController().signal,
  }
}

async function call(tool: { execute: unknown }, args: Record<string, unknown>, events: RecordedEvent[]): Promise<LoopToolResult> {
  const execute = tool.execute as unknown as
    (args: Record<string, unknown>, exec: unknown) => Promise<LoopToolResult>
  return execute(args, fakeExec(events))
}

function harnessState(tmpDir: string): string {
  const file = join(tmpDir, 'session-artifacts', 'sess-loop-1', 'harness', 'harness_state.json')
  return readFileSync(file, 'utf8')
}

describe('loop tool', () => {
  it('begin opens a run and lands the contract as a memory entry', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'loop-tool-'))
    const events: RecordedEvent[] = []
    const tool = createLoopTool({ dataDir: dir, maxRounds: 8 })

    const result = await call(tool, {
      action: 'begin',
      task: 'Write the report file.',
      contract: 'Report exists at report.md with three sections.',
    }, events)

    expect(result.runId).toMatch(/^loop_/)
    expect(result.text).toContain('opened')
    expect(events).toHaveLength(1)
    expect(events[0]?.name).toBe('session/loop-start')
    const state = harnessState(dir)
    expect(state).toContain('"memory"')
    expect(state).toContain(`${result.runId}/contract`)
    expect(state).toContain('plugin-rlm-loop')
  })

  it('record lands verified progress only for a clean audit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'loop-tool-'))
    const events: RecordedEvent[] = []
    const tool = createLoopTool({ dataDir: dir, maxRounds: 8 })
    const begin = await call(tool, { action: 'begin', task: 't', contract: 'c' }, events)

    const good = await call(tool, {
      action: 'record',
      round: 2,
      route: 'cli',
      audit_report: CLEAN_REPORT,
      progress_note: 'report.md exists with the agreed sections.',
    }, events)

    expect(good.accepted).toBe(true)
    expect(good.landed).toBe(true)
    expect(good.status).toBe('complete')
    const state = harnessState(dir)
    expect(state).toContain(`${begin.runId}/round_002`)
    expect(state).toContain('[Verified via audit round 2: complete/clean/aligned]')

    const done = await call(tool, {
      action: 'record',
      round: 3,
      route: 'done',
      audit_report: CLEAN_REPORT.replace('aligned', 'unknown'),
      progress_note: 'ignored',
    }, events)

    expect(done.accepted).toBe(false)
    expect(done.landed).toBe(false)
    expect(done.text).toContain('Route done REJECTED')
    expect(done.text).not.toContain('VERIFIED progress')

    const roundEvents = events.filter(e => e.name === 'session/loop-round-done')
    expect(roundEvents).toHaveLength(2)
    expect(roundEvents[0]?.payload).toMatchObject({ accepted: true, landed: true })
    expect(roundEvents[1]?.payload).toMatchObject({ accepted: false, landed: false, route: 'done' })
  })

  it('record refuses an unparseable header instead of guessing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'loop-tool-'))
    const events: RecordedEvent[] = []
    const tool = createLoopTool({ dataDir: dir, maxRounds: 8 })
    await call(tool, { action: 'begin', task: 't' }, events)

    const result = await call(tool, {
      action: 'record',
      round: 1,
      route: 'cli',
      audit_report: 'Looks fine to me!',
      progress_note: 'nope',
    }, events)

    expect(result.accepted).toBe(false)
    expect(result.status).toBe('unparsed')
    expect(result.text).toContain('three-line header')
    expect(() => harnessState(dir)).toThrowError()
  })

  it('a dirty verdict never becomes progress even with a note', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'loop-tool-'))
    const events: RecordedEvent[] = []
    const tool = createLoopTool({ dataDir: dir, maxRounds: 8 })
    const begin = await call(tool, { action: 'begin', task: 't', contract: 'c' }, events)
    const before = harnessState(dir)

    const result = await call(tool, {
      action: 'record',
      round: 1,
      route: 'cli',
      audit_report: DIRTY_REPORT,
      progress_note: 'should not land',
    }, events)

    expect(result.accepted).toBe(false)
    expect(harnessState(dir)).toBe(before)
    expect(harnessState(dir)).not.toContain(`${begin.runId}/round_001`)
  })

  it('status summarizes recorded rounds; record before begin throws', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'loop-tool-'))
    const events: RecordedEvent[] = []
    const tool = createLoopTool({ dataDir: dir, maxRounds: 8 })

    await expect(call(tool, {
      action: 'record', round: 1, route: 'cli', audit_report: CLEAN_REPORT,
    }, events)).rejects.toThrow(/no active run/i)

    await call(tool, { action: 'begin', task: 'Summarize files.', contract: 'c' }, events)
    await call(tool, {
      action: 'record', round: 1, route: 'cli', audit_report: CLEAN_REPORT,
      progress_note: 'ok facts',
    }, events)

    const status = await call(tool, { action: 'status' }, events)
    expect(status.text).toContain('1 recorded rounds')
    expect(status.text).toContain('1 verified')
  })

  it('clean verdict without a note warns that nothing landed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'loop-tool-'))
    const events: RecordedEvent[] = []
    const tool = createLoopTool({ dataDir: dir, maxRounds: 8 })
    await call(tool, { action: 'begin', task: 't', contract: 'c' }, events)

    const result = await call(tool, {
      action: 'record', round: 1, route: 'cli', audit_report: CLEAN_REPORT,
    }, events)

    expect(result.accepted).toBe(true)
    expect(result.landed).toBe(false)
    expect(result.text).toContain('no progress_note given')
  })

  it('emits the round-done event with the full verdict payload', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'loop-tool-'))
    const events: RecordedEvent[] = []
    const tool = createLoopTool({ dataDir: dir, maxRounds: 8 })
    await call(tool, { action: 'begin', task: 'Ship the thing.', contract: 'It ships.' }, events)

    await call(tool, {
      action: 'record', round: 2, route: 'cli', audit_report: CLEAN_REPORT,
      progress_note: 'file verified on disk',
    }, events)

    expect(events.map(e => e.name)).toEqual(['session/loop-start', 'session/loop-round-done'])
    const start = (events[0] as { payload: Record<string, unknown> }).payload
    expect(start).toMatchObject({ runId: expect.stringMatching(/^loop_/), taskChars: 15, contractChars: 9 })

    const done = (events[1] as { payload: Record<string, unknown> }).payload
    expect(done).toMatchObject({
      runId: (events[0] as { payload: { runId: string } }).payload.runId,
      round: 2,
      route: 'cli',
      status: 'complete',
      integrity: 'clean',
      contractAudit: 'aligned',
      accepted: true,
      landed: true,
      noteChars: 'file verified on disk'.length,
    })
  })

  it('an event-persistence failure never fails the recording itself', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'loop-tool-'))
    const tool = createLoopTool({ dataDir: dir, maxRounds: 8 })
    const brokenExec = {
      agent: {
        session: {
          id: 'sess-loop-broken',
          append: () => {
            throw new Error('session log unavailable')
          },
        },
      },
      signal: new AbortController().signal,
    }
    const execute = tool.execute as unknown as
      (args: Record<string, unknown>, exec: unknown) => Promise<LoopToolResult>

    const begin = await execute({ action: 'begin', task: 't', contract: 'c' }, brokenExec)
    expect(begin.runId).toMatch(/^loop_/)

    const record = await execute({
      action: 'record', round: 1, route: 'done', audit_report: CLEAN_REPORT,
      progress_note: 'verified facts',
    }, brokenExec)
    // The trust gate and harness landing still run; only the event is lost.
    expect(record.accepted).toBe(true)
    expect(record.landed).toBe(true)
  })

  it('begin supersedes the previous run while durable facts remain', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'loop-tool-'))
    const events: RecordedEvent[] = []
    const tool = createLoopTool({ dataDir: dir, maxRounds: 8 })

    const first = await call(tool, { action: 'begin', task: 'first task', contract: 'c1' }, events)
    await call(tool, {
      action: 'record', round: 1, route: 'cli', audit_report: CLEAN_REPORT,
      progress_note: 'round one facts',
    }, events)

    const second = await call(tool, { action: 'begin', task: 'second task', contract: 'c2' }, events)
    expect(second.runId).not.toBe(first.runId)
    expect(second.text).toContain(`Previous run ${first.runId} (1 recorded rounds) is replaced`)

    // The new run starts with an empty round ledger.
    const status = await call(tool, { action: 'status' }, events)
    expect(status.text).toContain('0 recorded rounds')
    expect(status.text).toContain('second task')

    // Round numbering restarts under the new run id; the old entry id is never reused.
    const record = await call(tool, {
      action: 'record', round: 1, route: 'cli', audit_report: CLEAN_REPORT,
      progress_note: 'fresh run facts',
    }, events)
    expect(record.runId).toBe(second.runId)
    const state = harnessState(dir)
    expect(state).toContain(`${first.runId}/round_001`)
    expect(state).toContain(`${second.runId}/round_001`)
  })
})
