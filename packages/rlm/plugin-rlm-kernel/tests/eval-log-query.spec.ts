/**
 * T7.11: unit tests for the deterministic eval-log-query aggregation
 * (scripts/eval-log-query.mts). Keyless and fixture-driven — the five
 * evaluation sources are represented by hand-built session.jsonl lines that
 * mirror the payloads the emitting plugins append (host-handlers.ts,
 * verifier events.ts, loop events.ts, memory events.ts, assistant/message
 * usage in dsh-session).
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import {
  addAggregates,
  aggregateEvents,
  dist,
  formatReport,
  parseLogText,
  runCli,
  type ParsedEvent,
} from '../scripts/eval-log-query.mts'

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-rlm-evallog-'))
  roots.push(root)
  return root
}

describe('dist', () => {
  it('computes nearest-rank median/p95/mean/max over finite values', () => {
    const d = dist([4, 1, 100, 2, 3])
    expect(d).toEqual({ n: 5, total: 110, median: 3, mean: 22, p95: 100, max: 100 })
  })

  it('is all-zero for empty input and ignores non-finite values', () => {
    expect(dist([])).toEqual({ n: 0, total: 0, median: 0, mean: 0, p95: 0, max: 0 })
    expect(dist([Number.NaN, 7]).median).toBe(7)
  })
})

describe('parseLogText', () => {
  it('captures the header line, drops malformed lines and packed chunk rows, keeps events', () => {
    const text = [
      JSON.stringify({ type: 'session', version: 0, id: 's-1', createdAt: 100, delegationDepth: 0 }),
      JSON.stringify({ type: 'text-chunks', seq0: 5, time0: 1, data: { rows: [] } }),
      'not json at all',
      JSON.stringify({ type: 'session/subcall-query', seq: 9, time: 7, data: { batchSize: 1 } }),
      JSON.stringify({ type: 'assistant/message', seq: 10, time: 8, data: {} }),
      '',
    ].join('\n')
    const parsed = parseLogText(text)
    expect(parsed.header).toEqual({ id: 's-1', createdAt: 100, project: undefined })
    expect(parsed.events.map(e => e.type)).toEqual(['session/subcall-query', 'assistant/message'])
    expect(parsed.events[0]).toMatchObject({ seq: 9, time: 7 })
  })
})

function event(type: string, data: Record<string, unknown>): ParsedEvent {
  return { type, seq: 1, time: 1, data }
}

describe('aggregateEvents', () => {
  it('folds all five evaluation sources into per-source aggregates', () => {
    const agg = aggregateEvents([
      event('turn/start', { turn: 0 }),
      event('session/subcall-query', {
        batchSize: 2, model: 'deepseek-v4-flash', answerChars: [10, 20],
        truncated: [false, true], degenerate: false, retries: 0, durationMs: 100, depth: 1,
      }),
      event('session/subcall-query', {
        batchSize: 1, model: 'subcall-mini', answerChars: [30],
        truncated: [], degenerate: true, retries: 1, durationMs: 200,
      }),
      event('session/verify-request', { models: ['m'], candidateCount: 3 }),
      event('session/verify-result', { index: 0, scores: [1, 2], nComparisons: 6, failedJudges: ['j'], durationMs: 500 }),
      event('session/loop-start', { runId: 'r', taskChars: 10, contractChars: 5 }),
      event('session/loop-round-done', { runId: 'r', round: 1, status: 'complete', integrity: 'clean', contractAudit: 'aligned', accepted: true, landed: true }),
      event('session/loop-round-done', { runId: 'r', round: 2, status: 'incomplete', integrity: 'suspect', contractAudit: 'unknown', accepted: false, landed: false }),
      event('session/memory-captured', { sessionId: 's', dialogTurns: 12, draftsAdmitted: 3, extractionRan: true, draftChars: 240 }),
      event('assistant/message', { turn: 0, step: 0, message: {}, usage: { inputTokens: 1000, outputTokens: 50 } }),
    ])
    expect(agg.subcallBatches).toBe(2)
    expect(agg.subcallCalls).toBe(3)
    expect(agg.subcallAnswerChars).toEqual([10, 20, 30])
    expect(agg.subcallTruncatedAnswers).toBe(1)
    expect(agg.subcallDegenerateBatches).toBe(1)
    expect(agg.subcallRetries).toBe(1)
    expect(agg.subcallByModel).toEqual({ 'deepseek-v4-flash': 2, 'subcall-mini': 1 })
    expect(agg.subcallByDepth).toEqual({ '1': 2, unset: 1 })
    expect(agg.verifyRuns).toBe(1)
    expect(agg.verifyComparisons).toEqual([6])
    expect(agg.verifyFailedJudgeRuns).toBe(1)
    expect(agg.loopRuns).toBe(1)
    expect(agg.loopRounds).toBe(2)
    expect(agg.loopAccepted).toBe(1)
    expect(agg.loopLanded).toBe(1)
    expect(agg.memoryCaptures).toBe(1)
    expect(agg.memoryDraftsAdmitted).toBe(3)
    expect(agg.rootUsageMessages).toBe(1)
    expect(agg.rootInputTokens).toBe(1000)
    expect(agg.rootOutputTokens).toBe(50)
  })
})

describe('addAggregates', () => {
  it('sums numeric counters and concatenates distributions', () => {
    const a = aggregateEvents([event('session/subcall-query', { batchSize: 1, model: 'm', answerChars: [5], truncated: [], degenerate: false, retries: 0, durationMs: 10 })])
    const b = aggregateEvents([event('session/subcall-query', { batchSize: 2, model: 'm', answerChars: [6, 7], truncated: [], degenerate: false, retries: 0, durationMs: 20 })])
    const merged = addAggregates(a, b)
    expect(merged.subcallCalls).toBe(3)
    expect(merged.subcallAnswerChars).toEqual([5, 6, 7])
    expect(merged.subcallByModel).toEqual({ m: 3 })
    expect(merged.subcallDurations).toEqual([10, 20])
  })
})

describe('formatReport', () => {
  it('renders every source section and the durable-proxy note', () => {
    const agg = aggregateEvents([event('session/subcall-query', { batchSize: 1, model: 'm', answerChars: [8000], truncated: [true], degenerate: false, retries: 0, durationMs: 1000, depth: 0 })])
    const text = formatReport(agg, 1)
    expect(text).toContain('[subcall]')
    expect(text).toContain('[verify]')
    expect(text).toContain('[loop]')
    expect(text).toContain('[memory]')
    expect(text).toContain('[root-tokens]')
    expect(text).toContain('durable per-subcall proxy')
    expect(text).toContain('100%')
  })
})

describe('runCli', () => {
  it('enumerates session artifacts across projects, skips zstd-less junk, and prints a JSON rollup', async () => {
    const root = makeRoot()
    const writeSession = (project: string, id: string, lines: string[]): void => {
      const dir = join(root, project, id)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'session.jsonl'), lines.join('\n'), 'utf8')
    }
    const header = JSON.stringify({ type: 'session', version: 0, id: 's1', createdAt: 1, delegationDepth: 0 })
    writeSession('proj-a', 'sess-1', [
      header,
      JSON.stringify(event('session/subcall-query', { batchSize: 2, model: 'm', answerChars: [10, 20], truncated: [], degenerate: false, retries: 0, durationMs: 100, depth: 1 })),
    ])
    writeSession('proj-a', 'sess-2', [header])
    writeSession('proj-b', 'sess-3', [
      header,
      JSON.stringify(event('session/loop-round-done', { runId: 'r', round: 1, status: 'complete', integrity: 'clean', contractAudit: 'aligned', accepted: true, landed: true })),
    ])
    writeFileSync(join(root, 'proj-a', 'stray.txt'), 'not a session dir')

    const out: string[] = []
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown): boolean => {
      out.push(String(chunk))
      return true
    })
    try {
      const code = await runCli([root, '--json'])
      expect(code).toBe(0)
    } finally {
      stdoutSpy.mockRestore()
    }
    const payload = JSON.parse(out.join('')) as { files: number; rollup: { subcallCalls: number; loopRounds: number } }
    expect(payload.files).toBe(3)
    expect(payload.rollup.subcallCalls).toBe(2)
    expect(payload.rollup.loopRounds).toBe(1)
  })

  it('returns 1 and writes to stderr when the root has no session artifacts', async () => {
    const root = makeRoot()
    const err: string[] = []
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown): boolean => {
      err.push(String(chunk))
      return true
    })
    try {
      expect(await runCli([root])).toBe(1)
    } finally {
      stderrSpy.mockRestore()
    }
    expect(err.join('')).toContain('no session.jsonl')
  })
})
