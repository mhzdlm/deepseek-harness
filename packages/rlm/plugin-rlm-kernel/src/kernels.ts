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
import { KernelBusyAfterInterruptError, KernelManager, type HostRequestHandlers } from './vendor/kernel/index.ts'
import type { ExecuteResult } from './vendor/kernel/index.ts'
import type { KernelPythonSkill } from './vendor/kernel/bootstrap.ts'
import type { RestoreResult } from './vendor/kernel/state-snapshot.ts'
import { snapshotPathIn, manifestPathIn } from './vendor/kernel/state-snapshot.ts'
import { buildRlmBootstrapCode } from './rlm-bootstrap.ts'

/** item-4: default idle timeout before a kernel is reclaimed (10 minutes). */
export const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60_000
/** item-4: how often the plugin's idle sweep runs. */
export const IDLE_SWEEP_INTERVAL_MS = 60_000

export interface SessionKernelOptions {
  /** Python interpreter with ipykernel + prime-agent-runtime. Omitted → auto-bootstrapped venv. */
  python?: string
  /** Root directory for kernel artifacts (snapshots + harness state). */
  dataDir: string
  hostHandlers: HostRequestHandlers
  pythonSkills?: readonly KernelPythonSkill[]
  /**
	 * item-4: idle timeout for kernel reclamation. A kernel unused for this
	 * long is disposed (dill snapshot flushes first, so a later ipython call
	 * re-provisions from the snapshot). `0` disables reclamation.
	 */
  idleTimeoutMs?: number
  /** Injectable clock for idle-decision tests. Defaults to `Date.now`. */
  now?: () => number
  /** item-13: auto-snapshot debounce after a successful cell (ms). Default 1500. */
  snapshotDebounceMs?: number
}

/**
 * Pure idle bookkeeping (item-4). Tracks last-use per id and decides which ids
 * have been idle longer than the timeout, excluding currently-busy ones.
 * Kept as a separate exported class so it is unit-testable without a kernel.
 */
export class IdleTracker {
  constructor(
    private readonly timeoutMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private readonly lastUsed = new Map<string, number>()

  touch(id: string): void {
    this.lastUsed.set(id, this.now())
  }

  remove(id: string): void {
    this.lastUsed.delete(id)
  }

  /**
	 * Ids among `candidates` whose last use is older than the timeout and that
	 * are not in `busy`.
	 */
  expired(candidates: readonly string[], busy: ReadonlySet<string>, now: number = this.now()): string[] {
    if (this.timeoutMs <= 0) return []
    return candidates.filter((id) => {
      if (busy.has(id)) return false
      const last = this.lastUsed.get(id)
      return last === undefined ? false : now - last > this.timeoutMs
    })
  }
}

/**
 * Registry of live kernels, keyed by session id. Disposal is driven by the
 * plugin via `disposeSession` on `session/disposed`, and (item-4) by an idle
 * sweep that disposes kernels unused for `idleTimeoutMs` — their dill snapshot
 * is flushed on dispose, so a later ipython call re-provisions from it.
 */
export class SessionKernelRegistry {	private readonly kernels = new Map<string, KernelManager>()
  private readonly pendingRestore = new Map<string, RestoreResult>()
  /**
	 * In-flight provision promises, keyed by session id. Guards against two
	 * concurrent `ipython` calls on a fresh session each provisioning their own
	 * kernel (one would be orphaned and the pair would fight over one dill
	 * snapshot). P0-fix: kernels.ts:43-49 race.
	 */
  private readonly inflight = new Map<string, Promise<KernelManager>>()
  /** Sessions whose kernel is currently executing an ipython cell (item-4). */
  private readonly busy = new Set<string>()
  private readonly idle: IdleTracker
  private readonly artifactRoot: string

  constructor(private readonly options: SessionKernelOptions) {
    this.artifactRoot = path.join(options.dataDir, 'session-artifacts')
    this.idle = new IdleTracker(options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS, options.now ?? (() => Date.now()))
  }

  async forSession(sessionId: string): Promise<KernelManager> {
    this.idle.touch(sessionId)
    const existing = this.kernels.get(sessionId)
    if (existing) return existing
    const pending = this.inflight.get(sessionId)
    if (pending) return pending
    const provisioning = this.provision(sessionId)
      .then((manager) => {
        // The registry entry is only claimed if no `disposeSession`
        // removed the in-flight promise while we were provisioning; a
        // concurrent dispose chains `manager.dispose()` instead, so no
        // orphaned kernel process and no stale registry entry.
        if (this.inflight.get(sessionId) === provisioning) {
          this.kernels.set(sessionId, manager)
        } else {
          void manager.dispose()
        }
        return manager
      })
      .finally(() => {
        if (this.inflight.get(sessionId) === provisioning) this.inflight.delete(sessionId)
      })
    this.inflight.set(sessionId, provisioning)
    return provisioning
  }

