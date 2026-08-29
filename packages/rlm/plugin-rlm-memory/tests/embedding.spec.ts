/**
 * Phase E embedding seam (REME.md §12.1): the `EmbeddingService` interface, the
 * OpenAI-compatible `ExternalEmbeddingProvider` (driven by an injected fake `fetchImpl`
 * so no network is touched), and the deterministic `FakeEmbeddingService` used by the
 * hybrid-search tests.
 */
import { describe, expect, it } from 'vitest'
import { createExternalEmbeddingProvider, createFakeEmbeddingService, cosine } from '../src/embedding.ts'

/** Minimal stand-in for `globalThis.fetch` returning a canned OpenAI-shaped body. */
function makeFakeFetch(body: unknown, opts: { ok?: boolean; status?: number } = {}) {
  const ok = opts.ok ?? true
  const status = opts.status ?? 200
  return (async (_url: string, _init?: unknown) => ({
    ok,
    status,
    text: async () => (ok ? '' : 'boom'),
    json: async () => body,
  })) as unknown as typeof globalThis.fetch
}

/** First element of a non-empty embedding batch, without a non-null assertion. */
function head(vectors: number[][]): number[] {
  for (const v of vectors) return v
  throw new Error('expected at least one embedding vector')
}

describe('FakeEmbeddingService', () => {
  it('is deterministic and fixed-dimension', async () => {
    const svc = createFakeEmbeddingService(16)
    const a = await svc.embed(['sort a list'])
    const b = await svc.embed(['sort a list'])
    expect(a).toEqual(b)
    expect(a.length).toBe(1)
    expect(a[0]?.length).toBe(16)

    const two = await svc.embed(['one', 'two'])
    expect(two).toHaveLength(2)
    expect(two[0]?.length).toBe(16)
  })

  it('scores shared vocabulary closer than unrelated text', async () => {
    const svc = createFakeEmbeddingService(64)
    const v1 = await svc.embed(['sort a list in python'])
    const v2 = await svc.embed(['order a list in python'])
    const v3 = await svc.embed(['bake bread from flour'])
    expect(cosine(head(v1), head(v2))).toBeGreaterThan(cosine(head(v1), head(v3)))
  })
})

describe('ExternalEmbeddingProvider', () => {
  it('maps an OpenAI-shaped response preserving order and infers dim', async () => {
    const svc = createExternalEmbeddingProvider({
      baseURL: 'https://x.test/v1',
      apiKey: 'KEY',
      model: 'm',
      fetchImpl: makeFakeFetch({ data: [
        { embedding: [0.1, 0.2], index: 0 },
        { embedding: [0.3, 0.4], index: 1 },
      ] }),
    })
    expect(svc.dim).toBe(0) // inferred on first embed
    const out = await svc.embed(['a', 'b'])
    expect(out).toEqual([[0.1, 0.2], [0.3, 0.4]])
    expect(svc.dim).toBe(2)
  })

  it('POSTs to {baseURL}/embeddings with Bearer auth and the model id', async () => {
    const body = { data: [{ embedding: [0.5], index: 0 }] }
    const calls: Array<{ url: string; auth: string; sentModel: string }> = []
    const fetchImpl = (async (url: string, init?: { headers?: Record<string, string>; body?: string }) => {
      calls.push({
        url,
        auth: init?.headers?.authorization ?? '',
        sentModel: (JSON.parse(init?.body ?? '{}') as { model: string }).model,
      })
      return { ok: true, status: 200, text: async () => '', json: async () => body } as unknown as Response
    }) as unknown as typeof globalThis.fetch
    const svc = createExternalEmbeddingProvider({
      baseURL: 'https://x.test/v1/',
      apiKey: 'SECRET',
      model: 'text-embedding-3-small',
      fetchImpl,
    })
    await svc.embed(['hi'])
    expect(calls.length).toBe(1)
    expect(calls[0]?.url).toBe('https://x.test/v1/embeddings')
    expect(calls[0]?.auth).toBe('Bearer SECRET')
    expect(calls[0]?.sentModel).toBe('text-embedding-3-small')
  })

  it('fails loud on a non-OK response', async () => {
    const svc = createExternalEmbeddingProvider({
      baseURL: 'https://x.test/v1',
      apiKey: 'KEY',
      model: 'm',
      fetchImpl: makeFakeFetch({ error: 'nope' }, { ok: false, status: 401 }),
    })
    await expect(svc.embed(['a'])).rejects.toThrow(/401/)
  })

  it('batches requests by batchSize', async () => {
    const body = (n: number) => ({ data: Array.from({ length: n }, (_, i) => ({ embedding: [i], index: i })) })
    let calls = 0
    const fetchImpl = (async (_url: string, init?: { body?: string }) => {
      calls++
      const input = (JSON.parse(init?.body ?? '{}') as { input: string[] }).input
      return { ok: true, status: 200, text: async () => '', json: async () => body(input.length) } as unknown as Response
    }) as unknown as typeof globalThis.fetch
    const svc = createExternalEmbeddingProvider({
      baseURL: 'https://x.test/v1',
      apiKey: 'K',
      model: 'm',
      batchSize: 2,
      fetchImpl,
    })
    const out = await svc.embed(['a', 'b', 'c'])
    expect(calls).toBe(2) // 3 texts, batch 2 -> 2 requests
    expect(out).toHaveLength(3)
  })
})
