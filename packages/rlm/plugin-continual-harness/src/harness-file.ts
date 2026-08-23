/**
 * Harness state file access, 1:1 aligned with the vendored `harness.py` JSON
 * layout so the TS host and the kernel runtime share the same file safely
 * (single writer at a time; atomic rename).
 *
 * The kernel plugin places the state at
 * `<ctx.baseDir>/session-artifacts/<sessionId>/harness/harness_state.json`
 * (it sets `RLM_HARNESS_STATE_DIR` for the kernel env) and global-scope state
 * at `<ctx.baseDir>/global/harness/harness_state.json` (`RLM_GLOBAL_HARNESS_STATE_DIR`).
 * This module owns the read/render path and the reverse-snapshot/rollback used by /refine,
 * including merging the two files into one working view.
 *
 * FIX-7: writers can pass the mtime observed at read time; writeHarnessState
 * re-stats before renaming and throws {@link HarnessConflictError} when the
 * file moved underneath us — mirroring the vendored `harness.py`
 * `_sync_from_disk()` guard on the host side.
 *
 * FIX-11: a corrupt (unparseable) state file is backed up as
 * `harness_state.json.corrupt-<ts>` before being treated as empty, so a
 * salvageable file is never silently overwritten to zero.
 * @module @deepseek-ai/dsh-plugin-continual-harness
 */

import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { copyFileSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import path from 'node:path'

/** How many `.corrupt-*` backups to keep before pruning (FIX-11). */
const CORRUPT_BACKUP_KEEP = 5

/** FIX-7: the state file changed on disk between a read and the CAS write. */
export class HarnessConflictError extends Error {
  constructor(filePath: string) {
    super(`harness state changed on disk during read-modify-write: ${filePath}`)
    this.name = 'HarnessConflictError'
  }
}

export type HarnessKind = 'prompt' | 'memory' | 'skill' | 'subagent'
export type HarnessScope = 'local' | 'global'

export interface HarnessEntry {
  id: string
  kind: HarnessKind
  title: string
  content: string
  path: string
  scope: HarnessScope
  reference: Record<string, unknown>
  arguments: Record<string, unknown>
  metadata: Record<string, unknown>
  source: string
  created_at: string
  updated_at: string
  version: number
}

export interface RefinementEvent {
  id: string
  trigger: string
  changes: string[]
  evidence: string
  outcome: string
  snapshot?: { path: string } | null
  /**
	 * FIX-5: state of every touched key immediately after this event applied
	 * (null = deleted). rollbackRefine compares the live value against this
	 * before overwriting, so a rollback cannot silently clobber newer edits.
	 */
  after?: Record<string, HarnessEntry | null> | null
}

export interface HarnessStateFile {
  schema: number
  entries: Partial<Record<HarnessKind, Record<string, HarnessEntry>>>
  refinements: RefinementEvent[]
}

/** State plus the on-disk mtime observed at read, for CAS writes (FIX-7). */
export interface HarnessStateWithMeta {
  state: HarnessStateFile
  /** `null` when the file did not exist. */
  mtimeMs: number | null
}

export function harnessStatePath(baseDir: string, sessionId: string): string {
  return path.join(baseDir, 'session-artifacts', sessionId, 'harness', 'harness_state.json')
}

/**
 * Cross-session global harness state file. The kernel writes `global_=True`
 * entries here via `RLM_GLOBAL_HARNESS_STATE_DIR` (see the kernel plugin);
 * this is the one file that makes the harness "continual" across sessions.
 */
export function globalHarnessStatePath(baseDir: string): string {
  return path.join(baseDir, 'global', 'harness', 'harness_state.json')
}

/**
 * FIX-11: copy a corrupt state file aside before the read path treats it as
 * empty. Backup failure never blocks the read path. Old backups are pruned to
 * `CORRUPT_BACKUP_KEEP` entries.
 */
async function backupCorrupt(filePath: string): Promise<void> {
  try {
    const backup = `${filePath}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`
    await copyFile(filePath, backup)
    const dir = path.dirname(filePath)
    const base = path.basename(filePath)
    const backups = (await readdir(dir)).filter(f => f.startsWith(`${base}.corrupt-`)).sort()
    for (const old of backups.slice(0, Math.max(0, backups.length - CORRUPT_BACKUP_KEEP))) {
      await rm(path.join(dir, old), { force: true }).catch(() => undefined)
    }
  } catch (error) {
    // A missing file is not corrupt — no backup needed, silently proceed.
    const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined
    if (code === 'ENOENT') return
    // A real backup failure (permissions, disk full, etc.) should surface.
    console.warn(`[continual-harness] failed to backup corrupt state file ${filePath}: ${error}`)
  }
}

/** Read state plus observed mtime; missing or corrupt files yield empty state. */
export async function readHarnessStateDetailed(filePath: string): Promise<HarnessStateWithMeta> {
  let mtimeMs: number | null = null
  try {
    mtimeMs = (await stat(filePath)).mtimeMs
  } catch {
    return { state: emptyHarnessState(), mtimeMs: null }
  }
  try {
    const data: unknown = JSON.parse(await readFile(filePath, 'utf8'))
    if (!isRecord(data)) return { state: emptyHarnessState(), mtimeMs }
    return {
      state: {
        schema: typeof data.schema === 'number' ? data.schema : 1,
        entries: isRecord(data.entries) ? data.entries : {},
        refinements: Array.isArray(data.refinements) ? data.refinements : [],
      },
      mtimeMs,
    }
  } catch {
    // FIX-11: salvage the corrupt file before treating it as empty.
    await backupCorrupt(filePath)
    return { state: emptyHarnessState(), mtimeMs }
  }
}

export async function readHarnessState(filePath: string): Promise<HarnessStateFile> {
  return (await readHarnessStateDetailed(filePath)).state
}

/**
 * FIX-7: CAS write. When `expectedMtimeMs` is provided, re-stats the file
 * immediately before renaming and throws {@link HarnessConflictError} if it
 * moved — so `/refine` cannot clobber a kernel-side write that landed between
 * its read and its write.
 */
export async function writeHarnessState(
  filePath: string,
  state: HarnessStateFile,
  expectedMtimeMs?: number | null,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  if (expectedMtimeMs !== undefined) {
    try {
      const current = (await stat(filePath)).mtimeMs
      if (current !== expectedMtimeMs) throw new HarnessConflictError(filePath)
    } catch (error) {
      if (error instanceof HarnessConflictError) throw error
      // Missing file matches an expectedMtimeMs of null (read of a
      // non-existent file); anything else is a real conflict.
      if (expectedMtimeMs !== null) throw error
    }
  }
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, JSON.stringify(state, null, 2), 'utf8')
  await rename(tmp, filePath)
}

