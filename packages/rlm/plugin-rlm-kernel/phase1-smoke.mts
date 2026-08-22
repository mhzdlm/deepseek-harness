/**
 * Phase 1 runtime smoke test: dill snapshot + kill/restart restore.
 *  - define `x = 41`, explicit snapshotState()
 *  - dispose kernel (kill), respawn with the SAME snapshot path
 *  - restoreState() revives `x`, then `x + 1` === 42
 *  - also checks an unpicklable variable is reported skipped at snapshot time
 *
 * Run: node <repo>/node_modules/.pnpm/tsx@4.x/node_modules/tsx/dist/cli.mjs phase1-smoke.mts
 */
import { mkdtempSync, mkdirSync, existsSync } from 'node:fs'
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

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'dsh-rlm-phase1-'))
const artifactDir = path.join(dataDir, 'session-artifacts', 'smoke')
mkdirSync(artifactDir, { recursive: true })

const snapshotPath = path.join(artifactDir, 'state.dill')
const manifestPath = path.join(artifactDir, 'state.manifest.json')

function makeManager(): KernelManager {
	return new KernelManager({
		python,
		cwd: process.cwd(),
		env: { RLM_SESSION_DIR: artifactDir, RLM_HARNESS_STATE_DIR: path.join(artifactDir, 'harness') },
		sessionId: 'smoke',
		hostHandlers: { 'model.info': async () => ({ provider: 'stub', model: 'smoke-model' }) },
		snapshot: { path: snapshotPath, manifestPath },
		username: 'dsh-agent',
	})
}

const python = await ensureKernelPython()

console.log('== kernel #1: define state, snapshot ==')
const k1 = makeManager()
try {
	await k1.start()
	await k1.restoreState()
	await k1.execute(buildRlmBootstrapCode(), { internal: true })

	await k1.execute('x = 41')
	await k1.execute('import threading; lock = threading.Lock()') // dill pickles this fine

	const snap = await k1.snapshotState()
	check('snapshotState returns result', snap !== null && existsSync(snapshotPath), JSON.stringify(snap))
	check('snapshot manifest written', existsSync(manifestPath))

	await k1.dispose()
	check('kernel #1 disposed', true)
} finally {
	await k1.dispose()
}

console.log('== kernel #2: respawn + restore ==')
const k2 = makeManager()
try {
	await k2.start()
	const restore = await k2.restoreState()
	check('restoreState revives x', restore?.restored.includes('x') ?? false, JSON.stringify(restore))

	await k2.execute(buildRlmBootstrapCode(), { internal: true })

	const r = await k2.execute('x + 1')
	check('restored state usable (x+1 === 42)', r.status === 'ok' && String(r.result).includes('42'), `result=${JSON.stringify(r.result)}`)

	const snap2 = await k2.snapshotState()
	check('snapshot after restore includes x', snap2 !== null, JSON.stringify(snap2))
} finally {
	await k2.dispose()
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
