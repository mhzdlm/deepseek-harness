/**
 * Unit tests for the T2.1 harness→kernel skill bridge (`collectPythonSkills`):
 * python-reference entries materialize against the
 * `<dataDir>/skills/<entryId>/pyproject.toml` convention, packages that are
 * absent are reported as missing (not fatal), and non-python or non-skill
 * entries are ignored. Global scope only — the shared venv cannot honor
 * per-session skill sets.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { collectPythonSkills } from '../src/skill-source.ts'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function makeDataDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'rlm-skills-'))
  dirs.push(dir)
  return dir
}

function entry(id: string, reference: Record<string, unknown>) {
  return {
    id,
    kind: 'skill',
    title: id,
    content: '',
    path: '',
    scope: 'global',
    reference,
    arguments: {},
    metadata: {},
    source: 'test',
    created_at: '2026-08-25T00:00:00.000Z',
    updated_at: '2026-08-25T00:00:00.000Z',
    version: 1,
  }
}

function writeGlobalState(dir: string, skills: ReturnType<typeof entry>[]): void {
  const globalDir = path.join(dir, 'global', 'harness')
  mkdirSync(globalDir, { recursive: true })
  writeFileSync(
    path.join(globalDir, 'harness_state.json'),
    JSON.stringify({ schema: 1, entries: { skill: Object.fromEntries(skills.map(s => [s.id, s])) }, refinements: [] }),
    'utf8',
  )
}

function writeSkillPackage(dir: string, id: string, importName: string): void {
  const pkg = path.join(dir, 'skills', id)
  mkdirSync(pkg, { recursive: true })
  writeFileSync(path.join(pkg, 'pyproject.toml'), `[project]\nname = "${id}"\nversion = "0.1.0"\n`, 'utf8')
  mkdirSync(path.join(pkg, importName), { recursive: true })
}

describe('collectPythonSkills', () => {
  it('materializes python-reference entries whose package exists', async () => {
    const dir = makeDataDir()
    writeSkillPackage(dir, 'release-audit', 'release_audit')
    writeGlobalState(dir, [
      entry('release-audit', { type: 'python', import: 'release_audit', callable: 'run' }),
    ])

    const { skills, missing } = await collectPythonSkills(dir)
    expect(missing).toEqual([])
    expect(skills).toHaveLength(1)
    expect(skills[0]).toMatchObject({
      name: 'release-audit',
      importName: 'release_audit',
      packagePath: path.join(dir, 'skills', 'release-audit'),
      pyprojectPath: path.join(dir, 'skills', 'release-audit', 'pyproject.toml'),
    })
  })

  it('reports entries whose package directory is absent instead of failing', async () => {
    const dir = makeDataDir()
    writeSkillPackage(dir, 'present-skill', 'present_skill')
    writeGlobalState(dir, [
      entry('present-skill', { type: 'python', import: 'present_skill', callable: 'run' }),
      entry('ghost-skill', { type: 'python', import: 'ghost_skill', callable: 'run' }),
    ])

    const { skills, missing } = await collectPythonSkills(dir)
    expect(skills.map(skill => skill.name)).toEqual(['present-skill'])
    expect(missing).toEqual(['ghost-skill'])
  })

  it('ignores non-python references and non-skill kinds', async () => {
    const dir = makeDataDir()
    writeSkillPackage(dir, 'text-only', 'text_only')
    writeGlobalState(dir, [
      // Instruction-only skill: no python reference.
      entry('text-only', {}),
      { ...entry('memory-note', { type: 'python', import: 'nope', callable: 'run' }), kind: 'memory' },
      // Python reference without an import name is not installable either.
      entry('broken-ref', { type: 'python' }),
    ])

    const { skills, missing } = await collectPythonSkills(dir)
    expect(skills).toEqual([])
    expect(missing).toEqual([])
  })
})
