/**
 * Log-only process event for the active recall injection (T7.13, LAYERS.md §3):
 * appended through the owning session's Session at each section render, so the
 * observe/enforce experiment data ("what WOULD be injected / what WAS
 * injected") is queryable from the durable log. Emission is best-effort —
 * event failures never fail a prompt assembly.
 *
 * @module @deepseek-ai/dsh-plugin-continual-harness/events
 */
import type { Session } from '@deepseek-ai/dsh-session';
/**
 * Every session-log event type this plugin appends. The persistence read path
 * refuses logs containing types outside the generated catalog
 * (`KNOWN_SESSION_EVENT_TYPES`), and `Session.append` cannot mark an event
 * ignorable, so adding a member here requires regenerating the catalog
 * (`pnpm run gen-persistence-catalog`).
 */
export declare const CONTINUAL_HARNESS_EVENT_TYPES: readonly ["session/memory-recall-inject"];
/** One recall-injection evaluation at section render (observe or enforce). */
export interface MemoryRecallInjectEventData {
    /** `observe` records what WOULD be injected without touching the prompt; `enforce` actually injects. */
    mode: 'observe' | 'enforce';
    /** The recall query (most recent user message, truncated). */
    query: string;
    /** Ranked hit note relPaths the recall surfaced (budget-limited). */
    hitIds: string[];
    /** Characters the section WOULD inject (observe) or DID inject (enforce). */
    injectedChars: number;
}
declare module '@deepseek-ai/dsh-session/types' {
    interface SessionEventMap {
        /** Log-only record of one recall-injection evaluation at harness section render. */
        'session/memory-recall-inject': MemoryRecallInjectEventData;
    }
}
/**
 * Append one recall-injection event to the session's durable log.
 * @param session - the owning agent's session, or null to skip.
 * @param payload - the injection record to append.
 */
export declare function emitRecallInjectEvent(session: Pick<Session, 'append'> | null | undefined, payload: MemoryRecallInjectEventData): void;
//# sourceMappingURL=events.d.ts.map