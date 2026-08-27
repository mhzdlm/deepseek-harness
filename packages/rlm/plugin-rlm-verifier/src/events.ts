/**
 * Log-only process events for the verify tool, following the
 * `session/title-llm-request` precedent: appended through the execution's own
 * Session before dispatch and after settlement, so "why this verdict" is
 * auditable from the durable log without entering derived model history.
 * Emission is best-effort — event failures never fail a verification.
 *
 * @module @deepseek-ai/dsh-plugin-rlm-verifier/events
 */

import type { Session } from '@deepseek-ai/dsh-session'

/**
 * Every session-log event type this plugin appends. The persistence read path
 * refuses logs containing types outside the generated catalog
 * (`KNOWN_SESSION_EVENT_TYPES`), and `Session.append` cannot mark an event
 * ignorable, so adding a member here requires regenerating the catalog
 * (`pnpm run gen-persistence-catalog`); `tests/persistence-catalog.spec.ts`
 * pins that pairing.
 */
export const VERIFY_EVENT_TYPES = ['session/verify-request', 'session/verify-result'] as const

/** Pre-dispatch record of one verification run. */
export interface VerifyRequestEventData {
  /** Execution engine; the seam hosts all scoring since phase 2b. */
  engine: 'seam'
  /** Effective verifier model(s); multiple only in multi-judge runs. */
  models: string[]
  criteria: Record<string, string>
  candidateCount: number
  /** First 120 chars of each candidate, after privacy masking when active. */
  candidatesDigest: string[]
  /** Per-candidate character length, after privacy masking when active. */
  candidatesChars?: number[]
  judgeProfiles?: string[]
}

/** One judge's fused-input record: everything needed to recompute the fusion. */
export interface VerifyJudgeOutcomeData {
  model: string
  /** `ok` = every scoring call succeeded; `degraded` = some calls failed and were
   *  scored as neutral ties but the tournament still completed; `failed` = the
   *  tournament itself threw (no preference vector produced). */
  status: 'ok' | 'degraded' | 'failed'
  /** Judge preference vector over candidates (Borda input). */
  meanPreference: number[]
  nComparisons: number
}

/** Post-settlement record: the parseable outcome plus timing. */
export interface VerifyResultEventData {
  engine: 'seam'
  models: string[]
  index: number
  scores: number[]
  ranking: number[]
  nComparisons: number
  failedJudges?: string[]
  durationMs: number
  /** Per-judge fusion inputs so the ranking is recomputable (T2.6). */
  judges?: VerifyJudgeOutcomeData[]
  /** auto_spawn child session ids — the linkage to full candidate logs. */
  childSessionIds?: string[]
  /** Session-artifacts path holding the run's full detail JSON, when written. */
  detailPath?: string
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Log-only pre-dispatch record of one verify run. */
    'session/verify-request': VerifyRequestEventData
    /** Log-only post-settlement record of one verify run. */
    'session/verify-result': VerifyResultEventData
  }
}

/**
 * Append one verify lifecycle event to the session's durable log.
 * @param session - the executing agent's session, or null to skip.
 */
export function emitVerifyEvent(
  session: Pick<Session, 'append'> | null | undefined,
  name: (typeof VERIFY_EVENT_TYPES)[number],
  payload: VerifyRequestEventData | VerifyResultEventData,
): void {
  if (!session) return
  try {
    session.append(name, payload as never)
  } catch {
    // Process events are observability; persistence failures stay silent.
  }
}
