/**
 * Phase 2 kernel-side smoke test: `rlm()` recursion bridge (host side stubbed).
 *  - cell-level `await rlm.run(...)` works (nest_asyncio) and returns a handle
 *  - `rlm("...")` callable form delegates to run
 *  - `await rlm.list_subagents()` roundtrips a subagent registry
 *
 * The real `ctx.subagents.start` wiring lives in host-handlers.ts and needs a
 * dsh host integration test; this exercises the kernel <-> comm <-> handler
 * contract that the real handler must satisfy.
 *
 * Run: node <repo>/node_modules/.pnpm/tsx@4.x/node_modules/tsx/dist/cli.mjs phase2-smoke.mts
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

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'dsh-rlm-phase2-'))
const artifactDir = path.join(dataDir, 'session-artifacts', 'smoke')
mkdirSync(artifactDir, { recursive: true })

const python = await ensureKernelPython()

const manager = new KernelManager({
	python,
	cwd: process.cwd(),
	env: { RLM_SESSION_DIR: artifactDir, RLM_HARNESS_STATE_DIR: path.join(artifactDir, 'harness') },
	sessionId: 'smoke',
	hostHandlers: {
		// Stub the host side of the bridge. Field contract mirrors the vendored
		// rlm runtime's _spawn_handle_from_payload / _subagent_from_payload.
		'rlm.run': async (payload) => ({
			rlm_child_id: 'child-1',
			name: 'child-1',
			session_dir: 'child-1-session',
			model: 'stub/model',
		}),
		'rlm.list_subagents': async () => ({
			subagents: [
				{
					rlm_child_id: 'child-1',
					session_name: 'child-1',
					session_dir: 'child-1-session',
					status: 'running',
				},
			],
		}),
	},
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

	console.log('== rlm.run / callable / list_subagents ==')

	const r1 = await manager.execute(
		`h = await rlm.run("do a recursive thing")
print("child id:", h.rlm_child_id, "| name:", h.name)`,
	)
	check(
		'await rlm.run(...) returns handle (nest_asyncio)',
		r1.status === 'ok' && r1.stdout.includes('child id: child-1'),
		r1.status === 'ok' ? r1.stdout.trim() : (r1.error?.traceback ?? []).join('\n'),
	)

	const r2 = await manager.execute(`h2 = await rlm("quick inline")
print("callable id:", h2.rlm_child_id)`)
	check('callable rlm(...) delegates to run', r2.status === 'ok' && r2.stdout.includes('callable id: child-1'), r2.stdout.trim())

	const r3 = await manager.execute(`subs = await rlm.list_subagents()
print("subagents:", [(s.rlm_child_id, s.status) for s in subs])`)
	check(
		'await rlm.list_subagents() roundtrips',
		r3.status === 'ok' && r3.stdout.includes("'child-1', 'running'"),
		r3.status === 'ok' ? r3.stdout.trim() : (r3.error?.traceback ?? []).join('\n'),
	)
} catch (error) {
	check('fatal', false, error instanceof Error ? error.message : String(error))
} finally {
	await manager.dispose()
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
