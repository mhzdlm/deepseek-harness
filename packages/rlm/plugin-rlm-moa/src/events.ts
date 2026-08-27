/**
 * Log-only process events for the moa panel, following the
 * `session/title-llm-request` precedent. Reference events carry each advisor
 * answer passed through the active privacy pipeline (`full` stores the masked
 * text); the synthesis event stores the final output verbatim. Emission is
 * best-effort — event failures never fail a turn.
 *
 * @module @deepseek-ai/dsh-plugin-rlm-moa/events
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
export const MOA_EVENT_TYPES = ['session/moa-reference', 'session/moa-synthesis'] as const

/** One settled reference slot's durable record. */
export interface MoaReferenceEventData {
  preset: string
  label: string
  provider: string
  mode: 'llm' | 'subagent'
  status: 'ok' | 'failed'
  /** Advisor answer under the active privacy pipeline ('' when failed). */
  text: string
  ms: number
}

/** The aggregator's final output plus panel outcome summary. */
export interface MoaSynthesisEventData {
  preset: string
  synthesis: string
  failedLabels: string[]
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Log-only record of one settled moa reference slot. */
    'session/moa-reference': MoaReferenceEventData
    /** Log-only record of one moa aggregation result. */
    'session/moa-synthesis': MoaSynthesisEventData
  }
}

/**
 * Append one moa lifecycle event to the session's durable log.
 * @param session - the executing agent's session, or null to skip.
 * @param name - the moa event type to append.
 * @param payload - the event data to record.
 */
export function emitMoaEvent(
  session: Pick<Session, 'append'> | null | undefined,
  name: (typeof MOA_EVENT_TYPES)[number],
  payload: MoaReferenceEventData | MoaSynthesisEventData,
): void {
  if (!session) return
  try {
    session.append(name, payload as never)
  } catch {
    // Process events are observability; persistence failures stay silent.
  }
}