  /** Claim and clear the restore notice for a session (if any), to be
	 *  surfaced as a prefix on the next `ipython` tool result. */
  consumeRestoreNotice(sessionId: string): RestoreResult | undefined {
    const notice = this.pendingRestore.get(sessionId)
    this.pendingRestore.delete(sessionId)
    return notice
  }

  /** item-7: whether a live (provisioned) kernel exists for the session. */
  hasSession(sessionId: string): boolean {
    return this.kernels.has(sessionId)
  }

  /**
	 * item-6: execute a cell for a session, recovering from a kernel that
	 * refused to be interrupted.
	 *
	 * Aborting a cell sends a control-channel `interrupt_request`; on Windows
	 * this cannot interrupt blocking C calls like `time.sleep()`, so the cell
	 * keeps running and the NEXT execute hits `KernelBusyAfterInterruptError`.
	 * Rather than surfacing a hard "kill the kernel" error, recreate the kernel
	 * from its dill snapshot (variables survive) and run the cell once more.
	 * A retry with an already-aborted signal settles `aborted` immediately, so
	 * a cancelled cell is never accidentally re-run.
	 */
  async execute(
    sessionId: string,
    code: string,
    opts: { signal?: AbortSignal; maxOutputChars?: number },
  ): Promise<ExecuteResult> {
    let kernel = await this.forSession(sessionId)
    try {
      return await kernel.execute(code, opts)
    } catch (error) {
      if (!(error instanceof KernelBusyAfterInterruptError)) throw error
      this.disposeSession(sessionId)
      kernel = await this.forSession(sessionId)
      return await kernel.execute(code, opts)
    }
  }

  /** Mark a session's kernel as actively executing (item-4). */
  markBusy(sessionId: string): void {
    this.busy.add(sessionId)
    this.idle.touch(sessionId)
  }

  /** Mark a session's kernel execution finished (item-4). */
  markIdle(sessionId: string): void {
    this.busy.delete(sessionId)
    this.idle.touch(sessionId)
  }

  /**
	 * item-4: dispose every kernel that has been idle longer than the timeout.
	 * State is preserved by the dill snapshot flush inside `KernelManager.dispose`,
	 * so the next ipython call re-provisions and restores. Returns the disposed
	 * session ids (for tests/diagnostics).
	 */
  disposeIdle(now?: number): string[] {
    const disposed: string[] = []
    for (const sessionId of this.idle.expired([...this.kernels.keys()], this.busy, now ?? this.options.now?.())) {
      this.disposeSession(sessionId)
      disposed.push(sessionId)
    }
    return disposed
  }

  disposeSession(sessionId: string): void {
    this.idle.remove(sessionId)
    this.busy.delete(sessionId)
    const manager = this.kernels.get(sessionId)
    if (manager) {
      this.kernels.delete(sessionId)
      this.pendingRestore.delete(sessionId)
      void manager.dispose()
    }
    // A kernel still mid-provision must not be left to register after the
    // session is gone: drop the in-flight promise (so forSession's claim
    // check misses) and dispose the result once it materializes.
    const pending = this.inflight.get(sessionId)
    this.inflight.delete(sessionId)
    if (pending) void pending.then(m => m.dispose()).catch(() => undefined)
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
        // P0-fix: global-scope harness must resolve under the dsh data
        // dir instead of prime's `~/.prime/agent` fallback, otherwise
        // `global_=True` writes vanish into a store the host never reads.
        RLM_GLOBAL_HARNESS_STATE_DIR: path.join(this.options.dataDir, 'global', 'harness'),
      },
      sessionId,
      hostHandlers: this.options.hostHandlers,
      ...(this.options.pythonSkills !== undefined ? { pythonSkills: this.options.pythonSkills } : {}),
      // item-13: expose the vendored auto-snapshot debounce window.
      ...(this.options.snapshotDebounceMs !== undefined ? { debounceMs: this.options.snapshotDebounceMs } : {}),
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

/**
 * item-7: kick off kernel provision for a session in the background, so the
 * ~5s cold start happens at session creation instead of the first ipython
 * call. Failures are swallowed — the next `forSession` (from an actual ipython
 * call) retries provisioning from scratch.
 */
export function warmUpSession(kernels: SessionKernelRegistry, sessionId: string): void {
  void kernels.forSession(sessionId).catch(() => undefined)
}
