/**
 * RLM memory plugin (ReMe's form, the Continual Harness paper's discipline,
 * dsh's sovereignty): Phase A write path. Captures completed root sessions,
 * sanitizes the transcript (strips tool results — anti-pollution, REME.md §5.1
 * D5), writes `dialog/<id>.jsonl`, spawns a host-owned extraction subagent that
 * proposes draft notes gated by an evidence locator (REME.md §5.1 D6), appends a
 * log-only `session/memory-captured` event (REME.md §5.1 D7), and exposes the
 * `/memory list|show|delete|consolidate|rollback|retire|archived|unretire` command
 * family (delete is drafts-only; published notes go through the Phase C promotion
 * gate and Phase D retirement below). Phase B (memory_search recall over `published/`) is implemented
 * here: an in-memory keyword index rebuilt from `published/` on each call (no
 * persisted `index/keyword.json` to drift, REME.md §5.2 / §10 Phase B acceptance),
 * the `memory_search` tool with the §8 D4 use-signal (increments `use_count`/
 * `last_accessed` per hit, never `version`), and a hints-only `agent/session-start`
 * guidance injection pointing the model at the tool (REME.md §6 D13). Phase C
 * (consolidation/gate/rollback) and Phase D (retire/archive, REME.md §5.4 D12) are
 * implemented: an aging scan scores `published/` notes by `use_count` + recency and a
 * reversible `archive/` move retires low-value stale notes under `exitMode: off|observe|enforce`
 * (default `off`, conservative — nothing retires unless enabled, REME.md §9).
 *
 * Capture accumulates per-session turns from the single `session/event` bus emit
 * (every `SessionEventMap` member reaches listeners through it), and flushes on
 * `session/disposed` — mirroring ReMe `runtime.capture` but host-owned.
 *
 * @module @deepseek-ai/dsh-plugin-rlm-memory
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import type { CommandInvocation } from '@deepseek-ai/dsh-commands'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { homedir } from 'node:os'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { MEMORY_EVENT_TYPES, emitMemoryCapturedEvent } from './events.ts'
import { ensureMemoryDirs, readDialog, type Note } from './storage.ts'
import { extractDrafts, persistCapture, type CaptureBufferEntry } from './capture.ts'
import { type CaptureTurn } from './sanitize.ts'
import { listMemoryText, showMemoryText, deleteMemoryText, consolidateText, rollbackText, retireText, archivedText, unretireText } from './memory-cmd.ts'
import { createMemorySearchTool } from './memory-search-tool.ts'
import { createExternalEmbeddingProvider, type EmbeddingService } from './embedding.ts'
import { memoryGuidance } from './guidance.ts'
import { importLegacyNotes, pickupMailboxSeeds, syncMailboxProjection, watchMailboxProjection, proposeCriterion, approveCriterion, MAILBOX_SCOPE } from './mailbox.ts'
import type { RlmCriterionTier, RlmScope, RlmStore } from '@deepseek-ai/dsh-plugin-rlm-store'
import { RLM_CRITERION_TIERS, observeReport, renderObserveReport } from '@deepseek-ai/dsh-plugin-rlm-store'
import type { GateMode } from './consolidate.ts'
import type { ExitMode } from './retire.ts'
// GateMode is re-declared here as the package-level type so consumers importing from the
// package entry (./index) get the same union without reaching into ./consolidate.
export type { GateMode }
// ExitMode is re-exported from ./retire.ts for the same reason (Phase D).
export type { ExitMode }
// Phase 8 (review round 6): the lexical recall entry point is re-exported so
// sibling plugins (plugin-continual-harness's recall-inject) import it through
// this package's compiled entry instead of a cross-package `src/*.ts`
// specifier, which plain Node cannot load from node_modules — the same
// discipline as the kernel package's `redactReferenceText` re-export.
export { search, hybridSearch } from './search.ts'
export type { SearchHit } from './search.ts'

/** Plugin manifest name, matching the npm package identifier. */
export const name = 'plugin-rlm-memory'
/** Services this plugin requires at activation. */
export const inject = ['subagents', 'commands', 'tools']

/** Capture timing mode (REME.md §9 `captureMode`). */
export type CaptureMode = 'off' | 'sessionEnd' | 'intervalTurns'
/** Privacy filter tier (REME.md §9 `privacyFilter`, mirrors moa's three tiers). */
export type PrivacyFilter = '' | 'display' | 'full'
/** Recall mode (REME.md §9, §12 open question 1). Phase B ships `'keyword'` only. */
export type RecallMode = 'keyword' | 'auto'
/** Embedding provider selection (REME.md §12.1 Phase E). */
export type EmbeddingProviderMode = 'off' | 'external'

