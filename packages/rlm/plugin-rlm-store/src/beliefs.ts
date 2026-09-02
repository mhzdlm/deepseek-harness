/**
 * Belief nodes: the content of the materialized view (ARCHITECTURE.md §4/§7).
 *
 * Edges and grade fields are *written at judgment time* (REDESIGN Phase A);
 * their mechanical consequences — closure propagation for voiding, freshness
 * derivation over provenance ∪ touched records — arrive in Phase B. The
 * reducer below is the single application path shared by incremental append
 * and rebuild replay, so the two can never disagree.
 *
 * @module @deepseek-ai/dsh-plugin-rlm-store/beliefs
 */

import { createHash } from 'node:crypto'
import type { RlmBeliefKind, RlmGrade } from './events.ts'

/** Belief lifecycle. `frozen` is reserved for the Phase D audit freeze. */
export type RlmBeliefStatus = 'active' | 'degraded' | 'voided' | 'frozen'

/** Optional verification bookkeeping written at judgment time; the freshness *derivation* is Phase B. */
export interface RlmLastVerified {
  /** Verification channel, e.g. `loop-three-line-header` or `verify-tournament`. */
  channel: string
  /** Stream position of the verifying judgment. */
  eventPos: number
  note?: string
  /** Mechanical checkpoint snapshot at verification time (touch key → checkpoint). */
  touchpoints?: Record<string, string>
}

/** One belief: the only state content of a scope. */
export interface RlmBeliefNode {
  /** Content-addressed id (hash of the creating judgment payload). */
  id: string
  kind: RlmBeliefKind
  grade: RlmGrade
  status: RlmBeliefStatus
  /** The belief statement. */
  content: string
  title?: string
  /** Stable subject key (symbol / path / topic) for Phase B conflict detection. */
  subject?: string
  /** Which scope's stream the belief lives in (echoed for projection renderers). */
  scope: string
  /** Supersedes edge: the belief id this one replaces, with the reason. */
  supersedes?: { id: string; reason: string }
  /** The judging stream range (from the provenance of the creating judgment). */
  provenanceFrom: number
  provenanceTo: number
  /** The criterion reference of the creating judgment (provenance for projections). */
  criterionRef: string
  /** Derivation edges: belief ids this was built from (written at judgment time; propagation is Phase B). */
  basedOn: string[]
  lastVerified?: RlmLastVerified
  /** Stream position of the creating judgment. */
  createdAt: number
  /** Stream position of the last judgment that touched this node. */
  updatedAt: number
  /** Wall-clock of the creating event (ISO string from the stream). */
  time: string
  /** Status the node held before a freeze, so unfreeze restores it exactly (reducer-owned; never written by callers). */
  preFreezeStatus?: RlmBeliefStatus
}

/**
 * Verdict semantics over beliefs, shared by append and rebuild:
 *
 * - creating verdicts (`conclusion`, `selection`, `completion`, `merge`,
 *   `experience`, `check-pass`, `promotion`, `handoff-nomination`) require a
 *   `belief` payload and insert a node; only `promotion` grades evidenced
 *   (and only from a non-open criterion — enforced at judge());
 * - target verdicts (`demotion`, `voiding`) require `target` and flip the
 *   node's status (voiding's closure propagation is Phase B; the edge itself
 *   is already on the record);
 * - `check-doubt`, `rollback`, `unpin` are event-only in Phase A — they are
 *   counted and remembered, but touch no node.
 *
 * @param beliefs - the view's belief list, mutated in place.
 * @param event - the judgment event being applied.
 * @returns void
 */
