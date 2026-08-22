/**
 * Phase 0 runtime smoke test:
 *  1. ensureKernelPython — real venv bootstrap via uv
 *  2. KernelManager spawn + `1+1`
 *  3. Variable persistence across cells
 *  4. Jupyter Comm roundtrip: host_request('model.info') from a running cell
 *     (this is also the control-channel anti-deadlock test)
 *
 * Run: node <repo>/node_modules/.pnpm/tsx@4.x/node_modules/tsx/dist/cli.mjs phase0-smoke.mts
 */
import { mkdtempSync, mkdirSync } from 'node:fs'
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

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'dsh-rlm-phase0-'))
const artifactDir = path.join(dataDir, 'session-artifacts', 'smoke')
mkdirSync(artifactDir, { recursive: true })

console.log('== step 1: ensureKernelPython (venv bootstrap) ==')
const python = await ensureKernelPython()
check('ensureKernelPython', true, python)

console.log('== step 2: spawn kernel + bootstrap ==')
const manager = new KernelManager({
	python,
	cwd: process.cwd(),
	env: {
		RLM_SESSION_DIR: artifactDir,
		RLM_HARNESS_STATE_DIR: path.join(artifactDir, 'harness'),
	},
	sessionId: 'smoke',
	hostHandlers: {
		'model.info': async () => ({ provider: 'stub', model: 'smoke-model', contextWindow: 128000 }),
	},
	snapshot: {
		path: path.join(artifactDir, 'state.dill'),
		manifestPath: path.join(artifactDir, 'state.manifest.json'),
	},
	username: 'dsh-agent',
})

try {
	await manager.start()
	check('kernel start', true)

	const restore = await manager.restoreState()
	check(
		'restoreState (fresh → empty result expected)',
		restore !== null && restore.restored.length === 0 && restore.failed.length === 0,
		JSON.stringify(restore),
	)

	const boot = await manager.execute(buildRlmBootstrapCode(), { internal: true })
	check('rlm bootstrap', boot.status === 'ok', boot.status !== 'ok' ? (boot.error?.traceback ?? []).join('\n') : '')

	console.log('== step 3: basic execution ==')
	const r1 = await manager.execute('1+1')
	check('1+1', r1.status === 'ok' && String(r1.result).includes('2'), `result=${JSON.stringify(r1.result)}`)

	await manager.execute('x = 41')
	const r2 = await manager.execute('x + 1')
	check('variable persistence', r2.status === 'ok' && String(r2.result).includes('42'), `result=${JSON.stringify(r2.result)}`)

	console.log('== step 4: comm roundtrip / control channel ==')
	const r3 = await manager.execute(
		`import rlm as _rlm
_reply = await _rlm.host_request('model.info', {})
print('host_request returned:', _reply)`,
	)
	check(
		"host_request('model.info') roundtrip",
		r3.status === 'ok' && r3.stdout.includes('smoke-model'),
		`status=${r3.status} stdout=${r3.stdout.trim()} ${r3.error ? `err=${(r3.error.traceback ?? []).join(' | ')}` : ''}`,
	)

	const r4 = await manager.execute("print(type(rlm).__name__, callable(rlm))")
	check('rlm handle injected', r4.status === 'ok' && r4.stdout.includes('True'), r4.stdout.trim())
} catch (error) {
	check('fatal', false, error instanceof Error ? error.message : String(error))
} finally {
	await manager.dispose()
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
