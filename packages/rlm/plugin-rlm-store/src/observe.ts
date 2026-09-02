/**
 * Observe-grade audit statistics (BUILD.md 收账面; the r9 体系级待验 window):
 * everything the projection views bound — pendingChecks caps at 64,
 * escalations are bare counters, freshness verdicts are read-time derivations
 * that never land — is recomputed here from the stream through the SAME
 * reducer, so observe-period statistics stay exact while the mechanisms run
 * in their non-enforcing tiers.
 *
 * This answers the three calibration questions with numbers, not judgement:
 * - density: is the 50-action alarm threshold anywhere near the real
 *   judgment rhythm (gap distribution vs threshold)?
 * - trigger ⑥: how often do hard/soft nominations fire, how many were ever
 *   dispositioned, and (soft only) how many cleared vs confirmed?
 * - freshness: at this instant, WHO would `enforceFreshness` demote?
 *
 * Pure read-side aggregation: no append, no judgment, no projection writes.
 *
 * @module @deepseek-ai/dsh-plugin-rlm-store/observe
 */

import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import type { RlmEventType } from './events.ts'
import { RlmStore, type RlmEvent, type RlmScope } from './store.ts'
import { withBaseCriteria } from './criteria.ts'
import { closureInvariantViolations } from './freshness.ts'

/** Judgment-gap distribution; `open` is the unfinished tail since the last judgment (null when no judgment ever landed). */
export interface ObserveGapStats {
  min: number
  p50: number
  p90: number
  max: number
  open: number | null
}

/** Per-scope judgment-rhythm statistics. */
export interface ObserveDensityStats {
  events: number
  judgments: number
  /** judgments / events (0 when the scope is empty). */
  judgmentRatio: number
  gaps: ObserveGapStats
  escalations: number
  /** Where each escalation crossed (seq + the counter value), recomputed from the stream. */
  escalationMarks: Array<{ seq: number; actions: number }>
}

/** Per-scope ⑥ nomination statistics with disposition association. */
export interface ObserveNominationStats {
  hard: number
  soft: number
  /** Nominations no subsequent judgment ever dispositioned. */
  unchecked: number
  /** Nominations a later check-pass cleared (checked, held — the suspected false positives). */
  cleared: number
  /** Nominations a later check-doubt / demotion / voiding / rollback confirmed. */
  confirmed: number
  /** cleared / (cleared + confirmed) over SOFT nominations only; null when the denominator is 0. */
  softClearedRate: number | null
  /** check verdicts that named no target (check-pass may carry no belief/target) — not attributable to any nomination. */
  targetlessChecks: number
}

/** One belief that enforceFreshness WOULD demote at snapshot time. */
export interface ObserveFreshnessItem {
  id: string
  subject?: string
  criterionRef: string
  grade: string
  clock: 'external' | 'internal' | 'analytic'
  reasons: string[]
}

/** Per-scope reverse-filtering audit statistics (Phase D). */
export interface ObserveAuditStats {
  /** Audit check-pass judgments (critic raised no objection). */
  passes: number
  /** Demotion/voiding judgments from accepted objections. */
  objectionsAccepted: number
  /** Freeze judgments (arbiter rejected the criticism). */
  freezes: number
  /** Unfreeze judgments (human batch-review releases). */
  releases: number
  /** Beliefs currently frozen — the pending batch-review queue depth. */
  frozenPending: number
}

/** Per-scope aggregate. */
export interface ObserveScopeReport {
  scope: string
  density: ObserveDensityStats
  nominations: ObserveNominationStats
  freshness: { active: number; stale: ObserveFreshnessItem[] }
  audit: ObserveAuditStats
  /** F4 closure-invariant violations (active beliefs resting on voided foundations); empty on a healthy scope. */
  closureViolations: string[]
}

/** The mailbox scope's production numbers. */
export interface ObserveMailboxStats {
  publishes: number
  /** Session-side decide-handover records. */
  decisions: number
  /** Session-side pickup notices. */
  pickups: number
  upserts: number
  retracts: number
  approvals: number
  /** Criterion proposals parked in the mailbox stream. */
  proposals: number
  /** Active criterion:<id> beliefs not (yet) in the registered set. */
  pendingProposals: number
  activeBeliefs: number
  audit: ObserveAuditStats
}

/** The full observe report. */
export interface RlmObserveReport {
  generatedAt: string
  /** The density threshold the numbers were computed against. */
  densityAlarmActions: number
  scopes: ObserveScopeReport[]
  mailbox: ObserveMailboxStats
  /**口径 notes — how to read the numbers (kept with the data, not in docs alone). */
  notes: string[]
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[Math.max(0, idx)] ?? 0
}

