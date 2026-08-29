/**
 * Unit tests for the `/memory` command handlers (list | show | delete; REME.md §10 Phase A).
 */
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ensureMemoryDirs, writeDraft, type Note, type NoteFrontmatter } from '../src/storage.ts'
import { listMemoryText, showMemoryText, deleteMemoryText } from '../src/memory-cmd.ts'

const roots: string[] = []
const tmp = (): string => {
  const r = mkdtempSync(join(tmpdir(), 'memory-cmd-'))
  roots.push(r)
  return r
}
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
})

function draft(source: string, body: string): Note {
  const now = new Date().toISOString()
  const frontmatter: NoteFrontmatter = {
    kind: 'personal', scope: 'session', session_id: 'sess-1', source,
    source_conversation: 'dialog/sess-1.jsonl', created_at: now, updated_at: now,
    version: 1, use_count: 0, last_accessed: now,
    gate: { mode: 'observe', verdict: 'pass', reviewed_at: now },
  }
  return { frontmatter, body }
}

describe('/memory list', () => {
  it('reports (no memory drafts) when the store is empty', () => {
    const dir = tmp()
    ensureMemoryDirs(dir)
    expect(listMemoryText(dir)).toBe('(no memory drafts)')
  })

  it('lists drafts with kind/scope and source', () => {
    const dir = tmp()
    ensureMemoryDirs(dir)
    writeDraft(dir, draft('turn:0', '# Note A\nbody'), 'sess-1', 'Note A')
    const text = listMemoryText(dir)
    expect(text).toContain('[personal/session]')
    expect(text).toContain('source: turn:0')
    expect(text).toContain('Note A')
  })
})

describe('/memory show', () => {
  it('shows frontmatter + body for an existing draft', () => {
    const dir = tmp()
    ensureMemoryDirs(dir)
    const path = writeDraft(dir, draft('turn:1', '# Shown note\ncontent here'), 'sess-1', 'Shown note')
    const name = path.split(/[\\/]/).pop()!
    const text = showMemoryText(dir, name)
    expect(text).toContain('source: turn:1')
    expect(text).toContain('session_id: sess-1')
    expect(text).toContain('# Shown note')
    expect(text).toContain('content here')
  })

  it('reports unknown for a missing draft', () => {
    const dir = tmp()
    ensureMemoryDirs(dir)
    expect(showMemoryText(dir, 'nope.md')).toContain('Unknown draft')
  })
})

describe('/memory delete', () => {
  it('deletes an existing draft and reports confirmation', () => {
    const dir = tmp()
    ensureMemoryDirs(dir)
    const path = writeDraft(dir, draft('turn:0', '# Del\nx'), 'sess-1', 'Del')
    const name = path.split(/[\\/]/).pop()!
    const out = deleteMemoryText(dir, name)
    expect(out).toContain('Deleted draft')
    expect(existsSync(path)).toBe(false)
  })

  it('refuses to delete outside drafts/ (published notes await Phase C)', () => {
    const dir = tmp()
    const out = deleteMemoryText(dir, join(dir, 'published', 'x.md'))
    expect(out).toContain('not inside')
  })
})
