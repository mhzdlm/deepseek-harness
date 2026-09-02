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
/**
 * Every session-log event type this plugin appends. The persistence read path
 * refuses logs containing types outside the generated catalog
 * (`KNOWN_SESSION_EVENT_TYPES`), and `Session.append` cannot mark an event
 * ignorable, so adding a member here requires regenerating the catalog
 * (`pnpm run gen-persistence-catalog`); `tests/persistence-catalog.spec.ts`
 * pins that pairing.
 */
export const MEMORY_EVENT_TYPES = ['session/memory-captured'];
/**
 * Append the memory-captured event to the session's durable log.
 * @param session - the captured session, or null to skip.
 * @param payload - the capture record to append.
 */
export function emitMemoryCapturedEvent(session, payload) {
    if (!session)
        return;
    try {
        session.append('session/memory-captured', payload);
    }
    catch {
        // Process events are observability; persistence failures stay silent.
    }
}
//# sourceMappingURL=events.js.map