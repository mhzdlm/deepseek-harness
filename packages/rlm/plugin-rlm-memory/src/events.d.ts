/**
 * Log-only session event for the memory capture path, following the
 * `session/title-llm-request` and `session/verify-request|result` precedents:
 * appended through the captured session's own Session so "what was memorized"
 * is auditable from the durable log without entering derived model history.
 * Emission is best-effort — event failures never fail a capture.
 *
 * REME.md §5.1 (D7 provenance: decision-audit log-only session event, the
 * "model-visible ⟺ logged" tie). Borrow shape from plugin-rlm-loop/events.ts
 * and plugin-rlm-moa/events.ts (log-only SessionEventMap merge + emit helper).
 *
 * @module @deepseek-ai/dsh-plugin-rlm-memory/events
 */
import type { Session } from '@deepseek-ai/dsh-session';
/**
 * Every session-log event type this plugin appends. The persistence read path
 * refuses logs containing types outside the generated catalog
 * (`KNOWN_SESSION_EVENT_TYPES`), and `Session.append` cannot mark an event
 * ignorable, so adding a member here requires regenerating the catalog
 * (`pnpm run gen-persistence-catalog`); `tests/persistence-catalog.spec.ts`
 * pins that pairing.
 */
export declare const MEMORY_EVENT_TYPES: readonly ["session/memory-captured"];
/** Durable record of one completed-session capture. */
export interface MemoryCapturedEventData {
    /** The captured session id (the dialog jsonl basename). */
    sessionId: string;
    /** Number of turns written to `dialog/<sessionId>.jsonl` (user+model, tool_result stripped). */
    dialogTurns: number;
    /** Number of draft notes the extraction subagent produced and the gate admitted. */
    draftsAdmitted: number;
    /** Whether the extraction subagent returned any proposal at all. */
    extractionRan: boolean;
    /** Total characters written across the admitted draft note bodies. */
    draftChars: number;
}
declare module '@deepseek-ai/dsh-session/types' {
    interface SessionEventMap {
        /**
         * Log-only record that the memory plugin captured a completed session:
         * wrote `dialog/<sessionId>.jsonl` and landed zero or more admission-gated
         * draft notes. Carries the dialog turn count and the number of drafts the
         * evidence gate admitted, so a reader can reconstruct what was memorized
         * without reopening the memory store.
         * @param sessionId - the captured session id (the dialog jsonl basename).
         * @param dialogTurns - turns written to the sanitized dialog jsonl.
         * @param draftsAdmitted - draft notes the evidence gate admitted.
         * @param extractionRan - whether the extraction subagent returned a proposal.
         * @param draftChars - total characters across admitted draft bodies.
         */
        'session/memory-captured': MemoryCapturedEventData;
    }
}
/**
 * Append the memory-captured event to the session's durable log.
 * @param session - the captured session, or null to skip.
 * @param payload - the capture record to append.
 */
export declare function emitMemoryCapturedEvent(session: Pick<Session, 'append'> | null | undefined, payload: MemoryCapturedEventData): void;
//# sourceMappingURL=events.d.ts.map