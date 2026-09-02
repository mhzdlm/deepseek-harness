/**
 * T7.11 (LAYERS.md §5): deterministic evaluation log query over the five RLM
 * evaluation sources durably recorded in session logs —
 *
 *   1. `session/subcall-query`   (kernel llm.query bridge: batch/calls/chars/
 *                                truncation/retries/degenerate/duration, use/depth)
 *   2. `session/verify-request` / `session/verify-result` (verifier runs)
 *   3. `session/loop-start` / `session/loop-round-done` (loop trust-gate rounds)
 *   4. `session/memory-captured` (memory capture + evidence-gated drafts)
 *   5. `assistant/message.usage` (root-conversation token totals)
 *
 * Aggregation is pure and unit-tested (tests/eval-log-query.spec.ts); the CLI
 * enumerates a `.sessions/`-style root (`<project>/<encodedSessionId>/session
 * .jsonl[.zstd]`) and prints a human report or `--json`. Manual-only by design
 * (LAYERS.md §5 R3: 只手动，不 CI).
 *
 * Known limit (same note in the report output): subcall LLM calls execute
 * through the host seam, so their token usage is purpose-attributed at the
 * meter/transport level and is NOT durable in the session log. The durable
 * per-subcall proxy is the subcall-query event's answerChars and durationMs.
 * `assistant/message.usage` covers the root conversation's own model calls.
 *
 * @module @deepseek-ai/dsh-plugin-rlm-kernel/eval-log-query
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { decompressZstdFrame } from '@deepseek-ai/dsh-session-persistence-jsonl/src/zstd.ts'

/** `session/subcall-query` payload (emitted by kernel host-handlers). */
export interface SubcallQueryData {
  batchSize: number
  model: string
  answerChars: number[]
  truncated: boolean[]
  degenerate: boolean
  retries: number
  durationMs: number
  use?: string
  depth?: number
}

/** `session/verify-request` payload. */
export interface VerifyRequestData {
  models: string[]
  candidateCount: number
  judgeProfiles?: string[]
}

/** `session/verify-result` payload. */
export interface VerifyResultData {
  index: number
  scores: number[]
  nComparisons: number
  failedJudges?: string[]
  durationMs: number
}

/** `session/loop-start` payload. */
export interface LoopStartData {
  runId: string
  taskChars: number
  contractChars: number
}

/** `session/loop-round-done` payload. */
export interface LoopRoundDoneData {
  runId: string
  round: number
  status: string
  integrity: string
  contractAudit: string
  accepted: boolean
  landed: boolean
}

/** `session/memory-captured` payload. */
export interface MemoryCapturedData {
  sessionId: string
  dialogTurns: number
  draftsAdmitted: number
  extractionRan: boolean
  draftChars: number
}

/** One parsed session-log event line (chunk rows and junk are dropped). */
export interface ParsedEvent {
  type: string
  seq?: number
  time?: number
  data: Record<string, unknown>
}

/** First-line session header, narrowed to the fields the report uses. */
export interface ParsedSessionHeader {
  id: string
  createdAt: number
  project?: string
}

export interface ParsedLog {
  header: ParsedSessionHeader | undefined
  events: ParsedEvent[]
}

/** Distribution summary over one numeric metric. */
export interface Dist {
  n: number
  total: number
  median: number
  mean: number
  p95: number
  max: number
}

/** Per-session aggregates for all five sources. */
export interface SessionAggregate {
  subcallBatches: number
  subcallCalls: number
  subcallAnswerChars: number[]
  subcallDurations: number[]
  subcallRetries: number
  subcallTruncatedAnswers: number
  subcallDegenerateBatches: number
  subcallByModel: Record<string, number>
  subcallByDepth: Record<string, number>
  verifyRuns: number
  verifyComparisons: number[]
  verifyDurations: number[]
  verifyFailedJudgeRuns: number
  loopRuns: number
  loopRounds: number
  loopAccepted: number
  loopLanded: number
  memoryCaptures: number
  memoryDraftsAdmitted: number
  memoryDialogTurns: number[]
  memoryDraftChars: number[]
  rootUsageMessages: number
  rootInputTokens: number
  rootOutputTokens: number
}

const CHUNK_ROW_TYPES = new Set(['text-chunks', 'reasoning-chunks', 'tool-call-chunks'])

/**
 * Parse one session.jsonl text into its header and usable event lines.
 * Malformed JSON lines and packed chunk rows are skipped (the eval query is a
 * best-effort reader over logs that may be torn mid-write).
 */
