/**
 * Reverse-filtering audit (ARCHITECTURE.md §7, Phase D): the critic — by hard
 * constraint a DIFFERENT model than the producer — raises objections against a
 * belief; a procedural arbiter (code, never a model) validates the objection's
 * form: a criterion is cited and registered, references locate in the stream,
 * the verdict is legal. The outcomes are asymmetric:
 *
 * - no objection → a check-pass judgment (the audit pass is itself a judgment,
 *   so density accounting never mistakes it for absence);
 * - objection accepted → a demotion/voiding judgment on the cited criterion
 *   (minimum structured tier — open-tier grounds can never overturn);
 * - objection rejected → the belief's trust-gate eligibility is FROZEN (no
 *   promotion, no merge, no publish) and it joins the batch human-review queue
 *   ({@link listFrozenForReview}); only a human release lifts the freeze
 *   ({@link releaseAuditFreeze}).
 *
 * Every outcome lands through the judgment channel — the arbiter's accept and
 * reject are themselves judgments. The transport is injected so the pipeline
 * is unit-testable and the wiring layer (moa plugin) owns the model seam.
 *
 * @module @deepseek-ai/dsh-plugin-rlm-store/audit
 */

import type { RlmStore, RlmScope, RlmMaterializedView } from './store.ts'
import type { RlmBeliefNode } from './beliefs.ts'

/** The structured reply the critic is required to produce; the arbiter checks its form mechanically. */
export interface RlmCriticReply {
  objection: boolean
  /** Substantive ground; required when objection is true. */
  reason?: string
  /** Proposed action for an accepted objection; the arbiter narrows it to `demotion`/`voiding` (default demotion). */
  verdict?: string
  /** Registered criterion the objection invokes (non-open tier). */
  criterionRef?: string
  /** Locatable references: `seq:N` stream positions or `belief:<id>`. */
  refs?: string[]
}

/** Transport-agnostic critic invocation, injected by the wiring layer. */
export type RlmAuditCallCritic = (request: { system: string; userText: string }) => Promise<{ text: string }>

export interface RlmAuditOptions {
  store: RlmStore
  scope: RlmScope
  beliefId: string
  callCritic: RlmAuditCallCritic
  /** Model identity that produced the belief (the independence baseline). */
  producerModel: string
  /** Critic model identity; MUST differ from producerModel (hard constraint). */
  criticModel: string
  /** Recorded in data-support for the audit trail, e.g. `model@provider`. */
  criticLabel?: string
}

export type RlmAuditOutcome = 'pass' | 'objection-accepted' | 'objection-rejected-frozen' | 'skipped'

export interface RlmAuditResult {
  beliefId: string
  outcome: RlmAuditOutcome
  /** Stream position of the audit judgment (absent for skips). */
  judgmentSeq?: number
  /** Arbiter check failures behind a rejection (empty otherwise). */
  failures: string[]
  criticLabel: string
  /** The objection's reason, when one was raised. */
  reason?: string
}

const CRITIC_SYSTEM =
  'You are the independent critic in a reverse-filtering audit. The belief ' +
  'below was produced by a DIFFERENT model; your job is to find substantive ' +
  'grounds to demote or void it: factual error, staleness, an unsupported ' +
  'claim, or contradiction by the related beliefs. If the belief is sound, ' +
  'raise no objection. Reply with STRICT JSON only, no prose: ' +
  '{"objection": boolean, "reason"?: string, "verdict"?: "demotion"|"voiding", ' +
  '"criterionRef"?: string, "refs"?: string[]}. ' +
  'refs locate your evidence: "seq:N" for a stream event, "belief:<id>" for a ' +
  'related belief. criterionRef must name one of the registered criteria ' +
  'listed below; deterministic or structured tier only.'

/**
 * Run one belief through the reverse-filtering pipeline. The independence
 * constraint is enforced before any model call: a critic identical to the
 * producer is a re-judgment by the same model, not an audit.
 * @param options - store, scope, target belief, injected critic transport, and model identities.
 * @returns the audit outcome with the judgment's stream position.
 */
