/**
 * File-authoritative Markdown store for the memory layer. Notes are
 * YAML-frontmatter Markdown; the dialog jsonl is the derived-rebuildable
 * source of truth the extraction subagent reads (REME.md §4 D3: "Memory as
 * File, File as Memory"; frontmatter provenance fields borrow ReMe
 * `auto_memory.py _ensure_session_frontmatter`).
 *
 * All paths live under one `memoryDir` with subdirs `published/`, `drafts/`,
 * `archive/`, `dialog/`, `index/`, `logs/`. This module owns the directory
 * layout and the frontmatter round-trip; it does not own the evidence gate
 * (see ./evidence.ts) or the capture buffer (see ./capture.ts).
 *
 * Phase B adds the `published/` read path: `listPublished`, `readNote`, and
 * `updateUsage` (REME.md §5.2 D4 use-signal; `use_count`/`last_accessed`
 * increment on each recall hit without bumping `version`, which tracks
 * content, not access — see updateUsage). The keyword index is NOT persisted
 * here; buildIndex derives it from `published/` each call so it can never
 * drift (delete-and-rerun equivalence, REME.md §5.2 / §10 Phase B acceptance).
 *
 * @module @deepseek-ai/dsh-plugin-rlm-memory/storage
 */

import { mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, existsSync, statSync, utimesSync } from 'node:fs'
import { join, sep, dirname, relative } from 'node:path'

/** The three ReMe-style buckets (REME.md §4 D4: tri-bucket borrows ReMe `dream_bucket_enum`). */
export type NoteKind = 'procedure' | 'personal' | 'wiki'
/** Note scope, aligned with harness local/global semantics (REME.md §4). */
export type NoteScope = 'session' | 'global'

/** Frontmatter contract for every note this plugin writes (REME.md §4). */
export interface NoteFrontmatter {
  kind: NoteKind
  scope: NoteScope
  session_id: string
  /** Evidence gate product — a reference that locates inside the source dialog jsonl (REME.md §5.1 D6). */
  source: string
  /** Pointer to the original conversation (dialog jsonl) for traceability. */
  source_conversation: string
  created_at: string
  updated_at: string
  version: number
  use_count: number
  last_accessed: string
  /** Publish-gate placeholder; Phase A leaves every draft at observe/pass, Phase C reviews it. */
  gate: { mode: string; verdict: string; reviewed_at: string }
  /**
   * Set only on an `enforce`-rejected draft (REME.md §5.3 D10): the ISO time the gate
   * refused promotion and the human-readable reason. Absent on published/promoted notes.
   */
  rejected_at?: string
  /** Rejection reason recorded when `enforce` refuses a draft (see `rejected_at`). */
  rejection?: string
  /** Set only on an archived note (REME.md §5.4 D12): the ISO time the note was retired (moved to `archive/`). */
  retired_at?: string
}

/** One note file: its frontmatter plus its Markdown body. */
export interface Note {
  frontmatter: NoteFrontmatter
  body: string
}

/**
 * Subdirectory names under `memoryDir` (REME.md §4 layout).
 * `snapshots/` added in Phase C (D11); `archived/` is the Phase D retire target (D12).
 */
export const SUBDIRS = ['published', 'drafts', 'dialog', 'index', 'logs', 'snapshots', 'archived'] as const

/**
 * Create the memory directory tree if absent. Idempotent.
 * @param memoryDir - resolved memory root.
 */
export function ensureMemoryDirs(memoryDir: string): void {
  for (const sub of SUBDIRS) mkdirSync(join(memoryDir, sub), { recursive: true })
}

/**
 * Path of the sanitized dialog jsonl for one session.
 * @param memoryDir - resolved memory root.
 * @param sessionId - the captured session id.
 * @returns absolute path `memoryDir/dialog/<sessionId>.jsonl`.
 */
export function dialogPath(memoryDir: string, sessionId: string): string {
  return join(memoryDir, 'dialog', `${sessionId}.jsonl`)
}