export function parseLogText(text: string): ParsedLog {
  const out: ParsedLog = { header: undefined, events: [] }
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    let value: unknown
    try {
      value = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (typeof value !== 'object' || value === null) continue
    const record = value as Record<string, unknown>
    if (record.type === 'session' && typeof record.id === 'string' && typeof record.createdAt === 'number') {
      if (out.header === undefined) {
        out.header = {
          id: record.id,
          createdAt: record.createdAt,
          ...(typeof record.project === 'string' ? { project: record.project } : {}),
        }
      }
      continue
    }
    if (typeof record.type !== 'string' || CHUNK_ROW_TYPES.has(record.type)) continue
    out.events.push({
      type: record.type,
      ...(typeof record.seq === 'number' ? { seq: record.seq } : {}),
      ...(typeof record.time === 'number' ? { time: record.time } : {}),
      data: (typeof record.data === 'object' && record.data !== null ? record.data : {}) as Record<string, unknown>,
    })
  }
  return out
}

function emptyAggregate(): SessionAggregate {
  return {
    subcallBatches: 0,
    subcallCalls: 0,
    subcallAnswerChars: [],
    subcallDurations: [],
    subcallRetries: 0,
    subcallTruncatedAnswers: 0,
    subcallDegenerateBatches: 0,
    subcallByModel: {},
    subcallByDepth: {},
    verifyRuns: 0,
    verifyComparisons: [],
    verifyDurations: [],
    verifyFailedJudgeRuns: 0,
    loopRuns: 0,
    loopRounds: 0,
    loopAccepted: 0,
    loopLanded: 0,
    memoryCaptures: 0,
    memoryDraftsAdmitted: 0,
    memoryDialogTurns: [],
    memoryDraftChars: [],
    rootUsageMessages: 0,
    rootInputTokens: 0,
    rootOutputTokens: 0,
  }
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function recordKey(map: Record<string, number>, key: string, by: number): void {
  map[key] = (map[key] ?? 0) + by
}

/**
 * Fold one session's parsed events into per-source aggregates. Unknown event
 * types are ignored so the aggregator tolerates log formats from any version.
 */
export function aggregateEvents(events: readonly ParsedEvent[]): SessionAggregate {
  const agg = emptyAggregate()
  for (const event of events) {
    const data = event.data
    switch (event.type) {
      case 'session/subcall-query': {
        const d = data as unknown as SubcallQueryData
        const batchSize = Math.max(0, num(d.batchSize))
        agg.subcallBatches += 1
        agg.subcallCalls += batchSize
        if (Array.isArray(d.answerChars)) for (const chars of d.answerChars) agg.subcallAnswerChars.push(num(chars))
        agg.subcallDurations.push(num(d.durationMs))
        agg.subcallRetries += num(d.retries)
        if (Array.isArray(d.truncated)) for (const flag of d.truncated) if (flag === true) agg.subcallTruncatedAnswers += 1
        if (d.degenerate === true) agg.subcallDegenerateBatches += 1
        recordKey(agg.subcallByModel, typeof d.model === 'string' && d.model.length > 0 ? d.model : 'unknown', batchSize)
        recordKey(agg.subcallByDepth, typeof d.depth === 'number' ? String(d.depth) : 'unset', batchSize)
        break
      }
      case 'session/verify-request':
        agg.verifyRuns += 1
        break
      case 'session/verify-result': {
        const d = data as unknown as VerifyResultData
        agg.verifyComparisons.push(num(d.nComparisons))
        agg.verifyDurations.push(num(d.durationMs))
        if (Array.isArray(d.failedJudges) && d.failedJudges.length > 0) agg.verifyFailedJudgeRuns += 1
        break
      }
      case 'session/loop-start':
        agg.loopRuns += 1
        break
      case 'session/loop-round-done': {
        const d = data as unknown as LoopRoundDoneData
        agg.loopRounds += 1
        if (d.accepted === true) agg.loopAccepted += 1
        if (d.landed === true) agg.loopLanded += 1
        break
      }
      case 'session/memory-captured': {
        const d = data as unknown as MemoryCapturedData
        agg.memoryCaptures += 1
        agg.memoryDraftsAdmitted += num(d.draftsAdmitted)
        agg.memoryDialogTurns.push(num(d.dialogTurns))
        agg.memoryDraftChars.push(num(d.draftChars))
        break
      }
      case 'assistant/message': {
        const usage = data.usage as Record<string, unknown> | undefined
        if (usage === undefined || typeof usage !== 'object') break
        agg.rootUsageMessages += 1
        agg.rootInputTokens += num(usage.inputTokens)
        agg.rootOutputTokens += num(usage.outputTokens)
        break
      }
      default:
        break
    }
  }
  return agg
}

const NUMERIC_AGGREGATE_KEYS = [
  'subcallBatches', 'subcallCalls', 'subcallRetries', 'subcallTruncatedAnswers', 'subcallDegenerateBatches',
  'verifyRuns', 'verifyFailedJudgeRuns',
  'loopRuns', 'loopRounds', 'loopAccepted', 'loopLanded',
  'memoryCaptures', 'memoryDraftsAdmitted',
  'rootUsageMessages', 'rootInputTokens', 'rootOutputTokens',
] as const

/** Element-wise sum of two aggregates (arrays concatenate). */
export function addAggregates(target: SessionAggregate, addend: SessionAggregate): SessionAggregate {
  const merged: SessionAggregate = {
    ...target,
    subcallAnswerChars: [...target.subcallAnswerChars, ...addend.subcallAnswerChars],
    subcallDurations: [...target.subcallDurations, ...addend.subcallDurations],
    subcallByModel: { ...target.subcallByModel },
    subcallByDepth: { ...target.subcallByDepth },
    verifyComparisons: [...target.verifyComparisons, ...addend.verifyComparisons],
    verifyDurations: [...target.verifyDurations, ...addend.verifyDurations],
    memoryDialogTurns: [...target.memoryDialogTurns, ...addend.memoryDialogTurns],
    memoryDraftChars: [...target.memoryDraftChars, ...addend.memoryDraftChars],
  }
  for (const [key, by] of Object.entries(addend.subcallByModel)) recordKey(merged.subcallByModel, key, by)
  for (const [key, by] of Object.entries(addend.subcallByDepth)) recordKey(merged.subcallByDepth, key, by)
  for (const key of NUMERIC_AGGREGATE_KEYS) {
    merged[key] = merged[key] + addend[key]
  }
  return merged
}

/** Nearest-rank distribution summary; empty input yields all-zero stats. */
export function dist(values: readonly number[]): Dist {
  const finite = values.filter(v => Number.isFinite(v)).sort((a, b) => a - b)
  if (finite.length === 0) return { n: 0, total: 0, median: 0, mean: 0, p95: 0, max: 0 }
  const total = finite.reduce((sum, v) => sum + v, 0)
  const at = (ratio: number): number => {
    const index = Math.min(finite.length - 1, Math.max(0, Math.ceil(ratio * finite.length) - 1))
    return finite[index] as number
  }
  return {
    n: finite.length,
    total,
    median: at(0.5),
    mean: total / finite.length,
    p95: at(0.95),
    max: finite[finite.length - 1] as number,
  }
}

function fmt(value: number): string {
  return value.toLocaleString('en-US', { maximumFractionDigits: 1 })
}

function fmtDist(label: string, d: Dist): string {
  return `  ${label.padEnd(20)} median ${fmt(d.median)} · mean ${fmt(d.mean)} · p95 ${fmt(d.p95)} · max ${fmt(d.max)} · total ${fmt(d.total)}`
}

/** Human-readable report for a cross-session rollup. */
export function formatReport(rollup: SessionAggregate, sessionCount: number): string {
  const lines: string[] = []
  lines.push(`sessions: ${sessionCount}`)
  lines.push('')
  lines.push(`[subcall] batches ${rollup.subcallBatches} · calls ${rollup.subcallCalls}`)
  lines.push(fmtDist('answerChars/call', dist(rollup.subcallAnswerChars)))
  lines.push(fmtDist('durationMs/batch', dist(rollup.subcallDurations)))
  const truncRate = rollup.subcallCalls > 0 ? (100 * rollup.subcallTruncatedAnswers) / rollup.subcallCalls : 0
  lines.push(`  truncated ${rollup.subcallTruncatedAnswers} (${fmt(truncRate)}%) · degenerate batches ${rollup.subcallDegenerateBatches} · retries ${rollup.subcallRetries}`)
  lines.push(`  by model: ${Object.entries(rollup.subcallByModel).map(([m, n]) => `${m} ${n}`).join(' · ') || '—'}`)
  lines.push(`  by depth: ${Object.entries(rollup.subcallByDepth).map(([d, n]) => `${d}=${n}`).join(' · ') || '—'}`)
  lines.push('')
  lines.push(`[verify] runs ${rollup.verifyRuns} · runs with failed/degraded judges ${rollup.verifyFailedJudgeRuns}`)
  lines.push(fmtDist('nComparisons/run', dist(rollup.verifyComparisons)))
  lines.push(fmtDist('durationMs/run', dist(rollup.verifyDurations)))
  lines.push('')
  const acceptRate = rollup.loopRounds > 0 ? (100 * rollup.loopAccepted) / rollup.loopRounds : 0
  lines.push(`[loop] runs ${rollup.loopRuns} · rounds ${rollup.loopRounds} · accepted ${rollup.loopAccepted} (${fmt(acceptRate)}%) · landed ${rollup.loopLanded}`)
  lines.push('')
  lines.push(`[memory] captures ${rollup.memoryCaptures} · drafts admitted ${rollup.memoryDraftsAdmitted}`)
  lines.push(fmtDist('dialogTurns/capture', dist(rollup.memoryDialogTurns)))
  lines.push(fmtDist('draftChars/capture', dist(rollup.memoryDraftChars)))
  lines.push('')
  lines.push(`[root-tokens] messages with usage ${rollup.rootUsageMessages} · input ${fmt(rollup.rootInputTokens)} · output ${fmt(rollup.rootOutputTokens)}`)
  lines.push('note: subcall token usage is purpose-attributed at the host meter and is not durable in')
  lines.push('      session logs; answerChars/durationMs above are the durable per-subcall proxy.')
  return lines.join('\n')
}

/** Locate every session artifact under a `.sessions`-style root. */
export function listSessionFiles(root: string): Array<{ project: string; file: string }> {
  const out: Array<{ project: string; file: string }> = []
  if (!existsSync(root)) return out
  for (const project of readdirSync(root)) {
    const projectDir = join(root, project)
    try {
      if (!statSync(projectDir).isDirectory()) continue
    } catch {
      continue
    }
    for (const idDir of readdirSync(projectDir)) {
      const dir = join(projectDir, idDir)
      try {
        if (!statSync(dir).isDirectory()) continue
      } catch {
        continue
      }
      const plain = join(dir, 'session.jsonl')
      if (existsSync(plain)) {
        out.push({ project, file: plain })
        continue
      }
      const zstd = join(dir, 'session.jsonl.zstd')
      if (existsSync(zstd)) out.push({ project, file: zstd })
    }
  }
  return out.sort((a, b) => a.file.localeCompare(b.file))
}

/** CLI entry: aggregate every session artifact under `root`; returns exit code. */
export async function runCli(argv: readonly string[]): Promise<number> {
  const args = argv.filter(a => a !== '--json')
  const asJson = argv.includes('--json')
  const root = resolve(args[0] ?? '.')
  const files = listSessionFiles(root)
  if (files.length === 0) {
    process.stderr.write(`eval-log-query: no session.jsonl[.zstd] artifacts under ${root}\n`)
    return 1
  }
  let rollup = emptyAggregate()
  for (const entry of files) {
    let text: string
    if (entry.file.endsWith('.zstd')) {
      text = (await decompressZstdFrame(readFileSync(entry.file))).toString('utf8')
    } else {
      text = readFileSync(entry.file, 'utf8')
    }
    const parsed = parseLogText(text)
    rollup = addAggregates(rollup, aggregateEvents(parsed.events))
  }
  if (asJson) {
    process.stdout.write(JSON.stringify({ root, files: files.length, rollup, distributions: {
      subcallAnswerChars: dist(rollup.subcallAnswerChars),
      subcallDurations: dist(rollup.subcallDurations),
      verifyComparisons: dist(rollup.verifyComparisons),
      verifyDurations: dist(rollup.verifyDurations),
      memoryDialogTurns: dist(rollup.memoryDialogTurns),
      memoryDraftChars: dist(rollup.memoryDraftChars),
    } }, null, 2) + '\n')
  } else {
    process.stdout.write(`RLM eval log query — ${relative(dirname(root), root) || root}\n\n`)
    process.stdout.write(formatReport(rollup, files.length) + '\n')
  }
  return 0
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (isMain) {
  runCli(process.argv.slice(2)).then(
    code => process.exitCode = code,
    error => {
      process.stderr.write(`eval-log-query: ${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 1
    },
  )
}