export async function runAudit(options: RlmAuditOptions): Promise<RlmAuditResult> {
  const { store, scope } = options
  if (options.criticModel === options.producerModel) {
    throw new Error(
      `rlm-audit: hard constraint violated — critic model ${JSON.stringify(options.criticModel)} ` +
        'equals the producer model; same-model re-judgment is not an independent audit',
    )
  }
  const view = await store.ensureLoaded(scope)
  const belief = view.beliefs.find(b => b.id === options.beliefId)
  if (!belief) throw new Error(`rlm-audit: belief ${JSON.stringify(options.beliefId)} not found in the scope`)
  const criticLabel = options.criticLabel ?? options.criticModel
  if (belief.status === 'voided' || belief.status === 'frozen') {
    return {
      beliefId: belief.id,
      outcome: 'skipped',
      failures: [],
      criticLabel,
      reason: `belief is ${belief.status}`,
    }
  }

  // The audit judgment's provenance is the belief's own provenance range —
  // that is the evidence the critic reviewed.
  const from = Math.max(1, belief.provenanceFrom)
  const to = Math.min(view.seq, Math.max(from, belief.provenanceTo))
  const eventRange = [from, to] as readonly [number, number]

  const criteria = store.listCriteria()
  const related = view.beliefs
    .filter(b => b.id !== belief.id && b.status === 'active')
    .filter(b => b.subject !== undefined && b.subject === belief.subject || belief.basedOn.includes(b.id))
    .slice(0, 8)
  const reply = await options.callCritic({
    system: CRITIC_SYSTEM,
    userText: buildCriticPrompt(belief, criteria, related),
  })

  const parsed = parseCriticReply(reply.text)
  if (parsed.error !== undefined) {
    return freeze(store, scope, belief, eventRange, criticLabel, [
      `critic reply is not the structured objection form (${parsed.error})`,
    ])
  }
  const objection = parsed.reply
  if (!objection.objection) {
    const judgment = await store.judge(scope, {
      criterionRef: 'crit/audit-pass',
      verdict: 'check-pass',
      dataSupport: { summary: `audit pass: critic ${criticLabel} raised no objection` },
      provenance: { eventRange },
    })
    return { beliefId: belief.id, outcome: 'pass', judgmentSeq: judgment.seq, failures: [], criticLabel }
  }

  // Procedural arbitration — form only, no model involved.
  const failures: string[] = []
  const reason = (objection.reason ?? '').trim()
  if (reason === '') failures.push('the objection carries no reason')
  let verdict: 'demotion' | 'voiding' = 'demotion'
  if (objection.verdict !== undefined) {
    if (objection.verdict === 'demotion' || objection.verdict === 'voiding') verdict = objection.verdict
    else failures.push(`illegal verdict ${JSON.stringify(objection.verdict)} (demotion|voiding)`)
  }
  const criterionRef = objection.criterionRef ?? 'crit/audit-objection'
  const criterion = criteria.find(c => c.id === criterionRef)
  if (!criterion) {
    failures.push(`criterion ${JSON.stringify(criterionRef)} is not registered`)
  } else if (criterion.tier === 'open') {
    failures.push(`criterion ${criterionRef} is open-tier; overturning requires deterministic or structured grounds`)
  }
  const refs = (objection.refs ?? []).filter((r): r is string => typeof r === 'string')
  for (const ref of refs) {
    if (!refLocates(ref, view)) failures.push(`reference ${JSON.stringify(ref)} does not locate in the stream`)
  }
  if (failures.length > 0) {
    return freeze(store, scope, belief, eventRange, criticLabel, failures, refs)
  }

  const judgment = await store.judge(scope, {
    criterionRef,
    verdict,
    target: belief.id,
    dataSupport: { summary: `audit objection (${criticLabel}): ${reason}`, refs },
    provenance: { eventRange },
  })
  return {
    beliefId: belief.id,
    outcome: 'objection-accepted',
    judgmentSeq: judgment.seq,
    failures: [],
    criticLabel,
    reason,
  }
}

/** One belief awaiting batch human review: frozen, with the freeze judgment's position. */
export interface RlmFrozenReviewItem {
  id: string
  subject?: string
  title?: string
  grade: string
  /** Stream position of the freeze judgment (the node's last touch). */
  frozenAt: number
  contentPreview: string
}

/**
 * The batch human-review queue: every frozen belief in the scope. Derived from
 * the view — the stream is the authority, no side queue exists.
 * @param store - the store instance.
 * @param scope - the scope to list.
 * @returns frozen beliefs, oldest freeze first.
 */
export async function listFrozenForReview(store: RlmStore, scope: RlmScope): Promise<RlmFrozenReviewItem[]> {
  const view = await store.ensureLoaded(scope)
  return view.beliefs
    .filter(b => b.status === 'frozen')
    .map(b => ({
      id: b.id,
      ...(b.subject !== undefined ? { subject: b.subject } : {}),
      ...(b.title !== undefined ? { title: b.title } : {}),
      grade: b.grade,
      frozenAt: b.updatedAt,
      contentPreview: b.content.length > 120 ? `${b.content.slice(0, 117)}...` : b.content,
    }))
    .sort((a, b) => a.frozenAt - b.frozenAt)
}

