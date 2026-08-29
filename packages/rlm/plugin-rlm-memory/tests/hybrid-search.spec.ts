/**
 * Phase E hybrid recall (REME.md §12.1): `hybridSearch` fuses lexical BM25 with cached
 * embedding cosine. These tests prove the semantic path executes end-to-end (embed ->
 * cache -> read -> blend) and that publish-time caching (`promoteDraft` via `consolidate`)
 * populates the embedding cache `hybridSearch` consumes. The lexical `search` is left
 * untouched and covered by search.spec.ts.
 *
 * Note: the deterministic fake embedding is token-overlap based, so it validates the
 * mechanism (cache + blend), not true semantic ranking — real semantic recall is gated
 * behind the real-key e2e (rlm-memory-real.e2e.ts) using a real OpenAI-compatible model.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { search, hybridSearch } from '../src/search.ts'
import {
  ensureMemoryDirs,
  writePublished,
  writeDraft,
  publishedRelFor,
  readEmbedding,
  writeEmbedding,
  listPublished,
  type Note,
  type NoteFrontmatter,
} from '../src/storage.ts'
import { consolidate } from '../src/consolidate.ts'
import { createFakeEmbeddingService } from '../src/embedding.ts'

const roots: string[] = []
const tmp = (): string => {
  const r = mkdtempSync(join(tmpdir(), 'memory-hybrid-'))
  roots.push(r)
  return r
}
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
})

/** Normalize OS path separators so Windows `published\...` equals `published/...`. */
const norm = (p: string): string => p.replace(/\\/g, '/')

function sampleNote(source: string, body: string, kind: NoteFrontmatter['kind'] = 'procedure'): Note {
  const now = new Date().toISOString()
  const frontmatter: NoteFrontmatter = {
    kind,
    scope: 'session',
    session_id: 'sess-x',
    source,
    source_conversation: 'dialog/sess-x.jsonl',
    created_at: now,
    updated_at: now,
    version: 1,
    use_count: 0,
    last_accessed: now,
    gate: { mode: 'observe', verdict: 'pass', reviewed_at: now },
  }
  return { frontmatter, body }
}

/** Cache a note's embedding the way `promoteDraft` does at publish time. */
async function cacheEmbedding(dir: string, note: Note, svc = createFakeEmbeddingService(32)): Promise<void> {
  const rel = publishedRelFor(note)
  const [vec] = await svc.embed([`${note.frontmatter.source}\n${note.body}`])
  if (vec) writeEmbedding(dir, rel, vec)
}

describe('hybridSearch mechanism', () => {
  it('lexical baseline: search finds the token-overlapping note', () => {
    const dir = tmp()
    ensureMemoryDirs(dir)
    const sortNote = sampleNote('sort-algo', '# Sorting in Python\nUse sorted() to sort a list efficiently.')
    writePublished(dir, sortNote)
    writePublished(dir, sampleNote('cooking', '# A recipe\nMix flour and water to bake bread.'))
    const hits = search(dir, 'sort list python', 5)
    expect(hits.length).toBeGreaterThanOrEqual(1)
    expect(norm(hits[0]!.relPath)).toBe(norm(publishedRelFor(sortNote)))
  })

  it('hybridSearch runs the embed+cache+blend path and ranks the overlapping note first', async () => {
    const dir = tmp()
    ensureMemoryDirs(dir)
    const sortNote = sampleNote('sort-algo', '# Sorting in Python\nUse sorted() to sort a list efficiently.')
    const cookNote = sampleNote('cooking', '# A recipe\nMix flour and water to bake bread.')
    writePublished(dir, sortNote)
    writePublished(dir, cookNote)

    const svc = createFakeEmbeddingService(32)
    await cacheEmbedding(dir, sortNote, svc)
    await cacheEmbedding(dir, cookNote, svc)

    const hits = await hybridSearch(dir, 'sort list python', 5, undefined, svc)
    expect(hits.length).toBeGreaterThanOrEqual(1)
    expect(norm(hits[0]!.relPath)).toBe(norm(publishedRelFor(sortNote)))
  })

  it('falls back to lexical when a note has no cached embedding', async () => {
    const dir = tmp()
    ensureMemoryDirs(dir)
    const sortNote = sampleNote('sort-algo', '# Sorting in Python\nUse sorted() to sort a list efficiently.')
    writePublished(dir, sortNote) // no embedding cache written
    const svc = createFakeEmbeddingService(32)
    const hits = await hybridSearch(dir, 'sort list', 5, undefined, svc)
    expect(hits.length).toBeGreaterThanOrEqual(1)
    expect(norm(hits[0]!.relPath)).toBe(norm(publishedRelFor(sortNote)))
  })

  it('returns nothing for a query with no lexical or cached-vector overlap', async () => {
    const dir = tmp()
    ensureMemoryDirs(dir)
    const sortNote = sampleNote('sort-algo', '# Sorting in Python\nUse sorted() to sort a list efficiently.')
    writePublished(dir, sortNote)
    const svc = createFakeEmbeddingService(32)
    await cacheEmbedding(dir, sortNote, svc)
    const hits = await hybridSearch(dir, 'zzz qqq', 5, undefined, svc)
    expect(hits).toEqual([])
  })
})

describe('publish-time embedding cache', () => {
  it('consolidate caches the promoted note embedding when a provider is given', async () => {
    const dir = tmp()
    ensureMemoryDirs(dir)
    const draft = sampleNote('draft-src', '# How to sort\nSort a list in python.')
    writeDraft(dir, draft, 'sess-x', 'draft-src')
    const svc = createFakeEmbeddingService(32)
    await consolidate(dir, {
      gateMode: 'observe',
      maxPublishedNotes: 200,
      maxPublishedBytes: 5_000_000,
      embeddingService: svc,
    })
    expect(listPublished(dir).length).toBe(1)
    // The promoted note's embedding was cached at publish time.
    expect(readEmbedding(dir, publishedRelFor(draft))).not.toBeNull()
  })

  it('consolidate leaves no cache when no provider is given (lexical fallback)', async () => {
    const dir = tmp()
    ensureMemoryDirs(dir)
    const draft = sampleNote('draft-src', '# How to sort\nSort a list in python.')
    writeDraft(dir, draft, 'sess-x', 'draft-src')
    await consolidate(dir, { gateMode: 'observe', maxPublishedNotes: 200, maxPublishedBytes: 5_000_000 })
    expect(readEmbedding(dir, publishedRelFor(draft))).toBeNull()
  })
})
