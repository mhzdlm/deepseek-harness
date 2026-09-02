/**
 * Unit tests for the `create_python_skill` tool gate (T2.3): slug/identifier
 * validation, loud disk-mismatch failures naming the concrete missing files,
 * and the success path registering through the CAS upsert.
 */
import { mkdtempSync, mkdirSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createSkillCreateTool, validateSkillPackage } from '../src/skill-create.ts'
import { globalHarnessStatePath } from '@deepseek-ai/dsh-plugin-continual-harness'
import { upsertPythonSkillEntry } from '../src/skill-source.ts'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function makeDataDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'rlm-create-tool-'))
  dirs.push(dir)
  return dir
}

function writeGoodPackage(dataDir: string, id: string, importName: string): void {
  const pkg = path.join(dataDir, 'skills', id)
  mkdirSync(pkg, { recursive: true })
  writeFileSync(path.join(pkg, 'pyproject.toml'), `[project]\nname = "${id}"\n`, 'utf8')
  writeFileSync(path.join(pkg, `${importName}.py`), 'async def run():\n    return {}\n', 'utf8')
}

describe('validateSkillPackage', () => {
  it('passes a complete package', () => {
    const dir = makeDataDir()
    writeGoodPackage(dir, 'demo-audit', 'demo_audit')
    expect(validateSkillPackage(dir, 'demo-audit', 'demo_audit')).toEqual([])
  })

  it('names each concrete mismatch for a partial package', () => {
    const dir = makeDataDir()
    mkdirSync(path.join(dir, 'skills', 'demo-audit'), { recursive: true })
    const problems = validateSkillPackage(dir, 'demo-audit', 'demo_audit')
    expect(problems).toHaveLength(2)
    expect(problems.some(p => p.includes('pyproject.toml'))).toBe(true)
    expect(problems.some(p => p.includes('demo_audit.py'))).toBe(true)
  })
})

describe('create_python_skill tool', () => {
  function tool(dataDir: string) {
    // The real CAS upsert is injected exactly as the host assembly does.
    return createSkillCreateTool({ dataDir, upsert: upsertPythonSkillEntry }) as unknown as {
      execute: (args: Record<string, unknown>, exec?: unknown) => Promise<{ text?: string }>
    }
  }

  it('rejects a bad slug before touching disk or state', async () => {
    const dir = makeDataDir()
    await expect(tool(dir).execute({ name: 'Bad Slug', import_name: 'x', title: 't', description: 'd' }))
      .rejects.toThrow(/name must match/)
  })

  it('refuses kernel-reserved import names before touching disk or state (Phase 8)', async () => {
    const dir = makeDataDir()
    // A valid package under a reserved name: the reservation must still win,
    // otherwise `import_name="rlm"` overwrites the kernel's callable runtime.
    writeGoodPackage(dir, 'impostor', 'rlm')
    await expect(tool(dir).execute({
      name: 'impostor', import_name: 'rlm', title: 'Impostor', description: 'd',
    })).rejects.toThrow(/reserved by the kernel runtime/)
    await expect(tool(dir).execute({
      name: 'impostor-b', import_name: '_prime_agent_host_request', title: 'Impostor', description: 'd',
    })).rejects.toThrow(/reserved by the kernel runtime/)
    // Nothing leaked into the harness state (which the rejection never creates).
    const statePath = globalHarnessStatePath(dir)
    expect(existsSync(statePath)).toBe(false)
  })

  it('fails loud listing what is missing on disk', async () => {
    const dir = makeDataDir()
    await expect(tool(dir).execute({
      name: 'ghost-skill', import_name: 'ghost_skill', title: 'Ghost', description: 'd',
    })).rejects.toThrow(/does not match the request[\s\S]*pyproject\.toml/)
  })

  it('registers a matching package and reports the effective timing', async () => {
    const dir = makeDataDir()
    writeGoodPackage(dir, 'demo-audit', 'demo_audit')
    const result = await tool(dir).execute({
      name: 'demo-audit', import_name: 'demo_audit', title: 'Demo audit', description: 'Audits demos.',
    })
    expect(result.text).toContain('await demo_audit')
    expect(result.text).toContain('next kernel provision')

    // Phase A freeze (BUILD.md R5): the global scope no longer accepts writes;
    // the disk install happens but the registration entry is not persisted.
    expect(existsSync(globalHarnessStatePath(dir))).toBe(false)
    expect(result.text).toContain('frozen')
  })
})
