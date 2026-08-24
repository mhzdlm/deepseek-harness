/**
 * Session-scoped JSONL trace for MoA panel runs, written under
 * `<dataDir>/moa-traces/`. One line per tool execution; append-only by
 * design — the file is an observability sidecar, never read back by the
 * plugin itself.
 *
 * @module @deepseek-ai/dsh-plugin-rlm-moa/trace
 */

import { mkdirSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'

/** One reference slot's outcome inside a traced run. */
export interface MoaTraceReference {
  label: string
  status: 'ok' | 'failed'
  /** Wall-clock milliseconds spent on the slot. */
  ms: number
  /** Advisor answer length in characters (0 when failed). */
  chars: number
}

/** One completed (or partially failed) MoA panel run. */
export interface MoaTraceEntry {
  /** Epoch milliseconds at completion. */
  ts: number
  sessionId?: string
  preset: string
  problemChars: number
  references: MoaTraceReference[]
  failedLabels: string[]
  synthesisChars: number
}

/**
 * Append one trace entry as a single JSONL line. Best-effort: tracing must
 * never break a turn, so every error is swallowed.
 * @param traceDir - directory under which `<sessionId|anonymous>.jsonl` lives.
 * @param entry - the completed-run record.
 */
export function appendMoaTrace(traceDir: string, entry: MoaTraceEntry): void {
  try {
    mkdirSync(traceDir, { recursive: true })
    const file = join(traceDir, `${entry.sessionId || 'anonymous'}.jsonl`)
    appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8')
  } catch {
    // Trace writes are observability side effects; disk failures stay silent.
  }
}
