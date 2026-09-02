/**
 * Phase E embedding seam (REME.md §12.1, T5.4). dsh has no native embeddings API
 * yet, so this package defines its own `EmbeddingService` interface and ships an
 * OpenAI-compatible external Provider. When dsh ships a native seam, add a
 * `DshEmbeddingProvider` implementing the same interface and flip the Config default
 * (`embeddingsProvider`); consumers (`search.ts` `hybridSearch`, `consolidate.ts`
 * `promoteDraft`) need no change.
 *
 * This is a make-do until dsh native — it is NOT a ReMe/Continual-Harness concept.
 * The borrow/idea provenance is a transition decision, logged in the Phase E Agent
 * Note (REME.md §8 D-style). The lexical `search` path is the always-available
 * fallback (`embeddingsProvider` defaults to `'off'`), so the committed unit/real-key
 * suite is unaffected.
 *
 * @module @deepseek-ai/dsh-plugin-rlm-memory/embedding
 */
/** A text-embedding provider: maps N texts to N vectors of a fixed dimension. */
export interface EmbeddingService {
    /** Vector dimension (fixed for a given model). */
    readonly dim: number;
    /** Embed `texts` into vectors; the result order matches `texts`. */
    embed(texts: string[]): Promise<number[][]>;
}
/** Construction options for {@link createExternalEmbeddingProvider}. */
export interface ExternalEmbeddingOptions {
    /** Base URL, e.g. `https://api.openai.com/v1` or a DeepSeek/Voyage endpoint. */
    baseURL: string;
    /** API key (from Config or env; never hardcoded, never committed). */
    apiKey: string;
    /** Model id, e.g. `text-embedding-3-small`. */
    model: string;
    /** Optional fixed dimension; if omitted, inferred from the first response. */
    dim?: number;
    /** Injectable fetch (defaults to `globalThis.fetch`). Tests pass a fake to skip network. */
    fetchImpl?: typeof globalThis.fetch;
    /** Max texts per HTTP request (batching); default 32. */
    batchSize?: number;
    /** Wall-clock budget per HTTP request; an expired request rejects (default 30_000). */
    timeoutMs?: number;
}
/**
 * Build an OpenAI-compatible embedding provider. Speaks
 * `POST {baseURL}/embeddings` with `{ model, input }` and reads
 * `{ data: [{ embedding, index }] }`; pass `baseURL` as the OpenAI-compatible base
 * (e.g. `https://api.openai.com/v1`) — the `/embeddings` path is appended, so do NOT
 * include it in `baseURL`. Swapping vendors = change `baseURL`/`apiKey`/`model`; zero
 * code change. Fails loud on a non-OK HTTP response.
 * @param opts - provider configuration.
 * @returns an {@link EmbeddingService}.
 */
export declare function createExternalEmbeddingProvider(opts: ExternalEmbeddingOptions): EmbeddingService;
/**
 * Deterministic fake embedding service for tests: hashes each token (ASCII word or
 * single CJK codepoint) into a stable pseudo-vector, so texts sharing vocabulary score
 * closer (cosine) than unrelated texts. Not for production. Dimension is fixed.
 * @param dim - vector dimension (default 16).
 * @returns a deterministic {@link EmbeddingService}.
 */
export declare function createFakeEmbeddingService(dim?: number): EmbeddingService;
/**
 * Cosine similarity of two equal-length vectors, in `[-1, 1]`. Returns 0 for an empty
 * or zero vector (no signal), so a missing cached embedding degrades to "no semantic
 * match" rather than NaN.
 * @param a - first vector.
 * @param b - second vector.
 * @returns cosine similarity.
 */
export declare function cosine(a: number[], b: number[]): number;
//# sourceMappingURL=embedding.d.ts.map