/**
 * Human batch-review release: lift a belief's freeze. This is the asymmetric
 * approval path — machines freeze, humans release — and lands as an unfreeze
 * judgment on the structured audit-release criterion.
 * @param store - the store instance.
 * @param scope - the scope holding the belief.
 * @param beliefId - the frozen belief to release.
 * @param note - the human's release rationale, recorded in data-support.
 * @returns the unfreeze judgment event's stream position.
 */
export async function releaseAuditFreeze(
  store: RlmStore,
  scope: RlmScope,
  beliefId: string,
  note: string,
): Promise<number> {
  const view = await store.ensureLoaded(scope)
  const belief = view.beliefs.find(b => b.id === beliefId)
  if (!belief) throw new Error(`rlm-audit: belief ${JSON.stringify(beliefId)} not found in the scope`)
  const from = Math.max(1, belief.provenanceFrom)
  const to = Math.min(view.seq, Math.max(from, belief.provenanceTo))
  const judgment = await store.judge(scope, {
    criterionRef: 'crit/audit-release',
    verdict: 'unfreeze',
    target: beliefId,
    dataSupport: { summary: `audit release (human review): ${note.trim() === '' ? 'freeze lifted' : note.trim()}` },
    provenance: { eventRange: [from, to] },
  })
  return judgment.seq
}

/** Arbiter rejection path: freeze the belief and record the failed checks. */
async function freeze(
  store: RlmStore,
  scope: RlmScope,
  belief: RlmBeliefNode,
  eventRange: readonly [number, number],
  criticLabel: string,
  failures: string[],
  refs?: string[],
): Promise<RlmAuditResult> {
  const judgment = await store.judge(scope, {
    criterionRef: 'crit/audit-freeze',
    verdict: 'freeze',
    target: belief.id,
    dataSupport: {
      summary: `audit freeze: arbiter rejected the criticism — ${failures.join('; ')}`,
      ...(refs !== undefined && refs.length > 0 ? { refs } : {}),
    },
    provenance: { eventRange },
  })
  return {
    beliefId: belief.id,
    outcome: 'objection-rejected-frozen',
    judgmentSeq: judgment.seq,
    failures,
    criticLabel,
  }
}

/** Mechanical locatability: `seq:N` within the stream, or an existing `belief:<id>`. */
function refLocates(ref: string, view: RlmMaterializedView): boolean {
  const seq = /^seq:(\d+)$/.exec(ref)
  if (seq) {
    const n = Number(seq[1])
    return Number.isInteger(n) && n >= 1 && n <= view.seq
  }
  const belief = /^belief:(.+)$/.exec(ref)
  if (belief) return view.beliefs.some(b => b.id === belief[1])
  return false
}

/** Parse the critic's reply; the error string marks an unparseable (arbiter-rejected) form. */
function parseCriticReply(text: string): { reply: RlmCriticReply; error?: undefined } | { reply?: undefined; error: string } {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return { error: 'no JSON object found' }
  let raw: unknown
  try {
    raw = JSON.parse(text.slice(start, end + 1))
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { error: 'not a JSON object' }
  const record = raw as Record<string, unknown>
  if (typeof record['objection'] !== 'boolean') return { error: '"objection" must be a boolean' }
  const reply: RlmCriticReply = { objection: record['objection'] }
  if (typeof record['reason'] === 'string') reply.reason = record['reason']
  if (typeof record['verdict'] === 'string') reply.verdict = record['verdict']
  if (typeof record['criterionRef'] === 'string') reply.criterionRef = record['criterionRef']
  if (Array.isArray(record['refs'])) reply.refs = record['refs'].filter((r): r is string => typeof r === 'string')
  return { reply }
}

/** The criterion fields the critic prompt renders (the store's listCriteria view). */
type CriticCriterionView = ReadonlyArray<{ id: string; tier: string; title: string }>

function buildCriticPrompt(belief: RlmBeliefNode, criteria: CriticCriterionView, related: RlmBeliefNode[]): string {
  const parts = [
    `## Belief under audit\n\nid: ${belief.id}\ngrade: ${belief.grade}\nkind: ${belief.kind}\n` +
      `creating criterion: ${belief.criterionRef}\nprovenance: events ${belief.provenanceFrom}..${belief.provenanceTo}\n` +
      `${belief.subject !== undefined ? `subject: ${belief.subject}\n` : ''}\n${belief.content}`,
    `## Registered criteria\n\n${criteria.map(c => `- ${c.id} [${c.tier}] ${c.title}`).join('\n')}`,
  ]
  if (related.length > 0) {
    parts.push(
      `## Related active beliefs\n\n${related.map(b => `- belief:${b.id}${b.subject !== undefined ? ` (${b.subject})` : ''}: ${b.content}`).join('\n')}`,
    )
  }
  parts.push('Audit the belief. Reply with the strict JSON form only.')
  return parts.join('\n\n')
}
