/**
 * Unit tests for the frontmatter round-trip (write a note, read it back; REME.md §4 D4).
 */
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ensureMemoryDirs,
  writeDraft,
  parseNote,
  listDrafts,
  readDialog,
  writeDialog,
  deleteDraft,
  type Note,
  type NoteFrontmatter,
} from '../src/storage.ts'

const roots: string[] = []
const tmp = (): string => {
  const r = mkdtempSync(join(tmpdir(), 'memory-fm-'))
  roots.push(r)
  return r
}
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
})

function sampleNote(source: string): Note {
  const now = new Date().toISOString()
  const frontmatter: NoteFrontmatter = {
    kind: 'procedure',
    scope: 'session',
    session_id: 'sess-abc',
    source,
    source_conversation: 'dialog/sess-abc.jsonl',
    created_at: now,
    updated_at: now,
    version: 1,
    use_count: 0,
    last_accessed: now,
    gate: { mode: 'observe', verdict: 'pass', reviewed_at: now },
  }
  return { frontmatter, body: '# How to sort\nUse `sorted()` on an iterable.' }
}

describe('frontmatter write/read round-trip', () => {
  it('writeDraft then parseNote recovers frontmatter and body exactly', () => {
    const dir = tmp()
    ensureMemoryDirs(dir)
    const path = writeDraft(dir, sampleNote('turn:0'), 'sess-abc', 'How to sort')
    expect(existsSync(path)).toBe(true)
    const note = parseNote(path)
    expect(note).not.toBeNull()
    expect(note!.frontmatter.kind).toBe('procedure')
    expect(note!.frontmatter.source).toBe('turn:0')
    expect(note!.frontmatter.session_id).toBe('sess-abc')
    expect(note!.frontmatter.gate).toEqual({ mode: 'observe', verdict: 'pass', reviewed_at: note!.frontmatter.gate.reviewed_at })
    expect(note!.body).toBe('# How to sort\nUse `sorted()` on an iterable.')
  })

  it('serializeNote then parseNote is stable (no data loss across the fence)', () => {
    const dir = tmp()
    ensureMemoryDirs(dir)
    const note = sampleNote('contains:sort')
    const path = writeDraft(dir, note, 'sess-abc', 'sort note')
    const note2 = parseNote(path)
    expect(note2).not.toBeNull()
    expect(note2!.frontmatter).toEqual(note.frontmatter)
    expect(note2!.body).toBe(note.body)
  })

  it('listDrafts enumerates across kind subdirs', () => {
    const dir = tmp()
    ensureMemoryDirs(dir)
    writeDraft(dir, sampleNote('turn:0'), 's1', 'A')
    writeDraft(dir, { ...sampleNote('turn:1'), frontmatter: { ...sampleNote('turn:1').frontmatter, kind: 'wiki' } }, 's1', 'B')
    const drafts = listDrafts(dir)
    expect(drafts).toHaveLength(2)
  })
})

describe('dialog persistence', () => {
  it('writeDialog then readDialog round-trips sanitized turns', () => {
    const dir = tmp()
    writeDialog(dir, 'sess-xyz', JSON.stringify({ role: 'user', content: 'hi' }) + '\n' + JSON.stringify({ role: 'assistant', content: 'yo' }) + '\n')
    const turns = readDialog(dir, 'sess-xyz')
    expect(turns).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'yo' },
    ])
  })

  it('readDialog returns [] for an absent session', () => {
    expect(readDialog(tmp(), 'nope')).toEqual([])
  })
})

describe('deleteDraft (drafts-only guard)', () => {
  it('deletes a draft inside drafts/', () => {
    const dir = tmp()
    ensureMemoryDirs(dir)
    const path = writeDraft(dir, sampleNote('turn:0'), 's1', 'A')
    deleteDraft(dir, path)
    expect(existsSync(path)).toBe(false)
  })

  it('throws when the path escapes drafts/ (published notes not deletable in Phase A)', () => {
    const dir = tmp()
    const outside = join(dir, 'published', 'x.md')
    expect(() => deleteDraft(dir, outside)).toThrow(/not inside/)
  })
})
