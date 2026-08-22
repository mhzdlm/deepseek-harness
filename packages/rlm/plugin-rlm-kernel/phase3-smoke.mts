/**
 * Phase 3 kernel-side smoke test: Continual Harness storage.
 *  - `rlm.get_harness_state()` resolves against RLM_SESSION_DIR (env-injected)
 *  - create_memory → list("memory") roundtrip
 *  - harness_state.json is written by the kernel alone (no host handler)
 *
 * The system-prompt injection side lives in plugin-continual-harness and needs
 * a dsh host; this exercises the vendored harness.py storage the prompt
 * section will read.
 *
 * Run: node <repo>/node_modules/.pnpm/tsx@4.x/node_modules/tsx/dist/cli.mjs phase3-smoke.mts
 */
import { mkdtempSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ensureKernelPython } from './src/vendor/kernel/bootstrap.ts'
import { KernelManager } from './src/vendor/kernel/index.ts'
import { buildRlmBootstrapCode } from './src/rlm-bootstrap.ts'

let failures = 0
function check(name: string, ok: boolean, detail = '') {
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
	if (!ok) failures++
}

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'dsh-rlm-phase3-'))
const artifactDir = path.join(dataDir, 'session-artifacts', 'smoke')
mkdirSync(artifactDir, { recursive: true })

const python = await ensureKernelPython()
const harnessDir = path.join(artifactDir, 'harness')
const stateFile = path.join(harnessDir, 'harness_state.json')

const manager = new KernelManager({
	python,
	cwd: process.cwd(),
	env: { RLM_SESSION_DIR: artifactDir, RLM_HARNESS_STATE_DIR: harnessDir },
	sessionId: 'smoke',
	hostHandlers: { 'model.info': async () => ({ provider: 'stub', model: 'smoke-model' }) },
	snapshot: {
		path: path.join(artifactDir, 'state.dill'),
		manifestPath: path.join(artifactDir, 'state.manifest.json'),
	},
	username: 'dsh-agent',
})

try {
	await manager.start()
	await manager.restoreState()
	await manager.execute(buildRlmBootstrapCode(), { internal: true })

	console.log('== harness create/list ==')

	const r1 = await manager.execute(
		`import rlm as _rlm
_h = _rlm.get_harness_state()
_e = _h.create_memory("phase3", "remember this fact")
print("created:", _e.id)`,
	)
	check('create_memory returns entry', r1.status === 'ok' && r1.stdout.includes('created:'), r1.status === 'ok' ? r1.stdout.trim() : (r1.error?.traceback ?? []).join('\n'))

	const r2 = await manager.execute(
		`import rlm as _rlm
_h = _rlm.get_harness_state()
_mems = _h.list("memory")
print("memories:", [(m.id, m.title) for m in _mems])`,
	)
	check(
		'list("memory") roundtrips',
		r2.status === 'ok' && r2.stdout.includes('phase3'),
		r2.status === 'ok' ? r2.stdout.trim() : (r2.error?.traceback ?? []).join('\n'),
	)

	check('harness_state.json written on disk', existsSync(stateFile), stateFile)

	const raw = JSON.parse(readFileSync(stateFile, 'utf8'))
	const memories = raw.entries?.memory ?? {}
	check(
		'harness_state.json contains the memory entry',
		typeof memories === 'object' && memories !== null && 'phase3' in memories,
		`keys=${Object.keys(raw).join(',')}`,
	)
} catch (error) {
	check('fatal', false, error instanceof Error ? error.message : String(error))
} finally {
	await manager.dispose()
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