/** Plugin configuration: where to store memory and how aggressively to capture/recall. */
export interface Config {
  /** Memory root; defaults to `~/.dsh/rlm/memory`. Subdirs created on first capture. */
  memoryDir?: string
  /** When to capture: `off`, `sessionEnd` (default), or `intervalTurns`. */
  captureMode?: CaptureMode
  /** Turn interval for `intervalTurns` mode (default 16). */
  captureIntervalTurns?: number
  /** Only capture root (non-subagent) sessions (default true, REME.md §5.1 D5). */
  rootAgentsOnly?: boolean
  /** `''` (off), `'display'`, or `'full'` credential/PII masking before the dialog lands. */
  privacyFilter?: PrivacyFilter
  /** Default top-K for `memory_search` (default 5, REME.md §9/§10 Phase B acceptance). */
  recallTopK?: number
  /** Recall mode: `'keyword'` (default) or `'auto'`. Phase B has no embeddings seam, */
  recallMode?: RecallMode
  /** Guidance/UI language for the session-start hint: `'en'` (default) or `'zh'`. */
  language?: string
  /**
   * Publish-gate mode (REME.md §5.3 D10, default `'observe'`): `off` no-op,
   * `observe` promote+flag, `enforce` promote only evidence-valid drafts.
   */
  gateMode?: GateMode
  /** Growth budget: max published notes before promotion is skipped/rejected (default 200, REME.md §5.3 D2). */
  maxPublishedNotes?: number
  /** Growth budget: max total bytes across `published/` (default 5_000_000, REME.md §5.3 D2). */
  maxPublishedBytes?: number
  /**
   * Retirement exit mode (REME.md §5.4 D12 / §9 `exitMode`, default `'off'`):
   * conservative — nothing retires unless enabled. `off` no-op; `observe` logs
   * intent but does not move; `enforce` moves `published/` → `archived/` (reversible).
   */
  exitMode?: ExitMode
  /**
   * Aging scan minimum age in days before a note can be a retire candidate
   * (default 180, REME.md §5.4/§9 — deliberately high so normal use never triggers).
   */
  agingMinAgeDays?: number
  /** Aging scan minimum `use_count` to stay safe (default 1, REME.md §5.4/§9 — a note used even once is never retired). */
  agingMinUseCount?: number
  /**
   * Embedding provider (REME.md §12.1 Phase E). `off` (default) keeps lexical-only
   * recall; `external` enables the OpenAI-compatible `ExternalEmbeddingProvider` (vector
   * + lexical hybrid recall). A dsh-native seam, when available, is a future provider on
   * the same `EmbeddingService` interface (no consumer change).
   */
  embeddingsProvider?: EmbeddingProviderMode
  /** External embeddings base URL, e.g. `https://api.openai.com/v1` (OpenAI-compatible). */
  embeddingsBaseURL?: string
  /** External embeddings API key; never committed. Falls back to `embeddingsApiKeyEnv`. */
  embeddingsApiKey?: string
  /** Env var to read the API key from when `embeddingsApiKey` is empty (e.g. `DEEPSEEK_API_KEY`). */
  embeddingsApiKeyEnv?: string
  /** External embeddings model id, e.g. `text-embedding-3-small`. */
  embeddingsModel?: string
  /** Optional fixed embedding dimension; inferred from the first response when omitted. */
  embeddingsDim?: number
  /** Max texts per embeddings request (batching); default 32. */
  embeddingsBatchSize?: number
  /** Wall-clock budget per embeddings HTTP request (default 30_000); expiry degrades recall to lexical. */
  embeddingsTimeoutMs?: number
  /** Wall-clock budget for the capture extraction child (default 120_000); expiry lands the dialog without drafts. */
  captureTimeoutMs?: number
}

/** Schemastery schema validating {@link Config} at plugin load. */
export const Config: z<Config> = z.object({
  memoryDir: z.string(),
  captureMode: z.union(['off', 'sessionEnd', 'intervalTurns'] as const),
  captureIntervalTurns: z.natural(),
  rootAgentsOnly: z.boolean(),
  privacyFilter: z.union(['', 'display', 'full'] as const),
  recallTopK: z.natural(),
  recallMode: z.union(['keyword', 'auto'] as const),
  language: z.string(),
  gateMode: z.union(['off', 'observe', 'enforce'] as const),
  maxPublishedNotes: z.natural(),
  maxPublishedBytes: z.natural(),
  exitMode: z.union(['off', 'observe', 'enforce'] as const),
  agingMinAgeDays: z.natural(),
  agingMinUseCount: z.natural(),
  embeddingsProvider: z.union(['off', 'external'] as const),
  embeddingsBaseURL: z.string(),
  embeddingsApiKey: z.string(),
  embeddingsApiKeyEnv: z.string(),
  embeddingsModel: z.string(),
  embeddingsDim: z.natural(),
  embeddingsBatchSize: z.natural(),
  embeddingsTimeoutMs: z.natural(),
  captureTimeoutMs: z.natural(),
})

