/**
 * The unified storage core (docs 仓 ARCHITECTURE.md §6, BUILD.md §1): per
 * scope one append-only event stream plus its materialized view, with the
 * judgment channel as the only belief-writing path.
 *
 * Authority model encoded here: `append` is the single write path for
 * non-judgment events; `judge` is the single write path for `rlm/judgment`
 * (calling append with that type directly is refused); the materialized state
 * file is a cache updated by the same writer that appends the event — the
 * stream is the authority, `rebuild` regenerates the view from it, and a
 * stale or missing state file is never trusted over the stream.
 *
 * Belief application is the shared reducer in `./beliefs.ts` (incremental
 * append and rebuild replay run the same code); projection consumers listen
 * via {@link RlmStore.onChange} and render their own shapes from the view —
 * the store itself stays shape-agnostic and dependency-free.
 *
 * @module @deepseek-ai/dsh-plugin-rlm-store/store
 */

import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { RlmCriterion, RlmCriterionTier, RlmEventType, RlmEventPayload, RlmVerdictForm } from './events.ts'
import { CREATING_VERDICTS, RLM_VERDICT_FORMS, TARGET_VERDICTS } from './events.ts'
import { RLM_EVENT_CATALOG, isKnownEventType } from './catalog.ts'
import type { RlmBeliefNode } from './beliefs.ts'
import { applyJudgmentToBeliefs } from './beliefs.ts'
import type { FreshnessVerdict } from './freshness.ts'
import { evaluateBeliefFreshness, closureInvariantViolations } from './freshness.ts'

/** A scope of authority: one stream + one materialized view (r9 §5). */
export type RlmScope = { kind: 'session'; id: string } | { kind: 'mailbox' }

/** Input to the judgment channel: the four requirements minus the tier, which the criteria registry supplies. */
export interface RlmJudgmentInput {
  criterionRef: string
  verdict: RlmVerdictForm
  belief?: {
    kind: 'declarative' | 'procedural'
    content: string
    title?: string
    subject?: string
    supersedes?: { id: string; reason: string }
    basedOn?: readonly string[]
    lastVerified?: { channel: string; eventPos: number; note?: string }
  }
  /** Target belief id for `demotion` / `voiding`. */
  target?: string
  dataSupport: {
    summary: string
    refs?: readonly string[]
  }
  provenance: {
    eventRange: readonly [number, number]
    versionRef?: string
  }
}

/** The materialized view of one scope: derived, cache-grade, rebuildable. */
export interface RlmMaterializedView {
  scope: RlmScope
  seq: number
  eventCount: number
  countsByType: Partial<Record<RlmEventType, number>>
  beliefs: RlmBeliefNode[]
  /**
   * All action-boundary events, in order (they are first-class and
   * low-volume by design). Projections render from these plus the beliefs.
   */
  actions: RlmEvent[]
  /** External-touch ledger, append-only (latest checkpoint per key wins on read). */
  touchLedger: RlmTouchRecord[]
  /** Conflict-surfacing nominations from trigger ⑥ (bounded to the latest 64). */
  pendingChecks: RlmConflictNomination[]
  /** Non-judgment actions since the last judgment landed (density alarm counter). */
  actionsSinceJudgment: number
}

/** The stream on disk is unreadable or violates the catalog. */
export class RlmStoreFormatError extends Error {}

/** A judgment failed one of the four formal requirements. */
export class RlmJudgmentError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Session ids become directory names; keep them boring. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

function scopeKey(scope: RlmScope): string {
  if (scope.kind === 'mailbox') return 'mailbox'
  if (!SESSION_ID_PATTERN.test(scope.id)) {
    throw new RlmStoreFormatError(`rlm-store: invalid session scope id ${JSON.stringify(scope.id)}`)
  }
  return `session/${scope.id}`
}

function emptyView(scope: RlmScope): RlmMaterializedView {
  return {
    scope,
    seq: 0,
    eventCount: 0,
    countsByType: {},
    beliefs: [],
    actions: [],
    touchLedger: [],
    pendingChecks: [],
    actionsSinceJudgment: 0,
  }
}

/**
 * Append the event's effect to a view. Shared by append (incremental) and
 * rebuild (replay) so the two can never disagree. Belief application lives in
 * the shared reducer (./beliefs.ts).
 */
/**
 * Extract touch records from a payload (`touches: [{key, checkpoint}]`) and
 * run conflict surfacing for observation events (trigger ⑥).
 */
