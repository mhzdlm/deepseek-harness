/**
 * Unit tests for Phase D retirement (REME.md §5.4, §8 D3/D12, §9, §10 Phase D acceptance,
 * §12 open question 1): `observe` only logs (note stays published); `enforce` moves
 * published → archived AND `unretire` moves it back (content preserved, published count
 * recovers); the conservative-default case (a note with `use_count >= agingMinUseCount` OR
 * recent `last_accessed` is NOT a candidate even under `enforce`); and the NEVER-DELETE case
 * (after retire the bytes exist under `archived/`, assert no deletion). Scoring is
 * deterministic use_count + recency, no LLM/embeddings.
 */
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ensureMemoryDirs,
  writePublished,
  listPublished,
  listArchived,
  parseNote,
  readNote,
  type Note,
  type NoteFrontmatter,
} from '../src/storage.ts'
import {
  retireNote,
  unretireNote,
  listArchivedNotes,
  type RetireOptions,
} from '../src/retire.ts'

const roots: string[] = []
const tmp = (): string => {
  const r = mkdtempSync(join(tmpdir(), 'memory-retire-'))
  roots.push(r)
  return r
}
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
})

// Fixed reference instant so age math is deterministic across runs.
const NOW = Date.parse('2026-08-30T00:00:00.000Z')
const daysAgoIso = (days: number): string => new Date(NOW - days * 86_400_000).toISOString()

function fm(over: Partial<NoteFrontmatter> = {}): NoteFrontmatter {
  const now = daysAgoIso(0)
  return {
    kind: 'personal',
    scope: 'global',
    session_id: 'sess-1',
    source: 'turn:0',
    source_conversation: 'dialog/sess-1.jsonl',
    created_at: now,
    updated_at: now,
    version: 1,
    use_count: 0,
    last_accessed: now,
    gate: { mode: 'observe', verdict: 'pass', reviewed_at: now },
    ...over,
  }
}

function pubNote(dir: string, slug: string, over: Partial<NoteFrontmatter> = {}): string {
  return writePublishedWithSource(dir, slug, { frontmatter: fm(over), body: `# ${slug}\nbody for ${slug}` })
}

// Write a published note whose relPath slug is `slug` (so listPublished/archived match it).
// Phase 8: the explicit relPath keeps these fixtures addressable by bare slug —
// production promotions gain a session suffix, but these seeds are hand-placed.
function writePublishedWithSource(dir: string, slug: string, base: Note): string {
  const note: Note = { ...base, frontmatter: { ...base.frontmatter, source: slug } }
  return writePublished(dir, note, `published/${note.frontmatter.kind}/${slug}.md`)
}

const OFF: RetireOptions = { exitMode: 'off', agingMinAgeDays: 180, agingMinUseCount: 1 }
const OBSERVE: RetireOptions = { exitMode: 'observe', agingMinAgeDays: 180, agingMinUseCount: 1 }
const ENFORCE: RetireOptions = { exitMode: 'enforce', agingMinAgeDays: 180, agingMinUseCount: 1 }

describe('exitMode off', () => {
  it('retire is a logged no-op; the note stays published', async () => {
    const dir = tmp()
    ensureMemoryDirs(dir)
    pubNote(dir, 'keep')
    const msg = await retireNote(dir, 'keep', OFF)
    expect(msg).toContain('exitMode=off')
    expect(listPublished(dir).length).toBe(1)
    expect(listArchived(dir).length).toBe(0)
  })
})

describe('exitMode observe', () => {
  it('does NOT move the note; it stays published', async () => {
    const dir = tmp()
    ensureMemoryDirs(dir)
    pubNote(dir, 'observe-me', { last_accessed: daysAgoIso(200), use_count: 0 })
    const msg = await retireNote(dir, 'observe-me', OBSERVE)
    expect(msg).toContain('observe')
    expect(listPublished(dir).length).toBe(1) // unchanged
    expect(listArchived(dir).length).toBe(0) // never moved
  })
})

describe('exitMode enforce', () => {
  it('moves published → archived, preserves bytes, and is reversible via unretire', async () => {
    const dir = tmp()
    ensureMemoryDirs(dir)
    const body = '# Retire target\nthis is the durable content that must survive the move'
    writePublishedWithSource(dir, 'target', { frontmatter: fm({ source: 'target', last_accessed: daysAgoIso(200), use_count: 0 }), body })
    // retire
    const msg = await retireNote(dir, 'target', ENFORCE)
    expect(msg).toContain('Retired')
    expect(listPublished(dir).length).toBe(0)
    expect(listArchived(dir).length).toBe(1)
    // NEVER-DELETE: the bytes exist under archived/ (not removed)
    const archivedPath = listArchived(dir)[0]!
    expect(existsSync(archivedPath)).toBe(true)
    const archivedNote = parseNote(archivedPath)!
    expect(archivedNote.body).toBe(body)
    expect(archivedNote.frontmatter.retired_at).toBeDefined()

    // unretire → back under published/, content identical, archived empty again
    const umsg = await unretireNote(dir, 'target')
    expect(umsg).toContain('Un-retired')
    expect(listPublished(dir).length).toBe(1)
    expect(listArchived(dir).length).toBe(0)
    const restored = readNote(dir, 'published/personal/target.md')!
    expect(restored.body).toBe(body)
    expect(restored.frontmatter.retired_at).toBeUndefined()
  })

  it('does not retire a non-candidate under enforce (conservative default)', async () => {
    const dir = tmp()
    ensureMemoryDirs(dir)
    pubNote(dir, 'safe', { last_accessed: daysAgoIso(10), use_count: 0 })
    const msg = await retireNote(dir, 'safe', ENFORCE)
    expect(msg).toContain('not a retire candidate')
    expect(listPublished(dir).length).toBe(1)
    expect(listArchived(dir).length).toBe(0)
  })

  it('force bypasses the threshold for an explicit user retire', async () => {
    const dir = tmp()
    ensureMemoryDirs(dir)
    pubNote(dir, 'forced', { last_accessed: daysAgoIso(1), use_count: 5 })
    const msg = await retireNote(dir, 'forced', ENFORCE, true)
    expect(msg).toContain('Retired')
    expect(listPublished(dir).length).toBe(0)
    expect(listArchived(dir).length).toBe(1)
  })
})

describe('listArchivedNotes', () => {
  it('reflects retired notes and empties after unretire', async () => {
    const dir = tmp()
    ensureMemoryDirs(dir)
    writePublishedWithSource(dir, 'only', { frontmatter: fm({ source: 'only', last_accessed: daysAgoIso(300), use_count: 0 }), body: '# Only' })
    await retireNote(dir, 'only', ENFORCE)
    const listed = listArchivedNotes(dir)
    expect(listed.some(r => r.includes('only'))).toBe(true)
    await unretireNote(dir, 'only')
    expect(listArchivedNotes(dir)).toHaveLength(0)
  })
})
