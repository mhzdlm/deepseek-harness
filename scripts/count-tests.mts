/**
 * Test-count generator for STATUS.md「测试统计」(Phase 10 文档治理): counts
 * `it/test/dIt/vIt/rIt` 行首调用块 per spec file across the RLM packages and
 * emits the STATUS table rows — the same counting convention the review
 * rounds used (`it.skip`/`test.skip` counted separately as 占位). Manual-run
 * only: `npx tsx scripts/count-tests.mts [--json]`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const RLM_ROOT = 'packages/rlm'
const ITEM_RE = /^[ \t]*(?:it|test|dIt|vIt|rIt)\(/
const SKIP_RE = /^[ \t]*(?:it|test|dIt|vIt|rIt)\.(?:skip|todo|fixme)\(/

interface FileCount {
  file: string
  items: number
  skipped: number
  e2e: boolean
}

function countFile(path: string): FileCount {
  const lines = readFileSync(path, 'utf8').split('\n')
  let items = 0
  let skipped = 0
  for (const line of lines) {
    if (SKIP_RE.test(line)) skipped += 1
    else if (ITEM_RE.test(line)) items += 1
  }
  return { file: path, items, skipped, e2e: path.endsWith('.e2e.ts') }
}

function listPackages(): string[] {
  return readdirSync(RLM_ROOT).filter(name => {
    const dir = join(RLM_ROOT, name)
    try {
      return statSync(dir).isDirectory() && statSync(join(dir, 'package.json')).isFile()
    } catch {
      return false
    }
  }).sort()
}

function listSpecs(pkg: string): FileCount[] {
  const dir = join(RLM_ROOT, pkg, 'tests')
  const out: FileCount[] = []
  for (const file of readdirSync(dir)) {
    if (file.endsWith('.spec.ts') || file.endsWith('.e2e.ts')) out.push(countFile(join(dir, file)))
  }
  return out.sort((a, b) => a.file.localeCompare(b.file))
}

const asJson = process.argv.includes('--json')
const packages = listPackages()
const result: Record<string, { specTotal: number; e2eTotal: number; files: FileCount[] }> = {}
for (const pkg of packages) {
  const files = listSpecs(pkg)
  result[pkg] = {
    specTotal: files.filter(f => !f.e2e).reduce((s, f) => s + f.items, 0),
    e2eTotal: files.filter(f => f.e2e).reduce((s, f) => s + f.items, 0),
    files,
  }
}

if (asJson) {
  console.log(JSON.stringify(result, null, 2))
} else {
  for (const pkg of packages) {
    const { specTotal, e2eTotal, files } = result[pkg] as { specTotal: number; e2eTotal: number; files: FileCount[] }
    console.log(`### ${pkg} — spec ${specTotal} + e2e ${e2eTotal}`)
    for (const f of files) {
      const skip = f.skipped > 0 ? `（含 ${f.skipped} skip）` : ''
      console.log(`  ${f.file.split(/[\\/]/).pop()}: ${f.items}${skip}${f.e2e ? ' [e2e]' : ''}`)
    }
  }
  const total = Object.values(result).reduce((s, p) => s + p!.specTotal, 0)
  const e2e = Object.values(result).reduce((s, p) => s + p!.e2eTotal, 0)
  console.log(`TOTAL keyless/venv spec: ${total} · real-key/venv e2e: ${e2e}`)
}