function extractTouchesAndConflicts(view: RlmMaterializedView, event: RlmEvent): void {
  const touches = event.payload['touches']
  if (Array.isArray(touches)) {
    for (const t of touches) {
      if (
        typeof t === 'object' && t !== null && !Array.isArray(t)
        && typeof (t as Record<string, unknown>)['key'] === 'string'
        && typeof (t as Record<string, unknown>)['checkpoint'] === 'string'
      ) {
        const rec = t as { key: string; checkpoint: string }
        view.touchLedger.push({ key: rec.key, checkpoint: rec.checkpoint, seq: event.seq })
      }
    }
  }
  if (event.type !== 'rlm/observation') return
  // Trigger ⑥ hard: the observation declares a subject held by an active belief.
  const subject = event.payload['subject']
  const hardIds = typeof subject === 'string' && subject !== ''
    ? view.beliefs.filter(b => b.status === 'active' && b.subject === subject).map(b => b.id)
    : []
  if (hardIds.length > 0) {
    view.pendingChecks.push({ kind: 'hard', seq: event.seq, beliefIds: hardIds })
  }
  // Trigger ⑥ soft: lexical co-occurrence with an active belief's content
  // (observe-grade; precision is measured before any enforce upgrade).
  const content = event.payload['content']
  if (typeof content === 'string' && content.length >= 8) {
    const tokens = new Set(content.toLowerCase().split(/[\W_]+/u).filter(t => t.length >= 4))
    if (tokens.size > 0) {
      const softIds = view.beliefs
        .filter(b => b.status === 'active')
        .filter((b) => {
          const btokens = new Set(b.content.toLowerCase().split(/[\W_]+/u).filter(t => t.length >= 4))
          let overlap = 0
          for (const t of tokens) if (btokens.has(t)) overlap += 1
          return overlap >= 3
        })
        .map(b => b.id)
      if (softIds.length > 0) view.pendingChecks.push({ kind: 'soft', seq: event.seq, beliefIds: softIds })
    }
  }
  if (view.pendingChecks.length > 64) view.pendingChecks.splice(0, view.pendingChecks.length - 64)
}

/** Latest checkpoint per key — the snapshot frozen into beliefs at judgment time. */
function currentLedgerSnapshot(view: RlmMaterializedView): Record<string, string> {
  const snapshot: Record<string, string> = {}
  for (const t of view.touchLedger) snapshot[t.key] = t.checkpoint
  return snapshot
}

function applyToView(view: RlmMaterializedView, event: RlmEvent, key: string): void {
  view.seq = event.seq
  view.eventCount += 1
  view.countsByType[event.type] = (view.countsByType[event.type] ?? 0) + 1
  if (event.type === 'rlm/action-boundary') view.actions.push(event)
  if (event.type !== 'rlm/judgment') {
    // Density alarm: only judgments release the counter (r9 — the alarm
    // counts the absence of judgment, so every other event accrues it).
    view.actionsSinceJudgment += 1
    extractTouchesAndConflicts(view, event)
    // The human revision mutates beliefs through the shared reducer (the
    // semantic-exempt writer still writes the stream, not the file).
    if (event.type === 'rlm/human-revision') {
      applyJudgmentToBeliefs(view.beliefs, {
        seq: event.seq,
        time: event.time,
        scopeKey: key,
        type: event.type,
        payload: event.payload as Parameters<typeof applyJudgmentToBeliefs>[1]['payload'],
      })
    }
    return
  }
  // A judgment landed: the density counter releases.
  view.actionsSinceJudgment = 0
  const p = event.payload as { provenanceFrom?: unknown; provenanceTo?: unknown }
  applyJudgmentToBeliefs(view.beliefs, {
    seq: event.seq,
    time: event.time,
    scopeKey: key,
    provenanceFrom: typeof p.provenanceFrom === 'number' ? p.provenanceFrom : undefined,
    provenanceTo: typeof p.provenanceTo === 'number' ? p.provenanceTo : undefined,
    payload: event.payload as Parameters<typeof applyJudgmentToBeliefs>[1]['payload'],
  }, currentLedgerSnapshot(view))
}

/** The two fields writeEvent needs beyond seq/time; everything else is derived. */
interface RlmEventDraft {
  type: RlmEventType
  payload: RlmEventPayload
}

/** One appended event: the only writable primitive of a scope. */
export interface RlmEvent {
  seq: number
  type: RlmEventType
  time: string
  payload: RlmEventPayload
}

/** Callback fired after a scope's view changed and its state cache was persisted. */
export type RlmStoreListener = (scope: RlmScope, view: RlmMaterializedView) => void

