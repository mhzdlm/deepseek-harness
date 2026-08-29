/**
 * Unit tests for the Phase B keyword recall: index rebuild from `published/`,
 * ranked search, rebuild equivalence, and the §8 D4 use-signal increment
 * (REME.md §5.2 D8, §10 Phase B acceptance). The index is derived from files
 * each call, so two independent buildIndex+search calls must rank identically.
 */
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { tokenize, buildIndex, search } from '../src/search.ts'
import { ensureMemoryDirs, writePublished, listPublished, parseNote, updateUsage, type Note, type NoteFrontmatter } from '../src/storage.ts'

const roots: string[] = []
const tmp = (): string => {
  const r = mkdtempSync(join(tmpdir(), 'memory-search-'))
  roots.push(r)
  return r
}
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
})

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

describe('tokenize (mixed CN/EN)', () => {
  it('emits lowercased ASCII words of length >= 2', () => {
    const terms = tokenize('Sort a List in Python')
    expect(terms.get('sort')).toBe(1)
    expect(terms.get('list')).toBe(1)
    expect(terms.get('python')).toBe(1)
    expect(terms.has('a')).toBe(false) // length < 2 dropped
  })

  it('emits CJK character bigrams so Chinese queries match', () => {
    const terms = tokenize('排序列表')
    // bigrams: 排序, 序列, 列表
    expect(terms.get('排序')).toBe(1)
    expect(terms.get('序列')).toBe(1)
    expect(terms.get('列表')).toBe(1)
  })
})

describe('search ranking', () => {
  it('returns the more relevant note first', () => {
    const dir = tmp()
    ensureMemoryDirs(dir)
    writePublished(dir, sampleNote('sort-algo', '# Sorting in Python\nUse sorted() to sort a list efficiently.'))
    writePublished(dir, sampleNote('cooking', '# A recipe\nMix flour and water to bake bread.'))

    // "sort list" matches the sorting note (two terms) but not the recipe.
    const hits = search(dir, 'sort list', 5)
    expect(hits.length).toBeGreaterThanOrEqual(1)
    expect(hits[0]!.title).toContain('Sorting')
  })

  it('returns empty when the query term is in neither note', () => {
    const dir = tmp()
    ensureMemoryDirs(dir)
    writePublished(dir, sampleNote('a', '# Alpha\nSomething about alpha.'))
    writePublished(dir, sampleNote('b', '# Beta\nSomething about beta.'))
    expect(search(dir, 'zebra-quantum-xyz', 5)).toEqual([])
  })

  it('kind filter excludes other buckets', () => {
    const dir = tmp()
    ensureMemoryDirs(dir)
    writePublished(dir, sampleNote('personal-note', '# Personal\nremember to sort the list.', 'personal'))
    writePublished(dir, sampleNote('wiki-note', '# Wiki\nhow to sort a list.', 'wiki'))
    const hits = search(dir, 'sort list', 5, 'wiki')
    expect(hits.length).toBe(1)
    expect(hits[0]!.kind).toBe('wiki')
  })
})

describe('rebuild equivalence (delete-and-rerun)', () => {
  it('two independent buildIndex+search calls rank identically', () => {
    const dir = tmp()
    ensureMemoryDirs(dir)
    writePublished(dir, sampleNote('s1', '# Sorting\nSort a list with sorted().'))
    writePublished(dir, sampleNote('s2', '# Cooking\nBake bread from flour.'))
    writePublished(dir, sampleNote('s3', '# Searching\nBinary search a sorted list.'))

    const runA = search(dir, 'sort list', 5)
    const runB = search(dir, 'sort list', 5)
    expect(runA.map(h => h.relPath)).toEqual(runB.map(h => h.relPath))
    expect(runA.map(h => h.score)).toEqual(runB.map(h => h.score))
    // The index is rebuilt from files; listPublished proves the source of truth.
    expect(listPublished(dir).length).toBe(3)
    expect(buildIndex(dir).notes.length).toBe(3)
  })
})

describe('use-signal increment (REME.md §8 D4)', () => {
  it('updates use_count and last_accessed but not version on a search hit', () => {
    const dir = tmp()
    ensureMemoryDirs(dir)
    const path = writePublished(dir, sampleNote('hit-me', '# Recall target\nThis note is about sorting a list.'))
    const before = parseNote(path)!
    expect(before.frontmatter.use_count).toBe(0)

    const hits = search(dir, 'sorting list', 5)
    expect(hits.length).toBeGreaterThanOrEqual(1)
    // The tool applies the §8 D4 use-signal on each hit; `search` stays pure
    // (so rebuild equivalence never mutates files). Replicate the tool's update
    // here to assert the storage write path increments use_count.
    updateUsage(dir, hits[0]!.relPath, new Date().toISOString())

    const after = parseNote(path)!
    expect(after.frontmatter.use_count).toBe(1)
    // last_accessed moved to a later timestamp (the search sets it to "now").
    expect(new Date(after.frontmatter.last_accessed).getTime()).toBeGreaterThanOrEqual(new Date(before.frontmatter.last_accessed).getTime())
    // version tracks content, not access: unchanged.
    expect(after.frontmatter.version).toBe(before.frontmatter.version)
  })

  it('updateUsage increments use_count without bumping version', () => {
    const dir = tmp()
    ensureMemoryDirs(dir)
    const path = writePublished(dir, sampleNote('u', '# U\nbody'))
    updateUsage(dir, path, new Date().toISOString())
    const note = parseNote(path)!
    expect(note.frontmatter.use_count).toBe(1)
    expect(note.frontmatter.version).toBe(1)
    expect(existsSync(path)).toBe(true)
  })
})
