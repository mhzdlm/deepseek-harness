/**
 * Host bridge: maps `host.request` types from the kernel's `rlm` runtime to
 * dsh services. This is the only surface where the Python side can touch the
 * host, and it is deliberately narrow — anything credential-bearing or
 * lifecycle-related goes through here; harness state stays file-local to the
 * kernel (see vendored `harness.py`).
 *
 * Result delivery for spawned children relies on dsh's native subagent
 * settlement (`subagent-settled` notice into the parent session, which also
 * re-wakes the parent loop), so `rlm.run` returns a handle immediately.
 *
 * FIX-6: `rlm.run` controllers are tracked per owning session and aborted on
 * `session/disposed` (via `abortSession`), so children cannot outlive their
 * parent session as orphaned runs. The controller is registered BEFORE
 * `subagents.start` resolves, closing the window where a disposal could slip
 * between `start()` and registration (previously NEW-4).
 *
 * P1-fix (NEW-1): `rlm.find_models` and `rlm.delete_subagent` now have real
 * handlers instead of failing with "host request type ... is not available in
 * this session"; `rlm.list_subagents` projects children into the `RLMSubagent`
 * schema the vendored runtime's `_subagent_from_payload` actually requires
 * (the raw `SubagentListEntry` shape previously would have raised
 * "missing rlm_child_id" on the Python side).
 * @module @deepseek-ai/dsh-plugin-rlm-kernel
 */

import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
// Importing the subagent package's types pulls its `declare module '@deepseek-ai/cordis'`
// augmentation into the program, making `ctx.subagents` type-check.
import type { SubagentListEntry, SubagentRun, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
// Importing the llm package's types pulls its `declare module '@deepseek-ai/cordis'`
// augmentation into the program, making `ctx.llm` type-check (same trick as the
// subagent import above). `ctx.llm` is `LlmRuntime | undefined` at runtime when
// the llm service is unmounted, so the `find_models` handler still guards it.
import type { LlmModelInfo } from '@deepseek-ai/dsh-llm'
import type { HostRequestHandlers } from './vendor/kernel/index.ts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export interface HostHandlersBundle {
  handlers: HostRequestHandlers
  /** Abort every outstanding `rlm.run` child owned by the given session. */
  abortSession(sessionId: string): void
}

interface ChildRecord {
  run: SubagentRun
  controller: AbortController
  label: string
}

/** Project a `SubagentListEntry` (one-shot child) into the vendored `RLMSubagent` schema. */
function subagentDescriptor(
  dataDir: string,
  id: string,
  label: string | undefined,
  activity: 'running' | 'inactive',
): Record<string, unknown> {
  return {
    rlm_child_id: id,
    active_session_id: activity === 'running' ? id : null,
    session_id: id,
    session_name: label ?? id,
    session_dir: path.join(dataDir, 'session-artifacts', id),
    status: activity === 'running' ? 'running' : 'completed',
  }
}

/**
 * Build the handler map for one plugin instance. The map is owned by the
 * plugin's apply fiber and shared by every per-session kernel it spawns.
 *
 * `dataDir` is the plugin's artifact root; it is used to report a child's
 * truthful artifacts directory in `rlm.run` results (FIX-9).
 */