export interface RlmStoreOptions {
  /** Internal freshness clock: verification-to-head event distance. Default 256. */
  internalClockDistance?: number
  /** Judgment-density alarm: non-judgment actions before the alarm locks promotion. Default 50. */
  densityAlarmActions?: number
}

/** One external-touch record: an observed object, its checkpoint, and when. */
export interface RlmTouchRecord {
  key: string
  checkpoint: string
  seq: number
}

/** One conflict-surfacing nomination (trigger ⑥). */
export interface RlmConflictNomination {
  kind: 'hard' | 'soft'
  /** The observation stream position that raised it. */
  seq: number
  /** Belief ids whose subject or content co-occurs with the observation. */
  beliefIds: string[]
}

/** Per-scope judgment-density alarm state. */
export interface RlmAlarmState {
  active: boolean
  actionsSinceJudgment: number
  /** Times the escalation threshold was crossed and the inspection chain warned. */
  escalations: number
}

/** A replayed ⑥ nomination with the triggering observation's wall-clock. */
export type TimedNomination = RlmConflictNomination & { time: string }

export class RlmStore {
  private readonly views = new Map<string, RlmMaterializedView>()
  private readonly criteria = new Map<string, { tier: RlmCriterionTier; title: string }>()
  private readonly listeners: RlmStoreListener[] = []
  private readonly options: Required<RlmStoreOptions>
  /**
   * Escalation warnings issued per scope, PROCESS-local by design: throttle
   * state is not stream content (the view must stay fully replayable), and a
   * restart re-firing the warning is the honest behavior.
   */
  private readonly escalationCounts = new Map<string, number>()
  /** Per-scope write serialization: seq assignment and the stream append must never interleave. */
  private readonly writeChains = new Map<string, Promise<void>>()

  /**
   * @param rootDir - directory holding every scope stream (`<dataDir>/store`).
   * @param options - escort-mechanism tunables (thresholds are implementation-layer numbers).
   */
  constructor(readonly rootDir: string, options: RlmStoreOptions = {}) {
    this.options = {
      internalClockDistance: options.internalClockDistance ?? 256,
      densityAlarmActions: options.densityAlarmActions ?? 50,
    }
  }

  /**
   * Register a criterion the judgment channel may reference. Unregistered
   * criterion references fail judge() — criteria exist only if seeded.
   * @param criterion - the criterion to admit.
   * @returns void
   */
  registerCriterion(criterion: RlmCriterion): void {
    this.criteria.set(criterion.id, { tier: criterion.tier, title: criterion.title })
  }

  /**
   * The registered criteria, for audit surfaces (`/memory criteria list`,
   * Phase D review): id, tier, title in registration order.
   * @returns the registered criteria.
   */
  listCriteria(): Array<{ id: string; tier: RlmCriterionTier; title: string }> {
    return [...this.criteria.entries()].map(([id, c]) => ({ id, tier: c.tier, title: c.title }))
  }

  /**
   * Subscribe to view changes. Listeners fire after every successful
   * append/judge/rebuild on any scope; projections render here.
   * @param listener - the callback to register.
   * @returns an unsubscriber.
   */
  onChange(listener: RlmStoreListener): () => void {
    this.listeners.push(listener)
    return () => {
      const i = this.listeners.indexOf(listener)
      if (i >= 0) this.listeners.splice(i, 1)
    }
  }

  private streamPath(scope: RlmScope): string {
    return path.join(this.rootDir, scopeKey(scope), 'events.jsonl')
  }

  private statePath(scope: RlmScope): string {
    return path.join(this.rootDir, scopeKey(scope), 'state.json')
  }

  /**
   * The in-memory materialized view. Empty until the scope has been touched by
   * {@link ensureLoaded}, {@link append}, {@link judge} or {@link rebuild}.
   * @param scope - the scope to read.
   * @returns the current materialized view (cache-grade; rebuild is the truth).
   */
  view(scope: RlmScope): RlmMaterializedView {
    const key = scopeKey(scope)
    return this.views.get(key) ?? emptyView(scope)
  }

  /**
   * Belief nodes of a scope: the state content (r9 §4). Active nodes only.
   * @param scope - the scope to read.
   * @returns active belief nodes, in creation order.
   */
  beliefs(scope: RlmScope): RlmBeliefNode[] {
    return this.view(scope).beliefs.filter(b => b.status === 'active')
  }

  /**
   * Fetch one belief by id, including degraded/voided nodes.
   * @param scope - the scope to read.
   * @param id - the belief id.
   * @returns the node, or undefined.
   */
  getBelief(scope: RlmScope, id: string): RlmBeliefNode | undefined {
    return this.view(scope).beliefs.find(b => b.id === id)
  }

