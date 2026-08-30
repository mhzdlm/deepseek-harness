/**
 * Phase 8 (review round 6) regression pins: the fixes this batch landed, each
 * against a concrete review finding. Kept in one file so the batch reads as a
 * unit — CJK slug survival, cross-session published collision, cumulative
 * dialog persistence, frontmatter quote round-trip, snapshot uniqueness, and
 * second-rollback mtime honesty.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  ensureMemoryDirs,
  listSnapshots,
  publishedRelFor,
  takeSnapshot,
  updateUsage,
  writeDraft,
  listDrafts,
  type Note,
  type NoteFrontmatter,
} from '../src/storage.ts'
import { persistCapture } from '../src/capture.ts'
import { unretireText } from '../src/memory-cmd.ts'
import { rollbackNote } from '../src/consolidate.ts'
import { isRetireCandidate } from '../src/retire.ts'

const roots: string[] = []
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'memory-phase8-'))
  roots.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fm(sessionId: string, source: string): NoteFrontmatter {
  const now = new Date().toISOString()
  return {
    kind: 'personal', scope: 'session', session_id: sessionId, source,
    source_conversation: `dialog/${sessionId}.jsonl`, created_at: now, updated_at: now,
    version: 1, use_count: 0, last_accessed: now,
    gate: { mode: 'observe', verdict: 'pass', reviewed_at: now },
  }
}

it('two Chinese drafts with different bodies land on distinct files (CJK slug)', () => {
  const dir = tmp()
  ensureMemoryDirs(dir)
  // Pre-Phase-8 both titles collapsed to `note-<sid>.md` and the second
  // writeDraft silently overwrote the first.
  writeDraft(dir, { frontmatter: fm('sess-a', 'turn:0'), body: '第一份中文笔记：部署流程' }, 'sess-a', '第一份中文笔记：部署流程')
  writeDraft(dir, { frontmatter: fm('sess-a', 'turn:1'), body: '第二份中文笔记：回滚流程' }, 'sess-a', '第二份中文笔记：回滚流程')
  expect(listDrafts(dir)).toHaveLength(2)
})

it('two sessions promoting the same source do not share a published path (cross-session collision)', () => {
  const dir = tmp()
  ensureMemoryDirs(dir)
  // Real session ids diverge within the 8-char disambiguator window.
  const a: Note = { frontmatter: fm('aaaa1111', 'turn:0'), body: 'session a knowledge' }
  const b: Note = { frontmatter: fm('bbbb2222', 'turn:0'), body: 'session b knowledge' }
  expect(publishedRelFor(a)).not.toBe(publishedRelFor(b))
})

it('persistCapture appends interval windows instead of erasing them (cumulative dialog)', () => {
  const dir = tmp()
  ensureMemoryDirs(dir)
  const mkEntry = (turns: Array<{ role: string; content: string }>) => ({ sessionId: 'sess-win', turns })
  persistCapture(dir, mkEntry([
    { role: 'user', content: 'window one turn' },
    { role: 'assistant', content: 'reply one' },
  ]), [])
  persistCapture(dir, mkEntry([
    { role: 'user', content: 'window two turn' },
    { role: 'assistant', content: 'reply two' },
  ]), [])
  const stored = readFileSync(join(dir, 'dialog', 'sess-win.jsonl'), 'utf8')
  // Pre-Phase-8 the second flush overwrote the file and window one was lost.
  expect(stored).toContain('window one turn')
  expect(stored).toContain('window two turn')
})

it('a frontmatter string containing a quote survives read-modify-write without backslash growth', () => {
  const dir = tmp()
  ensureMemoryDirs(dir)
  const notePath = join(dir, 'published', 'personal', 'quoted.md')
  mkdirSync(join(dir, 'published', 'personal'), { recursive: true })
  writeFileSync(notePath, [
    '---',
    'kind: personal',
    'scope: session',
    'session_id: sess-q',
    'source: "turn:\\"0\\" with quote"',
    'source_conversation: dialog/sess-q.jsonl',
    'created_at: 2026-08-30T00:00:00.000Z',
    'updated_at: 2026-08-30T00:00:00.000Z',
    'version: 1',
    'use_count: 0',
    'last_accessed: 2026-08-30T00:00:00.000Z',
    'gate: { mode: observe, verdict: pass, reviewed_at: 2026-08-30T00:00:00.000Z }',
    '---',
    '',
    'body',
    '',
  ].join('\n'), 'utf8')
  // Parse via updateUsage's own path (round-trips the frontmatter) N times.
  for (let i = 0; i < 5; i++) updateUsage(dir, 'published/personal/quoted.md', new Date().toISOString())
  const text = readFileSync(notePath, 'utf8')
  // Pre-Phase-8 each round doubled the escapes: \" -> \\" -> ...
  expect(text.match(/\\{2,}"/g)).toBeNull()
  expect(text).toContain('use_count: 5')
})

it('two snapshots of the same note in the same millisecond both survive', () => {
  const dir = tmp()
  ensureMemoryDirs(dir)
  const rel = 'published/personal/snap.md'
  const s1 = takeSnapshot(dir, rel, 'first')
  const s2 = takeSnapshot(dir, rel, 'second')
  expect(s1).not.toBe(s2)
  expect(listSnapshots(dir, rel)).toHaveLength(2)
})

it('a second rollback no longer false-flags a user edit (restore carries the snapshot mtime)', async () => {
  const dir = tmp()
  ensureMemoryDirs(dir)
  const rel = publishedRelFor({ frontmatter: fm('sess-rb', 'turn:0'), body: 'v2' })
  const liveAbs = join(dir, rel)
  mkdirSync(join(dir, 'published', 'personal'), { recursive: true })
  writeFileSync(liveAbs, 'v2 content', 'utf8')
  const snap = takeSnapshot(dir, rel, 'v1 content')
  // First rollback: clean.
  const first = await rollbackNote(dir, rel, false)
  expect(first.warnedUserEdit).toBe(false)
  expect(first.restored).toBe(true)
  expect(readFileSync(liveAbs, 'utf8')).toBe('v1 content')
  // Second rollback WITHOUT any user edit in between: must not claim an edit.
  const second = await rollbackNote(dir, rel, false)
  expect(second.warnedUserEdit).toBe(false)
  expect(second.restored).toBe(true)
  expect(readFileSync(liveAbs, 'utf8')).toBe('v1 content')
  // The restore really wrote the snapshot content again.
  expect(existsSync(snap)).toBe(true)
})

it('/memory unretire resolves a bare basename against the archived tree (Phase 8)', async () => {
  const dir = tmp()
  ensureMemoryDirs(dir)
  const archivedDir = join(dir, 'archived', 'personal')
  mkdirSync(archivedDir, { recursive: true })
  writeFileSync(join(archivedDir, 'oldnote.md'), [
    '---',
    'kind: personal',
    'scope: global',
    'session_id: sess-u',
    'source: turn:0',
    'source_conversation: dialog/sess-u.jsonl',
    'created_at: 2026-08-30T00:00:00.000Z',
    'updated_at: 2026-08-30T00:00:00.000Z',
    'version: 1',
    'use_count: 0',
    'last_accessed: 2026-08-30T00:00:00.000Z',
    'retired_at: 2026-08-30T01:00:00.000Z',
    'gate: { mode: observe, verdict: pass, reviewed_at: 2026-08-30T00:00:00.000Z }',
    '---',
    '',
    'old note body',
    '',
  ].join('\n'), 'utf8')
  // Pre-Phase-8 this reported "not found" for every input form.
  const message = await unretireText(dir, 'oldnote')
  expect(message).toContain('Un-retired')
  expect(existsSync(join(dir, 'published', 'personal', 'oldnote.md'))).toBe(true)
  expect(existsSync(join(archivedDir, 'oldnote.md'))).toBe(false)
})

it('retire treats a missing use_count as zero instead of permanent exemption', () => {
  const frontmatter = fm('sess-c', 'turn:0')
  const note: Note = { frontmatter: { ...frontmatter, use_count: undefined as unknown as number, last_accessed: '2000-01-01T00:00:00.000Z' }, body: 'b' }
  expect(isRetireCandidate(note, { exitMode: 'enforce', agingMinAgeDays: 180, agingMinUseCount: 1 }, Date.now())).toBe(true)
})
