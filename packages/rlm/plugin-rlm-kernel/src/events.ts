/**
 * Log-only process events for the kernel's dill snapshot, following the
 * `session/verify-request` precedent established by plugin-rlm-verifier:
 * appended through the session's own Session so "why this snapshot / what did
 * it carry" is auditable from the durable log without entering derived model
 * history. Emission is best-effort — event failures never fail a cell.
 *
 * @module @deepseek-ai/dsh-plugin-rlm-kernel/events
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
export const KERNEL_SNAPSHOT_EVENT_TYPES = ['session/kernel-snapshot'] as const

/** Outcome of one dill snapshot flush, surfaced for log-only audit. */
export interface KernelSnapshotEventData {
  /** Whether the snapshot serialized a payload (false ⇒ kernel/snapshot error). */
  ok: boolean
  /** Count of top-level names serialized into the payload. */
  vars?: number
  /** Payload size on disk, in bytes. */
  bytes?: number
  /** Names that could not be serialized (unpicklable / over-cap). */
  skipped?: string[]
  /** Oversized live variables removed by a compaction snapshot. */
  pruned?: string[]
  /** Wall-clock duration of the snapshot, in milliseconds. */
  ms?: number
  /** Why the snapshot failed, when `ok` is false. */
  error?: string
  /** What triggered the flush: a normal cell cycle or a forced reclaim eviction. */
  reason?: 'cell' | 'reclaim'
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Log-only record of one kernel dill snapshot flush. */
    'session/kernel-snapshot': KernelSnapshotEventData
  }
}

/**
 * Append one kernel-snapshot lifecycle event to the session's durable log.
 * @param session - the executing agent's session, or null to skip.
 */
export function emitKernelSnapshotEvent(
  session: Pick<Session, 'append'> | null | undefined,
  payload: KernelSnapshotEventData,
): void {
  if (!session) return
  try {
    session.append('session/kernel-snapshot', payload as never)
  } catch {
    // Process events are observability; persistence failures stay silent.
  }
}