/**
 * Resolve the configured memory directory, expanding a leading `~`. Defaults to
 * `~/.dsh/rlm/memory` (REME.md §4 open question 2: dataDir default, project-dir
 * form deferred). Explicit default resolution in `apply`, not a hidden `??`.
 * @param memoryDir - the raw config value (may be empty/undefined).
 * @returns an absolute filesystem path.
 */
function resolveMemoryDir(memoryDir: string | undefined): string {
  const raw = memoryDir && memoryDir.trim().length > 0 ? memoryDir : join(homedir(), '.dsh', 'rlm', 'memory')
  if (raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\')) {
    return `${homedir()}${raw.slice(1)}`
  }
  return raw
}

/**
 * Activates the plugin: subscribes to the session bus to accumulate turns,
 * flushes+sanitizes+extracts on `session/disposed` (or at intervals), registers
 * `/memory`, registers the Phase B `memory_search` tool, and injects a hints-only
 * guidance message on `agent/session-start`.
 * @param ctx - Cordis context providing subagent, command, and session services.
 * @param config - the resolved plugin configuration.
 * @returns void
 */
export function apply(ctx: Context, config: Config): void {
  const memoryDir = resolveMemoryDir(config.memoryDir)
  const captureMode = config.captureMode || 'sessionEnd'
  const captureIntervalTurns = config.captureIntervalTurns && config.captureIntervalTurns > 0 ? config.captureIntervalTurns : 16
  const rootAgentsOnly = config.rootAgentsOnly !== false
  // Privacy tiers mirror moa's: '' off, 'display' provenance labels, 'full' masks
  // credential/PII material before the dialog lands. Phase A applies 'full' as a
  // best-effort redaction pass over captured text (REME.md §5.1: privacy before
  // landing); 'display' is accepted but behaves like '' until a display surface
  // consumes it (no display surface in Phase A).
  const privacyFilter: PrivacyFilter = config.privacyFilter === 'display' || config.privacyFilter === 'full' ? config.privacyFilter : ''
  // Recall tunables (REME.md §9): explicit default resolution, no hidden `??`.
  const recallTopK = config.recallTopK && config.recallTopK > 0 ? config.recallTopK : 5
  const recallMode: RecallMode = config.recallMode === 'auto' ? 'auto' : 'keyword'
  // Phase C publish gate (REME.md §5.3 D10): explicit default resolution, no hidden `??`.
  const gateMode: GateMode = config.gateMode === 'off' || config.gateMode === 'enforce' ? config.gateMode : 'observe'
  // Phase C growth budget (REME.md §5.3 D2): explicit defaults 200 notes / 5_000_000 bytes.
  const maxPublishedNotes = config.maxPublishedNotes && config.maxPublishedNotes > 0 ? config.maxPublishedNotes : 200
  const maxPublishedBytes = config.maxPublishedBytes && config.maxPublishedBytes > 0 ? config.maxPublishedBytes : 5_000_000
  // Phase D retirement exit mode (REME.md §5.4 D12): default `off` (conservative — nothing
  // retires unless the deployer explicitly enables observe/enforce). Explicit default
  // resolution, no hidden `??`.
  const exitMode: ExitMode = config.exitMode === 'observe' || config.exitMode === 'enforce' ? config.exitMode : 'off'
  // Phase D conservative global thresholds (REME.md §5.4/§9 "global 阈值更保守"): 180 days
  // and use_count >= 1 — normal use never triggers retirement. Explicit defaults, no `??`.
  const agingMinAgeDays = config.agingMinAgeDays && config.agingMinAgeDays > 0 ? config.agingMinAgeDays : 180
  const agingMinUseCount = config.agingMinUseCount && config.agingMinUseCount > 0 ? config.agingMinUseCount : 1
  // External-call wall-clock budgets (T7.3): embeddings ride the synchronous
  // memory_search path, capture spawns a child — neither may hang unbounded.
  const embeddingsTimeoutMs = config.embeddingsTimeoutMs && config.embeddingsTimeoutMs > 0 ? config.embeddingsTimeoutMs : 30_000
  const captureTimeoutMs = config.captureTimeoutMs && config.captureTimeoutMs > 0 ? config.captureTimeoutMs : 120_000
  // Phase E embedding seam (REME.md §12.1): explicit default `off`, no hidden `??`.
  // When `external`, build the OpenAI-compatible provider; fail loud if the required
  // base URL / model / key are missing (misconfiguration fails loud, never silently
  // degrades to lexical).
  const embeddingsProvider: EmbeddingProviderMode = config.embeddingsProvider === 'external' ? 'external' : 'off'
  let embeddingService: EmbeddingService | undefined
  if (embeddingsProvider === 'external') {
    const baseURL = config.embeddingsBaseURL
    const model = config.embeddingsModel
    const apiKey = config.embeddingsApiKey
      || (config.embeddingsApiKeyEnv ? process.env[config.embeddingsApiKeyEnv] : undefined)
    if (!baseURL || !model || !apiKey) {
      throw new Error(
        '[plugin-rlm-memory] embeddingsProvider "external" requires embeddingsBaseURL, '
        + 'embeddingsModel, and an api key (embeddingsApiKey or embeddingsApiKeyEnv)',
      )
    }
    embeddingService = createExternalEmbeddingProvider({
      baseURL,
      apiKey,
      model,
      ...(config.embeddingsDim !== undefined ? { dim: config.embeddingsDim } : {}),
      ...(config.embeddingsBatchSize !== undefined ? { batchSize: config.embeddingsBatchSize } : {}),
      timeoutMs: embeddingsTimeoutMs,
    })
  }
  // REME.md §12 open question 1: dsh has no embeddings API. `recallMode: 'auto'` is
  // accepted; when an embedding seam IS configured (`external`), hybrid recall runs and
  // no downgrade is logged. Otherwise fall back to keyword and log once.
  if (recallMode === 'auto' && !embeddingService) {
    ctx.logger?.warn?.('[plugin-rlm-memory] recallMode "auto" requested but no embeddings seam configured (embeddingsProvider !== "external"); falling back to keyword recall')
  }

  ensureMemoryDirs(memoryDir)

  // Phase C mailbox wiring (docs 仓 ARCHITECTURE.md §9): the store is a soft
  // dependency — absent (no plugin-rlm-store mounted), every mailbox surface
  // degrades to the legacy direct-file behavior and a warning names it once.
  // Present, the projection watcher reconciles human edits into the stream
  // for the process lifetime (unref'd: it must never hold a CLI exit open).
  const store: RlmStore | undefined = ctx.get('rlm.store')
  if (!store) {
    ctx.logger?.warn?.('[plugin-rlm-memory] rlm.store service absent — mailbox publishing, pickup, and the human-revision channel are dormant (mount @deepseek-ai/dsh-plugin-rlm-store before this plugin)')
  } else {
    const watcher = watchMailboxProjection(store, memoryDir)
    watcher?.unref()
  }

  // In-memory per-session turn buffer. REME.md §12 / known limitation: this is an
  // in-process accumulation keyed by session id; a host restart mid-session loses
  // the buffered turns. The durable artifact is the dialog jsonl, written on
  // flush. Clear extension point: a persistence-backed buffer (Phase B/C).
  const buffers = new Map<string, CaptureBufferEntry>()
  // Per-session message counter, used by `intervalTurns` mode to trigger flushes.
  const counts = new Map<string, number>()

  // Real Agent per session (NOT just the Session): the extraction subagent needs
  // a valid `parent`, and the spawn driver dereferences `parent.ctx` (REME.md §5.1
  // D6 extraction). A `Session` cast as `Agent` has no `.ctx`, so every extraction
  // would throw and silently land zero drafts. Borrow the `agent/session-start`
  // capture pattern from plugin-rlm-loop / plugin-rlm-moa.
  const agentsBySession = new Map<string, Agent>()
  ctx.on('agent/session-start', ({ agent }) => {
    agentsBySession.set(String(agent.session.id), agent)
    // Phase B guidance injection (REME.md §6 D13): a hints-only plugin-instructions
    // message pointing the model at `memory_search`. It must NOT dump note contents
    // (hints-only discipline, prime 6/180/6000). Two-channel recall: the harness
    // time-index overview stays the "what was recently memorized" channel; this tool
    // is the "what is relevant now" channel. Inject path mirrors the ReMe dsh plugin.
    agent.inject(createUserMessage({
      content: [{ type: 'text', text: memoryGuidance(config.language === 'zh' ? 'zh' : 'en') }],
      source: { kind: 'plugin', plugin: name, form: 'instructions' },
    }))
    // Phase C continuation pickup (r9 §9): legacy notes are absorbed, mailbox
    // nominations join this session as PROVISIONAL beliefs, and the projection
    // re-renders. The result is injected as a short hints-only notice — never
    // belief contents (the memory_search tool is the recall channel).
    const sessionStore: RlmStore | undefined = ctx.get('rlm.store')
    if (sessionStore && agent.session?.id !== undefined) {
      const scope: RlmScope = { kind: 'session', id: String(agent.session.id) }
      void bootstrapMailboxForSession(sessionStore, memoryDir, scope, config.language === 'zh' ? 'zh' : 'en')
        .then((hint) => {
          if (hint !== '') {
            agent.inject(createUserMessage({
              content: [{ type: 'text', text: hint }],
              source: { kind: 'plugin', plugin: name, form: 'instructions' },
            }))
          }
        })
        .catch((error) => {
          ctx.logger.warn(`[rlm-memory] mailbox pickup failed for session ${String(agent.session.id)}: ${error instanceof Error ? error.message : String(error)}`)
        })
    }
  })

  // Phase B: register the `memory_search` tool as an effect so disposal removes it.
  // The tool searches only `published/` and updates the §8 D4 use-signal per hit.
  // Borrow the `ctx.effect(() => ctx.tools.register(...))` registration idiom from
  // plugin-rlm-loop/loop-tool.ts.
  ctx.effect(
    () => ctx.tools.register(createMemorySearchTool({
      memoryDir,
      recallTopK,
      ...(embeddingService ? { embeddingService } : {}),
    })),
    'register memory_search tool',
  )

  // Safety cap so a pathological session cannot grow the capture buffer without bound
  // (the dialog is best-effort; exceeding it drops the oldest turns, REME.md §3 D2, T6.19).
  const MAX_CAPTURE_TURNS = 10000

  /** Append one turn to a session's buffer, applying the privacy pass when on. */
  const bufferTurn = (sessionId: string, turn: CaptureTurn): void => {
    let entry = buffers.get(sessionId)
    if (!entry) {
      entry = { sessionId, turns: [] }
      buffers.set(sessionId, entry)
    }
    entry.turns.push(applyPrivacy(turn, privacyFilter))
    if (entry.turns.length > MAX_CAPTURE_TURNS) entry.turns.shift()
  }

  /** Whether a session is eligible for capture under rootAgentsOnly. */
  const eligible = (session: Session): boolean => !(rootAgentsOnly && session.header.parentSession !== undefined)

  // Accumulate user/model/tool messages per session from the single bus emit.
  // Capture input is taken from COMPLETED sessions (REME.md §3 D2: boundary =
  // completed conversation, mirroring QwenPaw auto_memory); we buffer here and
  // flush on `session/disposed`, matching ReMe `runtime.capture` but host-owned.
  // Phase 8 (review round 6): one in-flight interval capture per session — the
  // old code could start a second runCapture on the same buffer entry while the
  // first was still extracting (a slow extraction spanning the next %N trigger),
  // double-extracting and double-appending the window.
  const intervalCapturesInFlight = new Set<string>()
  // Phase 10: sessions disposed while their interval capture is in flight.
  // `persistCapture` appends the sanitized window to the cumulative stored
  // dialog, so a second concurrent runCapture on the same entry would append
  // the same window twice (duplicate rows, shifted `turn:N` references). A
  // disposed session receives no further turns, so the in-flight capture —
  // which reads `entry.turns` at persist time — already covers the whole
  // window; the disposed handler just marks the session and lets that
  // capture's `finally` drop the buffer.
  const disposeFlushPending = new Set<string>()
  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    if (captureMode === 'off') return
    if (!eligible(session)) return
    const turn = turnFromEvent(event)
    if (turn === null) return
    const id = String(session.id)
    bufferTurn(id, turn)
    if (captureMode === 'intervalTurns') {
      const seen = (counts.get(id) ?? 0) + 1
      counts.set(id, seen)
      if (seen % captureIntervalTurns === 0 && !intervalCapturesInFlight.has(id)) {
        const entry = buffers.get(id)
        if (entry) {
          const agent = agentsBySession.get(id) ?? (session as unknown as Agent)
          intervalCapturesInFlight.add(id)
          void runCapture(ctx, memoryDir, entry, agent, captureTimeoutMs)
            .catch((error) => {
              ctx.logger.warn(`[rlm-memory] interval capture failed for ${id}: ${error instanceof Error ? error.message : String(error)}`)
            })
            .finally(() => {
              intervalCapturesInFlight.delete(id)
              // The window is persisted; drop it only now so turns arriving
              // during the extraction were covered by the (cumulative) capture
              // and the next %N trigger starts from a clean buffer. A
              // pending-dispose session has no such turns (disposed sessions
              // emit nothing), so dropping the buffer here IS its final flush.
              buffers.delete(id)
              disposeFlushPending.delete(id)
            })
        }
      }
    }
  })

  // Flush on disposal: sanitize, persist dialog, extract, gate, emit event.
  ctx.on('session/disposed', (session: Session) => {
    const id = String(session.id)
    // The Agent-per-session registry is a lifecycle map, not a capture cache:
    // every disposed session releases its Agent unconditionally, whatever the
    // capture mode / eligibility / buffer state. (T6.11 reopened — three early
    // returns used to skip this delete and leak child-session Agents.)
    const agent = agentsBySession.get(id)
    agentsBySession.delete(id)
    if (captureMode === 'off') return
    if (!eligible(session)) return
    counts.delete(id)
    // Phase 10: dispose during an in-flight interval capture must NOT start a
    // second runCapture on the same entry — both would append the same window
    // to the cumulative dialog. The in-flight capture reads `entry.turns` at
    // persist time and no further turns can arrive, so it already covers the
    // whole window; its `finally` drops the buffer for us.
    if (intervalCapturesInFlight.has(id)) {
      disposeFlushPending.add(id)
      return
    }
    const entry = buffers.get(id)
    if (!entry) return
    buffers.delete(id)
    void runCapture(ctx, memoryDir, entry, agent ?? (session as unknown as Agent), captureTimeoutMs).catch((error) => {
      ctx.logger.warn(`[rlm-memory] capture on dispose failed for ${id}: ${error instanceof Error ? error.message : String(error)}`)
    })
  })

  // `/memory list|show|delete` — drafts-only delete (Phase C owns published).
  ctx.effect(
    () =>
      ctx.commands.register({
        name: 'memory',
        description: 'Cross-session memory: /memory list | /memory show <name> | /memory delete <name> | /memory consolidate | /memory rollback <noteId> [force] | /memory retire <noteId> [force] | /memory archived | /memory unretire <noteId> | /memory stats | /memory criteria list|propose|approve',
        input: { hint: 'list | show <name> | delete <name> | consolidate | rollback <noteId> [force] | retire <noteId> [force] | archived | unretire <noteId> | stats | criteria list | criteria propose <id> <tier> <title> | criteria approve <id> <tier> <title>' },
        handler: (invocation: CommandInvocation) => {
          const [subcommand, ...rest] = invocation.rawInput.trim().split(/\s+/)
          const arg = rest.join(' ')
          switch (subcommand ?? 'list') {
            case 'list':
              return { kind: 'success' as const, text: listMemoryText(memoryDir) }
            case 'show':
              if (!arg) return { kind: 'error' as const, text: 'Usage: /memory show <name>' }
              return { kind: 'success' as const, text: showMemoryText(memoryDir, arg) }
            case 'delete':
              if (!arg) return { kind: 'error' as const, text: 'Usage: /memory delete <name>' }
              return { kind: 'success' as const, text: deleteMemoryText(memoryDir, arg) }
            case 'consolidate': {
              // Phase C promotion (REME.md §5.3): publish gate + growth budget; with the
              // store mounted, promotions land in the mailbox and published/ re-renders.
              const cmdStore: RlmStore | undefined = ctx.get('rlm.store')
              const sessionId = String(invocation.agent.session.id)
              const opts = {
                gateMode,
                maxPublishedNotes,
                maxPublishedBytes,
                ...(embeddingService ? { embeddingService } : {}),
                ...(cmdStore
                  ? { store: cmdStore, sessionScope: { kind: 'session' as const, id: sessionId }, sessionId }
                  : {}),
              }
              return consolidateText(memoryDir, opts).then(({ text }) => ({ kind: 'success' as const, text }))
            }
            case 'rollback': {
              if (!arg) return { kind: 'error' as const, text: 'Usage: /memory rollback <noteId> [force]' }
              const force = /^force$/i.test(rest[rest.length - 1] ?? '')
              const noteId = force ? rest.slice(0, -1).join(' ').trim() : arg
              return rollbackText(memoryDir, noteId, force).then(text => ({ kind: 'success' as const, text }))
            }
            case 'retire': {
              // Phase D retirement (REME.md §5.4): respects exitMode; `force` bypasses the age/use threshold (explicit user retire).
              if (!arg) return { kind: 'error' as const, text: 'Usage: /memory retire <noteId> [force]' }
              const force = /^force$/i.test(rest[rest.length - 1] ?? '')
              const noteId = force ? rest.slice(0, -1).join(' ').trim() : arg
              const opts = { exitMode, agingMinAgeDays, agingMinUseCount }
              return retireText(memoryDir, noteId, force, opts).then(text => ({ kind: 'success' as const, text }))
            }
            case 'archived': {
              // Phase D: list retired notes under archive/ (REME.md §5.4 D12).
              return { kind: 'success' as const, text: archivedText(memoryDir) }
            }
            case 'unretire': {
              if (!arg) return { kind: 'error' as const, text: 'Usage: /memory unretire <noteId>' }
              return unretireText(memoryDir, arg).then(text => ({ kind: 'success' as const, text }))
            }
            case 'stats': {
              // The observe audit surface (BUILD.md 实测窗口): density rhythm
              // vs threshold, ⑥ nomination dispositions (full history),
              // freshness enforce-would-demote snapshot, mailbox numbers.
              const cmdStore: RlmStore | undefined = ctx.get('rlm.store')
              if (!cmdStore) {
                return { kind: 'error' as const, text: '/memory stats needs the rlm.store service (mount @deepseek-ai/dsh-plugin-rlm-store)' }
              }
              return observeReport(cmdStore.rootDir).then(report => ({ kind: 'success' as const, text: renderObserveReport(report) }))
            }
            case 'criteria': {
              // Phase C criterion-revision track (r9 §7): list / propose / approve.
              // The approval power is human-only — propose parks the revision in the
              // mailbox; approve is a deliberate human act through this command.
              const cmdStore: RlmStore | undefined = ctx.get('rlm.store')
              if (!cmdStore) {
                return { kind: 'error' as const, text: '/memory criteria needs the rlm.store service (mount @deepseek-ai/dsh-plugin-rlm-store)' }
              }
              const action = rest[0] ?? 'list'
              if (action === 'list') {
                const registered = new Set(cmdStore.listCriteria().map(c => c.id))
                const lines = cmdStore.listCriteria().map(c => `${c.id} [${c.tier}] ${c.title}`)
                const pending = cmdStore.beliefs(MAILBOX_SCOPE)
                  .filter((b): b is typeof b & { subject: string } =>
                    typeof b.subject === 'string'
                    && b.subject.startsWith('criterion:')
                    && !registered.has(b.subject.slice('criterion:'.length)))
                for (const p of pending) {
                  lines.push(`PENDING ${p.subject} (proposed in the mailbox, awaiting human approval)`)
                }
                return { kind: 'success' as const, text: lines.length > 0 ? lines.join('\n') : 'No criteria registered.' }
              }
              if (action === 'propose' || action === 'approve') {
                const id = rest[1]
                const tier = rest[2]
                const title = rest.slice(3).join(' ').trim()
                if (!id || !tier || title === '') {
                  return { kind: 'error' as const, text: `Usage: /memory criteria ${action} <id> <tier> <title...> (tier: ${RLM_CRITERION_TIERS.join('|')})` }
                }
                if (!RLM_CRITERION_TIERS.includes(tier as (typeof RLM_CRITERION_TIERS)[number])) {
                  return { kind: 'error' as const, text: `Unknown tier "${tier}" (expected one of ${RLM_CRITERION_TIERS.join('|')})` }
                }
                const scope: RlmScope = { kind: 'session', id: String(invocation.agent.session.id) }
                const tierLit = tier as RlmCriterionTier
                const run = async (): Promise<string> => {
                  if (action === 'propose') {
                    await proposeCriterion(cmdStore, scope, { id, tier: tierLit, title, reason: title })
                    return criteriaActionText('propose', id, tier, title)
                  }
                  await approveCriterion(cmdStore, { id, tier: tierLit, title, reason: 'approved via /memory criteria approve' })
                  return criteriaActionText('approve', id, tier, title)
                }
                return run().then(text => ({ kind: 'success' as const, text }))
              }
              return { kind: 'error' as const, text: `Unknown /memory criteria action "${action}" (list|propose|approve)` }
            }
            default:
              return { kind: 'error' as const, text: `Unknown /memory subcommand "${subcommand}" (list|show|delete|consolidate|rollback|retire|archived|unretire|stats|criteria)` }
          }
        },
      }),
    'register /memory command',
  )
}