/** Both harness state files with the mtime observed at read (for CAS writes). */
export interface HarnessStatesWithMeta {
  global: HarnessStateWithMeta
  local: HarnessStateWithMeta
}

/** Read global + per-session state in parallel, each with its observed mtime. */
export async function readHarnessStatesDetailed(
  baseDir: string,
  sessionId: string,
): Promise<HarnessStatesWithMeta> {
  const [global, local] = await Promise.all([
    readHarnessStateDetailed(globalHarnessStatePath(baseDir)),
    readHarnessStateDetailed(harnessStatePath(baseDir, sessionId)),
  ])
  return { global, local }
}

/**
 * CAS-write both files; a stale mtime on either throws {@link HarnessConflictError}.
 *
 * P1-fix: global-write failure rolls back the local write (restores the previous
 * local state) so the two files stay consistent — otherwise the next system-prompt
 * render sees a local-new + global-old torn view.
 */
export async function writeHarnessStates(
  baseDir: string,
  sessionId: string,
  global: HarnessStateFile,
  local: HarnessStateFile,
  expected: { global: number | null; local: number | null },
): Promise<void> {
  const localPath = harnessStatePath(baseDir, sessionId)
  // Local first: the session's refine event log lives there, so a global-file
  // conflict is safer to fail after the session's own record is durable.
  await writeHarnessState(localPath, local, expected.local)
  // P1-fix: snapshot pre-write local state for rollback on global failure.
  const localPrev = await readHarnessStateDetailed(localPath)
  try {
    await writeHarnessState(globalHarnessStatePath(baseDir), global, expected.global)
  } catch (globalError) {
    // P1-fix: global write failed — roll back local to its pre-write value
    // (best-effort; if rollback also fails the two files are still torn).
    if (localPrev.mtimeMs !== null) {
      try {
        await writeHarnessState(localPath, localPrev.state, expected.local)
      } catch {
        // Rollback failed — surface the original global error; torn state
        // is logged by the caller's catch.
      }
    }
    throw globalError
  }
}