/** Escalation marks recomputed with the exact writeEvent rule: counter > 0 and a multiple of the threshold. */
function escalationMarks(events: RlmEvent[], threshold: number): Array<{ seq: number; actions: number }> {
  const marks: Array<{ seq: number; actions: number }> = []
  let counter = 0
  for (const e of events) {
    if (e.type === 'rlm/judgment') {
      counter = 0
      continue
    }
    counter += 1
    if (counter > 0 && counter % threshold === 0) marks.push({ seq: e.seq, actions: counter })
  }
  return marks
}

function densityStats(events: RlmEvent[], threshold: number): ObserveDensityStats {
  const judgments = events.filter(e => e.type === 'rlm/judgment').length
  const gaps: number[] = []
  let since = 0
  for (const e of events) {
    if (e.type === 'rlm/judgment') {
      gaps.push(since)
      since = 0
    } else {
      since += 1
    }
  }
  // gaps[0] is the distance to the FIRST judgment (from stream start) — a
  // valid gap for rhythm purposes. The tail is reported separately as open.
  const sorted = [...gaps].sort((a, b) => a - b)
  const marks = escalationMarks(events, threshold)
  return {
    events: events.length,
    judgments,
    judgmentRatio: events.length > 0 ? judgments / events.length : 0,
    gaps: {
      min: sorted[0] ?? 0,
      p50: percentile(sorted, 50),
      p90: percentile(sorted, 90),
      max: sorted[sorted.length - 1] ?? 0,
      open: judgments > 0 ? since : null,
    },
    escalations: marks.length,
    escalationMarks: marks,
  }
}

const DISPOSING_VERDICTS = new Set(['check-doubt', 'demotion', 'voiding', 'rollback'])
const TARGETLESS_CHECK_VERDICTS = new Set(['check-pass', 'check-doubt'])

type NominationRecord = { kind: string; seq: number; beliefIds: string[] }

function nominationStats(events: RlmEvent[], nominations: NominationRecord[]): ObserveNominationStats {
  const stats: ObserveNominationStats = {
    hard: nominations.filter(n => n.kind === 'hard').length,
    soft: nominations.filter(n => n.kind === 'soft').length,
    unchecked: 0,
    cleared: 0,
    confirmed: 0,
    softClearedRate: null,
    targetlessChecks: 0,
  }
  let softCleared = 0
  let softConfirmed = 0
  for (const n of nominations) {
    let disposition: 'cleared' | 'confirmed' | null = null
    for (const e of events) {
      if (e.type !== 'rlm/judgment' || e.seq <= n.seq) continue
      const target = e.payload['target']
      const verdict = e.payload['verdict']
      if (typeof verdict !== 'string') continue
      if (typeof target === 'string' && n.beliefIds.includes(target)) {
        if (verdict === 'check-pass') disposition = 'cleared'
        else if (DISPOSING_VERDICTS.has(verdict)) disposition = 'confirmed'
      }
    }
    if (disposition === null) stats.unchecked += 1
    else if (disposition === 'cleared') stats.cleared += 1
    else stats.confirmed += 1
    if (n.kind === 'soft') {
      if (disposition === 'cleared') softCleared += 1
      else if (disposition === 'confirmed') softConfirmed += 1
    }
  }
  const softTotal = softCleared + softConfirmed
  stats.softClearedRate = softTotal > 0 ? softCleared / softTotal : null
  for (const e of events) {
    if (e.type !== 'rlm/judgment') continue
    const verdict = e.payload['verdict']
    const target = e.payload['target']
    if (typeof verdict === 'string' && TARGETLESS_CHECK_VERDICTS.has(verdict) && typeof target !== 'string') {
      stats.targetlessChecks += 1
    }
  }
  return stats
}

function actionCount(events: RlmEvent[], type: RlmEventType, action: string): number {
  return events.filter(e => e.type === type && e.payload['action'] === action).length
}

const AUDIT_PASS_CRITERION = 'crit/audit-pass'
const AUDIT_FREEZE_CRITERION = 'crit/audit-freeze'
const AUDIT_RELEASE_CRITERION = 'crit/audit-release'
const AUDIT_OBJECTION_PREFIX = 'audit objection ('

/**
 * Audit accounting: freezes/passes/releases key on their criterion; accepted
 * objections land on the critic-cited one and match the writer's data-support prefix.
 */
