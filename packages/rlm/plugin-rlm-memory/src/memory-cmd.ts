/**
 * `/memory` command handlers: `list | show | delete | consolidate | rollback | retire | archived | unretire`. Pure
 * functions over the file store so the Cordis command registration in index.ts stays a
 * thin switch (mirrors plugin-rlm-moa/moa-cmd.ts). `delete` operates on drafts only;
 * published notes go through the Phase C promotion/rollback gate (REME.md §5.1,
 * §10 Phase A acceptance: `delete` is drafts-only). `consolidate` runs the publish gate
 * + growth budget + reverse-snapshot promotion (REME.md §5.3); `rollback <noteId>`
 * restores the latest snapshot over a published note, honoring the override-warning
 * discipline (REME.md §5.3 D11). Phase D: `retire <noteId> [force]` moves a published
 * note to `archived/` under `exitMode` (off|observe|enforce); `archived` lists retired
 * notes; `unretire <noteId>` restores one (REME.md §5.4 D12).
 *
 * @module @deepseek-ai/dsh-plugin-rlm-memory/memory-cmd
 */

import { basename, isAbsolute } from 'node:path'
import { listDrafts, parseNote, deleteDraft, readNote, listPublished, listArchived, toPublishedRel } from './storage.ts'
import { consolidate, rollbackNote, type ConsolidateOptions } from './consolidate.ts'
import { retireNote, unretireNote, type RetireOptions } from './retire.ts'

/**
 * `/memory list`: every draft note with its kind, title (from body/source), and
 * the evidence `source` reference.
 * @param memoryDir - resolved memory root.
 * @returns a newline-joined text listing, or a notice when no drafts exist.
 */