  /**
   * Load a scope's view by replaying its stream — the honest cold start.
   * @param scope - the scope to load.
   * @returns the rebuilt materialized view.
   */
  async ensureLoaded(scope: RlmScope): Promise<RlmMaterializedView> {
    return this.rebuild(scope)
  }

  /**
   * Load the scope's view if this instance has never loaded it. The
   * synchronous readers ({@link view}, {@link beliefs}) never touch the disk
   * — any read that must see what prior processes wrote has to await this
   * first (a write loads implicitly; a bare read does not).
   * @param scope - the scope to load.
   * @returns the materialized view.
   */
  async loadOnce(scope: RlmScope): Promise<RlmMaterializedView> {
    return this.ensureLoadedOnce(scope)
  }

  /** Serialize the write path per scope; callers see their own promise, the chain itself never dies on a rejection. */
  private enqueueWrite<T>(scope: RlmScope, fn: () => Promise<T>): Promise<T> {
    const key = scopeKey(scope)
    const prev = this.writeChains.get(key) ?? Promise.resolve()
    const next = prev.then(fn)
    this.writeChains.set(key, next.then(() => undefined, () => undefined))
    return next
  }

  /**
   * Append one non-judgment event: the single write path for observations,
   * mechanical records, action boundaries, handoffs, rollbacks and (mailbox)
   * human revisions. The stream line is the authority; the state file is a
   * cache written by the same writer immediately after.
   * @param scope - target scope.
   * @param type - event type; must be cataloged for the scope.
   * @param payload - event payload (must be a plain object).
   * @returns the appended event.
   */
  async append(scope: RlmScope, type: RlmEventType, payload: RlmEventPayload): Promise<RlmEvent> {
    return this.enqueueWrite(scope, () => this.appendSerialized(scope, type, payload))
  }

  /** The serialized body of {@link append}. */
  private async appendSerialized(scope: RlmScope, type: RlmEventType, payload: RlmEventPayload): Promise<RlmEvent> {
    const view = await this.ensureLoadedOnce(scope)
    if (!isKnownEventType(type)) {
      throw new RlmStoreFormatError(`rlm-store: unknown event type ${JSON.stringify(type)}`)
    }
    if (type === 'rlm/judgment') {
      throw new RlmStoreFormatError('rlm-store: judgment events must go through judge()')
    }
    if (!RLM_EVENT_CATALOG[type].scopes.includes(scope.kind)) {
      throw new RlmStoreFormatError(`rlm-store: event type ${type} is not legal in ${scope.kind} scope`)
    }
    if (!isRecord(payload)) {
      throw new RlmStoreFormatError('rlm-store: event payload must be a plain object')
    }
    return this.writeEvent(scope, view, { type, payload })
  }

  /**
   * The judgment channel: the only way an event becomes a belief. Enforces the
   * four formal requirements (r9 §7) — criterion registered and tier-consistent,
   * data support present, verdict form legal with the tier gate (open-tier
   * criteria cannot promote to evidenced), provenance locatable in the stream —
   * plus the verdict-shape rules: creating verdicts carry a `belief` payload,
   * `demotion`/`voiding` carry an existing `target` id.
   * Form only: the store never guarantees the judgment was applied well.
   * @param scope - target scope.
   * @param input - the judgment to admit.
   * @returns the appended judgment event.
   */
  async judge(scope: RlmScope, input: RlmJudgmentInput): Promise<RlmEvent> {
    return this.enqueueWrite(scope, () => this.judgeSerialized(scope, input))
  }

