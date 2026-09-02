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
import { search, hybridSearch } from "./search.js";
import { updateUsage } from "./storage.js";
/** Render ranked hits as a full-text text block the model can read directly. */
function renderHits(hits) {
    if (hits.length === 0)
        return '(no published note matched the query)';
    const blocks = hits.map((hit, i) => {
        const header = `### [${i + 1}] ${hit.title}  (path: ${hit.relPath}, kind: ${hit.kind}, score: ${hit.score.toFixed(4)})`;
        return `${header}\n\n${hit.body}`;
    });
    return blocks.join('\n\n---\n\n');
}
/**
 * Build the `memory_search` tool over `published/` at {@link MemorySearchToolOptions.memoryDir}.
 * @param options - the memory root, default top-K, and recall mode.
 * @returns a `defineTool` tool object implementing `memory_search`.
 */
export function createMemorySearchTool(options) {
    return defineTool({
        name: 'memory_search',
        description: 'Recall relevant cross-session knowledge notes on demand. Searches only the published '
            + 'knowledge base (not drafts) using a keyword/BM25-ish index over title and body, and '
            + 'returns the top-K matching notes as full text (title, path, score, body). Use it when '
            + 'you need "what is relevant now"; the time-index overview already covers "what was '
            + 'recently memorized". Each returned note is marked as accessed (its recall count rises).',
        parameters: {
            query: {
                type: 'string',
                required: true,
                description: 'The recall query (a few keywords or a short phrase; mixed CN/EN works).',
            },
            limit: {
                type: 'integer',
                description: `Maximum number of notes to return (default ${options.recallTopK}).`,
            },
            kind: {
                type: 'string',
                description: "Optional bucket filter: 'procedure' | 'personal' | 'wiki'.",
            },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    text: { type: 'string', required: true },
                    count: { type: 'integer' },
                    hits: {
                        type: 'array',
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                title: { type: 'string', required: true },
                                path: { type: 'string', required: true },
                                score: { type: 'number', required: true },
                                kind: { type: 'string', required: true },
                                body: { type: 'string', required: true },
                            },
                        },
                    },
                },
            },
            render: (_args, value) => [{ type: 'text', text: value.text }],
        },
        async execute(args, exec) {
            const session = exec.agent?.session ?? null;
            if (!session)
                throw new Error('memory_search: requires an owning agent session');
            const query = typeof args.query === 'string' ? args.query : '';
            if (query.trim().length === 0)
                throw new Error('memory_search: query is required');
            const limitArg = typeof args.limit === 'number' && Number.isInteger(args.limit) && args.limit > 0
                ? args.limit
                : options.recallTopK;
            const kind = typeof args.kind === 'string' && args.kind.length > 0 ? args.kind : undefined;
            const hits = options.embeddingService
                ? await hybridSearch(options.memoryDir, query, limitArg, kind, options.embeddingService)
                : search(options.memoryDir, query, limitArg, kind);
            const nowIso = new Date().toISOString();
            // Update the aging signal on every hit (REME.md §8 D4): increment use_count
            // and set last_accessed, WITHOUT bumping version (content identity).
            for (const hit of hits) {
                try {
                    updateUsage(options.memoryDir, hit.relPath, nowIso);
                }
                catch {
                    // Usage tracking is observability for Phase D; a failure must never fail recall.
                }
            }
            return {
                text: renderHits(hits),
                count: hits.length,
                hits: hits.map(hit => ({ title: hit.title, path: hit.relPath, score: hit.score, kind: hit.kind, body: hit.body })),
            };
        },
    });
}
//# sourceMappingURL=memory-search-tool.js.map