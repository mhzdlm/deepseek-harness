/**
 * Unit tests for the evidence gate: a draft's `source` MUST locate inside its
 * dialog jsonl (REME.md §5.1 D6). Borrow /refine FIX-8 evidence-required.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { parseSource, sourceLocatesInDialog, admitByEvidence } from '../src/evidence.ts'
import { persistCapture } from '../src/capture.ts'
import { listDrafts, parseNote, type Note, type NoteFrontmatter } from '../src/storage.ts'
import { type CaptureTurn } from '../src/sanitize.ts'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dialog: Array<{ role: string; content: string }> = [
  { role: 'user', content: 'How do I sort a list in Python?' },
  { role: 'assistant', content: 'Use sorted(my_list) to get a new sorted list.' },
  { role: 'user', content: 'What about in place?' },
  { role: 'assistant', content: 'Call my_list.sort() to sort in place.' },
]

function note(source: string): Note {
  const now = new Date().toISOString()
  const frontmatter: NoteFrontmatter = {
    kind: 'procedure', scope: 'session', session_id: 's', source,
    source_conversation: 'dialog/s.jsonl', created_at: now, updated_at: now,
    version: 1, use_count: 0, last_accessed: now,
    gate: { mode: 'observe', verdict: 'pass', reviewed_at: now },
  }
  return { frontmatter, body: 'b' }
}

describe('parseSource', () => {
  it('parses turn:N, turn:N-M, and contains:<text>', () => {
    expect(parseSource('turn:0')).toEqual({ kind: 'turn', index: 0 })
    expect(parseSource('turn:1-3')).toEqual({ kind: 'span', start: 1, end: 3 })
    expect(parseSource('contains:sort()')).toEqual({ kind: 'contains', text: 'sort()' })
  })

  it('rejects unrecognized syntax (null)', () => {
    expect(parseSource('line:5')).toBeNull()
    expect(parseSource('turn:3-1')).toBeNull()
  })
})

describe('sourceLocatesInDialog', () => {
  it('accepts a turn index in range', () => {
    expect(sourceLocatesInDialog('turn:2', dialog)).toBe(true)
  })

  it('rejects a turn index out of range', () => {
    expect(sourceLocatesInDialog('turn:9', dialog)).toBe(false)
  })

  it('accepts a span fully in range, rejects a partially out-of-range span', () => {
    expect(sourceLocatesInDialog('turn:0-3', dialog)).toBe(true)
    expect(sourceLocatesInDialog('turn:2-5', dialog)).toBe(false)
  })

  it('accepts contains: when a line includes the substring', () => {
    expect(sourceLocatesInDialog('contains:sorted(my_list)', dialog)).toBe(true)
    expect(sourceLocatesInDialog('contains:nonexistent', dialog)).toBe(false)
  })

  it('rejects an unparseable source (gate fails closed)', () => {
    expect(sourceLocatesInDialog('garbage', dialog)).toBe(false)
  })
})

describe('admitByEvidence', () => {
  it('keeps only notes whose source locates; drops the rest (validated-proposal filter)', () => {
    const notes = [note('turn:1'), note('turn:99'), note('contains:sort()'), note('garbage')]
    const admitted = admitByEvidence(notes, dialog)
    expect(admitted.map(n => n.frontmatter.source).sort()).toEqual(['contains:sort()', 'turn:1'])
  })

  it('admits nothing when no source resolves', () => {
    expect(admitByEvidence([note('turn:50')], dialog)).toEqual([])
  })
})

describe('gate-backed persist (integration with storage)', () => {
  const roots: string[] = []
  afterEach(() => {
    while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
  })

  it('persistCapture writes dialog unconditionally and lands only gated drafts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memory-evidence-'))
    roots.push(dir)
    const turns: CaptureTurn[] = [
      { role: 'user', content: 'How do I sort a list in Python?' },
      { role: 'assistant', content: 'Use sorted(my_list) to get a new sorted list.' },
    ]
    const summary = persistCapture(dir, { sessionId: 's', turns }, [
      note('turn:0'),
      note('turn:100'),
    ])
    expect(summary.dialogTurns).toBe(2)
    expect(summary.draftsAdmitted).toBe(1)
    // The one admitted draft is readable and cites a locatable source.
    const drafts = listDrafts(dir)
    expect(drafts).toHaveLength(1)
    const written = parseNote(drafts[0]!)
    expect(written!.frontmatter.source).toBe('turn:0')
    // The dialog jsonl exists even though one proposal was rejected.
    expect(existsSync(join(dir, 'dialog', 's.jsonl'))).toBe(true)
    expect(listDrafts(dir)).toHaveLength(1)
  })
})
