/**
 * Log-only process events for the loop tool, following the
 * `session/title-llm-request` and `session/verify-request|result` precedents:
 * appended through the executing agent's own Session so "why is this round
 * trusted" is auditable from the durable log without entering derived model
 * history. Emission is best-effort — event failures never fail a recording.
 *
 * @module @deepseek-ai/dsh-plugin-rlm-loop/events
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
export const LOOP_EVENT_TYPES = ['session/loop-start', 'session/loop-round-done'] as const

/** Pre-record record of one Loop Engineering run. */
export interface LoopStartEventData {
  runId: string
  taskChars: number
  contractChars: number
}

/** Post-parse record of one recorded round: the verdict plus what was landed. */
export interface LoopRoundDoneEventData {
  runId: string
  round: number
  route: string
  status: string
  integrity: string
  contractAudit: string
  accepted: boolean
  /** Whether a verified-progress entry was landed into harness state. */
  landed: boolean
  noteChars: number
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Log-only record of one loop run start. */
    'session/loop-start': LoopStartEventData
    /** Log-only record of one recorded loop round. */
    'session/loop-round-done': LoopRoundDoneEventData
  }
}

/**
 * Append one loop lifecycle event to the session's durable log.
 * @param session - the executing agent's session, or null to skip.
 * @param name - the loop event type to append.
 * @param payload - the event data paired with the chosen event type.
 */
export function emitLoopEvent(
  session: Pick<Session, 'append'> | null | undefined,
  name: (typeof LOOP_EVENT_TYPES)[number],
  payload: LoopStartEventData | LoopRoundDoneEventData,
): void {
  if (!session) return
  try {
    session.append(name, payload as never)
  } catch {
    // Process events are observability; persistence failures stay silent.
  }
}
