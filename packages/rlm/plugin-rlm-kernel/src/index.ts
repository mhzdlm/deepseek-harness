/**
 * Persistent IPython kernel as the model's primary tool.
 *
 * Registers the `ipython` tool (backed by a per-session `KernelManager`
 * vendored from prime-agent), wires the `host.request` bridge to dsh services
 * (`rlm.run` → `ctx.subagents.start`), and disposes kernels on
 * `session/disposed`.
 * @module @deepseek-ai/dsh-plugin-rlm-kernel
 */

import { homedir } from 'node:os'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { createHostHandlers } from './host-handlers.ts'
import { createIpythonTool } from './ipython-tool.ts'
import { createSkillCreateTool } from './skill-create.ts'
import { DEFAULT_IDLE_TIMEOUT_MS, IDLE_SWEEP_INTERVAL_MS, SessionKernelRegistry, warmUpSession } from './kernels.ts'
import { collectPythonSkills, upsertPythonSkillEntry } from './skill-source.ts'

// Phase 10 (T9.10): the shared redaction moved to the zero-dependency
// `@deepseek-ai/dsh-plugin-rlm-redact` package, so moa/verifier no longer
// import this package (and its native zeromq dependency chain) just to mask
// reference text.

/**
 * Plugin name registered with the Cordis loader; also the package identity.
 */
export const name = 'plugin-rlm-kernel'
/**
 * Cordis services this plugin requires: the tool registry, the subagent
 * capability, the session store, and the agent registry.
 */
export const inject = ['tools', 'subagents', 'sessions', 'agents']

/**
 * Configuration for the persistent IPython-kernel plugin: the Python
 * interpreter and venv, kernel lifecycle limits, idle reclamation, snapshot
 * rotation, and the `rlm.run` fan-out bounds.
 */
export interface Config {
  /** Python interpreter with ipykernel + prime-agent-runtime. Omitted → auto-bootstrapped venv. */
  python?: string
  /** Root directory for kernel artifacts. Defaults to `~/.dsh/rlm`. */
  dataDir?: string
  /** Subagent provider name used by `rlm.run`. Defaults to `spawn` (in-process). */
  subagentProvider?: string
  /**
   * item-4: idle timeout (ms) before a session's kernel is reclaimed. State is
   * preserved by the dill snapshot, so a later ipython call re-provisions from
   * it. `0` disables reclamation. Defaults to 10 minutes.
   */
  idleTimeoutMs?: number
  /** item-13: cap on cell output text returned to the model. Defaults to 65536. */
  maxOutputChars?: number
  /** item-13: auto-snapshot debounce after a successful cell (ms). Defaults to 1500. */
  snapshotDebounceMs?: number
  /**
   * T4.1: how many prior dill snapshots to retain as `kernel-state.<n>.dill`.
   * `0` disables rotation. Defaults to 3; each copy is at most one payload size.
   */
  snapshotHistory?: number
  /**
   * item-7: provision a session's kernel at session/created instead of at the
   * first ipython call, moving the ~5s cold start off the critical path.
   * Defaults to off (each session pays a kernel process until idle reclamation).
   */
  warmupOnSessionCreate?: boolean
  /**
   * T3.2 (C semantics): cap on concurrently live kernels (0 = unlimited).
   * When exceeded, the oldest non-busy kernels are disposed LRU-first:
   * unleased ones outright; leased ones only after a forced snapshot succeeds
   * (failure defers eviction to a later sweep). Defaults to 4.
   */
  maxLiveKernels?: number
  /** T3.2 (C semantics): grace (ms) before a leased over-cap kernel retries its forced eviction snapshot. Defaults to 5000. */
  reclaimSnapshotGraceMs?: number
  /**
   * Outstanding `rlm.run` children (one-shot and retained, including in-flight
   * spawns) allowed per parent session before further spawns fail loud with a
   * remedy. Bounds the fan-out a looping model can create. Defaults to 8.
   */
  maxChildrenPerSession?: number
  /**
   * Character cap on a single `rlm.run` prompt; larger prompts fail loud with
   * actionable text instead of silently inflating a child's context. Defaults to 24000.
   */
  maxRunPromptChars?: number
  /**
   * T7.10 (LAYERS.md §2.3 R2): `llm.query` route selector — the subcall model
   * used when the kernel caller does not name one. The cheap-tier default is a
   * deployment choice: omit it to run subcalls on the owning agent's own model
   * (no downgrade), or set it (e.g. a flash-tier model) to unlock the paper's
   * cheap-fanout cost rule. Managed through the same preset surface as every
   * other kernel Config key.
   */
  subcallModel?: string
  /** T7.10 (R1): in-flight `llm.query` subcall streams allowed per owning session. Defaults to 8. */
  maxInFlightSubcalls?: number
  /** T7.10 (R1): max prompts in one `llm.query` batch request. Defaults to 32. */
  maxSubcallBatch?: number
  /** T7.10: char cap per subcall answer; longer answers are truncated and flagged. Defaults to 8000. */
  maxSubcallAnswerChars?: number
  /** T7.10 (T7.3 semantics): wall-clock budget per subcall generation. Defaults to 120000. */
  subcallTimeoutMs?: number
  /**
   * Phase 8 (review round 6): char cap per `llm.query` prompt. Sits far above
   * `maxRunPromptChars` — chunk-sized subcall context is legitimate; the cap
   * only stops absurd single prompts from becoming runaway billing calls.
   * Defaults to 100000.
   */
  maxSubcallPromptChars?: number
  /**
   * Phase 10 (LAYERS.md §2.2): session-level subcall budget — cumulative
   * `llm.query` calls allowed per session before further batches fail loud.
   * The session-level 总量 guard the per-call caps cannot provide (long-tailed
   * cost). Defaults to 200.
   */
  maxSessionSubcalls?: number
  /**
   * Phase 10 (LAYERS.md §2.2): session-level subcall volume budget —
   * cumulative answer characters per session. Defaults to 1000000.
   */
  maxSessionSubcallChars?: number
  /**
   * Phase 10: code-enforced recursion ceiling — `llm.query` calls at or above
   * this `depth` fail loud, replacing the persona-only guard (the paper's
   * documented weak-model failure mode). `0` disables subcalls entirely
   * (the evaluation battery's depth=0 baseline). Defaults to 2.
   */
  maxRecursionDepth?: number
}