/**
 * Write the sanitized dialog jsonl for one session, creating parent dirs.
 * @param memoryDir - resolved memory root.
 * @param sessionId - the captured session id.
 * @param jsonl - newline-terminated JSONL text.
 */
export function writeDialog(memoryDir: string, sessionId: string, jsonl: string): void {
  mkdirSync(join(memoryDir, 'dialog'), { recursive: true })
  writeFileSync(dialogPath(memoryDir, sessionId), jsonl, 'utf8')
}

/**
 * Read the stored dialog jsonl as parsed turn objects.
 * @param memoryDir - resolved memory root.
 * @param sessionId - the captured session id.
 * @returns an array of `{ role, content }` turns; `[]` when the file is absent.
 */
export function readDialog(memoryDir: string, sessionId: string): Array<{ role: string; content: string }> {
  const path = dialogPath(memoryDir, sessionId)
  if (!existsSync(path)) return []
  const text = readFileSync(path, 'utf8')
  const out: Array<{ role: string; content: string }> = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const obj = JSON.parse(trimmed) as { role: string; content: string }
      out.push({ role: obj.role, content: obj.content })
    } catch {
      // A malformed line is skipped, never fatal — the dialog is an audit artifact.
    }
  }
  return out
}

/**
 * Slugify a note title into a filesystem-safe basename fragment.
 * Phase 8 (review round 6): Unicode letters and numbers are preserved — the
 * old ASCII-only rule collapsed every CJK title to the `note` fallback, so a
 * Chinese session's drafts overwrote each other per kind.
 */
function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    // A 64-code-unit cut can split an astral character; drop a lone surrogate.
    .replace(/[\uD800-\uDBFF]$/, '')
    .replace(/^-+|-+$/g, '')
  return slug.length > 0 ? slug : 'note'
}

/** Build a deterministic draft note path from its kind, slug, and session id. */
function draftPath(memoryDir: string, kind: NoteKind, sessionId: string, title: string): string {
  return join(memoryDir, 'drafts', kind, `${slugify(title)}-${sessionId.slice(0, 8)}.md`)
}

/**
 * Serialize a note to frontmatter + body Markdown text.
 * @param note - the note to serialize.
 * @returns the complete `.md` file content with a leading `---` fence.
 */
export function serializeNote(note: Note): string {
  const lines = ['---']
  const fm = note.frontmatter as unknown as Record<string, unknown>
  for (const [key, value] of Object.entries(fm)) {
    lines.push(`${key}: ${yamlScalar(value)}`)
  }
  lines.push('---', '', note.body.trim(), '')
  return lines.join('\n')
}

/** Render one frontmatter scalar/object as compact YAML text. */
function yamlScalar(value: unknown): string {
  if (typeof value === 'object' && value !== null) {
    const inner = Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `${k}: ${yamlScalar(v)}`)
      .join(', ')
    return `{ ${inner} }`
  }
  if (typeof value === 'string') return JSON.stringify(value)
  return String(value)
}

/**
 * Parse a note file's frontmatter + body. Reads the file at `path`.
 * @param path - absolute note file path.
 * @returns the parsed note, or null when the file is missing or has no frontmatter.
 */
export function parseNote(path: string): Note | null {
  if (!existsSync(path)) return null
  const text = readFileSync(path, 'utf8')
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text)
  if (!match) return null
  const frontmatter = parseFrontmatter(match[1] ?? '') as unknown as NoteFrontmatter
  return { frontmatter, body: match[2]?.trim() ?? '' }
}

/** Parse the simple YAML block this plugin emits (flat scalars + one nested `gate:` map). */
function parseFrontmatter(block: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const lines = block.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line === undefined) continue
    const kv = /^(\S+):\s*(.*)$/.exec(line)
    if (!kv || kv[1] === undefined) continue
    const key = kv[1]
    const raw = (kv[2] ?? '').trim()
    if (raw.startsWith('{')) {
      // Nested object on its own line: { k: v, k2: v2 }
      const inner: Record<string, unknown> = {}
      for (const pair of raw.slice(1, -1).split(',')) {
        const pk = /^(\S+):\s*(.*)$/.exec(pair.trim())
        if (pk && pk[1] !== undefined) inner[pk[1]] = unquote(pk[2] ?? '')
      }
      out[key] = inner
    } else {
      out[key] = unquote(raw)
    }
  }
  return out
}

