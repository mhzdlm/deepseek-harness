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
 * @module @deepseek-ai/dsh-plugin-rlm-kernel
 */

import type { Context } from '@deepseek-ai/cordis'
// Importing the subagent package's types pulls its `declare module '@deepseek-ai/cordis'`
// augmentation into the program, making `ctx.subagents` type-check.
import type { SubagentRun, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import type { HostRequestHandlers } from './vendor/kernel/index.ts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Build the handler map for one plugin instance. The map is owned by the
 * plugin's apply fiber and shared by every per-session kernel it spawns.
 */
export function createHostHandlers(ctx: Context, subagentProvider: string): HostRequestHandlers {
  return {
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

      const controller = new AbortController()
      const request: SubagentStartRequest = {
        prompt: [{ type: 'text', text: prompt }],
        parent,
        label: name,
        signal: controller.signal,
        ...(typeof kwargs.persona === 'string' ? { persona: kwargs.persona } : {}),
        ...(typeof kwargs.maxDepth === 'number' ? { maxDepth: kwargs.maxDepth } : {}),
      }
      // `subagents.start` takes the provider NAME as its first argument;
      // the child's display name rides on `request.label`.
      const run: SubagentRun = await ctx.subagents.start(subagentProvider, request)

      return {
        rlm_child_id: run.id,
        name,
        // dsh sessions are id-addressed rather than directory-addressed;
        // mirror the session id so kernel-side code can correlate.
        session_dir: String(run.id),
        model: 'unknown',
      }
    },

    'rlm.list_subagents': async () => {
      const parent = ctx.agents.currentInitiator()
      if (!parent) return { subagents: [] }
      const children = await ctx.subagents.listChildren(parent.session.id)
      return { subagents: children }
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
}