/**
 * Schema for {@link Config}: validates the plugin's optional tuning fields
 * (interpreter, data dir, idle/snapshot/reclaim bounds, and run fan-out caps).
 */
export const Config: z<Config> = z.object({
  python: z.string().min(1),
  // Phase 8: an empty dataDir used to pass the schema and resolve to the cwd;
  // min(1) keeps the `?? default` fallback meaningful.
  dataDir: z.string().min(1),
  subagentProvider: z.string().min(1),
  idleTimeoutMs: z.natural(),
  maxOutputChars: z.natural(),
  snapshotDebounceMs: z.natural(),
  snapshotHistory: z.natural(),
  warmupOnSessionCreate: z.boolean(),
  maxLiveKernels: z.natural(),
  reclaimSnapshotGraceMs: z.natural(),
  // Phase 8: 0 used to make the `live >= 0` cap check always fire, rejecting
  // every rlm.run — the documented minimum is 1.
  maxChildrenPerSession: z.natural().min(1),
  maxRunPromptChars: z.natural().min(1),
  subcallModel: z.string().min(1),
  maxInFlightSubcalls: z.natural().min(1),
  maxSubcallBatch: z.natural().min(1),
  maxSubcallAnswerChars: z.natural().min(1),
  subcallTimeoutMs: z.natural().min(1),
  maxSubcallPromptChars: z.natural().min(1),
  maxSessionSubcalls: z.natural().min(1),
  maxSessionSubcallChars: z.natural().min(1),
  maxRecursionDepth: z.natural(),
})

/**
 * Cordis plugin entry point: wires the per-session kernel registry, registers
 * the `ipython` and `create_python_skill` tools, schedules idle reclamation,
 * and disposes kernels on `session/disposed`.
 * @param ctx - the Cordis context this plugin mounts into.
 * @param config - the resolved {@link Config} tuning the kernel lifecycle and run bounds.
 */
