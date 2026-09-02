/**
 * Transcript sanitization for the write path: strip tool-result blocks so the
 * captured dialog never re-enters a later capture as pseudo-user facts
 * (anti-pollution, REME.md §5.1 D5). The stored dialog is the source of truth
 * the extraction subagent reads; recall results are themselves tool results, so
 * this single rule also blocks recall from self-reinforcing capture — the
 * ReMe "recall does not re-enter auto_memory" contract's equivalent.
 *
 * Borrow: ReMe `_sanitize_msg_for_save` (source-verified: "let retrieved facts
 * masquerade as user-provided context" rationale). ReMe dsh plugin rootAgentsOnly
 * is enforced at the listener, not here.
 *
 * @module @deepseek-ai/dsh-plugin-rlm-memory/sanitize
 */
/**
 * Drop tool-result turns from a captured turn list. User/model/system turns pass
 * through; tool turns are removed entirely so the stored dialog carries only
 * user-provided and model-produced text — never retrieved or computed results.
 * @param turns - accumulated turns for one session, in arrival order.
 * @returns a new array with every `role === 'tool'` entry removed.
 */
export function sanitizeTurns(turns) {
    const out = [];
    for (const turn of turns) {
        if (turn.role === 'tool')
            continue;
        out.push(turn);
    }
    return out;
}
/**
 * Render sanitized turns as the line protocol written to `dialog/<id>.jsonl`:
 * one JSON object per turn with `role` and `content` only (no tool identifiers,
 * no tool results). Each line is a compact stable JSON object; order is preserved.
 * @param turns - sanitized (tool-stripped) turns.
 * @returns newline-joined JSONL text, empty string when no turns remain.
 */
export function renderDialogJsonl(turns) {
    const lines = turns.map(turn => JSON.stringify({ role: turn.role, content: turn.content }));
    return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}
/**
 * Render sanitized turns as plain `role: content` text for the extraction
 * subagent prompt (a human-readable view, not the stored jsonl). Tool turns are
 * already removed by {@link sanitizeTurns} before this is called.
 * @param turns - raw accumulated turns (tool turns dropped here).
 * @returns newline-joined plain-text dialog, empty string when nothing remains.
 */
export function renderDialogText(turns) {
    const lines = sanitizeTurns(turns).map(turn => `${turn.role}: ${turn.content}`);
    return lines.join('\n');
}
//# sourceMappingURL=sanitize.js.map