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
 *
 * `session.query` gives the kernel programmatic read access to the owning
 * session's own transcript (`transcript.tail` / `transcript.grep` in the
 * injected bootstrap): the prompt-as-a-variable half of the RLM model.
 * Read-only and hard-capped; writes still never leave the host. `rlm.message`
 * delivers follow-up turns to retained children via the subagent followup
 * bridge; delivery-only acknowledgement, answers ride the settlement path.
 * @module @deepseek-ai/dsh-plugin-rlm-kernel
 */

import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
// Importing the subagent package's types pulls its `declare module '@deepseek-ai/cordis'`
// augmentation into the program, making `ctx.subagents` type-check.
import type { SubagentListEntry, SubagentRun, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'

/** Minimal structural surface of the optional host-side session-query engine. */
interface SessionQueryEngineLike {
  searchSessions(request: { query: string; limit?: number }): Promise<{
    items: ReadonlyArray<{
      header: { id: unknown; title?: unknown }
      bestMatch: { snippet: string }
      live: boolean
    }>
    /** Opaque continuation cursor; present when more pages exist. */
    nextCursor?: string
  }>
}
// Importing the llm package's types pulls its `declare module '@deepseek-ai/cordis'`
// augmentation into the program, making `ctx.llm` type-check (same trick as the
// subagent import above). `ctx.llm` is `LlmRuntime | undefined` at runtime when
// the llm service is unmounted, so the `find_models` handler still guards it.
import { BlockAssembler, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { LlmModelInfo } from '@deepseek-ai/dsh-llm'
import { emitSubcallQueryEvent } from './events.ts'
import type { HostRequestHandlers } from './vendor/kernel/index.ts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Model-supplied grep patterns above this length are rejected outright. */
const MAX_PATTERN_CHARS = 200
/**
 * Character budget for one grep's regex evaluation over rendered messages. V8
 * cannot time out a backtracking regex, so the bound that actually holds is
 * input volume: past the budget the call marks itself truncated instead of
 * stalling the host on a pathological pattern.
 */
const GREP_SCAN_BUDGET_CHARS = 400_000

/**
 * Reject model-supplied regexes whose worst-case backtracking is exponential or
 * high-polynomial on adversarial input. JS has no linear-time regex engine, so
 * a complexity guard at construction — not more input caps — is the honest
 * bound: one `pattern.test()` on a single message must never stall the host.
 *
 * Two dangerous families are rejected with actionable text:
 * 1. an unbounded quantifier (`+`, `*`, `{n,}`) over a group whose content
 *    itself quantifies, alternates, or nests another group — `(a+)+`, `(a|b)*`,
 *    `(a?)+`, `(a{1,2})*`, `((a)+)+`, `(ab)+(a+)+`. Every quantified group is
 *    checked, not just the first (the round-5 review's first-group bypass);
 * 2. the same quantified atom repeated 3+ times in a row — `a*a*a*`,
 *    `\d+\d+\d+`, `[a-z]+[a-z]+[a-z]+` — ambiguous splits make the scan
 *    polynomial in the length. Character-class content is collapsed first so a
 *    class atom is treated like a literal atom.
 *
 * Bounded forms stay allowed: `(1|2)?`, `(ab)+`, `(\w+)`, `\d+\s*\d+`,
 * `.*foo.*bar`.
 * @param source - the raw pattern from the model.
 */
export function assertReDosSafePattern(source: string): void {
  // Neutralize escapes so regex metacharacters read as plain atoms and cannot
  // pose as delimiters (`\(` is a literal paren, not a group).
  const bare = source.replace(/\\./g, 'x')
  // Collapse character classes to one inert atom so class content cannot hide
  // delimiters/quantifiers from the scans below (`[a-z]+` → `A+`).
  const bareNoClasses = bare.replace(/\[[^\]]*\]/g, 'A')

  // Balanced-paren walk over the class-free pattern. Each frame tracks what its
  // group body contains; on a closing paren followed by an UNBOUNDED quantifier
  // the frame must be ambiguity-free, else the pair is exponential-shaped.
  interface GroupFrame { quantifiedAtom: boolean; alternation: boolean; nested: boolean }
  const stack: GroupFrame[] = []
  const isUnboundedQuantifier = (text: string, at: number): boolean => {
    const ch = text[at]
    if (ch === '+' || ch === '*') return true
    if (ch === '{') {
      // `{n,}` is unbounded; `{n,m}` and `{n}` are bounded.
      return /\{\d+,\s*\}/.test(text.slice(at))
    }
    return false
  }
  for (let i = 0; i < bareNoClasses.length; i++) {
    const ch = bareNoClasses[i]
    if (ch === '(') {
      const parent = stack[stack.length - 1]
      if (parent) parent.nested = true
      stack.push({ quantifiedAtom: false, alternation: false, nested: false })
      continue
    }
    if (ch === ')' && stack.length > 0) {
      const frame = stack.pop()
      if (!frame) continue
      if (isUnboundedQuantifier(bareNoClasses, i + 1) && (frame.quantifiedAtom || frame.alternation || frame.nested)) {
        throw new Error(
          'pattern uses a quantified group containing quantifiers, alternation, or nested groups '
          + '(e.g. "(a+)+", "(a|b)*", "((a)+)+", "(ab)+(a+)+") '
          + '— catastrophic backtracking can stall the host. '
          + 'Match one alternative at a time instead.',
        )
      }
      // The quantifier after the closing paren quantifies this whole group as
      // an atom of the enclosing group.
      const enclosing = stack[stack.length - 1]
      if (enclosing && /[+*?]/.test(bareNoClasses[i + 1] ?? '')) enclosing.quantifiedAtom = true
      continue
    }
    if (ch === '|') {
      const top = stack[stack.length - 1]
      if (top) top.alternation = true
      continue
    }
    if (ch === '+' || ch === '*' || ch === '?') {
      const top = stack[stack.length - 1]
      if (top) top.quantifiedAtom = true
      continue
    }
    if (ch === '{') {
      // Literal `{` requires an escape (already unescaped above), so a bare `{`
      // here is a quantifier; skip past it so its range digits are not scanned.
      const top = stack[stack.length - 1]
      if (top) top.quantifiedAtom = true
      const close = bareNoClasses.indexOf('}', i)
      if (close > i) i = close
      continue
    }
  }

  if (/([^*+?{}()\\])([*+?]|\{\d+(?:,\d*)?\})\1\2\1\2/.test(bareNoClasses)) {
    throw new Error(
      'pattern repeats the same quantified atom 3+ times in a row '
      + '(e.g. "a*a*a*" or "[a-z]+[a-z]+[a-z]+") — catastrophic backtracking can stall '
      + 'the host. Simplify the pattern.',
    )
  }
}

/** Structural shape of the LLM seam the `llm.query` bridge needs. */
interface LlmStreamLike {
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

/**
 * Detect a degenerate subcall answer (LAYERS.md §2.4, prime Appendix F.1's
 * "sub-LM gives up" pattern): empty, trivially short, or self-repeating text.
 * Host-side detection only — the exact strategy (chunking) stays with the
 * kernel caller, which receives the `degenerate` flag.
 * @param text - the generated answer text.
 * @returns whether the answer is degenerate and worth a retry.
 */
function isDegenerateAnswer(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length === 0) return true
  if (trimmed.length < 8) return true
  // Same whitespace-separated token repeated three or more times in a row
  // ("yes yes yes", "ok ok ok") — the sub-model give-up noise pattern.
  const tokens = trimmed.split(/\s+/).filter(Boolean)
  if (tokens.length >= 3 && tokens.every(token => token === tokens[0])) return true
  return false
}

/**
 * Run one `llm.query` subcall through the host LLM seam with
 * `purpose: 'rlm-subcall'` attribution and its own wall-clock budget.
 * @param llm - the LLM seam (already verified to expose `stream`).
 * @param provider - provider name (from the owning agent, or the request).
 * @param model - resolved model (request → route selector → owning agent).
 * @param promptText - the subcall prompt.
 * @param maxTokens - optional output-token cap from the kernel caller.
 * @param timeoutMs - per-generate wall-clock budget; expiry rejects.
 * @returns the concatenated text of the response.
 */
async function generateSubcallAnswer(
  llm: LlmStreamLike,
  provider: string | undefined,
  model: string,
  promptText: string,
  maxTokens: unknown,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<string> {
  const assembler = new BlockAssembler()
  const options = {
    ...(provider !== undefined ? { provider } : {}),
    model,
    messages: [
      createUserMessage({
        content: [{ type: 'text', text: promptText }],
        source: { kind: 'plugin', plugin: 'dsh-plugin-rlm-kernel' },
      }),
    ],
    ...(typeof maxTokens === 'number' && maxTokens > 0 ? { maxTokens } : {}),
    purpose: 'rlm-subcall',
    // Phase 8: the wall-clock timeout is composed with the session-disposal
    // signal so a disposed session stops billing immediately.
    signal: externalSignal ? AbortSignal.any([AbortSignal.timeout(timeoutMs), externalSignal]) : AbortSignal.timeout(timeoutMs),
  } as GenerateOptions
  for await (const chunk of llm.stream(options)) assembler.push(chunk)
  const finish = assembler.finish
  if (finish.kind === 'error') throw new Error(`llm.query subcall failed: ${finish.failure.message}`)
  if (finish.kind === 'aborted') {
    throw new Error(externalSignal?.aborted ? 'llm.query subcall cancelled (session disposed)' : 'llm.query subcall aborted')
  }
  return assembler
    .blocks()
    .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/**
 * Bundle returned by `createHostHandlers`: the host-request handler map plus a
 * per-session abort hook used to cancel outstanding `rlm.run` children when
 * their owning session is disposed.
 */
export interface HostHandlersBundle {
  handlers: HostRequestHandlers
  /** Abort every outstanding `rlm.run` child owned by the given session. */
  abortSession(sessionId: string): void
}

/** Resource governors for model-driven `rlm.run` fan-out and `llm.query` subcalls. */
export interface HostHandlerLimits {
  /** Live children (one-shot and retained, including in-flight spawns) allowed per parent session. */
  maxChildrenPerSession: number
  /** Character cap on one `rlm.run` prompt. */
  maxRunPromptChars: number
  /** In-flight `llm.query` subcall streams allowed per owning session (LAYERS.md §2.2 R1). */
  maxInFlightSubcalls: number
  /** Max prompts in one `llm.query` batch request (LAYERS.md §2.2 R1). */
  maxSubcallBatch: number
  /** Char cap per subcall answer; longer answers are truncated and flagged (LAYERS.md §2.1). */
  maxSubcallAnswerChars: number
  /** Wall-clock budget per subcall generation (one retry counts as a fresh budget). */
  subcallTimeoutMs: number
  /**
   * Phase 8 (review round 6): char cap per `llm.query` prompt. Subcalls
   * legitimately carry chunk-sized context, so this sits far above
   * `maxRunPromptChars` — its only job is stopping an absurd single prompt
   * (e.g. a whole-repo string) from becoming a runaway billing call.
   */
  maxSubcallPromptChars: number
}

const DEFAULT_HANDLER_LIMITS: HostHandlerLimits = {
  maxChildrenPerSession: 8,
  maxRunPromptChars: 24_000,
  maxInFlightSubcalls: 8,
  maxSubcallBatch: 32,
  maxSubcallAnswerChars: 8_000,
  subcallTimeoutMs: 120_000,
  maxSubcallPromptChars: 100_000,
}

interface ChildRecord {
  /** Durable child id: the run id for one-shot spawns, the reserved session id for retained children. */
  readonly childId: string
  readonly label: string
  readonly controller: AbortController
  /** One-shot runs carry a live SubagentRun; retained children are managed by the continuation manager. */
  run?: SubagentRun
  retained?: boolean
}

/** Project a `SubagentListEntry` (one-shot child) into the vendored `RLMSubagent` schema. */
function subagentDescriptor(
  dataDir: string,
  id: string,
  label: string | undefined,
  activity: 'running' | 'inactive',
  retained = false,
): Record<string, unknown> {
  return {
    rlm_child_id: id,
    active_session_id: activity === 'running' ? id : null,
    session_id: id,
    session_name: label ?? id,
    session_dir: path.join(dataDir, 'session-artifacts', id),
    status: activity === 'running' ? 'running' : 'completed',
    retained,
  }
}

/**
 * Build the handler map for one plugin instance. The map is owned by the
 * plugin's apply fiber and shared by every per-session kernel it spawns.
 *
 * `dataDir` is the plugin's artifact root; it is used to report a child's
 * truthful artifacts directory in `rlm.run` results (FIX-9).
 *
 * @param ctx - The Cordis context used to reach host services (agents,
 *   subagents, optional llm/sessionQuery) and register the abort effect.
 * @param subagentProvider - The provider name passed to `ctx.subagents.start`
 *   for each spawned child.
 * @param dataDir - The plugin's artifact root, used to compute each child's
 *   artifacts directory in `rlm.run` results.
 * @param limitOverrides - Optional per-session resource governors merged over
 *   the package defaults (max children and prompt char cap).
 * @param options - Optional bridge tuning: `subcallModel` is the LAYERS.md §2.3
 *   route selector for `llm.query` (R2: kernel Config → preset surface); when
 *   omitted the subcall runs on the owning agent's own model (no downgrade).
 * @returns A bundle of the host-request handler map plus an `abortSession`
 *   function that cancels a session's outstanding `rlm.run` children.
 */
export function createHostHandlers(
  ctx: Context,
  subagentProvider: string,
  dataDir: string,
  limitOverrides: Partial<HostHandlerLimits> = {},
  options: { subcallModel?: string } = {},
): HostHandlersBundle {
  const limits: HostHandlerLimits = { ...DEFAULT_HANDLER_LIMITS, ...limitOverrides }
  const subcallModel = options.subcallModel
  // Per-session outstanding rlm.run controllers (registered BEFORE start so a
  // disposal during startup still aborts the pending spawn). Aborted on session
  // disposal so an orphaned child cannot keep running past its parent.
  const sessionControllers = new Map<string, Set<AbortController>>()
  // Per-session active rlm children keyed by run id, for rlm.delete_subagent.
  const sessionRuns = new Map<string, Map<string, ChildRecord>>()
  // Per-session count of spawns currently in flight (started but not yet
  // registered in sessionRuns). Keeps the fan-out cap exact in the parallel-spawn
  // window: a model firing several rlm.run calls at once must each see the
  // others' pending spawns, because their records only land after the await.
  const inflightSpawns = new Map<string, number>()
  const bumpInflight = (sid: string): void => {
    inflightSpawns.set(sid, (inflightSpawns.get(sid) ?? 0) + 1)
  }
  const dropInflight = (sid: string): void => {
    const next = (inflightSpawns.get(sid) ?? 1) - 1
    if (next <= 0) inflightSpawns.delete(sid)
    else inflightSpawns.set(sid, next)
  }
  // Per-session count of in-flight `llm.query` subcall streams (R1 quota): the
  // count bumps before the first await and drops in a finally, so concurrent
  // subcall batches cannot overrun the cap during the generation window.
  const inflightSubcalls = new Map<string, number>()
  const bumpInFlightSubcalls = (sid: string): void => {
    inflightSubcalls.set(sid, (inflightSubcalls.get(sid) ?? 0) + 1)
  }
  const dropInFlightSubcall = (sid: string): void => {
    const next = (inflightSubcalls.get(sid) ?? 1) - 1
    if (next <= 0) inflightSubcalls.delete(sid)
    else inflightSubcalls.set(sid, next)
  }
  // Phase 8 (review round 6): per-session abort handles for in-flight
  // `llm.query` batches. Without these, a disposed session left its serial
  // subcall chain generating (and billing) with no listener — up to
  // maxSubcallBatch × subcallTimeoutMs of orphaned work per abandoned batch.
  const sessionSubcallControllers = new Map<string, Set<AbortController>>()

  const abortSession = (sessionId: string): void => {
    inflightSpawns.delete(sessionId)
    inflightSubcalls.delete(sessionId)
    const sessionSubcalls = sessionSubcallControllers.get(sessionId)
    if (sessionSubcalls) {
      for (const controller of [...sessionSubcalls]) controller.abort()
      sessionSubcallControllers.delete(sessionId)
    }
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
        // Retained children have no run object: their lifecycle belongs to the
        // continuation manager, so aborting the controller is all we own.
        void record.run?.dispose().catch(() => undefined)
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

      // Resource governors: an unbounded prompt inflates a child's context
      // silently, and an unchecked fan-out lets a looping model create
      // unlimited concurrent LLM-burning children. Both fail loud with
      // actionable text instead of degrading.
      if (prompt.length > limits.maxRunPromptChars) {
        throw new Error(
          `rlm.run prompt is ${prompt.length} characters, over the ${limits.maxRunPromptChars}-character cap `
          + '(maxRunPromptChars). Summarize the task or split it across calls.',
        )
      }
      const live = (sessionRuns.get(sid)?.size ?? 0) + (inflightSpawns.get(sid) ?? 0)
      if (live >= limits.maxChildrenPerSession) {
        throw new Error(
          `rlm.run: ${live} children already live or in flight `
          + `(maxChildrenPerSession=${limits.maxChildrenPerSession}). `
          + 'Run rlm.list_subagents to see them, then free slots with rlm.delete_subagent on children you no longer need '
          + '(one-shot children release their slot when their run settles; retained children keep theirs until deleted).',
        )
      }

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
      // Count this spawn as in flight BEFORE the await: parallel rlm.run calls
      // must see each other's pending spawns (their records only land after
      // start resolves), or the fan-out cap would be undercounted (T7.6).
      bumpInflight(sid)

      const request: SubagentStartRequest = {
        prompt: [{ type: 'text', text: prompt }],
        parent,
        label: name,
        signal: controller.signal,
        ...(typeof kwargs.persona === 'string' ? { persona: kwargs.persona } : {}),
        ...(typeof kwargs.maxDepth === 'number' ? { maxDepth: kwargs.maxDepth } : {}),
      }

      const retained = kwargs.retained === true

      try {
        if (retained) {
          // Retained (continuable) child: durable, addressable for later
          // `rlm.message` follow-ups. The continuation manager owns the whole
          // lifecycle — we only record the reserved id. Admission resolves when
          // the inbox accepts the initial prompt; there is no result to await.
          const start = await ctx.subagents.startContinuable({
            provider: subagentProvider,
            label: name,
            request: {
              prompt: [{ type: 'text', text: prompt }],
              parent,
              ...(typeof kwargs.persona === 'string' ? { persona: kwargs.persona } : {}),
              ...(typeof kwargs.maxDepth === 'number' ? { maxDepth: kwargs.maxDepth } : {}),
            },
            signal: controller.signal,
          })
          const childId = String(start.childId)

          let runs = sessionRuns.get(sid)
          if (!runs) {
            runs = new Map<string, ChildRecord>()
            sessionRuns.set(sid, runs)
          }
          runs.set(childId, { childId, label: name, controller, retained: true })
          dropInflight(sid)

          return {
            rlm_child_id: childId,
            name,
            session_dir: path.join(dataDir, 'session-artifacts', childId),
            model: parent.options.model ?? 'unknown',
            retained: true,
          }
        }

        // One-shot spawn: `subagents.start` takes the provider NAME as its first
        // argument; the child's display name rides on `request.label`.
        const run: SubagentRun = await ctx.subagents.start(subagentProvider, request)
        const runId = String(run.id)

        let runs = sessionRuns.get(sid)
        if (!runs) {
          runs = new Map<string, ChildRecord>()
          sessionRuns.set(sid, runs)
        }
        const record: ChildRecord = { childId: runId, run, controller, label: name }
        runs.set(runId, record)
        dropInflight(sid)

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
        dropInflight(sid)
        controllers.delete(controller)
        if (controllers.size === 0) sessionControllers.delete(sid)
        throw error
      }
    },

    'rlm.list_subagents': async () => {
      const parent = ctx.agents.currentInitiator()
      if (!parent) return { subagents: [] }
      const children = await ctx.subagents.listChildren(parent.session.id)
      // Both modes project: retained (continuable) children are exactly the
      // ones rlm.message can address, so hiding them would make follow-ups
      // undiscoverable from the kernel.
      const subagents = children
        .filter(
          (entry): entry is SubagentListEntry & { kind: 'child'; mode: 'one-shot' | 'continuable' } =>
            entry.kind === 'child',
        )
        .map(entry => subagentDescriptor(dataDir, String(entry.id), entry.label, entry.activity, entry.mode === 'continuable'))
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
      await record.run?.dispose().catch(() => undefined)
      runs.delete(target)
      if (runs.size === 0) sessionRuns.delete(sid)
      const controllers = sessionControllers.get(sid)
      if (controllers) {
        controllers.delete(record.controller)
        if (controllers.size === 0) sessionControllers.delete(sid)
      }
      return {
        subagent: subagentDescriptor(dataDir, target, record.label, 'inactive'),
      }
    },

    // Deliver a follow-up message to a retained child as its next FIFO turn.
    // The child's answer comes back through the ordinary settlement/notice
    // path, never as this call's return value — mirroring prime's
    // agent_message semantics where only delivery is acknowledged.
    'rlm.message': async (payload) => {
      const message = typeof payload.message === 'string' ? payload.message : ''
      if (!message.trim()) throw new Error('rlm.message requires a non-empty message')
      const parent = ctx.agents.currentInitiator()
      if (!parent) throw new Error('rlm.message requires an owning agent session')
      const sid = String(parent.session.id)

      let target = typeof payload.target === 'string' ? payload.target.trim() : ''
      if (!target) {
        // Default to the most recently spawned retained child of this session.
        const runs = sessionRuns.get(sid)
        const retained = [...(runs?.values() ?? [])].filter(record => record.retained)
        const last = retained.at(-1)
        if (!last) {
          throw new Error(
            'rlm.message: no target given and no active retained child in this session (spawn one with rlm.run retained=true)',
          )
        }
        target = last.childId
      }

      // Resolve the durable child id: exact registry hit first, then label
      // match, then the subagent service's own listing (which knows children
      // from earlier host processes too).
      const runs = sessionRuns.get(sid)
      const byId = runs?.get(target)
      let childId = byId?.childId
      if (!childId) {
        const byLabel = [...(runs?.values() ?? [])].find(record => record.label === target)
        childId = byLabel?.childId
      }
      if (!childId) {
        // The service listing knows children from earlier host processes too,
        // but only continuable rows are follow-up targets — a one-shot run has
        // no live turn queue, so addressing one would fail downstream anyway.
        const children = await ctx.subagents.listChildren(parent.session.id)
        const entry = children.find(
          (candidate): candidate is SubagentListEntry & { kind: 'child'; mode: 'continuable' } =>
            candidate.kind === 'child' && candidate.mode === 'continuable'
            && (String(candidate.id) === target || ('label' in candidate && candidate.label === target)),
        )
        childId = entry ? String(entry.id) : undefined
      }
      if (!childId) {
        throw new Error(`rlm.message: no retained child matching "${target}" in this session`)
      }

      // Delivery is a short host-side operation with no kernel-facing cancel
      // channel, so the controller exists only to satisfy the followup
      // contract; nothing aborts it.
      const controller = new AbortController()
      const messageId = await ctx.subagents.followup(
        parent,
        SessionId(childId),
        [{ type: 'text', text: message }],
        {
          source: { kind: 'coordinator', form: 'relay', senderSessionId: parent.session.id },
          signal: controller.signal,
        },
      )
      return { child_id: childId, message_id: String(messageId) }
    },

    'rlm.find_models': async (payload) => {
      const query = typeof payload.query === 'string' ? payload.query.trim().toLowerCase() : ''
      const rawLimit = typeof payload.limit === 'number' && Number.isFinite(payload.limit) ? Math.floor(payload.limit) : 8
      const limit = Math.max(1, rawLimit)
      const agent = ctx.agents.currentInitiator()
      const provider = agent?.options.provider
      // Optional service read through ctx.get (topology-safe); the property
      // proxy would silently return undefined for an undeclared injection.
      const llm = (ctx as unknown as { get(name: string): unknown }).get('llm') as
        | { listModels(provider: string): Promise<LlmModelInfo[]> }
        | undefined
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

    // Programmatic read access to the owning session's own transcript
    // (prompt-as-a-variable): `transcript.tail(n)` / `transcript.grep(pattern)`
    // in the kernel are thin wrappers over this type. Read-only, capped.
    //
    // op=search extends the same type with cross-session full-text search via
    // the optional host-side session-query engine; it fails loud when that
    // service is not mounted instead of silently degrading to own-session.
    'session.query': async (payload) => {
      const agent = ctx.agents.currentInitiator()
      if (!agent) throw new Error('session.query requires an owning agent session')
      const op = payload.op === 'grep' ? 'grep' : payload.op === 'search' ? 'search' : 'tail'
      const n = typeof payload.n === 'number' && Number.isFinite(payload.n) ? Math.floor(payload.n) : 20
      const limit = typeof payload.limit === 'number' && Number.isFinite(payload.limit)
        ? Math.min(200, Math.max(1, Math.floor(payload.limit)))
        : 50
      const perMessageCap = Math.min(10_000, Math.max(50,
        typeof payload.maxChars === 'number' && Number.isFinite(payload.maxChars) ? Math.floor(payload.maxChars) : 2_000))
      const totalCap = Math.min(80_000, Math.max(500,
        typeof payload.maxTotal === 'number' && Number.isFinite(payload.maxTotal) ? Math.floor(payload.maxTotal) : 40_000))

      let pattern: RegExp | undefined
      if (op === 'grep' || op === 'search') {
        const source = typeof payload.pattern === 'string' ? payload.pattern : ''
        if (!source.trim()) throw new Error(`session.query ${op} requires a non-empty pattern`)
        if (source.length > MAX_PATTERN_CHARS) {
          throw new Error(`session.query: pattern exceeds ${MAX_PATTERN_CHARS} characters`)
        }
        if (op === 'grep') {
          try {
            // A model-supplied pattern must never be able to stall the host via
            // catastrophic backtracking; the complexity guard rejects the
            // exponential/polynomial families before a single test() runs (T7.6).
            assertReDosSafePattern(source)
            pattern = new RegExp(source, 'i')
          } catch (error) {
            throw new Error(`session.query: invalid pattern: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
      }

      // Cross-session full-text search rides the optional host-side session
      // query engine. Optional by design: the deployment mounts it when it
      // wants the capability; absent, we fail loud instead of silently
      // degrading to own-session scope.
      if (op === 'search') {
        const engine = (ctx as unknown as { get(name: string): unknown }).get('sessionQuery') as
          | SessionQueryEngineLike
          | undefined
        if (!engine) {
          throw new Error(
            'session.query search requires the host-side session-query service '
            + '(mount @deepseek-ai/dsh-session-query-sqlite on the host composition)',
          )
        }
        const page = await engine.searchSessions({ query: payload.pattern as string, limit })
        const items = page.items.map(hit => ({
          sessionId: String(hit.header.id),
          ...(typeof hit.header.title === 'string' ? { title: hit.header.title } : {}),
          snippet: hit.bestMatch.snippet.slice(0, perMessageCap),
          live: hit.live,
        }))
        return { messages: items, truncated: page.nextCursor !== undefined || items.length === limit, total: items.length }
      }

      const render = (message: { role: string; content: unknown }): { role: string; text: string } => {
        const blocks = Array.isArray(message.content) ? message.content : []
        const text = blocks
          .map((block) => {
            const record = block as { type?: string; text?: unknown }
            return record.type === 'text' && typeof record.text === 'string' ? record.text : ''
          })
          .filter(Boolean)
          .join(' ')
          .slice(0, perMessageCap)
        return { role: message.role, text }
      }

      const derived = agent.session.deriveMessages()
      let selected = derived.map(render).filter(item => item.text.length > 0)
      let truncated = false
      if (op === 'tail') {
        selected = selected.slice(-Math.min(Math.max(n, 1), 200))
      } else {
        if (pattern === undefined) throw new Error('session.query: pattern missing for grep')
        // Bounded evaluation: chronological scan up to a character budget; a
        // pathological model-supplied pattern degrades to `truncated` instead
        // of stalling the single-threaded host.
        const matched: typeof selected = []
        let scanned = 0
        for (const item of selected) {
          if (scanned >= GREP_SCAN_BUDGET_CHARS) { truncated = true; break }
          scanned += item.text.length
          if (pattern.test(item.text)) matched.push(item)
        }
        truncated = truncated || matched.length > limit
        selected = matched.slice(0, limit)
      }
      let used = 0
      const kept = selected.filter((item) => {
        if (used + item.text.length > totalCap) { truncated = true; return false }
        used += item.text.length
        return true
      })

      return { messages: kept, truncated, total: derived.length }
    },

    // T7.10 (LAYERS.md §2): the inner-layer model-call bridge. The kernel calls
    // `llm.query(prompt | prompts, **kwargs)`; the host executes each subcall
    // through the LLM seam with `purpose: 'rlm-subcall'` attribution. Bounded by
    // the per-session in-flight quota (R1), the batch-length cap, and a per-call
    // wall-clock budget (T7.3 semantics); degenerate answers (empty / trivially
    // short / self-repeating) are retried once and then flagged `degenerate` for
    // the kernel-side chunking decision (LAYERS.md §2.4). Answers are truncated
    // at `maxSubcallAnswerChars` and marked; every batch emits a log-only
    // `session/subcall-query` event (the §5 evaluation data source).
    'llm.query': async (payload) => {
      const agent = ctx.agents.currentInitiator() as
        | (ReturnType<typeof ctx.agents.currentInitiator> & { session: { id: unknown; append?: unknown } })
        | undefined
      if (!agent?.session) throw new Error('llm.query requires an owning agent session')
      const sid = String(agent.session.id)
      const prompts: string[] =
        typeof payload.prompt === 'string'
          ? [payload.prompt]
          : Array.isArray(payload.prompts)
            ? payload.prompts.filter((item: unknown): item is string => typeof item === 'string')
            : []
      if (prompts.length === 0) throw new Error('llm.query requires a non-empty prompt or prompts array')
      if (prompts.length > limits.maxSubcallBatch) {
        throw new Error(
          `llm.query: ${prompts.length} prompts exceeds the batch cap (maxSubcallBatch=${limits.maxSubcallBatch}). Split the batch.`,
        )
      }
      if ((inflightSubcalls.get(sid) ?? 0) >= limits.maxInFlightSubcalls) {
        throw new Error(
          `llm.query: ${inflightSubcalls.get(sid) ?? 0} subcalls already in flight `
          + `(maxInFlightSubcalls=${limits.maxInFlightSubcalls}). Await their results first.`,
        )
      }
      // Phase 8: per-prompt size governor. rlm.run has maxRunPromptChars;
      // without its counterpart here the kernel could hand the seam a
      // multi-megabyte string as one subcall prompt.
      let oversized = -1
      let oversizedChars = 0
      for (let index = 0; index < prompts.length; index++) {
        const one = prompts[index]
        if (one !== undefined && one.length > limits.maxSubcallPromptChars) {
          oversized = index
          oversizedChars = one.length
          break
        }
      }
      if (oversized >= 0) {
        throw new Error(
          `llm.query: prompt #${oversized} is ${oversizedChars} characters, over the `
          + `${limits.maxSubcallPromptChars}-character cap (maxSubcallPromptChars=${limits.maxSubcallPromptChars}). `
          + 'Chunk the context into smaller subcall prompts.',
        )
      }
      // Phase 8: register a disposal handle for the whole batch so
      // session/disposed stops in-flight generation instead of orphaning it.
      const batchController = new AbortController()
      let subcallControllers = sessionSubcallControllers.get(sid)
      if (!subcallControllers) {
        subcallControllers = new Set<AbortController>()
        sessionSubcallControllers.set(sid, subcallControllers)
      }
      subcallControllers.add(batchController)
      const llm = ctx.get('llm') as LlmStreamLike | undefined
      if (!llm || typeof llm.stream !== 'function') {
        throw new Error('llm.query requires the host-side llm service (mount an LLM provider)')
      }
      const requestedModel = typeof payload.model === 'string' ? payload.model : undefined
      const model = requestedModel ?? subcallModel ?? agent.options.model
      if (!model) {
        throw new Error('llm.query: no model resolved (set request model, subcallModel Config, or use an agent with a model)')
      }
      const answered: string[] = []
      const truncated: boolean[] = []
      let degenerate = false
      let retries = 0
      const started = Date.now()
      bumpInFlightSubcalls(sid)
      const answer = async (one: string): Promise<string> =>
        generateSubcallAnswer(llm, agent.options.provider, model, one, payload.maxTokens, limits.subcallTimeoutMs, batchController.signal)
      try {
        for (const one of prompts) {
          let text = await answer(one)
          if (isDegenerateAnswer(text)) {
            retries += 1
            text = await answer(one)
            if (isDegenerateAnswer(text)) degenerate = true
          }
          const over = text.length > limits.maxSubcallAnswerChars
          answered.push(over ? text.slice(0, limits.maxSubcallAnswerChars) : text)
          truncated.push(over)
        }
      } finally {
        dropInFlightSubcall(sid)
        subcallControllers.delete(batchController)
        if (subcallControllers.size === 0) sessionSubcallControllers.delete(sid)
      }
      const durationMs = Date.now() - started
      emitSubcallQueryEvent(agent.session as never, {
        batchSize: prompts.length,
        model,
        answerChars: answered.map(answer => answer.length),
        truncated,
        degenerate,
        retries,
        durationMs,
        ...(typeof payload.use === 'string' ? { use: payload.use } : {}),
        ...(typeof payload.depth === 'number' ? { depth: payload.depth } : {}),
      })
      return { answers: answered, model, degenerate, truncated, retries, durationMs }
    },
  }

  return { handlers, abortSession }
}
