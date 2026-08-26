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
import { buildRlmBootstrapCode, buildSkillImportProbe, parseSkillImportErrors } from './rlm-bootstrap.ts'

/** item-4: default idle timeout before a kernel is reclaimed (10 minutes). */
export const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60_000
/** item-4: how often the plugin's idle sweep runs. */
export const IDLE_SWEEP_INTERVAL_MS = 60_000
/** T3.2 Phase A: default cap on concurrently live (HOT) kernels; `0` disables. */
export const DEFAULT_MAX_LIVE_KERNELS = 4
/** T3.2 Phase A: grace before retrying a leased kernel whose snapshot failed at reclaim. */
export const DEFAULT_RECLAIM_SNAPSHOT_GRACE_MS = 5_000
/**
 * T2.6: hard backstop for the model-facing output cap. The ipython tool
 * requests this larger window from the vendored kernel so the plugin layer
 * can persist the full result to disk and hand the model a truncated view
 * plus a pointer; beyond it even the archived copy is capped.
 */
export const DEFAULT_FULL_OUTPUT_CAP = 10 * 1024 * 1024

export interface SessionKernelOptions {
  /** Python interpreter with ipykernel + prime-agent-runtime. Omitted → auto-bootstrapped venv. */
  python?: string
  /** Root directory for kernel artifacts (snapshots + harness state). */
  dataDir: string
  hostHandlers: HostRequestHandlers
  pythonSkills?: readonly KernelPythonSkill[]
  /**
   * T2.1: lazy per-provision skill collection. Called on every kernel
   * provision so a changed harness skill set (or an edited pyproject) flows
   * into the vendored `.bootstrap-version` comparison and triggers the
   * incremental venv reinstall on the next provision. Takes precedence over
   * the static `pythonSkills` list when present.
   */
  pythonSkillsProvider?: () => Promise<readonly KernelPythonSkill[]>
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
  /**
   * T3.2 (C semantics): cap on concurrently live (HOT) kernels; `0` disables.
   * When exceeded, the oldest non-busy kernels are disposed LRU-first:
   * unleased ones outright, leased ones only after a forced snapshot succeeds
   * (failure defers to the next sweep after {@link reclaimSnapshotGraceMs}).
   * Defaults to 4.
   */
  maxLiveKernels?: number
  /**
   * T3.2 Phase A: grace (ms) before retrying a leased kernel whose snapshot
   * failed at reclaim, so a temporary dill failure never silently loses a
   * lease-held namespace. Defaults to 5000.
   */
  reclaimSnapshotGraceMs?: number
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

  /**
   * T3.2 Phase A: candidates (excluding `exclude`) ordered least-recently-used
   * first, for LRU eviction. Unknown ids (never touched) are dropped.
   */
  oldest(candidates: readonly string[], exclude: ReadonlySet<string>): string[] {
    return candidates
      .filter(id => !exclude.has(id) && this.lastUsed.has(id))
      .sort((a, b) => (this.lastUsed.get(a) ?? 0) - (this.lastUsed.get(b) ?? 0))
  }
}

/**
 * Registry of live kernels, keyed by session id. Disposal is driven by the
 * plugin via `disposeSession` on `session/disposed`, and (item-4) by an idle
 * sweep that disposes kernels unused for `idleTimeoutMs` — their dill snapshot
 * is flushed on dispose, so a later ipython call re-provisions from it.
 */
