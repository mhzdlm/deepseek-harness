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
import { createHostHandlers } from './host-handlers.ts'
import { createIpythonTool } from './ipython-tool.ts'
import { createSkillCreateTool } from './skill-create.ts'
import { DEFAULT_IDLE_TIMEOUT_MS, IDLE_SWEEP_INTERVAL_MS, SessionKernelRegistry, warmUpSession } from './kernels.ts'
import { collectPythonSkills, upsertPythonSkillEntry } from './skill-source.ts'

// Re-exported so sibling judgment plugins can consume the shared redaction
// through this package's compiled entry instead of a cross-package src/*.ts
// specifier, which plain Node cannot load from node_modules.
export { redactReferenceText } from './redact.ts'

export const name = 'plugin-rlm-kernel'
export const inject = ['tools', 'subagents', 'sessions', 'agents']

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
   * Outstanding one-shot `rlm.run` children allowed per parent session before
   * further spawns fail loud (retained children are exempt — they idle cheaply
   * until messaged). Bounds the fan-out a looping model can create. Defaults to 8.
   */
  maxChildrenPerSession?: number
  /**
   * Character cap on a single `rlm.run` prompt; larger prompts fail loud with
   * actionable text instead of silently inflating a child's context. Defaults to 24000.
   */
  maxRunPromptChars?: number
}

export const Config: z<Config> = z.object({
  python: z.string(),
  dataDir: z.string(),
  subagentProvider: z.string(),
  idleTimeoutMs: z.natural(),
  maxOutputChars: z.natural(),
  snapshotDebounceMs: z.natural(),
  warmupOnSessionCreate: z.boolean(),
  maxLiveKernels: z.natural(),
  reclaimSnapshotGraceMs: z.natural(),
  maxChildrenPerSession: z.natural(),
  maxRunPromptChars: z.natural(),
})

export function apply(ctx: Context, config: Config): void {
  const dataDir = config.dataDir ?? path.join(homedir(), '.dsh', 'rlm')
  const hostHandlers = createHostHandlers(ctx, config.subagentProvider ?? 'spawn', dataDir, {
    ...(config.maxChildrenPerSession !== undefined ? { maxChildrenPerSession: config.maxChildrenPerSession } : {}),
    ...(config.maxRunPromptChars !== undefined ? { maxRunPromptChars: config.maxRunPromptChars } : {}),
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
    kernels.disposeSession(sid)
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
        console.warn('[rlm-kernel] idle sweep failed:', error)
      })
    }, IDLE_SWEEP_INTERVAL_MS)
    : undefined
  if (sweepTimer && typeof sweepTimer.unref === 'function') sweepTimer.unref()

  ctx.effect(
    () => () => {
      if (sweepTimer) clearInterval(sweepTimer)
      kernels.disposeAll()
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
