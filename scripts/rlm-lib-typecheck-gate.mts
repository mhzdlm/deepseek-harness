/**
 * RLM host-lib typecheck gate (docs 仓 BUILD.md Phase 0): runs the full host
 * TypeScript build and tolerates ONLY the documented official pre-existing
 * typecheck failures (docs 仓 archive/rlm_typecheck_official_pre-existing.md — upstream
 * debt we record, never patch). Any error outside the tolerated file set
 * fails the build, so official drift gets re-triaged instead of silently
 * masked. `pnpm run build:lib:host:rlm` chains this gate before tsdown.
 *
 * Why a full build instead of an RLM-scoped tsc closure: the tsdown/typert
 * pass consumes every workspace package's lib/types output; a scoped closure
 * leaves official outputs stale and typert then fails on drift between fresh
 * RLM sources and stale official JS. tsc -b emits JS even for projects that
 * fail typecheck, so tolerating the six documented errors is enough to get
 * complete, fresh lib/types workspace-wide.
 *
 * @module scripts/rlm-lib-typecheck-gate
 */

import { spawnSync } from 'node:child_process'
import path from 'node:path'

/** Official files whose typecheck failures are documented upstream debt (docs 仓 archive/rlm_typecheck_official_pre-existing.md). alpha.1→alpha.3 收敛：adapter/stream/github-ready-review 三项已被官方修复并移出本表（留表即容忍未来回潮）；余 convert.spec.ts 三项（CallId 更名未跟进 + toPiContext 旧签名）。 */
const TOLERATED_OFFICIAL_ERROR_FILES = [
  'packages/llm/llm-pi-ai/tests/convert.spec.ts',
]

function toPosix(value: string): string {
  return value.replaceAll('\\', '/')
}

const tsc = spawnSync(
  process.execPath,
  ['--max-old-space-size=4096', path.join('node_modules', 'typescript', 'bin', 'tsc'), '-b', 'tsconfig.host.json', '--pretty', 'false'],
  { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' },
)

const output = `${tsc.stdout ?? ''}${tsc.stderr ?? ''}`
const errorLines = output.split(/\r?\n/).filter((line) => line.includes(': error TS'))
const unknown = errorLines.filter((line) => !TOLERATED_OFFICIAL_ERROR_FILES.some((file) => toPosix(line).includes(file)))

if (unknown.length > 0) {
  console.error('rlm-lib-typecheck-gate: host typecheck produced errors outside the tolerated official set (docs 仓 archive/rlm_typecheck_official_pre-existing.md) — re-triage before building:')
  for (const line of unknown) console.error(`  ${line}`)
  process.exit(1)
}

if (tsc.status !== 0 && errorLines.length === 0) {
  // Non-typecheck failure (project config, OOM, crash) must never be swallowed.
  console.error(output)
  process.exit(tsc.status ?? 1)
}

if (errorLines.length > 0) {
  console.log(`rlm-lib-typecheck-gate: tolerated ${errorLines.length} documented official pre-existing typecheck error(s)`)
}
