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
export function memoryGuidance(language) {
    if (language === 'zh') {
        return '你有一个 `memory_search` 工具，可按需语义检索跨会话知识库。需要回忆"此刻相关的"已发布笔记时调用它；最近记了什么由常驻概览负责，无需检索。';
    }
    return 'You have a `memory_search` tool to recall relevant cross-session notes on demand. Call it when you need "what is relevant now"; the time-index overview already covers "what was recently memorized".';
}
//# sourceMappingURL=guidance.js.map