export class SessionKernelRegistry {
  private readonly kernels = new Map<string, KernelManager>()
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
  /**
   * T3.2 Phase A: leases per session (reason → count). A leased kernel is
   * exempt from idle reclamation and LRU eviction; cleared on disposal.
   */
  private readonly leases = new Map<string, Map<string, number>>()
  /**
   * T3.2 Phase A: sessions whose leased reclaim was skipped because the
   * snapshot failed; reclaim is retried only after this timestamp.
   */
  private readonly reclaimRetryAt = new Map<string, number>()
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
   * T2.6: this session's artifacts directory (snapshots, harness state, and
   * the tool-results archive written by the ipython tool).
   */
  sessionArtifactDir(sessionId: string): string {
    return path.join(this.artifactRoot, sessionId)
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
	 *
	 * P1-fix: the retry result carries `retried: true` so the model knows the
	 * cell may have executed twice (non-idempotent side effects may repeat).
	 *
	 * Defensive handling: if the session was disposed concurrently while we
	 * were re-provisioning, the in-flight promise chain disposes the freshly
	 * created kernel (see forSession's claim check). In that narrow window
	 * we surface a clear error rather than a confusing "kernel has been shut
	 * down" from deep inside Jupyter protocol.
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
      // The kernel couldn't be interrupted (blocking C call on Windows, or
      // slow startup past the interrupt grace window). Recreate from the
      // dill snapshot — the snapshot flush happened inside disposeSession.
      this.disposeSession(sessionId)
      try {
        kernel = await this.forSession(sessionId)
        // P1-fix: tag the retry result so callers detect double-execution.
        const result = await kernel.execute(code, opts)
        return { ...result, retried: true }
      } catch (retryError) {
        // A second KernelBusyAfterInterruptError here is pathological —
        // it means the fresh kernel is itself stuck on a prior execution,
        // which should be impossible after a clean provision. Surface a
        // specific error rather than looping forever.
        if (retryError instanceof KernelBusyAfterInterruptError) {
          throw new Error(
            `Kernel for session ${sessionId} is perpetually busy after two interrupt-recovery attempts; ` +
						'the cell may be stuck in an uninterruptible C call. Consider cancelling the task.',
          )
        }
        throw retryError
      }
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
   * T3.2 Phase A: hold one lease on a session's kernel so it survives idle
   * reclamation and LRU eviction until the matching {@link unpin}. Counted
   * per reason; cleared automatically on `session/disposed`.
   */
  pin(sessionId: string, reason: string): void {
    const reasons = this.leases.get(sessionId) ?? new Map<string, number>()
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1)
    this.leases.set(sessionId, reasons)
  }

  /** T3.2 Phase A: release one lease held by {@link pin}. */
  unpin(sessionId: string, reason: string): void {
    const reasons = this.leases.get(sessionId)
    if (!reasons) return
    const next = (reasons.get(reason) ?? 0) - 1
    if (next <= 0) reasons.delete(reason)
    else reasons.set(reason, next)
    if (reasons.size === 0) this.leases.delete(sessionId)
  }

  /** T3.2 Phase A: sessions holding at least one lease. */
  private pinnedSessions(): Set<string> {
    return new Set(this.leases.keys())
  }

  /**
   * item-4 + T3.2 (C semantics): dispose kernels idle past the timeout. Leased
   * and busy kernels are excluded from the idle sweep entirely — a lease means
   * "keep this kernel HOT". The live-kernel cap is enforced afterwards:
   * unleased kernels are evicted LRU-first, and only if still over cap do
   * leased kernels become eligible, each gated on a successful forced snapshot
   * (failure skips the cycle and retries after the grace window). Returns the
   * disposed session ids.
   */
  async disposeIdle(now?: number): Promise<string[]> {
    const nowMs = now ?? this.options.now?.() ?? Date.now()
    const disposed: string[] = []
    const pinned = this.pinnedSessions()
    const exclude = new Set([...this.busy, ...pinned])
    for (const sessionId of this.idle.expired([...this.kernels.keys()], exclude, nowMs)) {
      this.disposeSession(sessionId)
      disposed.push(sessionId)
    }
    await this.enforceLiveCap(disposed, nowMs)
    return disposed
  }

  /**
   * T3.2 (C semantics): whether a LEASED kernel may be evicted this cycle.
   * Forces a snapshot first; on failure schedules a retry after the grace
   * window and returns false (the kernel stays HOT), so memory pressure never
   * silently loses a lease-held namespace.
   */
  private async canSafelyEvictLeased(sessionId: string, nowMs: number): Promise<boolean> {
    const retryAt = this.reclaimRetryAt.get(sessionId)
    if (retryAt !== undefined && retryAt > nowMs) return false
    const manager = this.kernels.get(sessionId)
    if (!manager) return true
    const snapshot = await manager.snapshotState()
    if (snapshot === null) {
      this.reclaimRetryAt.set(sessionId, nowMs + (this.options.reclaimSnapshotGraceMs ?? DEFAULT_RECLAIM_SNAPSHOT_GRACE_MS))
      return false
    }
    this.reclaimRetryAt.delete(sessionId)
    return true
  }

  /**
   * T3.2 (C semantics): when the live-kernel count exceeds `maxLiveKernels`,
   * dispose the oldest kernels without a busy flag (LRU): unleased first; then
   * leased ones, each only after its forced snapshot succeeds.
   */
  private async enforceLiveCap(disposed: string[], nowMs: number): Promise<void> {
    const cap = this.options.maxLiveKernels
    if (cap === undefined || cap <= 0) return
    let excess = this.kernels.size - cap
    if (excess <= 0) return
    // Busy kernels are hard-exempt. Leased kernels are soft-exempt: they are
    // only considered after every unleased candidate is exhausted, and even
    // then only through the forced-snapshot gate (C semantics).
    const pinnedNow = this.pinnedSessions()
    const candidates = this.idle.oldest([...this.kernels.keys()], new Set(this.busy))
    const ordered = [
      ...candidates.filter(id => !pinnedNow.has(id)),
      ...candidates.filter(id => pinnedNow.has(id)),
    ]
    for (const sessionId of ordered) {
      if (excess <= 0) break
      if (pinnedNow.has(sessionId) && !(await this.canSafelyEvictLeased(sessionId, nowMs))) continue
      this.disposeSession(sessionId)
      disposed.push(sessionId)
      excess -= 1
    }
  }

  disposeSession(sessionId: string): void {
    this.idle.remove(sessionId)
    this.busy.delete(sessionId)
    // T3.2 Phase A: disposal is the terminal event — leases and reclaim
    // retries no longer mean anything for a gone session.
    this.leases.delete(sessionId)
    this.reclaimRetryAt.delete(sessionId)
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

    // T2.1: resolve the skill set at provision time so harness-driven skill
    // changes are picked up without a restart.
    const pythonSkills = this.options.pythonSkillsProvider
      ? await this.options.pythonSkillsProvider()
      : this.options.pythonSkills

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
      ...(pythonSkills !== undefined ? { pythonSkills } : {}),
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

    const bootstrap = await manager.execute(buildRlmBootstrapCode(pythonSkills))
    if (bootstrap.status !== 'ok') {
      await manager.dispose()
      throw new Error(
        `Failed to initialize rlm runtime: ${bootstrap.error?.traceback?.join('\n') ?? bootstrap.stderr}`,
      )
    }

    // T2.2: the prompt layer now promises every requested skill as callable.
    // Verify that promise against ground truth from inside the kernel — a
    // skill that cannot import fails provisioning here, naming each offender,
    // instead of surfacing as a runtime stub error on first use. A probe that
    // itself misbehaves is warned, not fatal: it is our own code, not a skill
    // mismatch.
    if (pythonSkills !== undefined && pythonSkills.length > 0) {
      const probe = await manager.execute(buildSkillImportProbe())
      const errors = probe.status === 'ok' ? parseSkillImportErrors(probe.stdout) : null
      if (errors === null) {
        console.warn('[rlm-kernel] skill import probe returned no parsable output; skipping verification')
      } else if (Object.keys(errors).length > 0) {
        const detail = Object.entries(errors)
          .map(([name, message]) => `  - ${name}: ${message.split('\n')[0]}`)
          .join('\n')
        await manager.dispose()
        throw new Error(`Python skills failed to import in the kernel venv:\n${detail}`)
      }
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