/** Decode a YAML scalar we emitted with `JSON.stringify` (Phase 8 quote-safe round-trip). */
function unquote(value: string): string | number | boolean {
  if (value === 'true') return true
  if (value === 'false') return false
  if (/^-?\d+$/.test(value)) return Number(value)
  const m = /^"(.*)"$/.exec(value)
  if (!m) return value
  // We emit strings with JSON.stringify, so decode with JSON semantics. The
  // old strip-outer-quotes-only rule doubled backslashes on every
  // read-modify-write cycle once a value contained a quote or backslash.
  try {
    return JSON.parse(`"${m[1]}"`) as string
  } catch {
    return m[1] as string
  }
}

/**
 * Write one draft note, creating the kind subdirectory. The note MUST carry a
 * `source` that the caller has already validated as locatable in its dialog
 * jsonl (the evidence gate lives in ./evidence.ts); this function only persists.
 * @param memoryDir - resolved memory root.
 * @param note - the note to write (frontmatter + body).
 * @param sessionId - the originating session id (used for the slug + collision-avoidance).
 * @param title - the note title used to derive the slug.
 * @returns the absolute path written.
 */
export function writeDraft(memoryDir: string, note: Note, sessionId: string, title: string): string {
  const path = draftPath(memoryDir, note.frontmatter.kind, sessionId, title)
  mkdirSync(join(memoryDir, 'drafts', note.frontmatter.kind), { recursive: true })
  writeFileSync(path, serializeNote(note), 'utf8')
  return path
}

/**
 * List draft note paths under `memoryDir/drafts` (recursively across kind subdirs).
 * @param memoryDir - resolved memory root.
 * @returns absolute paths of every `.md` file under drafts/.
 */
export function listDrafts(memoryDir: string): string[] {
  const root = join(memoryDir, 'drafts')
  if (!existsSync(root)) return []
  const out: string[] = []
  for (const kind of readdirSync(root)) {
    const kindDir = join(root, kind)
    if (!existsSync(kindDir)) continue
    for (const file of readdirSync(kindDir)) {
      if (file.endsWith('.md')) out.push(join(kindDir, file))
    }
  }
  return out
}

/**
 * Delete one draft note. Published notes are NOT deletable here (Phase C owns
 * promotion/rollback); this throws if the path is outside `memoryDir/drafts`.
 * @param memoryDir - resolved memory root.
 * @param path - absolute draft note path to delete.
 */
export function deleteDraft(memoryDir: string, path: string): void {
  const draftsRoot = join(memoryDir, 'drafts')
  const rel = path.startsWith(draftsRoot + sep) ? path.slice(draftsRoot.length + sep.length) : null
  if (rel === null || rel.split(sep).some(seg => seg === '..')) {
    throw new Error(`memory delete: ${path} is not inside ${draftsRoot} — only drafts are deletable in Phase A`)
  }
  if (!path.endsWith('.md') || !existsSync(path)) {
    throw new Error(`memory delete: ${path} is not a draft note file`)
  }
  rmSync(path, { force: true })
}

/**
 * Absolute path of the `published/` directory under `memoryDir`.
 * @param memoryDir - resolved memory root.
 * @returns `memoryDir/published`.
 */
export function publishedDir(memoryDir: string): string {
  return join(memoryDir, 'published')
}

/**
 * The session-disambiguated published basename for one note (Phase 8): the
 * source slug plus an 8-char session suffix, so two sessions' notes about
 * their own first turn never share a path.
 */