function auditStats(events: RlmEvent[], frozenPending: number): ObserveAuditStats {
  const stats: ObserveAuditStats = { passes: 0, objectionsAccepted: 0, freezes: 0, releases: 0, frozenPending }
  for (const e of events) {
    if (e.type !== 'rlm/judgment') continue
    const criterionRef = e.payload['criterionRef']
    if (criterionRef === AUDIT_PASS_CRITERION) {
      stats.passes += 1
      continue
    }
    if (criterionRef === AUDIT_FREEZE_CRITERION) {
      stats.freezes += 1
      continue
    }
    if (criterionRef === AUDIT_RELEASE_CRITERION) {
      stats.releases += 1
      continue
    }
    const support = e.payload['dataSupport']
    const summary = typeof support === 'object' && support !== null
      ? (support as Record<string, unknown>)['summary']
      : undefined
    if (typeof summary === 'string' && summary.startsWith(AUDIT_OBJECTION_PREFIX)) stats.objectionsAccepted += 1
  }
  return stats
}

interface ObserveOptions {
  densityAlarmActions?: number
  internalClockDistance?: number
}

/**
 * Discover scopes under a store root and produce the full observe report.
 * @param rootDir - the store root (`<dataDir>/store`).
 * @param options - thresholds default to the store defaults (50 / 256); pass
 *   the deployed store's actual thresholds when they differ.
 * @returns the observe report (pure aggregation; writes nothing).
 */
export async function observeReport(rootDir: string, options: ObserveOptions = {}): Promise<RlmObserveReport> {
  const threshold = options.densityAlarmActions ?? 50
  const store = withBaseCriteria(new RlmStore(rootDir, {
    ...(options.internalClockDistance !== undefined ? { internalClockDistance: options.internalClockDistance } : {}),
  }))
  const registered = new Set(store.listCriteria().map(c => c.id))

  const scopeKeys: string[] = []
  if (existsSync(path.join(rootDir, 'mailbox', 'events.jsonl'))) scopeKeys.push('mailbox')
  const sessionDir = path.join(rootDir, 'session')
  if (existsSync(sessionDir)) {
    for (const entry of readdirSync(sessionDir)) {
      if (existsSync(path.join(sessionDir, entry, 'events.jsonl'))) scopeKeys.push(`session/${entry}`)
    }
  }

  const mailboxEvents = scopeKeys.includes('mailbox')
    ? await store.readEvents({ kind: 'mailbox' })
    : []
  const mailboxBeliefs = scopeKeys.includes('mailbox')
    ? (await store.ensureLoaded({ kind: 'mailbox' })).beliefs
    : []

  const scopes: ObserveScopeReport[] = []
  let decisions = 0
  let pickups = 0
  for (const key of scopeKeys) {
    if (key === 'mailbox') continue
    const scope: RlmScope = { kind: 'session', id: key.slice('session/'.length) }
    const events = await store.readEvents(scope)
    const nominations = await store.replayNominations(scope)
    decisions += actionCount(events, 'rlm/handoff', 'decide-handover')
    pickups += actionCount(events, 'rlm/handoff', 'pickup')
    const view = await store.ensureLoaded(scope)
    const fresh = store.evaluateFreshness(scope)
    const stale: ObserveFreshnessItem[] = []
    for (const v of fresh) {
      if (!v.stale) continue
      const belief = view.beliefs.find(b => b.id === v.beliefId)
      stale.push({
        id: v.beliefId,
        ...(belief?.subject !== undefined ? { subject: belief.subject } : {}),
        criterionRef: belief?.criterionRef ?? '',
        grade: belief?.grade ?? '',
        clock: v.clock,
        reasons: v.reasons,
      })
    }
    scopes.push({
      scope: key,
      density: densityStats(events, threshold),
      nominations: nominationStats(events, nominations),
      freshness: { active: view.beliefs.filter(b => b.status === 'active').length, stale },
      audit: auditStats(events, view.beliefs.filter(b => b.status === 'frozen').length),
      closureViolations: closureInvariantViolations(view),
    })
  }

  const upserts = actionCount(mailboxEvents, 'rlm/human-revision', 'upsert')
  const retracts = actionCount(mailboxEvents, 'rlm/human-revision', 'retract')
  const approvals = actionCount(mailboxEvents, 'rlm/human-revision', 'approve-criterion')
  const proposals = actionCount(mailboxEvents, 'rlm/handoff', 'criterion-proposal')
  const pendingProposals = mailboxBeliefs.filter(
    b => b.status === 'active'
      && typeof b.subject === 'string' && b.subject.startsWith('criterion:')
      && !registered.has(b.subject.slice('criterion:'.length)),
  ).length

  return {
    generatedAt: new Date().toISOString(),
    densityAlarmActions: threshold,
    scopes,
    mailbox: {
      publishes: actionCount(mailboxEvents, 'rlm/handoff', 'publish'),
      decisions,
      pickups,
      upserts,
      retracts,
      approvals,
      proposals,
      pendingProposals,
      activeBeliefs: mailboxBeliefs.filter(b => b.status === 'active').length,
      audit: auditStats(mailboxEvents, mailboxBeliefs.filter(b => b.status === 'frozen').length),
    },
    notes: [
      'nominations: full-history replay through the same reducer as rebuild (the view caps at 64).',
      'softClearedRate = soft nominations cleared by a later check-pass over those confirmed; unchecked nominations are excluded from the rate (they are backlog, not evidence).',
      'freshness stale = what enforceFreshness WOULD demote right now (observe period never demotes).',
      'escalation marks follow the writer rule: non-judgment counter > 0 crossing a multiple of the threshold.',
      'audit: pass/accepted/frozen counts are the reverse-filtering precision window; accepted objections land on the critic-cited criterion and are matched by the data-support prefix "audit objection (".',
    ],
  }
}