/**
 * Run one capture: extract drafts via a host-owned subagent, persist the dialog,
 * land admission-gated drafts, and emit the audit event. Best-effort: the dialog
 * jsonl is written even when extraction fails or returns nothing. An extraction
 * failure is logged and audited as `extractionRan: false` — never silently
 * swallowed, never read as "nothing to extract".
 * @param ctx - Cordis context carrying the subagent runtime.
 * @param memoryDir - resolved memory root.
 * @param entry - the accumulated capture buffer entry.
 * @param agent - the captured session's owning Agent (extraction parent).
 * @param captureTimeoutMs - wall-clock budget for the extraction child.
 */
async function runCapture(
  ctx: Context,
  memoryDir: string,
  entry: CaptureBufferEntry,
  agent: Agent,
  captureTimeoutMs: number,
): Promise<void> {
  const subagents = ctx.get('subagents') as SubagentRuntime | undefined
  let proposals: Note[] = []
  let extractionRan = false
  if (subagents) {
    const { renderDialogText, sanitizeTurns } = await import('./sanitize.ts')
    // Phase 8 (review round 6): the extractor sees the CUMULATIVE stored dialog
    // plus this window — matching the cumulative file persistCapture writes, so
    // `turn:N` evidence references stay aligned under intervalTurns capture.
    const priorTurns = readDialog(memoryDir, entry.sessionId)
    const windowTurns = sanitizeTurns(entry.turns)
    const dialogText = renderDialogText([...priorTurns, ...windowTurns])
    try {
      // Accepted limitation: the controller is created solely to satisfy the
      // `signal` parameter — there is no external handle to cancel an
      // extraction. The wall-clock budget inside `extractDrafts` is the real
      // bound; wiring a plugin-lifetime controller awaits a host teardown
      // seam (NEXT: 登记为已接受限制).
      proposals = await extractDrafts(subagents, agent, entry.sessionId, dialogText, new AbortController().signal, captureTimeoutMs)
      extractionRan = true
    } catch (error) {
      ctx.logger.warn(`[rlm-memory] capture extraction failed for ${entry.sessionId}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const summary = persistCapture(memoryDir, entry, proposals)
  emitMemoryCapturedEvent(agent.session ?? null, {
    sessionId: entry.sessionId,
    dialogTurns: summary.dialogTurns,
    draftsAdmitted: summary.draftsAdmitted,
    extractionRan,
    draftChars: summary.draftChars,
  })
}

/**
 * Render the `/memory criteria propose|approve` outcome text (module-level so
 * the command handler stays free of deep-chained continuations).
 */
function criteriaActionText(action: 'propose' | 'approve', id: string, tier: string, title: string): string {
  if (action === 'propose') {
    return [
      `Criterion revision proposed: ${id} [${tier}] (${title}).`,
      'Parked in the mailbox for human approval.',
      `Approve with: /memory criteria approve ${id} ${tier} ${title}`,
    ].join(' ')
  }
  return [
    `Criterion approved and registered: ${id} [${tier}] (${title}).`,
    'The approval is recorded in the mailbox stream.',
  ].join(' ')
}

/**
 * Phase C session bootstrap (r9 §9 continuation): absorb legacy published
 * notes, pick up mailbox nominations as PROVISIONAL beliefs in the arriving
 * session, and re-render the projection. Returns a short hints-only notice
 * describing WHAT was picked up (subjects and conflict flags — never belief
 * contents) for injection at session start; empty when there is nothing to
 * pick up.
 * @param store - the unified store (mailbox authority).
 * @param memoryDir - resolved memory root (projection + legacy source).
 * @param scope - the arriving session's store scope.
 * @param lang - `'zh'` or `'en'` for the notice wording.
 * @returns the hints-only notice, or '' when nothing changed.
 */
async function bootstrapMailboxForSession(
  store: RlmStore,
  memoryDir: string,
  scope: RlmScope,
  lang: 'zh' | 'en',
): Promise<string> {
  const imported = await importLegacyNotes(store, memoryDir)
  const pickup = await pickupMailboxSeeds(store, scope)
  await syncMailboxProjection(store, memoryDir)
  if (pickup.picked === 0 && imported === 0) return ''
  const lines: string[] = []
  if (lang === 'zh') {
    lines.push(`[信箱] 跨会话接续：取件 ${String(pickup.picked)} 条提名（均为 provisional 信念，复验后才可信任）。`)
    if (pickup.conflicts.length > 0) {
      lines.push(`冲突集：${pickup.conflicts.join('、')} —— 同一主题存在多个竞争版本，须显式裁决后再使用。`)
    }
    if (imported > 0) lines.push(`旧记忆笔记已收编入信箱事件流：${String(imported)} 篇。`)
  } else {
    lines.push(`[mailbox] Cross-session continuation: picked up ${String(pickup.picked)} nomination(s) — all PROVISIONAL beliefs, re-verify before trusting.`)
    if (pickup.conflicts.length > 0) {
      lines.push(`Conflict sets: ${pickup.conflicts.join(', ')} — multiple competing versions of one subject; resolve explicitly before use.`)
    }
    if (imported > 0) lines.push(`${String(imported)} legacy note(s) absorbed into the mailbox stream.`)
  }
  return lines.join('\n')
}

/**
 * Apply the configured privacy pass to one buffered turn. `''`/`'display'` return
 * the text unchanged in Phase A; `'full'` masks credential/PII-shaped material so
 * it never lands in the dialog jsonl (REME.md §5.1 privacy).
 * @param turn - the turn to redact.
 * @param filter - the active privacy tier.
 * @returns a copy of the turn with redacted content when filter is `'full'`.
 */
function applyPrivacy(turn: CaptureTurn, filter: PrivacyFilter): CaptureTurn {
  if (filter !== 'full') return turn
  // Minimal credential/PII masking: sk-, pk-, Bearer/API tokens and email shapes.
  const redacted = turn.content
    .replace(/(sk-[A-Za-z0-9_-]{8,}|pk-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._-]+|AKIA[0-9A-Z]{16})/g, '[REDACTED:secret]')
    .replace(/([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z]{2,})/g, '[REDACTED:email]')
  return { ...turn, content: redacted }
}

/**
 * Extract a capture turn from one session event. Returns null for non-message
 * events (turn/step boundaries, chunks, request headers). Tool results are kept
 * as `role: 'tool'` turns so the sanitizer can drop them (REME.md §5.1 D5).
 * @param event - the session event from the `session/event` bus.
 * @returns a capture turn, or null when the event carries no capturable message.
 */
function turnFromEvent(event: SessionEvent): CaptureTurn | null {
  const type = event.type
  if (type === 'user/message') {
    const data = event.data as { content?: unknown }
    return { role: 'user', content: contentToText(data.content) }
  }
  if (type === 'assistant/message') {
    const data = event.data as { message?: { content?: unknown } }
    return { role: 'assistant', content: contentToText(data.message?.content) }
  }
  if (type === 'tool/result') {
    const data = event.data as { message?: { content?: unknown }; name?: string }
    const turn: CaptureTurn = { role: 'tool', content: contentToText(data.message?.content) }
    if (data.name !== undefined) turn.toolName = data.name
    return turn
  }
  return null
}

/**
 * Flatten a message `content` (string or `ContentBlock[]`) to plain text.
 * @param content - the message content value.
 * @returns concatenated text, or '' when absent.
 */
function contentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map(block => (block && typeof block === 'object' && 'text' in block ? String((block as { text: unknown }).text) : ''))
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

/** Re-export the event-type constant so consumers import one symbol. */
export { MEMORY_EVENT_TYPES }