function publishedBaseFor(note: Note): string {
  const slug = slugify(note.frontmatter.source)
  const sid = slugify(note.frontmatter.session_id).slice(0, 8)
  return sid.length > 0 ? `${slug}-${sid}` : slug
}

/**
 * The relative published path (`published/<kind>/<slug>.md`) a note will occupy once
 * promoted. Uses the same slug derivation as {@link writePublished} so consolidation
 * can compute the single-flight key and dedup target without duplicating the slug rule.
 * @param note - the note whose published path to compute.
 * @returns the relative path under `memoryDir`, e.g. `published/personal/turn-0-a1b2c3d4.md`.
 *
 * Phase 8 (review round 6): the path carries an 8-char session disambiguator.
 * The slug used to derive from `source` alone, so every session's first-turn
 * note landed on `published/<kind>/turn-0.md` and the later promotion silently
 * overwrote the earlier one (cross-session knowledge loss). Content-level dedup
 * (consolidate.ts `dedupTarget`) still merges genuinely-similar notes.
 */
export function publishedRelFor(note: Note): string {
  return join('published', note.frontmatter.kind, `${publishedBaseFor(note)}.md`).split(sep).join('/')
}

/**
 * Write one published note, creating the kind subdirectory. Published notes are
 * the recall index scope (REME.md §5.2 D8: search only reads `published/` — the
 * publish gate is what admits a note into recall). Rewriting frontmatter through
 * {@link serializeNote} keeps the on-disk YAML stable; callers own `version`.
 * @param memoryDir - resolved memory root.
 * @param note - the note to write (frontmatter + body).
 * @param targetRel - optional relative path under `memoryDir` (e.g.
 *   `published/personal/<id>.md`); defaults to a slug path under `published/`
 *   derived from the note's kind and source.
 * @returns the absolute path written.
 */
export function writePublished(memoryDir: string, note: Note, targetRel?: string): string {
  const path = targetRel
    ? join(memoryDir, ...targetRel.split('/'))
    // Fallback shares the session-disambiguated slug (Phase 8) so a bare
    // writePublished and a promoteDraft-derived target agree.
    : join(memoryDir, 'published', note.frontmatter.kind, `${publishedBaseFor(note)}.md`)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, serializeNote(note), 'utf8')
  return path
}

/**
 * List published note paths under `memoryDir/published` (recursively across kind
 * subdirs). Drafts and archive are deliberately excluded — recall indexes only
 * published notes (REME.md §5.2 D8, publish-gate semantics).
 * @param memoryDir - resolved memory root.
 * @returns absolute paths of every `.md` file under published/.
 */
export function listPublished(memoryDir: string): string[] {
  const root = publishedDir(memoryDir)
  if (!existsSync(root)) return []
  const out: string[] = []
  for (const kind of readdirSync(root)) {
    const kindDir = join(root, kind)
    if (!existsSync(kindDir)) continue
    for (const file of readdirSync(kindDir)) {
      if (file.endsWith('.md')) out.push(join(kindDir, file))
    }
  }
  return out
}

/**
 * Embedding cache (Phase E, REME.md §12.1). Embeddings are a DERIVED artifact cached
 * beside the lexical `index/` — NOT persisted inside the human-readable note Markdown,
 * and stored under `index/embeddings/` so no `SUBDIRS`/persistence-catalog change is
 * needed. Keyed by published relPath. The lexical `search` path never reads these; only
 * `hybridSearch` does, and a missing cache degrades to lexical-only.
 */

/**
 * Path of the embedding cache directory (`memoryDir/index/embeddings`).
 * @param memoryDir - resolved memory root.
 * @returns the absolute embedding-cache directory path.
 */
export function embeddingCacheDir(memoryDir: string): string {
  return join(memoryDir, 'index', 'embeddings')
}

/** Map a published relPath to a filesystem-safe cache key (slashes -> underscores). */
function embeddingKey(relPath: string): string {
  return relPath.replace(/[\\/]/g, '_')
}

