/**
 * Per-session kernel lifecycle. One `KernelManager` per dsh session so parent
 * and child agents never share a namespace. Start order is preserved from
 * prime: `start()` → `restoreState()` (dill snapshot) → RLM bootstrap.
 *
 * Artifacts (snapshot + harness state) live under
 * `<dataDir>/session-artifacts/<sessionId>`, which is also exported to the
 * kernel as `RLM_SESSION_DIR` so the vendored `harness.py` resolves its state
 * file without touching the host.
 * @module @deepseek-ai/dsh-plugin-rlm-kernel
 */

import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { KernelManager, type HostRequestHandlers } from './vendor/kernel/index.ts'
import type { KernelPythonSkill } from './vendor/kernel/bootstrap.ts'
import type { RestoreResult } from './vendor/kernel/state-snapshot.ts'
import { snapshotPathIn, manifestPathIn } from './vendor/kernel/state-snapshot.ts'
import { buildRlmBootstrapCode } from './rlm-bootstrap.ts'

export interface SessionKernelOptions {
	/** Python interpreter with ipykernel + prime-agent-runtime. Omitted → auto-bootstrapped venv. */
	python?: string
	/** Root directory for kernel artifacts (snapshots + harness state). */
	dataDir: string
	hostHandlers: HostRequestHandlers
	pythonSkills?: readonly KernelPythonSkill[]
}

/**
 * Registry of live kernels, keyed by session id. Disposal is driven by the
 * plugin via `disposeSession` on `session/disposed`.
 */
export class SessionKernelRegistry {
	private readonly kernels = new Map<string, KernelManager>()
	private readonly pendingRestore = new Map<string, RestoreResult>()
	private readonly artifactRoot: string

	constructor(private readonly options: SessionKernelOptions) {
		this.artifactRoot = path.join(options.dataDir, 'session-artifacts')
	}

	async forSession(sessionId: string): Promise<KernelManager> {
		const existing = this.kernels.get(sessionId)
		if (existing) return existing
		const manager = await this.provision(sessionId)
		this.kernels.set(sessionId, manager)
		return manager
	}

	/** Claim and clear the restore notice for a session (if any), to be
	 *  surfaced as a prefix on the next `ipython` tool result. */
	consumeRestoreNotice(sessionId: string): RestoreResult | undefined {
		const notice = this.pendingRestore.get(sessionId)
		this.pendingRestore.delete(sessionId)
		return notice
	}

	disposeSession(sessionId: string): void {
		const manager = this.kernels.get(sessionId)
		if (!manager) return
		this.kernels.delete(sessionId)
		this.pendingRestore.delete(sessionId)
		void manager.dispose()
	}

	disposeAll(): void {
		for (const sessionId of [...this.kernels.keys()]) {
			this.disposeSession(sessionId)
		}
	}

	private async provision(sessionId: string): Promise<KernelManager> {
		const artifactDir = path.join(this.artifactRoot, sessionId)
		await mkdir(artifactDir, { recursive: true })

		const manager = new KernelManager({
			// exactOptionalPropertyTypes: spread undefined fields away.
			...(this.options.python !== undefined ? { python: this.options.python } : {}),
			cwd: process.cwd(),
			env: {
				RLM_SESSION_DIR: artifactDir,
				RLM_HARNESS_STATE_DIR: path.join(artifactDir, 'harness'),
			},
			sessionId,
			hostHandlers: this.options.hostHandlers,
			...(this.options.pythonSkills !== undefined ? { pythonSkills: this.options.pythonSkills } : {}),
			snapshot: {
				path: snapshotPathIn(artifactDir),
				manifestPath: manifestPathIn(artifactDir),
			},
			username: 'dsh-agent',
		})

		await manager.start()

		// restore must run before the RLM bootstrap so the freshly injected
		// `rlm`/skill handles override any revived stale objects.
		const restore = await manager.restoreState()
		if (restore) this.pendingRestore.set(sessionId, restore)

		const bootstrap = await manager.execute(buildRlmBootstrapCode(this.options.pythonSkills))
		if (bootstrap.status !== 'ok') {
			await manager.dispose()
			throw new Error(
				`Failed to initialize rlm runtime: ${bootstrap.error?.traceback?.join('\n') ?? bootstrap.stderr}`,
			)
		}

		return manager
	}
}
