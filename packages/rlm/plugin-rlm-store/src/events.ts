/**
 * The store's event vocabulary (docs 仓 ARCHITECTURE.md §5): seven event types, the
 * verdict-form and criterion-tier enums, and the judgment payload contract.
 *
 * This stream is store-owned (`<dataDir>/store/`, one stream per scope) — it is
 * NOT the host session log, so nothing here joins the generated
 * KNOWN_SESSION_EVENT_TYPES catalog; the store keeps its own catalog
 * (./catalog.ts) with a pinning test.
 *
 * @module @deepseek-ai/dsh-plugin-rlm-store/events
 */

/** The seven event types of the rlm event stream (r9 §5). */
export const RLM_EVENT_TYPES = [
  'rlm/observation',
  'rlm/mechanical',
  'rlm/action-boundary',
  'rlm/judgment',
  'rlm/handoff',
  'rlm/rollback',
  'rlm/human-revision',
] as const

export type RlmEventType = (typeof RLM_EVENT_TYPES)[number]

/**
 * Verdict forms a judgment may carry (r9 §8). `check-pass` / `check-doubt` are
 * the check form — a judgment whose object is the state itself; both land as
 * events, so judgment-density accounting never mistakes a pass for absence.
 * `freeze` / `unfreeze` are the Phase D audit pair (r9 §7 reverse-filtering):
 * the arbiter's rejection of a criticism freezes the belief's trust-gate
 * eligibility; a human batch review lifts the freeze.
 */
export const RLM_VERDICT_FORMS = [
  'conclusion',
  'selection',
  'completion',
  'merge',
  'promotion',
  'demotion',
  'voiding',
  'rollback',
  'unpin',
  'experience',
  'handoff-nomination',
  'check-pass',
  'check-doubt',
  'freeze',
  'unfreeze',
] as const

export type RlmVerdictForm = (typeof RLM_VERDICT_FORMS)[number]

/** Criterion tiers (r9 §7): deterministic > structured > open. */
export const RLM_CRITERION_TIERS = ['deterministic', 'structured', 'open'] as const

export type RlmCriterionTier = (typeof RLM_CRITERION_TIERS)[number]

/** Belief grades (r9 §4). `open`-tier criteria can never produce `evidenced`. */
export const RLM_GRADES = ['provisional', 'evidenced'] as const

export type RlmGrade = (typeof RLM_GRADES)[number]

/** Belief kinds (r9 §4): statements about the world vs know-how. */
export type RlmBeliefKind = 'declarative' | 'procedural'

/** Verdict forms that create a belief node (require the `belief` payload). */
export const CREATING_VERDICTS: readonly RlmVerdictForm[] = [
  'conclusion',
  'selection',
  'completion',
  'merge',
  'experience',
  'check-pass',
  'promotion',
  'handoff-nomination',
]

/** Verdict forms that mutate an existing belief node (require `target`). */
export const TARGET_VERDICTS: readonly RlmVerdictForm[] = ['demotion', 'voiding', 'rollback', 'freeze', 'unfreeze']

/** Verdict forms that land as events without touching a node. */
export const EVENT_ONLY_VERDICTS: readonly RlmVerdictForm[] = ['check-doubt', 'unpin']

/** Scope kinds of authority (r9 §5): session streams and the mailbox stream. */
export type RlmScopeKind = 'session' | 'mailbox'

/** Free-form payload carried by non-judgment events; the store only checks shape. */
export interface RlmEventPayload {
  [key: string]: unknown
}

/** A registered criterion the judgment channel can reference. */
export interface RlmCriterion {
  /** Stable reference, e.g. `crit/loop-three-line-header`. */
  id: string
  tier: RlmCriterionTier
  /** Human-readable title for audit surfaces. */
  title: string
}

/**
 * The belief payload of a creating judgment (ARCHITECTURE.md §4/§7). Edges and
 * verification bookkeeping are written here, at judgment time — they cannot be
 * reconstructed after the fact.
 */
export interface RlmJudgmentBelief {
  kind: RlmBeliefKind
  /** The belief statement. */
  content: string
  title?: string
  /** Stable subject key (symbol / path / topic) for Phase B conflict detection. */
  subject?: string
  /** Supersedes edge: which belief id this replaces, and why. */
  supersedes?: { id: string; reason: string }
  /** Derivation edges: belief ids this was built from. */
  basedOn?: readonly string[]
  lastVerified?: {
    channel: string
    eventPos: number
    note?: string
    /** Mechanical checkpoint snapshot at verification time (touch key → checkpoint). */
    touchpoints?: Record<string, string>
  }
}

/**
 * The judgment payload: the four formal requirements of the judgment channel
 * (r9 §7) — criterion reference, data support, verdict, provenance. The store
 * enforces their *form*; it never guarantees the judgment was applied well.
 *
 * Verdict semantics: creating verdicts (`conclusion`, `selection`,
 * `completion`, `merge`, `experience`, `check-pass`, `promotion`,
 * `handoff-nomination`) require `belief`; `demotion` / `voiding` require
 * `target` (an existing belief id); `check-doubt` / `rollback` / `unpin` are
 * event-only.
 */
export interface RlmJudgmentPayload extends RlmEventPayload {
  criterionRef: string
  criterionTier: RlmCriterionTier
  verdict: RlmVerdictForm
  belief?: RlmJudgmentBelief
  /** Target belief id for `demotion` / `voiding`. */
  target?: string
  dataSupport: {
    summary: string
    refs?: readonly string[]
  }
  provenance: {
    /** Half-open-by-inclusion event range [from, to] in the same scope's stream. */
    eventRange: readonly [number, number]
    versionRef?: string
  }
}

/** One appended event: the only writable primitive of a scope. */
export interface RlmEvent {
  /** Per-scope monotonic sequence, 1-based. */
  seq: number
  type: RlmEventType
  /** ISO-8601 timestamp assigned at append time. */
  time: string
  payload: RlmEventPayload
}
