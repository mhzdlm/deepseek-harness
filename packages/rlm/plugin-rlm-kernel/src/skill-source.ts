/**
 * Bridge from harness skill entries to the kernel's Python-skill install
 * pipeline. A harness skill entry whose `reference.type` is `"python"` names
 * an import (`reference.import`) and is backed by a real Python package on
 * disk at `<dataDir>/skills/<entryId>/` (a `pyproject.toml` project). The
 * collector turns those entries into the `PythonSkillRuntimeInfo[]` shape the
 * vendored bootstrap already knows how to `uv pip install` into the kernel
 * venv and wrap for direct calls — the wiring that was present downstream but
 * never fed.
 *
 * Only the global harness scope is consulted by design: all sessions share one
 * kernel venv, so a per-session skill set would make sessions fight over the
 * `.bootstrap-version` manifest and thrash reinstalls. Local (per-session)
 * python skills stay text-only until a per-session venv story exists.
 *
 * @module @deepseek-ai/dsh-plugin-rlm-kernel
 */

import { existsSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import {
  globalHarnessStatePath,
  harnessStatePath,
  readHarnessStateDetailed,
  readHarnessStatesDetailed,
  writeHarnessStates,
  type HarnessEntry,
  type HarnessStateFile,
  type RefinementEvent,
} from '@deepseek-ai/dsh-plugin-continual-harness'
import type { PythonSkillRuntimeInfo } from './vendor/kernel/bootstrap.ts'
import { SLUG_PATTERN } from './skill-create.ts'

/**
 * Result of {@link collectPythonSkills}: the installable python-backed skills
 * collected from the global harness state, plus the entry ids that could not be
 * materialized.
 */
export interface CollectedPythonSkills {
  /** Installable python-backed skills, in harness entry order. */
  skills: PythonSkillRuntimeInfo[]
  /**
   * Entry ids that declare a python reference but have no package under
   * `<dataDir>/skills/<entryId>/`. Reported, not fatal: a half-created skill
   * must not take down kernel provisioning.
   */
  missing: string[]
  /**
   * Entry ids that fail the slug rule and therefore never reach a filesystem
   * path. The harness state file is hand-editable, so an id like `../../victim`
   * is untrusted input to `path.join`; such entries are reported here instead
   * of being passed to `uv pip install`.
   */
  invalid: string[]
}

function isPythonReference(entry: HarnessEntry): entry is HarnessEntry & { reference: { type: 'python'; import: string } } {
  const reference = entry.reference as { type?: unknown; import?: unknown }
  return (
    entry.kind === 'skill'
    && reference?.type === 'python'
    && typeof reference.import === 'string'
    && reference.import.trim().length > 0
  )
}

/**
 * Read the global harness state and materialize its python-backed skill
 * entries against the `<dataDir>/skills/<entryId>/` package convention.
 * @param dataDir - the rlm data dir (same root the harness state lives under).
 * @returns installable skills plus the ids whose packages are missing.
 */
export async function collectPythonSkills(dataDir: string): Promise<CollectedPythonSkills> {
  const { state } = await readHarnessStateDetailed(globalHarnessStatePath(dataDir))
  const skills: PythonSkillRuntimeInfo[] = []
  const missing: string[] = []
  const invalid: string[] = []
  for (const entry of Object.values(state.entries.skill ?? {})) {
    if (!isPythonReference(entry)) continue
    // Path safety: the id is untrusted input (the state file is hand-editable),
    // so only slug-form ids may join a filesystem path below.
    if (!SLUG_PATTERN.test(entry.id)) {
      invalid.push(entry.id)
      continue
    }
    const packagePath = path.join(dataDir, 'skills', entry.id)
    const pyprojectPath = path.join(packagePath, 'pyproject.toml')
    if (!existsSync(pyprojectPath)) {
      missing.push(entry.id)
      continue
    }
    skills.push({ name: entry.id, importName: entry.reference.import, packagePath, pyprojectPath })
  }
  return { skills, missing, invalid }
}

/** One python-backed skill registration request for {@link upsertPythonSkillEntry}. */
export interface PythonSkillEntrySpec {
  /** Entry id and package directory name under `<dataDir>/skills/`. Slug form. */
  readonly id: string
  /** Human-facing title stored on the entry. */
  readonly title: string
  /** What the skill does; becomes the entry `content` the prompt layer renders. */
  readonly description: string
  /** The module name the kernel wrapper will bind (`reference.import`). */
  readonly importName: string
  /** Callable inside the module the wrapper binds. Defaults to `"run"`. */
  readonly callable?: string
}

/**
 * Create or update the global-scope harness entry for one python-backed skill
 * (T2.3). Read-modify-write under mtime CAS on both state files, recording a
 * `skill-create` refinement event in the creating session's local refinement
 * log together with a reverse-snapshot file, so `/refine-rollback <eventId>`
 * in that session restores the previous entry (or removes a freshly created
 * one) from the global store.
 * @param dataDir - the rlm data dir the harness state lives under.
 * @param spec - the python-backed skill registration request to create or update.
 * @param sessionId - the session whose refinement log records the registration;
 *   defaults to the `skill-create` pseudo-session, whose log no interactive
 *   rollback reads — callers should pass the tool's owning session.
 * @returns the stored entry as written.
 * @throws HarnessConflictError when either state file moved mid-operation.
 */
export async function upsertPythonSkillEntry(
  dataDir: string,
  spec: PythonSkillEntrySpec,
  sessionId = 'skill-create',
): Promise<HarnessEntry> {
  const states = await readHarnessStatesDetailed(dataDir, sessionId)
  const global = states.global.state
  const local = states.local.state

  const existing = global.entries.skill?.[spec.id]
  const timestamp = new Date().toISOString()
  const entry: HarnessEntry = {
    id: spec.id,
    kind: 'skill',
    title: spec.title,
    content: spec.description,
    path: '',
    scope: 'global',
    reference: { type: 'python', import: spec.importName, callable: spec.callable ?? 'run' },
    arguments: {},
    metadata: {},
    source: 'skill-create',
    created_at: existing?.created_at ?? timestamp,
    updated_at: timestamp,
    version: (existing?.version ?? 0) + 1,
  }

  // Reverse snapshot for /refine-rollback: the pre-write value of the touched
  // global key, keyed in the standard `scope:kind:id` format the rollback
  // parser understands (null = the registration creates the entry).
  const reverseSnapshot = { [`global:skill:${spec.id}`]: existing ?? null }
  const snapshotDir = path.join(path.dirname(harnessStatePath(dataDir, sessionId)), 'refinements')
  await mkdir(snapshotDir, { recursive: true })
  const snapshotPath = path.join(snapshotDir, `skill-create-${timestamp.replace(/[:.]/g, '-')}.snapshot.json`)
  const tmp = `${snapshotPath}.tmp`
  await writeFile(tmp, JSON.stringify(reverseSnapshot, null, 2), 'utf8')
  await rename(tmp, snapshotPath)

  const event: RefinementEvent = {
    id: randomUUID(),
    trigger: 'skill-create',
    changes: [`upsert global:skill:${spec.id}`],
    evidence: `python package <dataDir>/skills/${spec.id}`,
    outcome: existing === undefined ? 'created' : 'updated',
    snapshot: { path: snapshotPath },
    after: reverseSnapshot,
  }

  const nextGlobal = {
    ...global,
    entries: {
      ...global.entries,
      skill: { ...(global.entries.skill ?? {}), [spec.id]: entry },
    },
  }
  const nextLocal: HarnessStateFile = { ...local, refinements: [...local.refinements, event] }

  await writeHarnessStates(dataDir, sessionId, nextGlobal, nextLocal, {
    global: states.global.mtimeMs,
    local: states.local.mtimeMs,
  })
  return entry
}
