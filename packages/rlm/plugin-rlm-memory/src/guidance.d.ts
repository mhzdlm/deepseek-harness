/**
 * Phase B session-start guidance injection (REME.md §6 D13). One short
 * hints-only message pointing the model at the `memory_search` tool; it must
 * NOT dump note contents (hints-only discipline, mirroring prime 6/180/6000
 * and the ReMe dsh plugin's `agent/session-start` injection). The model learns
 * the tool exists and what it is for; the harness time-index overview stays the
 * "what was recently memorized" channel, and `memory_search` is the "what is
 * relevant now" channel (dual-channel recall, REME.md §5.2 D8).
 *
 * @module @deepseek-ai/dsh-plugin-rlm-memory/guidance
 */
/**
 * Build the plugin-instructions text injected on session start.
 * @param language - `'en'` (default) or `'zh'`; only the two shipped locales.
 * @returns a one- or two-sentence hints-only string (no note content).
 */
export declare function memoryGuidance(language: string): string;
//# sourceMappingURL=guidance.d.ts.map