const HARNESS_KINDS = ['prompt', 'memory', 'skill', 'subagent'] as const

/**
 * Merge global + local into one working view for rendering and /refine.
 * Entries carry their own `scope` field, so renderers can distinguish
 * `[global]`-marked lines; refinements come from the session (local) file.
 */
export function mergeHarnessStates(global: HarnessStateFile, local: HarnessStateFile): HarnessStateFile {
  const entries: HarnessStateFile['entries'] = {}
  for (const kind of HARNESS_KINDS) {
    const globalEntries = global.entries[kind]
    const localEntries = local.entries[kind]
    if (globalEntries && Object.keys(globalEntries).length > 0) entries[kind] = { ...globalEntries }
    if (localEntries && Object.keys(localEntries).length > 0) {
      entries[kind] = { ...(entries[kind] ?? {}), ...localEntries }
    }
  }
  return { schema: 1, entries, refinements: local.refinements }
}

/**
 * Split a merged working state back into global/local files by each entry's
 * `scope` field. `globalRefinements` is preserved from the pre-merge global
 * read so kernel-side global ops' events are never dropped on rewrite.
 */
export function splitHarnessStateByScope(
  merged: HarnessStateFile,
  globalRefinements: RefinementEvent[],
): { global: HarnessStateFile; local: HarnessStateFile } {
  const globalEntries: HarnessStateFile['entries'] = {}
  const localEntries: HarnessStateFile['entries'] = {}
  for (const kind of HARNESS_KINDS) {
    const entries = merged.entries[kind]
    if (!entries) continue
    for (const [id, entry] of Object.entries(entries)) {
      if (entry.scope === 'global') (globalEntries[kind] ??= {})[id] = entry
      else (localEntries[kind] ??= {})[id] = entry
    }
  }
  return {
    global: { schema: 1, entries: globalEntries, refinements: globalRefinements },
    local: { schema: 1, entries: localEntries, refinements: merged.refinements },
  }
}

/**
 * Synchronous read for system-prompt sections (their `text` provider is sync).
 */
export function readHarnessStateSync(filePath: string): HarnessStateFile {
  try {
    const data: unknown = JSON.parse(readFileSync(filePath, 'utf8'))
    if (!isRecord(data)) return emptyHarnessState()
    return {
      schema: typeof data.schema === 'number' ? data.schema : 1,
      entries: isRecord(data.entries) ? data.entries : {},
      refinements: Array.isArray(data.refinements) ? data.refinements : [],
    }
  } catch {
    // FIX-11: salvage the corrupt file before treating it as empty.
    backupCorruptSync(filePath)
    pruneCorruptBackupsSync(filePath)
    return emptyHarnessState()
  }
}

/** FIX-11: prune `.corrupt-*` backups to {@link CORRUPT_BACKUP_KEEP} (sync path). */
function pruneCorruptBackupsSync(filePath: string): void {
  try {
    const dir = path.dirname(filePath)
    const base = path.basename(filePath)
    const backups = readdirSync(dir).filter(f => f.startsWith(`${base}.corrupt-`)).sort()
    for (const old of backups.slice(0, Math.max(0, backups.length - CORRUPT_BACKUP_KEEP))) {
      try {
        unlinkSync(path.join(dir, old))
      } catch {
        // best-effort prune
      }
    }
  } catch {
    // directory unreadable or missing; nothing to prune
  }
}

function backupCorruptSync(filePath: string): void {
  try {
    statSync(filePath) // ensure it exists (a missing file is not corrupt)
    copyFileSync(filePath, `${filePath}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`)
  } catch (error) {
    // A missing file is not corrupt — no backup needed, silently proceed.
    const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined
    if (code === 'ENOENT') return
    // A real backup failure (permissions, disk full, etc.) should surface.
    console.warn(`[continual-harness] failed to backup corrupt state file ${filePath}: ${error}`)
  }
}

function emptyHarnessState(): HarnessStateFile {
  return { schema: 1, entries: {}, refinements: [] }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