export function applyJudgmentToBeliefs(
  beliefs: RlmBeliefNode[],
  event: {
    seq: number
    time: string
    type?: string | undefined
    scopeKey: string
    provenanceFrom?: number | undefined
    provenanceTo?: number | undefined
    payload: {
      verdict: string
      criterionRef: string
      belief?: {        kind?: string
        content?: unknown
        title?: unknown
        subject?: unknown
        supersedes?: { id: string; reason: string }
        basedOn?: unknown
        lastVerified?: {
          channel: string
          eventPos: number
          note?: string
          touchpoints?: Record<string, string>
        }
      }
      target?: unknown
    }
  },
  ledgerSnapshot?: Record<string, string>,
): void {
  const payload = event.payload
  const verdict = payload.verdict

  // Phase D audit freeze pair (r9 §7 reverse-filtering): single-node
  // transitions, no closure flood — a freeze locks only the belief's own
  // trust-gate eligibility (no promotion, no merge, no publish), and the
  // release restores exactly the status it held before (grade included):
  // the pre-freeze status rides on the node so a degraded belief comes back
  // degraded, not silently revived to active.
  if (verdict === 'freeze' || verdict === 'unfreeze') {
    const target = typeof payload.target === 'string' ? payload.target : undefined
    const node = target ? beliefs.find(b => b.id === target) : undefined
    if (node) {
      if (verdict === 'freeze' && node.status !== 'voided' && node.status !== 'frozen') {
        node.preFreezeStatus = node.status
        node.status = 'frozen'
        node.updatedAt = event.seq
      }
      if (verdict === 'unfreeze' && node.status === 'frozen') {
        node.status = node.preFreezeStatus ?? 'active'
        delete node.preFreezeStatus
        node.updatedAt = event.seq
      }
    }
    return
  }

  if (verdict === 'demotion' || verdict === 'voiding' || verdict === 'rollback') {
    const target = typeof payload.target === 'string' ? payload.target : undefined
    const node = target ? beliefs.find(b => b.id === target) : undefined
    if (node) {
      // Closure propagation is mechanical (r9 §7 / RETREE F3): the verdict
      // floods the dependent closure. voiding voids dependents; demotion
      // degrades them (grade drops to provisional). A voided node never
      // un-voids, so the flood is monotone.
      const nextStatus = verdict === 'demotion' ? 'degraded' : 'voided'
      const flooded = new Set<string>()
      const flood: RlmBeliefNode[] = [node]
      while (flood.length > 0) {
        const current = flood.shift()
        if (!current || flooded.has(current.id)) continue
        flooded.add(current.id)
        if (current.status !== 'voided') {
          current.status = nextStatus
          if (nextStatus === 'degraded') current.grade = 'provisional'
          current.updatedAt = event.seq
        }
        for (const downstream of beliefs) {
          if (downstream.status === 'voided' || flooded.has(downstream.id)) continue
          if (downstream.basedOn.includes(current.id)) flood.push(downstream)
        }
      }
    }
    return
  }

  // Human revision (r9 §9 — the semantic-exempt writer): mailbox-scope events
  // of type `rlm/human-revision` mutate beliefs directly, without the
  // judgment channel. The physical write path is still the stream: the
  // projection watcher turns a human file edit into exactly this event.
  if (event.type === 'rlm/human-revision') {
    const p = event.payload as { action?: unknown; subject?: unknown; title?: unknown; content?: unknown }
    const subject = typeof p.subject === 'string' ? p.subject : ''
    if (subject === '') return
    if (p.action === 'retract') {
      const node = beliefs.find(b => b.status === 'active' && b.subject === subject)
      if (node) {
        node.status = 'voided'
        node.updatedAt = event.seq
      }
      return
    }
    const content = typeof p.content === 'string' ? p.content : ''
    if (content.trim() === '') return
    const previous = beliefs.filter(b => b.subject === subject && b.status === 'active').at(-1)
    if (previous) {
      // ReTree axiom, same as the judgment path: a revision voids the state
      // it replaces; the superseded node stays in the stream.
      previous.status = 'voided'
      previous.updatedAt = event.seq
    }
    beliefs.push({
      id: beliefIdOf(event.payload, event.seq),
      kind: 'declarative',
      grade: 'provisional',
      status: 'active',
      content,
      ...(typeof p.title === 'string' && p.title.trim() !== '' ? { title: p.title } : {}),
      // The subject survives the human channel too — pickup idempotency,
      // projection rendering and conflict detection all key on it.
      subject,
      scope: event.scopeKey,
      ...(previous ? { supersedes: { id: previous.id, reason: 'human revision' } } : {}),
      criterionRef: 'human-revision',
      basedOn: [],
      provenanceFrom: event.seq,
      provenanceTo: event.seq,
      createdAt: event.seq,
      updatedAt: event.seq,
      time: event.time,
    })
    return
  }

  if (verdict === 'check-doubt' || verdict === 'unpin') return

  const belief = payload.belief
  if (!belief || typeof belief.content !== 'string' || belief.content.trim() === '') return

  // ReTree axiom, mechanical here: a revision voids the state it replaces.
  // The superseded node stays in the stream (pinned) but leaves the active set.
  if (belief.supersedes && typeof belief.supersedes.id === 'string') {
    const supersededId = belief.supersedes.id
    const replaced = beliefs.find(b => b.id === supersededId && b.status !== 'voided')
    if (replaced) {
      replaced.status = 'voided'
      replaced.updatedAt = event.seq
    }
  }

  // Mechanical verification snapshot: every judgment IS a verification of the
  // belief it lands (r9 §7 — freshness bookkeeping is mechanical). The
  // touch-ledger checkpoints at judgment time are frozen into the belief so
  // the external clock can later detect drift; the stream position records
  // when the internal clock starts.
  const lastVerified: { channel: string; eventPos: number; note?: string; touchpoints?: Record<string, string> } = {
    channel: belief.lastVerified?.channel ?? 'judgment',
    eventPos: belief.lastVerified?.eventPos ?? event.seq,
    ...(belief.lastVerified?.note !== undefined ? { note: belief.lastVerified.note } : {}),
    ...(ledgerSnapshot ? { touchpoints: { ...ledgerSnapshot } } : {}),
  }

  const grade: RlmGrade = verdict === 'promotion' ? 'evidenced' : 'provisional'
  const kind: RlmBeliefKind = belief.kind === 'declarative' ? 'declarative' : 'procedural'
  const basedOn = Array.isArray(belief.basedOn) ? belief.basedOn.filter((x): x is string => typeof x === 'string') : []
  const node: RlmBeliefNode = {
    id: beliefIdOf(event.payload, event.seq),
    kind,
    grade,
    status: 'active',
    content: belief.content,
    ...(typeof belief.title === 'string' && belief.title.trim() !== '' ? { title: belief.title } : {}),
    ...(typeof belief.subject === 'string' && belief.subject.trim() !== '' ? { subject: belief.subject } : {}),
    scope: event.scopeKey,
    ...(belief.supersedes ? { supersedes: belief.supersedes } : {}),
    criterionRef: payload.criterionRef,
    basedOn,
    ...(lastVerified ? { lastVerified } : {}),
    provenanceFrom: Number(event.provenanceFrom ?? 0),
    provenanceTo: Number(event.provenanceTo ?? 0),
    createdAt: event.seq,
    updatedAt: event.seq,
    time: event.time,
  }
  beliefs.push(node)
}

/** Content-addressed belief id: hash of the canonical creating payload plus its stream position (deterministic under replay). */
export function beliefIdOf(payload: unknown, seq: number): string {
  return createHash('sha256').update(`${seq}\n${JSON.stringify(payload)}`).digest('hex').slice(0, 16)
}
