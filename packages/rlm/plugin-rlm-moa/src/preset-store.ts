/**
 * Managed-preset store for the `moa` command: `<dataDir>/moa-presets.json`
 * holds runtime-managed presets plus the active default pointer, layered over
 * the static presets declared in plugin Config. The store file wins on name
 * collisions; the default resolution order is store default → Config default
 * → first preset.
 *
 * @module @deepseek-ai/dsh-plugin-rlm-moa/preset-store
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { normalizePresets, type MoaResolvedPreset } from './presets.ts'

/** Shape of the managed JSON file. Both fields are optional. */
export interface MoaPresetStoreFile {
  /** Presets managed at runtime; override same-name Config presets. */
  presets?: Record<string, unknown>
  /** Active default pointer written by `/moa use <name>`. */
  defaultPreset?: string
}

/**
 * Read the managed store. A missing file yields an empty store; a file whose
 * *content* is corrupted is set aside as `<name>.corrupt-<ts>` and treated as
 * empty, mirroring the harness state file's corruption policy. A file that
 * exists but cannot be read (EPERM/EACCES/EISDIR — AV scan, momentary lock,
 * permission trouble) fails loud instead: quarantining here could set aside a
 * healthy store, and the next save would then overwrite it with an empty one —
 * silent data loss.
 * @param storePath - path to the managed store JSON file.
 * @returns the parsed store, or an empty store when the file is missing or corrupted.
 */
export function loadPresetStoreSync(storePath: string): MoaPresetStoreFile {
  let raw: string
  try {
    raw = readFileSync(storePath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object')
    return parsed as MoaPresetStoreFile
  } catch {
    try {
      renameSync(storePath, `${storePath}.corrupt-${Date.now()}`)
    } catch {
      // Best-effort quarantine; the empty-store fallback applies regardless.
    }
    return {}
  }
}

/** Monotonic per-process sequence making each save's tmp path unique. */
let saveSequence = 0

/** Atomically persist the managed store (tmp write + rename).
 *
 * The tmp path is unique per save: two rapid saves in one process (or pid reuse
 * across runs) must not share a tmp file, where interleaved or leftover bytes
 * could be promoted by the rename.
 * @param storePath - path to the managed store JSON file.
 * @param store - the store object to persist.
 */
export function savePresetStoreSync(storePath: string, store: MoaPresetStoreFile): void {
  mkdirSync(dirname(storePath), { recursive: true })
  const tmp = `${storePath}.tmp-${process.pid}-${++saveSequence}`
  try {
    writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, 'utf8')
    renameSync(tmp, storePath)
  } catch (error) {
    try {
      unlinkSync(tmp)
    } catch {
      // The tmp file may never have been created; cleanup is best-effort.
    }
    throw error
  }
}

/** Layered view over Config presets + managed store, re-read per call. */
export interface PresetView {
  /** Resolve a preset by name (or the active default). Throws with available names. */
  resolve(name?: string): MoaResolvedPreset
  /** All available preset names after merging. */
  available(): string[]
  /** The active default preset name after merging. */
  defaultName(): string
}

/**
 * Build a layered preset view. Every accessor re-reads the managed store so
 * `/moa use` and `/moa remove` take effect immediately, including for tool
 * executions in the same session.
 * @param configPresets - raw `presets` record from plugin Config.
 * @param configDefault - raw `defaultPreset` from plugin Config.
 * @param storePath - managed store file path.
 * @returns a layered `PresetView` that re-reads the managed store on every accessor call.
 */
export function createPresetView(
  configPresets: Record<string, unknown> | undefined,
  configDefault: string | undefined,
  storePath: string,
): PresetView {
  const read = (): { presets: Map<string, MoaResolvedPreset>; defaultName: string } => {
    const store = loadPresetStoreSync(storePath)
    const merged = { ...(configPresets ?? {}), ...(store.presets ?? {}) }
    const normalized = normalizePresets(merged)
    const requested = store.defaultPreset?.trim() || configDefault?.trim()
    const defaultName =
      requested !== undefined && requested !== '' && normalized.presets.has(requested)
        ? requested
        : normalized.defaultName
    return { presets: normalized.presets, defaultName }
  }
  return {
    resolve(name?: string): MoaResolvedPreset {
      const { presets, defaultName } = read()
      const key = name?.trim() || defaultName
      const preset = presets.get(key)
      if (!preset) {
        throw new Error(`moa: unknown preset '${key}'. Available presets: ${[...presets.keys()].join(', ')}`)
      }
      return preset
    },
    available(): string[] {
      return [...read().presets.keys()]
    },
    defaultName(): string {
      return read().defaultName
    },
  }
}