export function apply(ctx: Context, config: Config): void {
  const dataDir = config.dataDir ?? path.join(homedir(), '.dsh', 'rlm')
  const hostHandlers = createHostHandlers(ctx, config.subagentProvider ?? 'spawn', dataDir, {
    ...(config.maxChildrenPerSession !== undefined ? { maxChildrenPerSession: config.maxChildrenPerSession } : {}),
    ...(config.maxRunPromptChars !== undefined ? { maxRunPromptChars: config.maxRunPromptChars } : {}),
    ...(config.maxInFlightSubcalls !== undefined ? { maxInFlightSubcalls: config.maxInFlightSubcalls } : {}),
    ...(config.maxSubcallBatch !== undefined ? { maxSubcallBatch: config.maxSubcallBatch } : {}),
    ...(config.maxSubcallAnswerChars !== undefined ? { maxSubcallAnswerChars: config.maxSubcallAnswerChars } : {}),
    ...(config.subcallTimeoutMs !== undefined ? { subcallTimeoutMs: config.subcallTimeoutMs } : {}),
    ...(config.maxSubcallPromptChars !== undefined ? { maxSubcallPromptChars: config.maxSubcallPromptChars } : {}),
    ...(config.maxSessionSubcalls !== undefined ? { maxSessionSubcalls: config.maxSessionSubcalls } : {}),
    ...(config.maxSessionSubcallChars !== undefined ? { maxSessionSubcallChars: config.maxSessionSubcallChars } : {}),
    ...(config.maxRecursionDepth !== undefined ? { maxRecursionDepth: config.maxRecursionDepth } : {}),
  }, {
    ...(config.subcallModel !== undefined ? { subcallModel: config.subcallModel } : {}),
  })
  const kernels = new SessionKernelRegistry({
    // exactOptionalPropertyTypes: spread undefined fields away.
    ...(config.python !== undefined ? { python: config.python } : {}),
    dataDir,
    hostHandlers: hostHandlers.handlers,
    // T2.1: harness skill entries drive the kernel venv's python-skill
    // installs; collected per provision so edits flow without a restart.
    pythonSkillsProvider: async () => {
      const collected = await collectPythonSkills(dataDir)
      for (const id of collected.invalid) {
        console.warn(
          `[rlm-kernel] python skill "${id}" has a non-slug id; skipped `
          + '(ids must be lowercase slugs so they can never escape <dataDir>/skills/)',
        )
      }
      for (const id of collected.missing) {
        console.warn(
          `[rlm-kernel] python skill "${id}" has no package at ${path.join(dataDir, 'skills', id, 'pyproject.toml')}; skipped`,
        )
      }
      return collected.skills
    },
    ...(config.idleTimeoutMs !== undefined ? { idleTimeoutMs: config.idleTimeoutMs } : {}),
    ...(config.snapshotDebounceMs !== undefined ? { snapshotDebounceMs: config.snapshotDebounceMs } : {}),
    ...(config.snapshotHistory !== undefined ? { snapshotHistory: config.snapshotHistory } : {}),
    // T4.1/T4.2: resolve the durable Session so a flush can append its log-only
    // `session/kernel-snapshot` event.
    resolveSession: (sessionId: string) => ctx.sessions?.get(sessionId as SessionId),
    // T3.2 Phase A: live-kernel cap and reclaim-snapshot grace (defaults live
    // in kernels.ts and apply when the config keys are absent).
    ...(config.maxLiveKernels !== undefined ? { maxLiveKernels: config.maxLiveKernels } : {}),
    ...(config.reclaimSnapshotGraceMs !== undefined ? { reclaimSnapshotGraceMs: config.reclaimSnapshotGraceMs } : {}),
  })

  ctx.on('session/disposed', (session) => {
    const sid = String(session.id)
    // FIX-6: abort outstanding rlm.run children owned by this session before
    // tearing down its kernel.
    hostHandlers.abortSession(sid)
    void kernels.disposeSession(sid)
  })

  // T5: after a compaction, tell the model the persistent kernel namespace
  // survived it (prime's `<ipython_state>` after `_syncKernelStateAfterCompaction`).
  // A `compaction/end` event carries no session id in its payload, so we route by
  // the enclosing session argument; the registry ignores sessions without a live
  // kernel. `compaction/end` is a log-only event absent from this package's view
  // of the `SessionEvent` union, so the type is widened for the comparison.
  ctx.on('session/event', (session, event) => {
    if ((event as { type?: string } | undefined)?.type === 'compaction/end') {
      kernels.notifyCompactionEnd(String(session.id))
    }
  })

  // item-7: warm the kernel at session creation so the first ipython call is
  // fast. Errors are swallowed here; a real ipython call retries provision.
  if (config.warmupOnSessionCreate) {
    ctx.on('session/created', (session) => {
      warmUpSession(kernels, String(session.id))
    })
  }

  ctx.effect(
    () => ctx.tools.register(createIpythonTool(kernels, config.maxOutputChars ?? 65_536)),
    'register ipython tool',
  )
  // T2.3: the model-facing last step of the skill-creation workflow.
  ctx.effect(
    () => ctx.tools.register(createSkillCreateTool({ dataDir, upsert: upsertPythonSkillEntry })),
    'register create_python_skill tool',
  )

  // item-4: periodic idle sweep. Unref'd so a long-lived desktop host with no
  // other work is not kept alive by the timer alone. A failed cycle (a snapshot
  // throwing instead of returning null) must not become a recurring unhandled
  // rejection — warn once per failure and let the next sweep retry.
  // P2-fix: only create the timer when idleTimeoutMs > 0 (0 disables reclamation).
  const idleTimeoutMs = config.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
  const sweepTimer = idleTimeoutMs > 0
    ? setInterval(() => {
      kernels.disposeIdle().catch((error) => {
        ctx.logger.warn('[rlm-kernel] idle sweep failed; next sweep retries', { error })
      })
    }, IDLE_SWEEP_INTERVAL_MS)
    : undefined
  if (sweepTimer && typeof sweepTimer.unref === 'function') sweepTimer.unref()

  ctx.effect(
    () => () => {
      if (sweepTimer) clearInterval(sweepTimer)
      void kernels.disposeAll()
    },
    'rlm-kernel teardown',
  )

  // Expose the per-session kernel registry so sibling plugins (e.g.
  // plugin-rlm-verifier) can run their own cells through the same persistent
  // kernel. Optional at read time — the plugin remains fully functional when
  // nothing injects it.
  ctx.provide('rlm.kernels', kernels)
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Per-session kernel registry provided by plugin-rlm-kernel. */
    'rlm.kernels'?: SessionKernelRegistry
  }
}