export function listMemoryText(memoryDir: string): string {
  const paths = listDrafts(memoryDir)
  if (paths.length === 0) return '(no memory drafts)'
  const lines: string[] = []
  for (const path of paths) {
    const note = parseNote(path)
    if (!note) continue
    const title = (note.body.split('\n')[0] ?? '').replace(/^#\s*/, '').trim() || note.frontmatter.source
    lines.push(`- ${basename(path)}  [${note.frontmatter.kind}/${note.frontmatter.scope}]  source: ${note.frontmatter.source}\n    ${title}`)
  }
  return lines.length > 0 ? lines.join('\n') : '(no memory drafts)'
}

/**
 * `/memory show <name>`: full frontmatter + body for one draft note.
 * @param memoryDir - resolved memory root.
 * @param name - the draft note filename (basename) or absolute/relative path.
 * @returns the formatted note text, or an error message when not found.
 */
export function showMemoryText(memoryDir: string, name: string): string {
  let path: string
  try {
    path = resolveDraftPath(memoryDir, name)
  } catch {
    return `Unknown draft "${name}". Use /memory list to see drafts.`
  }
  const note = parseNote(path)
  if (!note) return `Unknown draft "${name}". Use /memory list to see drafts.`
  const fm = note.frontmatter
  const header = [
    `draft: ${basename(path)}`,
    `kind: ${fm.kind}  scope: ${fm.scope}`,
    `session_id: ${fm.session_id}`,
    `source: ${fm.source}`,
    `source_conversation: ${fm.source_conversation}`,
    `created_at: ${fm.created_at}  updated_at: ${fm.updated_at}  version: ${fm.version}`,
    `use_count: ${fm.use_count}  last_accessed: ${fm.last_accessed}`,
    `gate: ${fm.gate.mode}/${fm.gate.verdict}`,
  ].join('\n')
  return `${header}\n\n${note.body}`
}

/**
 * `/memory delete <name>`: remove one draft note. Throws when the resolved path
 * is not a draft (published notes are not deletable in Phase A).
 * @param memoryDir - resolved memory root.
 * @param name - the draft note filename (basename) or absolute/relative path.
 * @returns a confirmation or an error message.
 */
export function deleteMemoryText(memoryDir: string, name: string): string {
  try {
    const path = resolveDraftPath(memoryDir, name)
    deleteDraft(memoryDir, path)
    return `Deleted draft "${basename(path)}".`
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/** Resolve a `/memory` argument to a draft note path (basename only).
 * Path separators, `..`, and unknown names are rejected so a leaked argument can
 * never be used as a path outside the drafts tree. */
function resolveDraftPath(memoryDir: string, name: string): string {
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    throw new Error(`invalid draft name "${name}": path separators and ".." are not allowed`)
  }
  const candidate = listDrafts(memoryDir).find(p => basename(p) === name)
  if (!candidate) throw new Error(`no draft note named "${name}"`)
  return candidate
}

/**
 * `/memory consolidate`: run the publish gate + growth budget + reverse-snapshot
 * promotion over every draft (REME.md §5.3). Returns a human-readable audit summary; the
 * numeric result is the {@link consolidate} report.
 * @param memoryDir - resolved memory root.
 * @param options - resolved gate + budget options (from plugin Config).
 * @returns the consolidation summary text, plus the structured report for callers.
 */
export async function consolidateText(
  memoryDir: string,
  options: ConsolidateOptions,
): Promise<{ text: string; result: Awaited<ReturnType<typeof consolidate>> }> {
  const result = await consolidate(memoryDir, options)
  const lines: string[] = []
  if (result.noop) {
    lines.push('Consolidation is a no-op under gateMode=off (drafts stay drafts).')
  } else {
    lines.push(`Scanned ${result.scanned} draft(s): ${result.promoted} promoted, ${result.rejected} rejected, ${result.skippedBudget} skipped (budget).`)
  }
  for (const w of result.warnings) lines.push(`  - warn: ${w}`)
  return { text: lines.join('\n'), result }
}

/**
 * `/memory rollback <noteId>`: restore the latest snapshot over a published note
 * (REME.md §5.3 D11). `noteId` is the relative published path (or basename). With the
 * `force` flag, overrides a user-edited note (override-warning); without it, a note
 * edited after the last snapshot is not overwritten.
 * @param memoryDir - resolved memory root.
 * @param noteId - the published note id (relative path or basename).
 * @param force - when true, restore even over a user edit.
 * @returns a human-readable outcome text.
 */
export async function rollbackText(memoryDir: string, noteId: string, force: boolean): Promise<string> {
  const rel = resolvePublishedId(memoryDir, noteId)
  const outcome = await rollbackNote(memoryDir, rel, force)
  return outcome.message
}

/** Normalize a `/memory` note argument to a relative path strictly under `published/`.
 * Rejects `..` segments, absolute paths, and any resolved path that escapes the
 * published tree — a leaked id must never reach `join(memoryDir, rel)` outside the
 * memory root. */
function resolvePublishedRel(memoryDir: string, name: string): string {
  if (name.includes('..')) throw new Error(`invalid noteId "${name}": ".." segments are not allowed`)
  if (isAbsolute(name)) throw new Error(`invalid noteId "${name}": absolute paths are not allowed`)
  let rel: string
  if (name.includes('/') || name.includes('\\')) {
    rel = name.split(/[\\/]/).join('/')
  } else {
    const match = listPublished(memoryDir)
      .map(p => (p.startsWith(memoryDir) ? p.slice(memoryDir.length).replace(/^[\\/]/, '') : p))
      .find(r => r.split(/[\\/]/).pop() === name)
    rel = match ?? `published/${name}`
  }
  if (!rel.startsWith('published/') || rel.slice('published/'.length).includes('..')) {
    throw new Error(`invalid noteId "${name}": must resolve under published/`)
  }
  return rel
}

/** Resolve a `/memory rollback` argument to a published note relative path. */
function resolvePublishedId(memoryDir: string, name: string): string {
  return resolvePublishedRel(memoryDir, name)
}

/**
 * `/memory retire <noteId> [force]`: retire one published note (REME.md §5.4). Under
 * `exitMode: off` this is a logged no-op; under `observe` it logs intent but does not move
 * the note; under `enforce` it moves the note `published/` → `archived/` (reversible). The
 * `force` flag bypasses the age/use threshold for an explicit user retire (enforce only).
 * @param memoryDir - resolved memory root.
 * @param noteId - the published note id (relative path or basename).
 * @param force - when true, bypass the aging threshold.
 * @param options - resolved exitMode + aging thresholds.
 * @returns a human-readable outcome (the note stays put unless `enforce` + candidate).
 */
export async function retireText(memoryDir: string, noteId: string, force: boolean, options: RetireOptions): Promise<string> {
  return retireNote(memoryDir, resolvePublishedRel(memoryDir, noteId), options, force)
}

/**
 * `/memory archived`: list every archived note (REME.md §5.4 D12). The `archive/` dir is
 * read directly; an empty archive reports a notice (no notes retired yet).
 * @param memoryDir - resolved memory root.
 * @returns a newline-joined listing of `archived/<kind>/<slug>.md` paths, or a notice.
 */
export function archivedText(memoryDir: string): string {
  const paths = listArchived(memoryDir)
  if (paths.length === 0) return '(no archived notes)'
  const lines: string[] = []
  for (const abs of paths) {
    // Phase 8: print the feedable `/memory unretire` id (root-relative), not
    // the absolute path.
    const rel = abs.startsWith(memoryDir) ? abs.slice(memoryDir.length).replace(/^[\\/]/, '').split(/[\\/]/).filter(Boolean).join('/') : abs.split(/[\\/]/).filter(Boolean).join('/')
    const note = parseNote(abs)
    const title = note ? (note.body.split('\n')[0] ?? '').replace(/^#\s*/, '').trim() || note.frontmatter.source : '(unreadable)'
    lines.push(`- ${rel}  [${note?.frontmatter.kind ?? '?'}/${note?.frontmatter.scope ?? '?'}]  retired_at: ${note?.frontmatter.retired_at ?? '?'}  ${title}`)
  }
  return lines.join('\n')
}

/**
 * `/memory unretire <noteId>`: move an archived note back to `published/` (REME.md §5.4
 * D12, "retirement is reversible"). The note id is the SAME relPath it had under
 * `published/`; a basename is resolved against `archived/`.
 *
 * Phase 8 (review round 6): the id resolves against the ARCHIVED tree. The old
 * code ran the published-tree resolver here, so every hand-fed id — bare
 * basename, `basename.md`, or the absolute path `/memory archived` prints —
 * failed to resolve and the command always answered "not found". Accepted
 * forms: `archived/<kind>/<slug>.md`, `<kind>/<slug>.md`, `<slug>`,
 * `<slug>.md`, or an absolute path inside `memoryDir/archived/`.
 * @param memoryDir - resolved memory root.
 * @param noteId - the archived note id (relative path, basename, or absolute archived path).
 * @returns a human-readable outcome (restored, or a not-found notice).
 */
export async function unretireText(memoryDir: string, noteId: string): Promise<string> {
  return unretireNote(memoryDir, resolveArchivedId(memoryDir, noteId))
}

/**
 * Normalize a `/memory unretire` argument to the PUBLISHED-form relPath
 * `unretireNote` consumes (it swaps the `published/` prefix for `archived/`
 * itself). Accepted forms: `archived/<kind>/<slug>.md`, `<kind>/<slug>.md`,
 * `<slug>`, `<slug>.md`, or an absolute path inside `memoryDir`. Rejects `..`
 * segments and paths escaping the memory root.
 */
function resolveArchivedId(memoryDir: string, name: string): string {
  if (name.includes('..')) throw new Error(`invalid noteId "${name}": ".." segments are not allowed`)
  let archivedRel: string
  if (isAbsolute(name)) {
    // An absolute path (as `/memory archived` prints) must name a file inside
    // the memory root, then re-express it relative to the root.
    const norm = name.split(/[\\/]/).filter(Boolean).join('/')
    const rootNorm = memoryDir.split(/[\\/]/).filter(Boolean).join('/')
    if (!norm.startsWith(rootNorm + '/')) throw new Error(`invalid noteId "${name}": must resolve under ${memoryDir}`)
    archivedRel = norm.slice(rootNorm.length + 1)
  } else if (name.includes('/') || name.includes('\\')) {
    archivedRel = name.split(/[\\/]/).join('/')
  } else {
    // Bare basename: match against the archived listing (with or without .md).
    const candidates = [name, name.endsWith('.md') ? name : `${name}.md`]
    const match = listArchived(memoryDir)
      .map(p => toPublishedRel(memoryDir, p))
      .find((r) => {
        const base = r.split('/').pop() ?? ''
        return candidates.some(c => c === base)
      })
    if (match === undefined) throw new Error(`unretire: no archived note matches "${name}" (run /memory archived to list ids)`)
    archivedRel = match
  }
  if (archivedRel.startsWith('published/')) archivedRel = `archived/${archivedRel.slice('published/'.length)}`
  if (!archivedRel.startsWith('archived/')) archivedRel = `archived/${archivedRel}`
  // unretireNote consumes the PUBLISHED-form id (it swaps the prefix itself).
  return archivedRel.replace(/^archived\//, 'published/')
}

/** Re-export so the command layer and tests share the read helper. */
export { readNote }
