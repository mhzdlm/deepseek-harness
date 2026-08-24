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
  judgeProfiles?: string[]
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
  name: 'session/verify-request' | 'session/verify-result',
  payload: VerifyRequestEventData | VerifyResultEventData,
): void {
  if (!session) return
  try {
    session.append(name, payload as never)
  } catch {
    // Process events are observability; persistence failures stay silent.
  }
}
