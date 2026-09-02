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

import { copyFile, mkdir, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { Session } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { KernelBusyAfterInterruptError, KernelManager, type HostRequestHandlers } from './vendor/kernel/index.ts'
import type { ExecuteResult } from './vendor/kernel/index.ts'
import type { KernelPythonSkill } from './vendor/kernel/bootstrap.ts'
import type { RestoreResult, SnapshotResult } from './vendor/kernel/state-snapshot.ts'
import { snapshotPathIn, manifestPathIn } from './vendor/kernel/state-snapshot.ts'
import { emitKernelSnapshotEvent } from './events.ts'
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
/** T4.1: default number of prior dill snapshots retained as `kernel-state.<n>.dill`. */
export const DEFAULT_SNAPSHOT_HISTORY = 3
/** T4.1/T4.2: fallback debounce (ms) for a post-cell flush when built without `snapshotDebounceMs`. */
export const DEFAULT_SNAPSHOT_DEBOUNCE_MS = 1500

/**
 * Resolved options for a session's kernel registry, supplied by the plugin
 * from `ctx.sessions` at provision time.
 */
export interface SessionKernelOptions {
  /** Python interpreter with ipykernel + prime-agent-runtime. Omitted → auto-bootstrapped venv. */
  python?: string
  /** Root directory for kernel artifacts (snapshots + harness state). */
  dataDir: string
  hostHandlers: HostRequestHandlers
  /**
   * T4.1/T4.2: resolves the durable Session for a session id so a snapshot
   * flush can append its log-only `session/kernel-snapshot` event. Injected by
   * the plugin from `ctx.sessions`; absent in headless/unit contexts, where
   * events are best-effort and skip silently.
   */
  resolveSession?: (sessionId: string) => Session | undefined
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
   * T4.1: how many prior dill snapshots to retain as `kernel-state.<n>.dill`
   * beside the live `kernel-state.dill`. `0` disables rotation (only the live
   * snapshot persists). Defaults to 3; each copy is at most one payload size,
   * so the on-disk budget is bounded by `keep × maxBytes`.
   */
  snapshotHistory?: number
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
  /**
   * @param timeoutMs - Idle threshold in milliseconds; ids unused longer than this are expired.
   * @param now - Injectable clock returning the current time in ms; defaults to `Date.now`.
   */
  constructor(
    private readonly timeoutMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private readonly lastUsed = new Map<string, number>()

  /** Record that a kernel id was just used, resetting its idle countdown.
   * @param id - Kernel id to mark as just used. */
  touch(id: string): void {
    this.lastUsed.set(id, this.now())
  }

  /** Drop a kernel id from idle tracking (e.g. on disposal).
   * @param id - Kernel id to remove from idle tracking. */
  remove(id: string): void {
    this.lastUsed.delete(id)
  }

  /**
   * Ids among `candidates` whose last use is older than the timeout and that
   * are not in `busy`.
   * @param candidates - Ids to consider for expiry.
   * @param busy - Ids currently executing a cell, excluded from expiry.
   * @param now - Current time in ms; defaults to the injected clock.
   * @returns The candidate ids that have been idle longer than the timeout.
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
   * @param candidates - Ids to consider for LRU ordering.
   * @param exclude - Ids to drop (e.g. busy) before ordering.
   * @returns The candidate ids ordered least-recently-used first; unknown ids dropped.
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
  /** T4.1/T4.2: pending debounced post-cell snapshot flush timers, keyed by session id. */
  private readonly flushTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly idle: IdleTracker
  private readonly artifactRoot: string

  /**
   * @param options - Resolved kernel registry options for this session.
   */
  constructor(private readonly options: SessionKernelOptions) {
    this.artifactRoot = path.join(options.dataDir, 'session-artifacts')
    this.idle = new IdleTracker(options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS, options.now ?? (() => Date.now()))
  }

  /**
   * Return the live kernel for a session, provisioning one on first use and
   * sharing it across concurrent callers.
   * @param sessionId - Session whose kernel is requested.
   * @returns The session's `KernelManager`, provisioned if not already live.
   */
  async forSession(sessionId: string): Promise<KernelManager> {
    this.idle.touch(sessionId)
    const existing = this.kernels.get(sessionId)
    if (existing) return existing
    const pending = this.inflight.get(sessionId)
    if (pending) return pending
    const provisioning = this.provision(sessionId)
      .then((manager) => {
        // The registry entry is only claimed if no `disposeSession`
        // removed the in-flight promise while we were provisioning.
        // Ownership note: `disposeSession` is the ONLY remover of in-flight
        // entries, and it always disposes the promise it removed
        // (`pending.then(m => m.dispose())`), so a lost claim means that
        // dispose already owns this manager's teardown — this path must NOT
        // dispose it too (double dispose; KernelManager.dispose is not
        // idempotent).
        if (this.inflight.get(sessionId) === provisioning) {
          this.kernels.set(sessionId, manager)
          // Phase 10 (T9.1): the live-cap is admission control, so it fires
          // on the provision path — decoupled from the idle sweep, which only
          // exists when `idleTimeoutMs > 0`. With `idleTimeoutMs: 0` (the
          // documented "disable reclamation" setting) this is now the sole
          // cap trigger; LRU order protects the just-claimed kernel because
          // `touch` above made it the most recently used.
          void this.enforceLiveCap([], this.options.now?.() ?? Date.now())
            .catch((error) => {
              console.warn('[rlm-kernel] post-provision live-cap enforcement failed:', error)
            })
        }
        return manager
      })
      .finally(() => {
        if (this.inflight.get(sessionId) === provisioning) this.inflight.delete(sessionId)
      })
    this.inflight.set(sessionId, provisioning)
    return provisioning
  }

  /**
   * Claim one pending restore notice so its revival/lost lists can be
   * surfaced as a prefix on the next `ipython` tool result.
   * @param sessionId - Session whose restore notice is claimed.
   * @returns The restore notice, or `undefined` if none was pending.
   */
  consumeRestoreNotice(sessionId: string): RestoreResult | undefined {
    const notice = this.pendingRestore.get(sessionId)
    this.pendingRestore.delete(sessionId)
    return notice
  }

  /**
   * P2-A: inject a model-visible `notice` describing the kernel namespace
   * revival/loss right after restore, mirroring prime's `<ipython_state_restored>`
   * message. The model sees the state transition before it issues the next cell,
   * independent of `consumeRestoreNotice` (which still prefixes the next tool
   * result). Best-effort: a missing session resolver or append failure is silent.
   * @param sessionId - session whose kernel was just restored.
   * @param restore - the revival/loss result from `restoreState()`.
   */
  private appendRestoreNotice(sessionId: string, restore: RestoreResult): void {
    if (restore.restored.length === 0 && restore.failed.length === 0) return
    const parts: string[] = []
    if (restore.restored.length > 0) {
      parts.push(`<ipython_state_restored> revived: ${restore.restored.join(', ')} </ipython_state_restored>`)
    }
    if (restore.failed.length > 0) {
      const lost = restore.failed.map(f => f.name)
      parts.push(`<ipython_state_restored> lost (not restored): ${lost.join(', ')} </ipython_state_restored>`)
    }
    const session = this.options.resolveSession?.(sessionId)
    if (!session) return
    try {
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: parts.join('\n') }],
        source: {
          kind: 'plugin',
          plugin: 'dsh-rlm-kernel',
          form: 'notice',
          summary: 'kernel namespace restored from snapshot',
        },
      }), { surfaceOp: 'append' })
    } catch {
      // A notice is best-effort observability; persistence failures stay silent.
    }
  }

  /**
   * T5: after a compaction, tell the model the persistent kernel namespace is
   * intact by injecting prime's `<ipython_state>` message listing the surviving
   * top-level variable names. Compaction only folds the dialogue; the kernel
   * keeps running and every variable/import/helper defined before the checkpoint
   * is still live — mirroring prime's `_syncKernelStateAfterCompaction`.
   * Best-effort: a missing session resolver, empty namespace, or append failure
   * is silent.
   * @param sessionId - Session whose compaction just completed.
   */
  private async appendPostCompactionNotice(sessionId: string): Promise<void> {
    const names = await this.listVariables(sessionId).catch(() => undefined)
    if (!names || names.length === 0) return
    const content = `<ipython_state> still alive after compaction (kernel keeps running): ${names.join(', ')} </ipython_state>`
    const session = this.options.resolveSession?.(sessionId)
    if (!session) return
    try {
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: content }],
        source: {
          kind: 'plugin',
          plugin: 'dsh-rlm-kernel',
          form: 'notice',
          summary: 'kernel namespace intact after compaction',
        },
      }), { surfaceOp: 'append' })
    } catch {
      // A notice is best-effort observability; persistence failures stay silent.
    }
  }

  /**
   * T5: entry point for the plugin's `session/event` subscription. Called when a
   * `compaction/end` event is observed for `sessionId`; injects the post-
   * compaction `<ipython_state>` notice if a live kernel exists for the session.
   * No-op when no kernel is provisioned (e.g. compaction fired before any ipython
   * call). The notice itself is best-effort and internally null-guarded.
   * @param sessionId - Session whose compaction just completed.
   */
  async notifyCompactionEnd(sessionId: string): Promise<void> {
    if (!this.kernels.has(sessionId)) return
    await this.appendPostCompactionNotice(sessionId)
  }

  /**
   * item-7: whether a live (provisioned) kernel exists for the session.
   * @param sessionId - Session to check.
   * @returns Whether a live (provisioned) kernel exists for the session.
   */
  hasSession(sessionId: string): boolean {
    return this.kernels.has(sessionId)
  }

  /**
   * T2.6: this session's artifacts directory (snapshots, harness state, and
   * the tool-results archive written by the ipython tool).
   * @param sessionId - Session whose artifact directory is requested.
   * @returns The absolute path to the session's artifact directory.
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
   * @param sessionId - Session whose kernel runs the cell.
   * @param code - Python source to execute.
   * @param opts - Execution options: an abort signal and an output character cap.
   * @returns The cell's execution result, tagged `retried: true` when the kernel was recreated after an interrupt.
   */
  async execute(
    sessionId: string,
    code: string,
    opts: { signal?: AbortSignal; maxOutputChars?: number },
  ): Promise<ExecuteResult> {
    this.cancelScheduledFlush(sessionId)
    let kernel = await this.forSession(sessionId)
    try {
      const result = await kernel.execute(code, opts)
      this.scheduleSnapshot(sessionId)
      return result
    } catch (error) {
      if (!(error instanceof KernelBusyAfterInterruptError)) {
        // A failed cell still mutates the namespace (partial side effects), and
        // the vendored auto-snapshot persists it to disk regardless — schedule
        // the flush so the rotation and the log-only event cover that state
        // instead of leaving a silent accounting hole.
        this.scheduleSnapshot(sessionId)
        throw error
      }
      // The kernel couldn't be interrupted (blocking C call on Windows, or
      // slow startup past the interrupt grace window). Recreate from the
      // dill snapshot — disposeSession awaits the old kernel's final flush
      // before forSession provisions the replacement (T7.6).
      // Phase 8 (review round 6): disposeSession treats disposal as terminal
      // and clears the session's leases, but this session is NOT terminating —
      // re-arm any pins after the swap so a verifier's keep-HOT lease survives
      // instead of silently lapsing (the fresh kernel would then be reclaim/LRU
      // eligible while the holder still believes it is pinned).
      const heldLeases = this.leases.get(sessionId)
      await this.disposeSession(sessionId)
      try {
        kernel = await this.forSession(sessionId)
        if (heldLeases) {
          for (const [reason, count] of heldLeases) {
            for (let i = 0; i < count; i++) this.pin(sessionId, reason)
          }
        }
        // P1-fix: tag the retry result so callers detect double-execution.
        const result = await kernel.execute(code, opts)
        this.scheduleSnapshot(sessionId)
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
        this.scheduleSnapshot(sessionId)
        throw retryError
      }
    }
  }

  /**
   * List the live kernel's user-defined top-level variable names for a session,
   * or `undefined` when no kernel is live. Wraps the vendored
   * `KernelManager.listNamespaceNames`; used to report surviving state after a
   * compaction (prime's post-compaction `<ipython_state>` message).
   * @param sessionId - Session whose namespace names are requested.
   * @param signal - Abort signal forwarded to the introspection cell.
   * @returns The sorted top-level names, or `undefined` if the kernel is absent.
   */
  async listVariables(sessionId: string, signal?: AbortSignal): Promise<string[] | undefined> {
    const kernel = this.kernels.get(sessionId)
    if (!kernel) return undefined
    return (await kernel.listNamespaceNames(signal)) ?? undefined
  }

  /** Mark a session's kernel as actively executing (item-4).
   * @param sessionId - Session whose kernel is marked busy. */
  markBusy(sessionId: string): void {
    this.busy.add(sessionId)
    this.idle.touch(sessionId)
  }

  /** Mark a session's kernel execution finished (item-4).
   * @param sessionId - Session whose kernel is marked idle. */
  markIdle(sessionId: string): void {
    this.busy.delete(sessionId)
    this.idle.touch(sessionId)
  }

  /**
   * T3.2 Phase A: hold one lease on a session's kernel so it survives idle
   * reclamation and LRU eviction until the matching {@link unpin}. Counted
   * per reason; cleared automatically on `session/disposed`.
   * @param sessionId - Session whose kernel is leased.
   * @param reason - Lease reason; leases are reference-counted per reason.
   */
  pin(sessionId: string, reason: string): void {
    const reasons = this.leases.get(sessionId) ?? new Map<string, number>()
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1)
    this.leases.set(sessionId, reasons)
  }

  /**
   * T3.2 Phase A: release one lease held by {@link pin}.
   * @param sessionId - Session whose lease is released.
   * @param reason - Lease reason whose reference count is decremented.
   */
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
   * @param now - Current time in ms; defaults to the injected clock or `Date.now`.
   * @returns The session ids whose kernels were disposed by the sweep.
   */
  async disposeIdle(now?: number): Promise<string[]> {
    const nowMs = now ?? this.options.now?.() ?? Date.now()
    const disposed: string[] = []
    const pinned = this.pinnedSessions()
    const exclude = new Set([...this.busy, ...pinned])
    for (const sessionId of this.idle.expired([...this.kernels.keys()], exclude, nowMs)) {
      disposed.push(sessionId)
    }
    // T7.6: wait for every manager's final dill flush before the sweep returns,
    // so a follow-up forSession on the same session never races the flush.
    await Promise.all(disposed.map(id => this.disposeSession(id)))
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
    const ok = await this.flushSnapshot(sessionId, 'reclaim')
    if (!ok) {
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
    // Phase 8 (review round 6): DEFAULT_MAX_LIVE_KERNELS was defined but never
    // wired, so an unconfigured deployment had no cap despite INSTALL/LIFETIME
    // documenting "defaults to 4". An explicit `0` keeps its documented
    // "unlimited" meaning.
    const cap = this.options.maxLiveKernels ?? DEFAULT_MAX_LIVE_KERNELS
    if (cap <= 0) return
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
    const toDispose: string[] = []
    for (const sessionId of ordered) {
      if (excess <= 0) break
      if (pinnedNow.has(sessionId) && !(await this.canSafelyEvictLeased(sessionId, nowMs))) continue
      toDispose.push(sessionId)
      disposed.push(sessionId)
      excess -= 1
    }
    // T7.6: same ordering contract as disposeIdle — eviction waits for the
    // manager's final dill flush before the cap call returns.
    await Promise.all(toDispose.map(id => this.disposeSession(id)))
  }

  /**
   * Tear down a session's kernel, clearing idle/busy/lease state and any
   * in-flight provision. Resolves after the manager's final dill flush settles,
   * so a subsequent `forSession` on the same session (interrupt recovery, idle
   * re-provision) never races the old kernel's snapshot write — the old
   * `void manager.dispose()` let the flush and the next provision write the
   * same dill concurrently (T7.6).
   * @param sessionId - Session whose kernel is torn down.
   */
  async disposeSession(sessionId: string): Promise<void> {
    this.cancelScheduledFlush(sessionId)
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
      await manager.dispose().catch(error => console.warn('[rlm-kernel] kernel dispose failed:', error))
    }
    // A kernel still mid-provision must not be left to register after the
    // session is gone: drop the in-flight promise (so forSession's claim
    // check misses) and dispose the result once it materializes.
    const pending = this.inflight.get(sessionId)
    this.inflight.delete(sessionId)
    if (pending) await pending.then(m => m.dispose()).catch(error => console.warn('[rlm-kernel] dispose of in-flight kernel failed:', error))
  }

  /**
   * A starting cell cancels any armed post-cell flush so a busy namespace is
   * never serialized mid-execution; the success path re-arms the debounce.
   */
  private cancelScheduledFlush(sessionId: string): void {
    const pending = this.flushTimers.get(sessionId)
    if (!pending) return
    clearTimeout(pending)
    this.flushTimers.delete(sessionId)
  }

  /**
   * T4.1/T4.2: debounce a post-cell snapshot flush so a burst of cells snapshots
   * once after the kernel goes quiet, instead of once per cell. The flush both
   * rotates the on-disk history and appends the log-only `session/kernel-snapshot`
   * event.
   */
  private scheduleSnapshot(sessionId: string): void {
    const pending = this.flushTimers.get(sessionId)
    if (pending) clearTimeout(pending)
    const debounceMs = this.options.snapshotDebounceMs ?? DEFAULT_SNAPSHOT_DEBOUNCE_MS
    const timer = setTimeout(() => {
      this.flushTimers.delete(sessionId)
      void this.flushSnapshot(sessionId, 'cell')
    }, debounceMs)
    if (timer && typeof timer === 'object' && 'unref' in timer) timer.unref()
    this.flushTimers.set(sessionId, timer)
  }

  /**
   * T4.1/T4.2: take one explicit dill snapshot, rotate the retained history, and
   * append the log-only `session/kernel-snapshot` event. Returns whether the
   * snapshot serialized a payload — a `false` result keeps the prior history
   * intact (a failed flush has nothing new to retain). A missing kernel (already
   * disposed) or a snapshot error never throws; the event still records the
   * failure so the durable log explains a lost namespace.
   * @param sessionId - Session whose kernel is snapshotted.
   * @param reason - Why the snapshot is taken: a post-cell flush or a reclaim eviction.
   * @returns Whether the snapshot serialized a payload (`false` keeps prior history intact).
   */
  async flushSnapshot(sessionId: string, reason: 'cell' | 'reclaim'): Promise<boolean> {
    const manager = this.kernels.get(sessionId)
    if (!manager) return false
    const artifactDir = this.sessionArtifactDir(sessionId)
    const started = this.options.now?.() ?? Date.now()
    let result: SnapshotResult | null = null
    let snapshotError: unknown = null
    try {
      result = await manager.snapshotState()
    } catch (e) {
      result = null
      snapshotError = e
    }
    // A concurrent disposeSession during the snapshot makes the result — and
    // any error inside it — describe a torn-down kernel, not the session's
    // state: suppress the event rather than log a misleading failure.
    if (!this.kernels.has(sessionId)) return false
    const ms = (this.options.now?.() ?? Date.now()) - started
    emitKernelSnapshotEvent(this.options.resolveSession?.(sessionId), {
      ok: result !== null,
      ...(result ? { vars: result.saved.length } : {}),
      ...(result ? { bytes: result.bytes } : {}),
      ...(result ? { skipped: result.skipped.map(s => s.name) } : {}),
      ...(result?.pruned && result.pruned.length > 0 ? { pruned: result.pruned } : {}),
      ms,
      ...(result === null
        ? { error: snapshotError instanceof Error ? snapshotError.message : String(snapshotError) }
        : {}),
      reason,
    })
    if (result !== null) await this.rotateSnapshot(artifactDir)
    return result !== null
  }

  /**
   * T4.1: retain the last `snapshotHistory` dill snapshots as
   * `kernel-state.<n>.dill` (n = 1 is the newest). Each successful flush shifts
   * older copies outward and drops the oldest beyond the cap, so at most
   * `snapshotHistory` prior payloads survive beside the live `kernel-state.dill`.
   * `0` is a no-op; a copy failure never fails a cell (the live snapshot is the
   * source of truth).
   */
  private async rotateSnapshot(artifactDir: string): Promise<void> {
    const keep = this.options.snapshotHistory ?? DEFAULT_SNAPSHOT_HISTORY
    if (keep <= 0) return
    const live = snapshotPathIn(artifactDir)
    if (!existsSync(live)) return
    const historyPath = (n: number) => path.join(artifactDir, `kernel-state.${n}.dill`)
    try {
      for (let n = keep - 1; n >= 1; n--) {
        if (existsSync(historyPath(n))) await copyFile(historyPath(n), historyPath(n + 1))
      }
      await copyFile(live, historyPath(1))
      // Shifting leaves nothing beyond slot `keep`, but a previously larger
      // snapshotHistory (or external writes) can have left stale numbered files:
      // prune them with a bounded ascending scan that stops at the first gap.
      for (let n = keep + 1; existsSync(historyPath(n)); n++) {
        await unlink(historyPath(n))
      }
    } catch {
      // History is best-effort; a copy failure never fails a cell.
    }
  }

  /** Dispose every live and in-flight kernel, leaving the registry empty. */
  async disposeAll(): Promise<void> {
    // Phase 8 (review round 6): in-flight provisions were skipped — a warmup
    // racing teardown leaked its still-spawning kernel process.
    const sessionIds = new Set<string>([...this.kernels.keys(), ...this.inflight.keys()])
    await Promise.all([...sessionIds].map(sessionId => this.disposeSession(sessionId)))
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

    // Phase 8 (review round 6): any failure past a successful start must
    // dispose the spawned kernel process before propagating — a restore or
    // bootstrap throw used to leak a live kernel no registry entry pointed at.
    try {
      // restore must run before the RLM bootstrap so the freshly injected
      // `rlm`/skill handles override any revived stale objects.
      const restore = await manager.restoreState()
      if (restore) {
        this.pendingRestore.set(sessionId, restore)
        // P2-A: surface the revival/loss immediately as a model-visible notice
        // (prime's <ipython_state_restored>), so the model knows the kernel
        // namespace was restored before it issues the next cell — not only when
        // the next ipython tool result is prefixed (consumeRestoreNotice).
        this.appendRestoreNotice(sessionId, restore)
      }

      const bootstrap = await manager.execute(buildRlmBootstrapCode(pythonSkills))
      if (bootstrap.status !== 'ok') {
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
          throw new Error(`Python skills failed to import in the kernel venv:\n${detail}`)
        }
      }
    } catch (error) {
      await manager.dispose().catch((disposeError) => {
        console.warn('[rlm-kernel] kernel dispose after failed provision failed:', disposeError)
      })
      throw error
    }

    return manager
  }
}

/**
 * item-7: kick off kernel provision for a session in the background, so the
 * ~5s cold start happens at session creation instead of the first ipython
 * call. Failures are swallowed — the next `forSession` (from an actual ipython
 * call) retries provisioning from scratch.
 * @param kernels - The session kernel registry that owns the provision.
 * @param sessionId - Session whose kernel is warmed up in the background.
 */
export function warmUpSession(kernels: SessionKernelRegistry, sessionId: string): void {
  void kernels.forSession(sessionId).catch(() => undefined)
}
