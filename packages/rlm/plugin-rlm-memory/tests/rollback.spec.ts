/**
 * Unit tests for Phase C reverse-snapshot rollback (REME.md §5.3 D11): promote a draft
 * to published (snapshot taken), simulate a user edit (rewrite published so its mtime >
 * snapshot mtime), assert `rollback` returns `warnedUserEdit: true` and does NOT overwrite;
 * with `force` it restores the snapshot and content matches. Borrows the harness
 * `writeHarnessStates` override-warning pattern (harness-file.ts).
 */
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, statSync, utimesSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ensureMemoryDirs, writeDraft, writeDialog, writePublished, parseNote, publishedRelFor, type NoteFrontmatter } from '../src/storage.ts'
import { consolidate, rollbackNote, type ConsolidateOptions } from '../src/consolidate.ts'

const roots: string[] = []
const tmp = (): string => {
  const r = mkdtempSync(join(tmpdir(), 'memory-rollback-'))
  roots.push(r)
  return r
}
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
})

const OBSERVE: ConsolidateOptions = { gateMode: 'observe', maxPublishedNotes: 200, maxPublishedBytes: 5_000_000 }

function fm(source: string, version = 1): NoteFrontmatter {
  const now = new Date().toISOString()
  return {
    kind: 'personal', scope: 'session', session_id: 'sess-1', source,
    source_conversation: 'dialog/sess-1.jsonl', created_at: now, updated_at: now,
    version, use_count: 0, last_accessed: now,
    gate: { mode: 'observe', verdict: 'pass', reviewed_at: now },
  }
}

describe('rollback reverse-snapshot override-warning', () => {
  it('promotes draft over existing published (snapshot taken), warns on user edit, force restores', async () => {
    const dir = tmp()
    ensureMemoryDirs(dir)
    // Pre-seed a published note (with frontmatter) so the promotion overwrites it and
    // reverse-snapshots the prior content (D11). Phase 8: seed at the exact
    // session-disambiguated path the promotion derives (same-session
    // re-promotion; the cross-session collision no longer exists by design).
    const draft = { frontmatter: fm('turn:0'), body: '# Original\noriginal content' }
    const publishedRel = publishedRelFor(draft)
    writePublished(dir, { frontmatter: fm('turn:0', 1), body: '# Pre-existing\nprior content' }, publishedRel)
    writeDialog(dir, 'sess-1', JSON.stringify({ role: 'user', content: 'x' }) + '\n')
    writeDraft(dir, draft, 'sess-1', 'turn:0')
    await consolidate(dir, OBSERVE)

    const publishedAbs = join(dir, publishedRel)
    expect(existsSync(publishedAbs)).toBe(true)
    expect(parseNote(publishedAbs)!.body).toBe('# Original\noriginal content')
    // A reverse snapshot of the pre-existing content exists (D11).
    const snaps0 = join(dir, 'snapshots', publishedRel)
    expect(existsSync(snaps0)).toBe(true)
    const snapFile = join(snaps0, readdirSyncSafe(snaps0)[0]!)
    expect(readFileSync(snapFile, 'utf8')).toContain('Pre-existing')

    // Simulate a user edit: rewrite the published file with NEWER mtime than the snapshot.
    writeFileSync(publishedAbs, '# Edited by user\nuser changed this')
    const snapMtime = statSync(snapFile).mtimeMs
    const future = new Date(snapMtime + 2000)
    utimesSync(publishedAbs, future, future)

    // Rollback WITHOUT force: must warn and NOT overwrite.
    const warned = await rollbackNote(dir, publishedRel, false)
    expect(warned.warnedUserEdit).toBe(true)
    expect(warned.restored).toBe(false)
    expect(readFileSync(publishedAbs, 'utf8')).toContain('Edited by user') // unchanged

    // Rollback WITH force: restores the snapshot content (the pre-existing version).
    const forced = await rollbackNote(dir, publishedRel, true)
    expect(forced.warnedUserEdit).toBe(true)
    expect(forced.restored).toBe(true)
    const restored = parseNote(publishedAbs)
    expect(restored!.body).toContain('Pre-existing')
  })

  it('rolls back cleanly when no user edit intervened', async () => {
    const dir = tmp()
    ensureMemoryDirs(dir)
    // Pre-seed so promotion overwrites + snapshots a prior version (Phase 8:
    // seed at the derived session-disambiguated path).
    const draft = { frontmatter: fm('turn:0'), body: '# Original\noriginal content' }
    const publishedRel = publishedRelFor(draft)
    writePublished(dir, { frontmatter: fm('turn:0', 1), body: '# Pre-existing\nprior content' }, publishedRel)
    writeDialog(dir, 'sess-1', JSON.stringify({ role: 'user', content: 'x' }) + '\n')
    writeDraft(dir, draft, 'sess-1', 'turn:0')
    await consolidate(dir, OBSERVE)
    const publishedAbs = join(dir, publishedRel)
    // No edit: published mtime <= latest snapshot mtime, so no override warning.
    const out = await rollbackNote(dir, publishedRel, false)
    expect(out.warnedUserEdit).toBe(false)
    expect(out.restored).toBe(true)
    expect(parseNote(publishedAbs)!.body).toContain('Pre-existing')
  })
})

/** Read one filename from a dir, defensive against absence. */
function readdirSyncSafe(dir: string): string[] {
  return readdirSync(dir)
}
