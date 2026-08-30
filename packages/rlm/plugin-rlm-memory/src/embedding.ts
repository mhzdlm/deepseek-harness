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
  readonly dim: number
  /** Embed `texts` into vectors; the result order matches `texts`. */
  embed(texts: string[]): Promise<number[][]>
}

/** OpenAI-compatible `/v1/embeddings` request body (subset sent). */
interface OpenAIEmbedRequest {
  model: string
  input: string[]
}

/** OpenAI-compatible `/v1/embeddings` response (subset read). */
interface OpenAIEmbedResponse {
  data: Array<{ embedding: number[]; index: number }>
  model?: string
}

/** Construction options for {@link createExternalEmbeddingProvider}. */
export interface ExternalEmbeddingOptions {
  /** Base URL, e.g. `https://api.openai.com/v1` or a DeepSeek/Voyage endpoint. */
  baseURL: string
  /** API key (from Config or env; never hardcoded, never committed). */
  apiKey: string
  /** Model id, e.g. `text-embedding-3-small`. */
  model: string
  /** Optional fixed dimension; if omitted, inferred from the first response. */
  dim?: number
  /** Injectable fetch (defaults to `globalThis.fetch`). Tests pass a fake to skip network. */
  fetchImpl?: typeof globalThis.fetch
  /** Max texts per HTTP request (batching); default 32. */
  batchSize?: number
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
export function createExternalEmbeddingProvider(opts: ExternalEmbeddingOptions): EmbeddingService {
  const base = opts.baseURL.replace(/\/+$/, '')
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  const batchSize = opts.batchSize && opts.batchSize > 0 ? opts.batchSize : 32
  let dim = opts.dim ?? 0
  return {
    get dim() {
      return dim
    },
    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return []
      const out: number[][] = new Array<number[]>(texts.length)
      for (let i = 0; i < texts.length; i += batchSize) {
        const batch = texts.slice(i, i + batchSize)
        const res = await fetchImpl(`${base}/embeddings`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${opts.apiKey}` },
          body: JSON.stringify({ model: opts.model, input: batch } satisfies OpenAIEmbedRequest),
        })
        if (!res.ok) {
          const text = await res.text().catch(() => '')
          throw new Error(`[plugin-rlm-memory] embeddings request failed (${res.status}): ${text.slice(0, 200)}`)
        }
        const json = (await res.json()) as OpenAIEmbedResponse
        for (const item of json.data ?? []) {
          const at = i + item.index
          if (at >= 0 && at < texts.length) out[at] = item.embedding
          if (dim === 0) dim = item.embedding.length
        }
      }
      for (let i = 0; i < out.length; i++) if (out[i] === undefined) out[i] = new Array<number>(dim).fill(0)
      return out
    },
  }
}

/**
 * Deterministic fake embedding service for tests: hashes each token (ASCII word or
 * single CJK codepoint) into a stable pseudo-vector, so texts sharing vocabulary score
 * closer (cosine) than unrelated texts. Not for production. Dimension is fixed.
 * @param dim - vector dimension (default 16).
 * @returns a deterministic {@link EmbeddingService}.
 */
export function createFakeEmbeddingService(dim = 16): EmbeddingService {
  const vec = (text: string): number[] => {
    const v = new Array<number>(dim).fill(0)
    for (const tok of text.toLowerCase().match(/[a-z0-9]+|[一-鿿]/g) ?? []) {
      let h = 2166136261
      for (let i = 0; i < tok.length; i++) {
        h ^= tok.charCodeAt(i)
        h = Math.imul(h, 16777619)
      }
      const idx = Math.abs(h) % dim
      v[idx] = (v[idx] ?? 0) + 1
    }
    return v
  }
  return {
    dim,
    embed(texts: string[]): Promise<number[][]> {
      return Promise.resolve(texts.map(vec))
    },
  }
}

/**
 * Cosine similarity of two equal-length vectors, in `[-1, 1]`. Returns 0 for an empty
 * or zero vector (no signal), so a missing cached embedding degrades to "no semantic
 * match" rather than NaN.
 * @param a - first vector.
 * @param b - second vector.
 * @returns cosine similarity.
 */
export function cosine(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0) return 0
  let dot = 0
  let na = 0
  let nb = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const av = a[i] ?? 0
    const bv = b[i] ?? 0
    dot += av * bv
    na += av * av
    nb += bv * bv
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}