  /** The serialized body of {@link judge}. */
  private async judgeSerialized(scope: RlmScope, input: RlmJudgmentInput): Promise<RlmEvent> {
    const view = await this.ensureLoadedOnce(scope)
    const criterion = this.criteria.get(input.criterionRef)
    if (!criterion) {
      throw new RlmJudgmentError(`rlm-store/judgment: unregistered criterion reference ${JSON.stringify(input.criterionRef)}`)
    }
    if (!isRecord(input.dataSupport) || typeof input.dataSupport.summary !== 'string' || input.dataSupport.summary.trim() === '') {
      throw new RlmJudgmentError('rlm-store/judgment: data-support requirement failed (summary must be a non-empty string)')
    }
    if (!RLM_VERDICT_FORMS.includes(input.verdict)) {
      throw new RlmJudgmentError(`rlm-store/judgment: illegal verdict form ${JSON.stringify(input.verdict)}`)
    }
    if (input.verdict === 'promotion' && criterion.tier === 'open') {
      throw new RlmJudgmentError('rlm-store/judgment: open-tier criteria cannot promote to evidenced')
    }
    // Judgment-density alarm (r9 §8): while the alarm is active, the trust
    // gate locks evidenced promotion. Provisional-level work continues — the
    // lock is on the gate, not the engine.
    const view0 = view
    if (
      input.verdict === 'promotion'
      && view0.actionsSinceJudgment >= this.options.densityAlarmActions
    ) {
      throw new RlmJudgmentError(
        `rlm-store/judgment: promotion locked by the judgment-density alarm (${view0.actionsSinceJudgment} actions since the last judgment; run a check judgment to release it)`,
      )
    }
    const [from, to] = input.provenance.eventRange
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || from > to || to > view.seq) {
      throw new RlmJudgmentError(`rlm-store/judgment: provenance requirement failed (event range ${JSON.stringify(input.provenance.eventRange)} is not locatable in a stream of ${view.seq} events)`)
    }
    // check-pass is the exception among creating verdicts: the verdict itself
    // must always land (density accounting counts it), with or without a
    // belief payload — a clean check with nothing new to trust is still a
    // check that happened.
    const requiresBelief = CREATING_VERDICTS.includes(input.verdict) && input.verdict !== 'check-pass'
    if (requiresBelief) {
      if (!input.belief || typeof input.belief.content !== 'string' || input.belief.content.trim() === '') {
        throw new RlmJudgmentError(`rlm-store/judgment: verdict ${input.verdict} requires a belief payload with non-empty content`)
      }
    }
    if (TARGET_VERDICTS.includes(input.verdict)) {
      const target = typeof input.target === 'string' ? this.getBelief(scope, input.target) : undefined
      if (!target) {
        throw new RlmJudgmentError(`rlm-store/judgment: verdict ${input.verdict} requires a target referencing an existing belief`)
      }
      // Phase D freeze pair transition rules (r9 §7): a freeze locks a live
      // belief's trust-gate eligibility; only a frozen belief can be released.
      if (input.verdict === 'freeze' && (target.status === 'voided' || target.status === 'frozen')) {
        throw new RlmJudgmentError(`rlm-store/judgment: freeze requires a live target (belief ${target.id} is ${target.status})`)
      }
      if (input.verdict === 'unfreeze' && target.status !== 'frozen') {
        throw new RlmJudgmentError(`rlm-store/judgment: unfreeze requires a frozen target (belief ${target.id} is ${target.status})`)
      }
    }
    // Phase D audit freeze lock (r9 §7 reverse-filtering): a frozen belief's
    // trust-gate eligibility is locked — no promotion, no merge — until a
    // human batch review releases it (unfreeze) or the belief is voided. The
    // lock keys on the belief id: a new node judged on its own merits is a
    // new claim, not a route around the freeze.
    if ((input.verdict === 'promotion' || input.verdict === 'merge') && input.belief) {
      const frozenById = (id: string | undefined) =>
        id === undefined ? undefined : view0.beliefs.find(b => b.id === id && b.status === 'frozen')
      const hit = frozenById(input.belief.supersedes?.id)
        ?? input.belief.basedOn?.map(id => frozenById(id)).find(node => node !== undefined)
      if (hit) {
        throw new RlmJudgmentError(
          `rlm-store/judgment: ${input.verdict} locked — belief ${hit.id} is frozen pending audit review`,
        )
      }
    }
    const payload: RlmEventPayload = {
      criterionRef: input.criterionRef,
      criterionTier: criterion.tier,
      verdict: input.verdict,
      ...(input.belief
        ? {
          belief: {
            kind: input.belief.kind,
            content: input.belief.content,
            ...(input.belief.title !== undefined ? { title: input.belief.title } : {}),
            ...(input.belief.subject !== undefined ? { subject: input.belief.subject } : {}),
            ...(input.belief.supersedes !== undefined ? { supersedes: input.belief.supersedes } : {}),
            ...(input.belief.basedOn !== undefined ? { basedOn: input.belief.basedOn } : {}),
            ...(input.belief.lastVerified !== undefined ? { lastVerified: input.belief.lastVerified } : {}),
          },
        }
        : {}),
      ...(input.target !== undefined ? { target: input.target } : {}),
      dataSupport: {
        summary: input.dataSupport.summary,
        ...(input.dataSupport.refs !== undefined ? { refs: input.dataSupport.refs } : {}),
      },
      provenance: {
        eventRange: [from, to] as readonly [number, number],
        ...(input.provenance.versionRef !== undefined ? { versionRef: input.provenance.versionRef } : {}),
      },
      // Reducer passthroughs (mechanical freshness needs the bounds).
      provenanceFrom: from,
      provenanceTo: to,
    }
    return this.writeEvent(scope, view, { type: 'rlm/judgment', payload })
  }

  /**
   * Replay a scope's stream from line one and replace the materialized view.
   * Refuses streams with unknown types, malformed lines, sequence gaps, or
   * scope-catalog violations — the read path never guesses.
   * @param scope - the scope to rebuild.
   * @returns the rebuilt materialized view.
   */
  async rebuild(scope: RlmScope): Promise<RlmMaterializedView> {
    const key = scopeKey(scope)
    const view = emptyView(scope)
    let text: string
    try {
      text = await readFile(this.streamPath(scope), 'utf8')
    } catch {
      this.views.set(key, view)
      await this.persistState(scope, view)
      return view
    }
    let expected = 0
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        throw new RlmStoreFormatError(`rlm-store: malformed stream line ${expected + 1} in ${key}`)
      }
      if (!isRecord(parsed) || typeof parsed['seq'] !== 'number' || typeof parsed['type'] !== 'string' || !isRecord(parsed['payload'])) {
        throw new RlmStoreFormatError(`rlm-store: stream line ${expected + 1} in ${key} is not an event envelope`)
      }
      const type = parsed['type']
      if (!isKnownEventType(type)) {
        throw new RlmStoreFormatError(`rlm-store: stream line ${expected + 1} in ${key} has unknown event type ${JSON.stringify(type)} — is the catalog older than the stream?`)
      }
      if (!RLM_EVENT_CATALOG[type].scopes.includes(scope.kind)) {
        throw new RlmStoreFormatError(`rlm-store: stream line ${expected + 1} in ${key} carries ${type}, which is not legal in ${scope.kind} scope`)
      }
      const seq = parsed['seq']
      if (seq !== expected + 1) {
        throw new RlmStoreFormatError(`rlm-store: sequence gap in ${key} (expected ${expected + 1}, found ${seq})`)
      }
      applyToView(view, {
        seq,
        type,
        time: typeof parsed['time'] === 'string' ? parsed['time'] : '',
        payload: parsed['payload'],
      }, key)
      expected = seq
    }
    // F4 self-check on every load: the invariant checker is wired here so a
    // violation surfaces on the cold path even when no caller asks for it.
    const f4 = closureInvariantViolations(view)
    if (f4.length > 0) {
      console.warn(`[rlm-store] F4 closure invariant violated in ${key}: active beliefs rest on voided foundations: ${f4.join(', ')}`)
    }
    this.views.set(key, view)
    await this.persistState(scope, view)
    return view
  }

  // ── Phase B escort APIs ────────────────────────────────────────────────

  /**
   * Freshness evaluation over every active belief of a scope (r11 single
   * axis, mechanically derived — never from declared edges).
   * @param scope - the scope to evaluate.
   * @returns verdicts for active beliefs, in creation order.
   */
  evaluateFreshness(scope: RlmScope): FreshnessVerdict[] {
    const view = this.view(scope)
    const options = { internalClockDistance: this.options.internalClockDistance }
    return view.beliefs
      .filter(b => b.status === 'active')
      .map(b => evaluateBeliefFreshness(view, b, options))
  }

  /**
   * Mechanically demote every stale belief: each demotion is a real judgment
   * (deterministic freshness clock) and floods the dependent closure.
   * @param scope - the scope to sweep.
   * @returns the stale verdicts that were acted upon.
   */
  async enforceFreshness(scope: RlmScope): Promise<FreshnessVerdict[]> {
    const acted: FreshnessVerdict[] = []
    for (const verdict of this.evaluateFreshness(scope)) {
      if (!verdict.stale) continue
      const belief = this.getBelief(scope, verdict.beliefId)
      if (!belief || belief.status !== 'active') continue
      await this.judge(scope, {
        criterionRef: 'crit/freshness-clock',
        verdict: 'demotion',
        target: verdict.beliefId,
        dataSupport: { summary: verdict.reasons.join('; ') },
        provenance: { eventRange: [belief.provenanceFrom || 1, this.view(scope).seq] },
      })
      acted.push(verdict)
    }
    return acted
  }

  /**
   * Record a world reconciliation (regular re-read / rollback re-check):
   * appends an observation whose touches update the checkpoint ledger — the
   * external clock sees the drift on the next evaluation. Reconciliation
   * provides visibility, never undo (r9 §10).
   * @param scope - the scope to reconcile into.
   * @param touches - observed objects with their current checkpoints.
   * @param detail - optional free-form detail for the audit surface.
   * @returns the appended observation event.
   */
  recordWorldReconciliation(
    scope: RlmScope,
    touches: ReadonlyArray<{ key: string; checkpoint: string }>,
    detail?: string,
  ): Promise<RlmEvent> {
    return this.append(scope, 'rlm/observation', {
      kind: 'world-reconciliation',
      touches: touches.map(t => ({ ...t })),
      ...(detail !== undefined ? { detail } : {}),
    })
  }

  /**
   * Execute a rollback verdict (r9 §6/§8): void the target belief, flood the
   * dependent closure, and report the touch keys the caller must re-read.
   * Step 2/3 of the protocol (re-read + inject the deltas) belongs to the
   * caller, which feeds the deltas back through recordWorldReconciliation.
   * @param scope - the scope to roll back within.
   * @param targetId - the belief id being rolled back.
   * @param reason - why the rollback happens.
   * @returns the voided ids and the touch keys to re-read.
   */
  async executeRollback(scope: RlmScope, targetId: string, reason: string): Promise<{
    voidedIds: string[]
    reReadKeys: string[]
    seq: number
  }> {
    const before = this.view(scope)
    const target = this.getBelief(scope, targetId)
    if (!target) throw new RlmJudgmentError(`rlm-store/rollback: unknown target belief ${JSON.stringify(targetId)}`)
    await this.judge(scope, {
      criterionRef: 'crit/freshness-clock',
      verdict: 'rollback',
      target: targetId,
      dataSupport: { summary: reason },
      provenance: { eventRange: [target.provenanceFrom || 1, before.seq] },
    })
    // The rollback judgment itself only records; the closure void is applied
    // here so the report reflects exactly what the protocol retracted.
    const voidedIds: string[] = []
    const view = this.view(scope)
    for (const belief of view.beliefs) {
      const retracted = belief.status === 'voided' && belief.updatedAt === view.seq
      const isTarget = belief.id === targetId
      if (!isTarget && retracted) voidedIds.push(belief.id)
      if (isTarget) voidedIds.unshift(belief.id)
    }
    const keys = new Set<string>()
    for (const id of voidedIds) {
      const b = this.getBelief(scope, id)
      if (!b) continue
      for (const t of view.touchLedger) {
        if (t.seq >= (b.provenanceFrom || 1) && t.seq <= b.provenanceTo) keys.add(t.key)
      }
    }
    return { voidedIds, reReadKeys: [...keys], seq: view.seq }
  }

  /**
   * F4 closure invariant (RETREE / BUILD.md Phase B): no active belief may
   * rest on a voided member of its dependency closure.
   * @param scope - the scope to check.
   * @returns violating belief ids (empty on a healthy view).
   */
  checkClosureInvariant(scope: RlmScope): string[] {
    return closureInvariantViolations(this.view(scope))
  }

  /** Judgment-density alarm state for a scope (r9 §8: per session scope). */
  alarmState(scope: RlmScope): RlmAlarmState {
    const view = this.view(scope)
    return {
      active: view.actionsSinceJudgment >= this.options.densityAlarmActions,
      actionsSinceJudgment: view.actionsSinceJudgment,
      escalations: this.escalationCounts.get(scopeKey(scope)) ?? 0,
    }
  }

  /** The density-alarm threshold this store was built with (observe-grade stats need the actual number, not the default). */
  get densityAlarmActions(): number {
    return this.options.densityAlarmActions
  }

  // ── Observe-grade audit surface (BUILD.md 收账面 / Phase D 审计通道基座) ──

  /**
   * The scope's full event stream, parsed with the same strictness as
   * {@link rebuild} (unknown types, malformed lines, sequence gaps throw).
   * The read path for observe-grade statistics — everything the projection
   * views bound (pendingChecks caps at 64, escalations are a counter) is
   * recomputable from here.
   * @param scope - the scope to read.
   * @returns the parsed events in stream order.
   */
  async readEvents(scope: RlmScope): Promise<RlmEvent[]> {
    const key = scopeKey(scope)
    let text: string
    try {
      text = await readFile(this.streamPath(scope), 'utf8')
    } catch {
      return []
    }
    const events: RlmEvent[] = []
    let expected = 0
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        throw new RlmStoreFormatError(`rlm-store: malformed stream line ${expected + 1} in ${key}`)
      }
      if (!isRecord(parsed) || typeof parsed['seq'] !== 'number' || typeof parsed['type'] !== 'string' || !isRecord(parsed['payload'])) {
        throw new RlmStoreFormatError(`rlm-store: stream line ${expected + 1} in ${key} is not an event envelope`)
      }
      const type = parsed['type']
      if (!isKnownEventType(type)) {
        throw new RlmStoreFormatError(`rlm-store: stream line ${expected + 1} in ${key} has unknown event type ${JSON.stringify(type)}`)
      }
      if (RLM_EVENT_CATALOG[type].scopes.includes(scope.kind) === false) {
        throw new RlmStoreFormatError(`rlm-store: stream line ${expected + 1} in ${key} carries ${type}, which is not legal in ${scope.kind} scope`)
      }
      const seq = parsed['seq']
      if (seq !== expected + 1) {
        throw new RlmStoreFormatError(`rlm-store: sequence gap in ${key} (expected ${expected + 1}, found ${seq})`)
      }
      events.push({ seq, type, time: typeof parsed['time'] === 'string' ? parsed['time'] : '', payload: parsed['payload'] })
      expected = seq
    }
    return events
  }

  /**
   * Replay the scope's stream through the SAME reducer as rebuild, collecting
   * every ⑥ conflict nomination along the way — unlike the view's
   * `pendingChecks` (bounded to the latest 64), nothing is truncated, so
   * observe-grade trigger-frequency and disposition statistics stay exact.
   * @param scope - the scope to replay.
   * @returns the full nomination history in stream order.
   */
  async replayNominations(scope: RlmScope): Promise<TimedNomination[]> {
    const events = await this.readEvents(scope)
    const view = emptyView(scope)
    const nominations: Array<RlmConflictNomination & { time: string }> = []
    for (const event of events) {
      const before = view.pendingChecks.length
      applyToView(view, event, scopeKey(scope))
      for (let i = before; i < view.pendingChecks.length; i += 1) {
        const n = view.pendingChecks[i]
        if (n) nominations.push({ ...n, time: event.time })
      }
    }
    return nominations
  }

  private async ensureLoadedOnce(scope: RlmScope): Promise<RlmMaterializedView> {
    const key = scopeKey(scope)
    const loaded = this.views.get(key)
    if (loaded) return loaded
    return this.rebuild(scope)
  }

  /** Single physical write, shared by append and judge: seq assignment, stream line, view update, state cache. */
  private async writeEvent(scope: RlmScope, view: RlmMaterializedView, draft: RlmEventDraft): Promise<RlmEvent> {
    const event: RlmEvent = {
      seq: view.seq + 1,
      type: draft.type,
      time: new Date().toISOString(),
      payload: draft.payload,
    }
    await mkdir(path.dirname(this.streamPath(scope)), { recursive: true })
    await appendFile(this.streamPath(scope), `${JSON.stringify(event)}\n`, 'utf8')
    applyToView(view, event, scopeKey(scope))
    // Density escalation (inspection chain head): warn once per threshold
    // crossing — the upgrade surface stays a log line until a consumer
    // registers a real inspection chain (implementation-layer config).
    if (event.type !== 'rlm/judgment') {
      const threshold = this.options.densityAlarmActions
      if (view.actionsSinceJudgment > 0 && view.actionsSinceJudgment % threshold === 0) {
        const count = (this.escalationCounts.get(scopeKey(scope)) ?? 0) + 1
        this.escalationCounts.set(scopeKey(scope), count)
        console.warn(
          `[rlm-store] judgment-density escalation #${count} in ${scopeKey(scope)}: `
          + `${view.actionsSinceJudgment} actions without a judgment — inspection chain upgraded`,
        )
      }
    }
    await this.persistState(scope, view)
    for (const listener of this.listeners) {
      try {
        listener(scope, view)
      } catch (error) {
        // A projection failure must not roll back the authority — the stream
        // line and the view are already durable; listeners re-render on the
        // next change or via rebuild.
        console.warn('[rlm-store] projection listener failed:', error)
      }
    }
    return event
  }

  /**
   * Materialized-state cache write: temp file + rename. A crash between the
   * stream append and this write leaves a stale cache, which rebuild corrects
   * — the stream is the authority, this file never is.
   */
  private async persistState(scope: RlmScope, view: RlmMaterializedView): Promise<void> {
    const target = this.statePath(scope)
    const tmp = `${target}.tmp-${process.pid}`
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(tmp, JSON.stringify({ seq: view.seq, eventCount: view.eventCount, countsByType: view.countsByType, beliefs: view.beliefs }, null, 2), 'utf8')
    await rename(tmp, target)
  }
}

// beliefIdOf is re-exported for projection renderers that need stable ids for
// entries derived from judgments.
export { beliefIdOf } from './beliefs.ts'