/**
 * Cache one note's embedding vector. Best-effort store; callers must never fail because
 * caching failed.
 * @param memoryDir - resolved memory root.
 * @param relPath - the published note relPath (e.g. `published/wiki/x.md`).
 * @param vector - the embedding vector.
 */
export function writeEmbedding(memoryDir: string, relPath: string, vector: number[]): void {
  const dir = embeddingCacheDir(memoryDir)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${embeddingKey(relPath)}.json`), JSON.stringify({ dim: vector.length, vector }), 'utf8')
}

/**
 * Read a cached embedding vector, or null when absent (the note predates embeddings or
 * was written directly). `hybridSearch` treats null as "no semantic signal".
 * @param memoryDir - resolved memory root.
 * @param relPath - the published note relPath.
 * @returns the cached vector, or null.
 */
export function readEmbedding(memoryDir: string, relPath: string): number[] | null {
  const p = join(embeddingCacheDir(memoryDir), `${embeddingKey(relPath)}.json`)
  if (!existsSync(p)) return null
  try {
    const j = JSON.parse(readFileSync(p, 'utf8')) as { dim: number; vector: number[] }
    return j.vector
  } catch {
    return null
  }
}

/**
 * Remove a cached embedding (e.g. when a note is retired). Best-effort; a missing cache
 * is not an error.
 * @param memoryDir - resolved memory root.
 * @param relPath - the published note relPath.
 */
export function deleteEmbedding(memoryDir: string, relPath: string): void {
  const p = join(embeddingCacheDir(memoryDir), `${embeddingKey(relPath)}.json`)
  if (existsSync(p)) rmSync(p, { force: true })
}

/**
 * Read one note by its relative path under `memoryDir` (e.g. `published/wiki/x.md`).
 * Thin wrapper over {@link parseNote} that prepends `memoryDir` when given a
 * relative path. Returns null for an absent or frontmatter-less file.
 * @param memoryDir - resolved memory root.
 * @param relPath - relative note path (may already be absolute).
 * @returns the parsed note, or null when missing.
 */
export function readNote(memoryDir: string, relPath: string): Note | null {
  const path = relPath.startsWith(memoryDir) ? relPath : join(memoryDir, relPath)
  return parseNote(path)
}

/**
 * Increment a published note's `use_count` and set `last_accessed` to `nowIso`,
 * rewriting ONLY the frontmatter — `version` is left unchanged because it tracks
 * content, not access (REME.md §4 D4 / §5.2 D4 aging signal; the use-signal fields
 * borrow ReMe `auto_memory.py` provenance + the paper's aging strategy). The body
 * and every other field are preserved byte-for-byte except where YAML re-serializes
 * the unchanged scalars. Best-effort: a missing or unparseable note is a no-op.
 * @param memoryDir - resolved memory root.
 * @param relPath - relative note path under `memoryDir`.
 * @param nowIso - ISO timestamp for the new `last_accessed`.
 */
export function updateUsage(memoryDir: string, relPath: string, nowIso: string): void {
  const path = relPath.startsWith(memoryDir) ? relPath : join(memoryDir, relPath)
  const note = parseNote(path)
  if (!note) return
  // Capture the mtime BEFORE rewriting so the usage touch does not move it. Otherwise
  // every recall would shift the file mtime and make `/memory rollback` always flag a
  // spurious "user edit" against the reverse-snapshot override-warning (REME.md §5.3 D11, T6.5).
  let priorMtime: number | undefined
  try { priorMtime = statSync(path).mtimeMs } catch { /* missing stat is harmless */ }
  const updated: Note = {
    frontmatter: {
      ...note.frontmatter,
      // Phase 8: coerce defensively — a hand-edited `use_count:` (empty string)
      // used to make this `'' + 1 = '1'`, then `'11'` on every hit. `Number()`
      // folds any non-numeric junk back to a clean numeric base.
      use_count: (Number(note.frontmatter.use_count) || 0) + 1,
      last_accessed: nowIso,
    },
    body: note.body,
  }
  writeFileSync(path, serializeNote(updated), 'utf8')
  if (priorMtime !== undefined) {
    try { utimesSync(path, priorMtime / 1000, priorMtime / 1000) } catch { /* best-effort */ }
  }
}

/**
 * Absolute path of the `snapshots/` directory under `memoryDir` (Phase C reverse
 * snapshot store, REME.md §5.3 D11 — rollback history lives in `snapshots/`, mirroring
 * the `/refine` RefinementEvent snapshot shape from plugin-continual-harness).
 * @param memoryDir - resolved memory root.
 * @returns `memoryDir/snapshots`.
 */
export function snapshotsDir(memoryDir: string): string {
  return join(memoryDir, 'snapshots')
}

/**
 * Copy `content` into `snapshots/<relPath>/<iso>.md`, preserving the prior published
 * version before a consolidation overwrite (REME.md §5.3 D11 reverse-snapshot: precede
 * the apply step with a snapshot of the file it will change, so rollback has a restore
 * source). The iso segment is derived from `new Date().toISOString()` (lexically
 * sortable, so the latest snapshot is the last entry). Idempotent: creates the nested
 * dir under `snapshots/`.
 * @param memoryDir - resolved memory root.
 * @param relPath - the relative published note path being overwritten (e.g. `published/wiki/x.md`).
 * @param content - the current on-disk content of that note to preserve.
 * @returns the absolute snapshot file path written.
 */
export function takeSnapshot(memoryDir: string, relPath: string, content: string): string {
  const iso = new Date().toISOString().replace(/[:.]/g, '-')
  const safeRel = relPath.split(/[\\/]/).filter(Boolean).join('/')
  // Snapshot lives at `snapshots/<relPath>/<iso>.md`: the note's relPath is the container
  // directory (e.g. `snapshots/published/personal/turn-0.md/<iso>.md`), so each note keeps
  // a list of timestamped prior versions. `relPath` already ends in `.md`, so it forms a
  // directory named after the note's full relative path (REME.md §5.3 D11).
  // Phase 8 (review round 6): the ISO name only reaches millisecond resolution, so two
  // snapshots of the same note in the same millisecond silently overwrote each other.
  // A `-N` disambiguator keeps the name lexically sortable.
  const container = join(snapshotsDir(memoryDir), safeRel)
  let snapPath = join(container, `${iso}.md`)
  if (existsSync(snapPath)) {
    let n = 2
    while (existsSync(join(container, `${iso}-${n}.md`))) n += 1
    snapPath = join(container, `${iso}-${n}.md`)
  }
  mkdirSync(dirname(snapPath), { recursive: true })
  writeFileSync(snapPath, content, 'utf8')
  return snapPath
}

/**
 * List snapshot file paths for one note id, newest first. `noteId` is the relative
 * published path (e.g. `published/wiki/x.md`); snapshots live at
 * `snapshots/<noteId>/<iso>.md`. When there are none, returns `[]`.
 * @param memoryDir - resolved memory root.
 * @param noteId - the relative published note path whose snapshots to enumerate.
 * @returns absolute snapshot paths sorted by descending mtime (newest first).
 */
export function listSnapshots(memoryDir: string, noteId: string): string[] {
  const dir = join(snapshotsDir(memoryDir), noteId.split(/[\\/]/).filter(Boolean).join('/'))
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const file of readdirSync(dir)) {
    if (file.endsWith('.md')) out.push(join(dir, file))
  }
  out.sort((a, b) => {
    try { return statSync(b).mtimeMs - statSync(a).mtimeMs } catch { return 0 }
  })
  return out
}

/**
 * Restore the named snapshot over the published note it backs up. `noteId` is the
 * relative published path; `snapshotFile` is one entry from {@link listSnapshots}.
 * Rewrites the published note at `memoryDir/noteId` with the snapshot's stored content
 * (REME.md §5.3 D11 rollback — reverse-snapshot restore). Callers own the
 * "override-warning" discipline (do not overwrite a user-edited note without `force`);
 * this function only performs the file write.
 * @param memoryDir - resolved memory root.
 * @param noteId - the relative published note path to restore.
 * @param snapshotFile - the absolute snapshot file to copy from.
 * @returns the absolute published note path written.
 */
export function restoreSnapshot(memoryDir: string, noteId: string, snapshotFile: string): string {
  const target = noteId.startsWith(memoryDir) ? noteId : join(memoryDir, noteId.split(/[\\/]/).filter(Boolean).join('/'))
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, readFileSync(snapshotFile, 'utf8'), 'utf8')
  // Phase 8 (review round 6): carry the snapshot's mtime onto the restored file.
  // The restore write used to stamp `now` on the live file, so a SECOND rollback
  // of the same note always tripped the `liveMtime > snapMtime + 1` user-edit
  // warning (and `force` then misreported "overriding a user edit").
  try {
    const snapMtime = statSync(snapshotFile).mtimeMs
    utimesSync(target, snapMtime / 1000, snapMtime / 1000)
  } catch {
    // mtime sync is best-effort; the rollback itself already succeeded.
  }
  return target
}

/**
 * Absolute path of the `archived/` directory under `memoryDir` (Phase D retire
 * target, REME.md §4 D12 — "retirement is a move, naturally reversible").
 * @param memoryDir - resolved memory root.
 * @returns `memoryDir/archived`.
 */
export function archivedDir(memoryDir: string): string {
  return join(memoryDir, 'archived')
}

/**
 * Move a published note to `archived/<same relPath>`, preserving its bytes. The
 * original `published/` file is removed after the copy succeeds (never deleted:
 * the content lives on under `archived/`, fully reversible via
 * {@link unarchiveNote}, REME.md §5.4 D12). Stamps `retired_at` into the
 * archived note's frontmatter so the retire time is auditable. Uses a copy+unlink
 * (not `renameSync`) so the move is robust across same-filesystem renames and
 * leaves a clean `published/` index behind. The `archived/` copy keeps the same
 * relative kind/slug nesting as the source.
 * @param memoryDir - resolved memory root.
 * @param relPath - relative published note path (e.g. `published/personal/turn-0.md`).
 * @returns the absolute archived note path written.
 */
export function archiveNote(memoryDir: string, relPath: string): string {
  if (!relPath.startsWith('published/')) {
    throw new Error(`archiveNote: ${relPath} must be a published/ relPath`)
  }
  const src = relPath.startsWith(memoryDir) ? relPath : join(memoryDir, relPath.split(/[\\/]/).filter(Boolean).join('/'))
  if (!existsSync(src)) throw new Error(`archiveNote: ${relPath} does not exist under published/`)
  const note = parseNote(src)
  if (!note) throw new Error(`archiveNote: ${relPath} is not a valid note file`)
  const archived = join(archivedDir(memoryDir), relPath.split(/[\\/]/).filter(Boolean).slice(1).join(sep))
  mkdirSync(dirname(archived), { recursive: true })
  const stamped: Note = {
    frontmatter: { ...note.frontmatter, retired_at: new Date().toISOString() },
    body: note.body,
  }
  writeFileSync(archived, serializeNote(stamped), 'utf8')
  rmSync(src, { force: true })
  // Phase 8 (review round 6): drop the note's embedding cache alongside the
  // move — `deleteEmbedding` was a dead API, so retired notes kept stale
  // vectors that still surfaced in hybrid retrieval.
  deleteEmbedding(memoryDir, relPath.split(/[\\/]/).filter(Boolean).join('/'))
  return archived
}

/**
 * Move an archived note back to its original `published/<same relPath>`
 * (REME.md §5.4 D12, "retirement is reversible"). Clears `retired_at` from the
 * frontmatter on the way back so the note re-enters the recall index cleanly.
 * @param memoryDir - resolved memory root.
 * @param archivedRelPath - relative note path under `archived/`, the SAME relPath it had
 *   under `published/` (e.g. `published/personal/turn-0.md`). The `archived/` source is
 *   derived by swapping the leading `published` segment for `archived`.
 * @returns the absolute published note path written.
 */
export function unarchiveNote(memoryDir: string, archivedRelPath: string): string {
  const norm = archivedRelPath.split(/[\\/]/).filter(Boolean).join('/')
  const src = norm.startsWith(memoryDir) ? norm : join(memoryDir, norm)
  if (!existsSync(src)) throw new Error(`unarchiveNote: ${norm} does not exist under archived/`)
  const note = parseNote(src)
  if (!note) throw new Error(`unarchiveNote: ${norm} is not a valid note file`)
  // The published target mirrors the archived relPath, swapping the leading `archived` for
  // `published` (same kind/slug nesting, REME.md §5.4 D12 — a true move-back).
  const publishedRel = norm.startsWith('archived/') ? norm.replace(/^archived\//, 'published/') : join('published', norm)
  const published = publishedRel.startsWith(memoryDir) ? publishedRel : join(memoryDir, publishedRel)
  const { retired_at: _omit, ...rest } = note.frontmatter
  void _omit
  mkdirSync(dirname(published), { recursive: true })
  const restored: Note = { frontmatter: rest, body: note.body }
  writeFileSync(published, serializeNote(restored), 'utf8')
  rmSync(src, { force: true })
  return published
}

/**
 * List archived note paths under `memoryDir/archived` (recursively across kind
 * subdirs). Excludes `published/`/`drafts/` deliberately — recall indexes only
 * published notes (REME.md §5.2 D8), so archived notes are out of the recall scope.
 * @param memoryDir - resolved memory root.
 * @returns absolute paths of every `.md` file under archived/.
 */
export function listArchived(memoryDir: string): string[] {
  const root = archivedDir(memoryDir)
  if (!existsSync(root)) return []
  const out: string[] = []
  for (const kind of readdirSync(root)) {
    const kindDir = join(root, kind)
    if (!existsSync(kindDir)) continue
    for (const file of readdirSync(kindDir)) {
      if (file.endsWith('.md')) out.push(join(kindDir, file))
    }
  }
  return out
}

/**
 * Absolute published note path for a note id, resolving a basename to its
 * `published/` relPath when the argument is not already a relative path. Shared
 * by the Phase D command layer and tests so the lock key and the file path agree.
 * @param memoryDir - resolved memory root.
 * @param noteId - relative published path or basename.
 * @returns the absolute published note path.
 */
export function resolvePublishedAbs(memoryDir: string, noteId: string): string {
  if (noteId.includes('/') || noteId.includes('\\')) {
    return noteId.startsWith(memoryDir) ? noteId : join(memoryDir, noteId.split(/[\\/]/).filter(Boolean).join('/'))
  }
  const candidates = [noteId, noteId.endsWith('.md') ? noteId : `${noteId}.md`]
  const match = listPublished(memoryDir)
    .map(p => (p.startsWith(memoryDir) ? p.slice(memoryDir.length).replace(/^[\\/]/, '') : p))
    .find((rel) => {
      const base = rel.split(/[\\/]/).pop() ?? ''
      return candidates.some(c => c === base)
    })
  return match ? join(memoryDir, match) : join(memoryDir, 'published', noteId)
}

/**
 * Relative `published/` path for an absolute or relative note path. Inverse of
 * {@link resolvePublishedAbs}'s relative form; used to compute the lock key and
 * the `archived/` target from a resolved absolute path.
 * @param memoryDir - resolved memory root.
 * @param absPath - absolute note path.
 * @returns the relative `published/<kind>/<slug>.md` path.
 */
export function toPublishedRel(memoryDir: string, absPath: string): string {
  const norm = absPath.startsWith(memoryDir) ? absPath.slice(memoryDir.length).replace(/^[\\/]/, '') : absPath
  return norm.split(/[\\/]/).filter(Boolean).join('/')
}

/** Re-export `relative` for callers needing path-relative math. */
export { relative }
