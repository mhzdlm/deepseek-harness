/**
 * Unit tests for the Phase C growth budget (REME.md §5.3 D2 / §10 Phase C acceptance):
 * with `maxPublishedNotes=1`, the first promote succeeds; the second promote is skipped
 * under `observe` (logged) and rejected under `enforce` (stays a draft). The published
 * count stays at 1.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ensureMemoryDirs, writeDraft, writeDialog, listPublished, listDrafts, parseNote, type NoteFrontmatter } from '../src/storage.ts'
import { consolidate, type ConsolidateOptions } from '../src/consolidate.ts'

const roots: string[] = []
const tmp = (): string => {
  const r = mkdtempSync(join(tmpdir(), 'memory-budget-'))
  roots.push(r)
  return r
}
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
})

const BUDGET: ConsolidateOptions = { gateMode: 'observe', maxPublishedNotes: 1, maxPublishedBytes: 5_000_000 }

function fm(source: string): NoteFrontmatter {
  const now = new Date().toISOString()
  return {
    kind: 'personal', scope: 'session', session_id: 'sess-1', source,
    source_conversation: 'dialog/sess-1.jsonl', created_at: now, updated_at: now,
    version: 1, use_count: 0, last_accessed: now,
    gate: { mode: 'observe', verdict: 'pass', reviewed_at: now },
  }
}

function seedDraft(dir: string, source: string, body: string, title: string): void {
  writeDialog(dir, 'sess-1', JSON.stringify({ role: 'user', content: 'x' }) + '\n')
  writeDraft(dir, { frontmatter: fm(source), body }, 'sess-1', title)
}

describe('growth budget maxPublishedNotes=1', () => {
  it('observe: first promote ok; second skipped (logged), published stays 1', async () => {
    const dir = tmp()
    ensureMemoryDirs(dir)
    seedDraft(dir, 'turn:0', '# A\nfirst', 'A')
    const first = await consolidate(dir, BUDGET)
    expect(first.promoted).toBe(1)
    expect(listPublished(dir).length).toBe(1)

    seedDraft(dir, 'turn:1', '# B\nsecond', 'B')
    const second = await consolidate(dir, BUDGET)
    expect(second.promoted).toBe(0)
    expect(second.skippedBudget).toBe(1)
    expect(second.warnings.some(w => w.includes('budget'))).toBe(true)
    // Published count unchanged; the second draft remains a draft.
    expect(listPublished(dir).length).toBe(1)
    expect(listDrafts(dir).length).toBe(1)
  })

  it('enforce: first promote ok; second rejected (stays draft), published stays 1', async () => {
    const dir = tmp()
    ensureMemoryDirs(dir)
    writeDialog(dir, 'sess-1', JSON.stringify({ role: 'user', content: 'x' }) + '\n')
    seedDraft(dir, 'turn:0', '# A\nfirst', 'A')
    const first = await consolidate(dir, { ...BUDGET, gateMode: 'enforce' })
    expect(first.promoted).toBe(1)
    expect(listPublished(dir).length).toBe(1)

    seedDraft(dir, 'turn:1', '# B\nsecond', 'B')
    const second = await consolidate(dir, { ...BUDGET, gateMode: 'enforce' })
    expect(second.promoted).toBe(0)
    expect(second.rejected).toBe(1)
    expect(listPublished(dir).length).toBe(1)
    expect(listDrafts(dir).length).toBe(1)
    const draft = listDrafts(dir).map(p => parseNote(p)).find(n => n!.frontmatter.source === 'turn:1')
    expect(draft!.frontmatter.rejection).toBeDefined()
  })
})