export function createHostHandlers(
  ctx: Context,
  subagentProvider: string,
  dataDir: string,
): HostHandlersBundle {
  // Per-session outstanding rlm.run controllers (registered BEFORE start so a
  // disposal during startup still aborts the pending spawn). Aborted on session
  // disposal so an orphaned child cannot keep running past its parent.
  const sessionControllers = new Map<string, Set<AbortController>>()
  // Per-session active rlm children keyed by run id, for rlm.delete_subagent.
  const sessionRuns = new Map<string, Map<string, ChildRecord>>()

  const abortSession = (sessionId: string): void => {
    // Use distinct local names (sessionCtrl/sessionRunMap) to avoid shadowing
    // the outer sessionControllers/sessionRuns Maps — shadowing works at runtime
    // but is a maintenance trap when reading the code under time pressure.
    const sessionCtrl = sessionControllers.get(sessionId)
    if (sessionCtrl) {
      for (const controller of [...sessionCtrl]) controller.abort()
      sessionControllers.delete(sessionId)
    }
    const sessionRunMap = sessionRuns.get(sessionId)
    if (sessionRunMap) {
      for (const record of [...sessionRunMap.values()]) {
        record.controller.abort()
        void record.run.dispose().catch(() => undefined)
      }
      sessionRuns.delete(sessionId)
    }
  }

  const handlers: HostRequestHandlers = {
    // `await rlm("...")` → spawn a real dsh subagent; returns the handle
    // immediately, the child's result arrives later as a settlement notice.
    'rlm.run': async (payload) => {
      const prompt = payload.prompt
      if (typeof prompt !== 'string') throw new Error('rlm.run prompt must be a string')
      const kwargs = isRecord(payload.kwargs) ? payload.kwargs : {}
      const name = typeof kwargs.name === 'string' && kwargs.name.length > 0 ? kwargs.name : 'rlm-child'

      const parent = ctx.agents.currentInitiator()
      if (!parent) {
        throw new Error('rlm.run requires an owning agent session')
      }
      const sid = String(parent.session.id)

      // FIX-6 + NEW-4: a real, tracked controller — registered before start so
      // the child can be cancelled even if the parent session is disposed while
      // the spawn is still in flight.
      const controller = new AbortController()
      let controllers = sessionControllers.get(sid)
      if (!controllers) {
        controllers = new Set<AbortController>()
        sessionControllers.set(sid, controllers)
      }
      controllers.add(controller)

      const request: SubagentStartRequest = {
        prompt: [{ type: 'text', text: prompt }],
        parent,
        label: name,
        signal: controller.signal,
        ...(typeof kwargs.persona === 'string' ? { persona: kwargs.persona } : {}),
        ...(typeof kwargs.maxDepth === 'number' ? { maxDepth: kwargs.maxDepth } : {}),
      }

      try {
        // `subagents.start` takes the provider NAME as its first argument;
        // the child's display name rides on `request.label`.
        const run: SubagentRun = await ctx.subagents.start(subagentProvider, request)
        const runId = String(run.id)

        let runs = sessionRuns.get(sid)
        if (!runs) {
          runs = new Map<string, ChildRecord>()
          sessionRuns.set(sid, runs)
        }
        const record: ChildRecord = { run, controller, label: name }
        runs.set(runId, record)

        void run.result
          .catch(() => undefined)
          .finally(() => {
            runs.delete(runId)
            if (runs.size === 0) sessionRuns.delete(sid)
            controllers.delete(controller)
            if (controllers.size === 0) sessionControllers.delete(sid)
          })

        return {
          rlm_child_id: runId,
          name,
          // FIX-9: report the child's real artifacts directory (created lazily on
          // the child's first ipython use) instead of a bare run id masquerading
          // as a session directory.
          session_dir: path.join(dataDir, 'session-artifacts', runId),
          // FIX-9: surface the model the child will actually use when known,
          // instead of the opaque placeholder 'unknown'.
          model: run.localAgent?.options.model ?? parent.options.model ?? 'unknown',
        }
      } catch (error) {
        controllers.delete(controller)
        if (controllers.size === 0) sessionControllers.delete(sid)
        throw error
      }
    },

    'rlm.list_subagents': async () => {
      const parent = ctx.agents.currentInitiator()
      if (!parent) return { subagents: [] }
      const children = await ctx.subagents.listChildren(parent.session.id)
      const subagents = children
        .filter(
          (entry): entry is SubagentListEntry & { kind: 'child'; mode: 'one-shot' } =>
            entry.kind === 'child' && entry.mode === 'one-shot',
        )
        .map(entry => subagentDescriptor(dataDir, String(entry.id), entry.label, entry.activity))
      return { subagents }
    },

    'rlm.delete_subagent': async (payload) => {
      const target = typeof payload.target === 'string' ? payload.target.trim() : ''
      if (!target) throw new Error('rlm.delete_subagent requires a non-empty target')
      const parent = ctx.agents.currentInitiator()
      if (!parent) throw new Error('rlm.delete_subagent requires an owning agent session')
      const sid = String(parent.session.id)
      const runs = sessionRuns.get(sid)
      const record = runs?.get(target)
      if (!runs || !record) {
        throw new Error(
          `rlm.delete_subagent: no active rlm child "${target}" in this session (only running children spawned via rlm.run can be deleted)`,
        )
      }
      record.controller.abort()
      await record.run.dispose().catch(() => undefined)
      runs.delete(target)
      if (runs.size === 0) sessionRuns.delete(sid)
      return {
        subagent: subagentDescriptor(dataDir, target, record.label, 'inactive'),
      }
    },

    'rlm.find_models': async (payload) => {
      const query = typeof payload.query === 'string' ? payload.query.trim().toLowerCase() : ''
      const rawLimit = typeof payload.limit === 'number' && Number.isFinite(payload.limit) ? Math.floor(payload.limit) : 8
      const limit = Math.max(1, rawLimit)
      const agent = ctx.agents.currentInitiator()
      const provider = agent?.options.provider
      const llm = ctx.llm
      const models: (LlmModelInfo & { selector: string })[] = []
      if (provider && llm) {
        try {
          const infos = await llm.listModels(provider)
          const matches = query
            ? infos.filter(
              info => info.id.toLowerCase().includes(query) || info.name.toLowerCase().includes(query),
            )
            : infos
          for (const info of matches.slice(0, limit)) {
            models.push({ provider, id: info.id, name: info.name, selector: `${provider}/${info.id}` })
          }
        } catch {
          // A listing failure degrades to an empty list rather than killing the
          // in-kernel call with a bridge error.
        }
      }
      return { models }
    },

    // Kernel-side model introspection, mirroring prime's model.info handler:
    // the owning agent's provider/model (id) and an empty input list — dsh
    // resolves the model per request rather than pinning it on the session.
    'model.info': async () => {
      const agent = ctx.agents.currentInitiator()
      return {
        id: agent?.options.model ?? null,
        provider: agent?.options.provider ?? null,
        input: [],
      }
    },
  }

  return { handlers, abortSession }
}
