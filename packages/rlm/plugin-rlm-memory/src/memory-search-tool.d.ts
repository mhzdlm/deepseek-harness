/**
 * Phase B `memory_search` tool (REME.md §5.2 D8, §8 D8, §10 Phase B acceptance).
 * Borrows the `defineTool` shape from plugin-rlm-loop/loop-tool.ts: a
 * `{ name, description, parameters: {field: {type, required?, description}} }`
 * field-map, `output: { schema, render }`, and `execute(args, exec)` where
 * `exec.agent?.session` resolves the owning Session (throw if absent, like loop).
 *
 * On each hit the tool updates that note's `use_count`/`last_accessed` frontmatter
 * (the aging signal for Phase D, REME.md §8 D4 — use-signal fields borrow ReMe
 * `auto_memory.py` provenance + the paper's aging strategy), WITHOUT bumping
 * `version` (content-identity, not access). It returns full text (title, path,
 * score, body) via `output.render` — the result rides the tool-result log, never
 * the system prompt (REME.md §5.2 dual-channel; harness overview stays
 * time-indexed).
 *
 * Recall path is selected by the optional `embeddingService` closure: when one is
 * wired (`embeddingsProvider: 'external'`, Phase E REME.md §12.1) the tool runs
 * `hybridSearch` (lexical BM25 fused with cached-embedding cosine); otherwise it runs
 * the keyword/BM25-ish `search`. `recallMode` is accepted by the Config but does not
 * select the path today — both `'keyword'` and `'auto'` behave the same; `'auto'` with
 * no configured provider surfaces a one-time downgrade warning in index.ts.
 *
 * NOTE: `defineTool` (packages/core/tools/src/schema.ts `DefineToolOptions`) does
 * NOT accept a `purpose` field, so no `purpose: 'memory'` attribution is set here;
 * REME.md §5.2 references `purpose:'memory'` as the intended design, but the
 * current tool API cannot carry it. The tool's `name` still routes it through the
 * host-owned seam like verify/moa/loop.
 *
 * @module @deepseek-ai/dsh-plugin-rlm-memory/memory-search-tool
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { EmbeddingService } from './embedding.ts';
/** Construction options for the `memory_search` tool. */
export interface MemorySearchToolOptions {
    /** Memory root; the tool searches `published/` beneath it. */
    memoryDir: string;
    /** Default top-K (used when the caller omits `limit`). */
    recallTopK: number;
    /**
     * Optional embedding provider (Phase E, REME.md §12.1). When present, the tool runs
     * `hybridSearch` (lexical BM25 fused with cached-embedding cosine); otherwise it runs
     * the lexical `search`. The closure carries it so a dsh-native provider later needs no
     * tool change.
     */
    embeddingService?: EmbeddingService;
}
/**
 * Build the `memory_search` tool over `published/` at {@link MemorySearchToolOptions.memoryDir}.
 * @param options - the memory root, default top-K, and recall mode.
 * @returns a `defineTool` tool object implementing `memory_search`.
 */
export declare function createMemorySearchTool(options: MemorySearchToolOptions): ReturnType<typeof defineTool>;
//# sourceMappingURL=memory-search-tool.d.ts.map