/**
 * Live-kernel dogfood for the loop-audit skill (NEXT T2.4): the real venv
 * pipeline installs the packaged skill, the bootstrap binds it as a callable,
 * and `await loop_audit(report)` validates good and broken audit headers
 * against the deterministic protocol. Runs against an isolated throwaway
 * venv (DSH_RLM_KERNEL_VENV) so test skills never touch the shared user
 * venv; skipped when `uv` is unavailable on PATH.
 */
import { existsSync, cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { SessionKernelRegistry } from '../src/kernels.ts'
import { collectPythonSkills } from '../src/skill-source.ts'

const GOOD_REPORT = [
  'Status: complete',
  'Integrity: clean',
  'Contract audit: aligned',
  '',
  'Executor landed the bounded subtask; evidence summarized above.',
].join('\n')

const BAD_REPORT = [
  'status: done',
  'Integrity: clean',
  '',
  'prose without a proper header',
].join('\n')

// Resolve against this spec's own location so the suite passes under any
// working directory (repo root or the package dir, e.g. pnpm --filter runs).
const SKILL_SOURCE_DIR = path.resolve(import.meta.dirname, '../../plugin-rlm-loop/skills/loop-audit')

function hasUv(): boolean {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const candidate = path.join(dir, process.platform === 'win32' ? 'uv.exe' : 'uv')
    if (existsSync(candidate)) return true
  }
  return false
}

describe('loop-audit kernel skill (live isolated venv)', () => {
  if (!hasUv()) {
    it.skip('requires uv on PATH', () => undefined)
    return
  }

  let root: string | undefined
  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true })
  })

  it('installs via the harness convention and validates audit headers in-kernel', async () => {
    root = mkdtempSync(path.join(tmpdir(), 'rlm-loop-skill-'))
    const dataDir = path.join(root, 'data')
    process.env.DSH_RLM_KERNEL_VENV = path.join(root, 'venv')

    // Harness entry, global scope — written exactly as upsertPythonSkillEntry would.
    const harnessDir = path.join(dataDir, 'global', 'harness')
    mkdirSync(harnessDir, { recursive: true })
    writeFileSync(
      path.join(harnessDir, 'harness_state.json'),
      JSON.stringify({
        schema: 1,
        entries: {
          skill: {
            'loop-audit': {
              id: 'loop-audit', kind: 'skill', title: 'loop-audit',
              content: 'Validate auditor three-line headers.', path: '', scope: 'global',
              reference: { type: 'python', import: 'loop_audit', callable: 'run' },
              arguments: {}, metadata: {}, source: 'dogfood',
              created_at: '2026-08-25T00:00:00Z', updated_at: '2026-08-25T00:00:00Z', version: 1,
            },
          },
        },
        refinements: [],
      }),
      'utf8',
    )
    cpSync(SKILL_SOURCE_DIR, path.join(dataDir, 'skills', 'loop-audit'), { recursive: true, filter: () => true })

    const registry = new SessionKernelRegistry({
      dataDir,
      hostHandlers: {},
      pythonSkillsProvider: async () => (await collectPythonSkills(dataDir)).skills,
    } as never)

    try {
      const kernel = await registry.forSession('loop-skill-dogfood')

      const good = await kernel.execute([
        `report = ${JSON.stringify(GOOD_REPORT)}`,
        'r = await loop_audit(report)',
        "print(r['ok'], r['header']['status'], len(r['problems']))",
      ].join('\n'))
      expect(good.status).toBe('ok')
      expect(good.stdout).toContain('True complete 0')

      const bad = await kernel.execute([
        `report = ${JSON.stringify(BAD_REPORT)}`,
        'r = await loop_audit(report)',
        "print(r['ok'], r['header'], r['problems'][0][:22])",
      ].join('\n'))
      expect(bad.status).toBe('ok')
      expect(bad.stdout).toContain('False None')

      await registry.disposeAll()
    } catch (error) {
      try { registry.disposeAll() } catch { /* already disposing or disposed */ }
      throw error
    }
  }, 300_000)
})
