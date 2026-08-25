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
import path from 'node:path'
import {
  globalHarnessStatePath,
  readHarnessStateDetailed,
  type HarnessEntry,
} from '@deepseek-ai/dsh-plugin-continual-harness'
import type { PythonSkillRuntimeInfo } from './vendor/kernel/bootstrap.ts'

export interface CollectedPythonSkills {
  /** Installable python-backed skills, in harness entry order. */
  skills: PythonSkillRuntimeInfo[]
  /**
   * Entry ids that declare a python reference but have no package under
   * `<dataDir>/skills/<entryId>/`. Reported, not fatal: a half-created skill
   * must not take down kernel provisioning.
   */
  missing: string[]
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
  for (const entry of Object.values(state.entries.skill ?? {})) {
    if (!isPythonReference(entry)) continue
    const packagePath = path.join(dataDir, 'skills', entry.id)
    const pyprojectPath = path.join(packagePath, 'pyproject.toml')
    if (!existsSync(pyprojectPath)) {
      missing.push(entry.id)
      continue
    }
    skills.push({ name: entry.id, importName: entry.reference.import, packagePath, pyprojectPath })
  }
  return { skills, missing }
}