/** Render the report as compact command-surface text. */
export function renderObserveReport(report: RlmObserveReport): string {
  const lines: string[] = []
  lines.push(`[observe] ${report.generatedAt} (density threshold ${String(report.densityAlarmActions)})`)
  for (const s of report.scopes) {
    const d = s.density
    lines.push(
      `${s.scope}: ${String(d.events)} events, ${String(d.judgments)} judgments (${(d.judgmentRatio * 100).toFixed(0)}%); `
      + `gaps p50 ${String(d.gaps.p50)} / p90 ${String(d.gaps.p90)} / max ${String(d.gaps.max)}`
      + (d.gaps.open !== null ? `, open tail ${String(d.gaps.open)}` : '')
      + `; escalations ${String(d.escalations)}`,
    )
    const n = s.nominations
    if (n.hard + n.soft > 0) {
      lines.push(
        `  ⑥: ${String(n.hard)} hard / ${String(n.soft)} soft; cleared ${String(n.cleared)}, confirmed ${String(n.confirmed)}, unchecked ${String(n.unchecked)}`
        + (n.softClearedRate !== null ? `; soft cleared rate ${(n.softClearedRate * 100).toFixed(0)}%` : '')
        + (n.targetlessChecks > 0 ? `; ${String(n.targetlessChecks)} targetless check(s)` : ''),
      )
    }
    if (s.freshness.stale.length > 0) {
      lines.push(`  freshness: ${String(s.freshness.stale.length)}/${String(s.freshness.active)} active belief(s) WOULD be demoted by enforce:`)
      for (const item of s.freshness.stale) {
        lines.push(`    - ${item.subject ?? item.id} [${item.clock}] (${item.criterionRef}, ${item.grade}): ${item.reasons.join('; ')}`)
      }
    }
    if (s.closureViolations.length > 0) {
      lines.push(`  F4 VIOLATION: ${String(s.closureViolations.length)} active belief(s) rest on voided foundations: ${s.closureViolations.join(', ')}`)
    }
    const a = s.audit
    if (a.passes + a.objectionsAccepted + a.freezes + a.releases + a.frozenPending > 0) {
      lines.push(
        `  audit: ${String(a.passes)} pass / ${String(a.objectionsAccepted)} objection(s) accepted / ${String(a.freezes)} freeze(s), ${String(a.releases)} released; ${String(a.frozenPending)} pending review`,
      )
    }
  }
  const m = report.mailbox
  lines.push(
    `mailbox: ${String(m.publishes)} publishes / ${String(m.decisions)} decisions / ${String(m.pickups)} pickups; `
    + `revisions ${String(m.upserts)}+${String(m.retracts)}-; criteria: ${String(m.proposals)} proposed, ${String(m.approvals)} approved, ${String(m.pendingProposals)} pending; `
    + `${String(m.activeBeliefs)} active belief(s)`
    + (m.audit.frozenPending > 0 ? `; ${String(m.audit.frozenPending)} frozen pending review` : ''),
  )
  for (const note of report.notes) lines.push(`  (note) ${note}`)
  return lines.join('\n')
}
