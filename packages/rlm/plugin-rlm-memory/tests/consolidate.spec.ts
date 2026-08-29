/**
 * Unit tests for Phase C consolidation (REME.md §5.3, §10 Phase C acceptance):
 * observe promotes a draft WITHOUT valid evidence (gate:'observe'); enforce promotes a
 * draft WITH valid evidence (gate:'enforce') AND rejects a draft WITHOUT valid evidence
 * (stays draft, rejection recorded); the single-flight lock prevents a double promote.
 */
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ensureMemoryDirs, writeDraft, writeDialog, writePublished, listDrafts, listPublished, parseNote, type Note, type NoteFrontmatter } from '../src/storage.ts'
import { consolidate, promoteDraft, withLock, type ConsolidateOptions } from '../src/consolidate.ts'

const roots: string[] = []
const tmp = (): string => {
  const r = mkdtempSync(join(tmpdir(), 'memory-consolidate-'))
  roots.push(r)
  return r
}
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
})

const OBSERVE: ConsolidateOptions = { gateMode: 'observe', maxPublishedNotes: 200, maxPublishedBytes: 5_000_000 }
const ENFORCE: ConsolidateOptions = { gateMode: 'enforce', maxPublishedNotes: 200, maxPublishedBytes: 5_000_000 }

function fm(source: string, sessionId = 'sess-1', version = 1): NoteFrontmatter {
  const now = new Date().toISOString()
  return {
    kind: 'personal', scope: 'session', session_id: sessionId, source,
    source_conversation: `dialog/${sessionId}.jsonl`, created_at: now, updated_at: now,
    version, use_count: 0, last_accessed: now,
    gate: { mode: 'observe', verdict: 'pass', reviewed_at: now },
  }
}

function draftNote(source: string, body: string, sessionId = 'sess-1'): Note {
  return { frontmatter: fm(source, sessionId), body }
}

describe('consolidate gate observe', () => {
  it('promotes a draft WITHOUT valid evidence (gate: observe, non-blocking)', async () => {
    const dir = tmp()
    ensureMemoryDirs(dir)
    // No dialog written: the source cannot locate, but observe still promotes (flagged).
    const path = writeDraft(dir, draftNote('turn:99', '# Orphan note\nno evidence'), 'sess-1', 'Orphan note')
    const res = await consolidate(dir, OBSERVE)
    expect(res.promoted).toBe(1)
    expect(existsSync(path)).toBe(false) // draft consumed
    const published = listPublished(dir)
    expect(published.length).toBe(1)
    const note = parseNote(published[0]!)
    expect(note!.frontmatter.gate.mode).toBe('observe')
    expect(note!.frontmatter.gate.verdict).toBe('pass')
  })
})

describe('consolidate gate enforce', () => {
  it('promotes a draft WITH valid evidence (gate: enforce)', async () => {
    const dir = tmp()
    ensureMemoryDirs(dir)
    writeDialog(dir, 'sess-1', JSON.stringify({ role: 'user', content: 'the deployment server is 10.0.0.7' }) + '\n')
    const path = writeDraft(dir, draftNote('turn:0', '# Server note\n10.0.0.7'), 'sess-1', 'Server note')
    const res = await consolidate(dir, ENFORCE)
    expect(res.promoted).toBe(1)
    expect(res.rejected).toBe(0)
    expect(existsSync(path)).toBe(false)
    const note = parseNote(listPublished(dir)[0]!)
    expect(note!.frontmatter.gate.mode).toBe('enforce')
    expect(note!.frontmatter.gate.verdict).toBe('pass')
  })

  it('rejects a draft WITHOUT valid evidence (stays draft, rejection recorded)', async () => {
    const dir = tmp()
    ensureMemoryDirs(dir)
    writeDialog(dir, 'sess-1', JSON.stringify({ role: 'user', content: 'unrelated content' }) + '\n')
    const path = writeDraft(dir, draftNote('turn:99', '# Bad note\nno locate'), 'sess-1', 'Bad note')
    const res = await consolidate(dir, ENFORCE)
    expect(res.rejected).toBe(1)
    expect(res.promoted).toBe(0)
    // Draft remains (not promoted) and carries the rejection frontmatter.
    expect(existsSync(path)).toBe(true)
    const draft = parseNote(path)
    expect(draft!.frontmatter.rejected_at).toBeDefined()
    expect(typeof draft!.frontmatter.rejection).toBe('string')
    expect(draft!.frontmatter.rejection!.length).toBeGreaterThan(0)
    expect(listPublished(dir).length).toBe(0)
  })
})

describe('consolidate single-flight lock', () => {
  it('withLock serializes concurrent promotions of the same key (no double promote)', async () => {
    const dir = tmp()
    ensureMemoryDirs(dir)
    writeDialog(dir, 'sess-1', JSON.stringify({ role: 'user', content: 'x' }) + '\n')
    writeDraft(dir, draftNote('turn:0', '# Dup A\nx'), 'sess-1', 'Dup A')
    // Two concurrent consolidations racing on the same published target.
    const [a, b] = await Promise.all([
      consolidate(dir, OBSERVE),
      consolidate(dir, OBSERVE),
    ])
    // Exactly one note lands; the second sees zero drafts (already consumed).
    expect(a.promoted + b.promoted).toBe(1)
    expect(listPublished(dir).length).toBe(1)
    expect(listDrafts(dir).length).toBe(0)
  })

  it('withLock runs the guarded fn once per key (joins an in-flight promise)', async () => {
    let runs = 0
    const fn = () => { runs += 1; return Promise.resolve('ok') }
    const [r1, r2] = await Promise.all([withLock('k', fn), withLock('k', fn)])
    expect(r1).toBe('ok')
    expect(r2).toBe('ok')
    expect(runs).toBe(1)
    // After settle, a new call runs again.
    const r3 = await withLock('k', fn)
    expect(r3).toBe('ok')
    expect(runs).toBe(2)
  })
})

describe('promoteDraft direct', () => {
  it('reverse-snapshots an existing published note before overwrite (slug collision)', async () => {
    const dir = tmp()
    ensureMemoryDirs(dir)
    // Pre-existing published note (version 1) at the real slug (`turn:0` -> `turn-0.md`).
    writePublished(dir, { frontmatter: fm('turn:0', 1), body: '# Old\nold body' })
    // A new draft whose slug collides (same source) — promote overwrites + snapshots.
    writeDraft(dir, { frontmatter: { ...fm('turn:0'), version: 1 }, body: '# New\nnew body' }, 'sess-1', 'turn-0')
    const decision = await promoteDraft(dir, join(dir, 'drafts', 'personal', 'turn-0-sess-1.md'), OBSERVE)
    expect(decision.kind).toBe('promote')
    const publishedNote = parseNote(join(dir, 'published', 'personal', 'turn-0.md'))
    expect(publishedNote!.body).toBe('# New\nnew body')
    expect(publishedNote!.frontmatter.version).toBe(2) // bumped on rewrite
    // Snapshot of the prior version exists.
    const snapDir = join(dir, 'snapshots', 'published', 'personal')
    expect(existsSync(snapDir)).toBe(true)
  })
})
