/**
 * Log-only process event for the active recall injection (T7.13, LAYERS.md §3):
 * appended through the owning session's Session at each section render, so the
 * observe/enforce experiment data ("what WOULD be injected / what WAS
 * injected") is queryable from the durable log. Emission is best-effort —
 * event failures never fail a prompt assembly.
 *
 * @module @deepseek-ai/dsh-plugin-continual-harness/events
 */
/**
 * Every session-log event type this plugin appends. The persistence read path
 * refuses logs containing types outside the generated catalog
 * (`KNOWN_SESSION_EVENT_TYPES`), and `Session.append` cannot mark an event
 * ignorable, so adding a member here requires regenerating the catalog
 * (`pnpm run gen-persistence-catalog`).
 */
export const CONTINUAL_HARNESS_EVENT_TYPES = ['session/memory-recall-inject'];
/**
 * Append one recall-injection event to the session's durable log.
 * @param session - the owning agent's session, or null to skip.
 * @param payload - the injection record to append.
 */
export function emitRecallInjectEvent(session, payload) {
    if (!session)
        return;
    try {
        session.append('session/memory-recall-inject', payload);
    }
    catch {
        // Process events are observability; persistence failures stay silent.
    }
}
//# sourceMappingURL=events.js.map