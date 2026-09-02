/**
 * Base criteria: the human-seeded deployment assets of the judgment channel
 * (ARCHITECTURE.md §7, BUILD.md R4 — distribution is a deployment asset that
 * ships with the code and does not trace further; *evolution* is the runtime
 * mechanism). Producers register these onto their store instance; a judgment
 * referencing an unregistered criterion is refused.
 *
 * @module @deepseek-ai/dsh-plugin-rlm-store/criteria
 */

import type { RlmCriterion } from './events.ts'
import type { RlmStore } from './store.ts'

/**
 * The shipped base criterion set. Tiers follow §7: deterministic = code-checkable,
 * structured = model-scored against a template with code-checked form, open =
 * model-judged without a score (can never promote to evidenced).
 */
export const BASE_CRITERIA: readonly RlmCriterion[] = [
  {
    id: 'crit/loop-three-line-header',
    tier: 'deterministic',
    title: 'Loop audit three-line header (Status/Integrity/Contract audit parsed by code)',
  },
  {
    id: 'crit/evidence-gate-locatable',
    tier: 'deterministic',
    title: 'Evidence gate: provenance references locatable in the source stream',
  },
  {
    id: 'crit/refine-whitelist',
    tier: 'deterministic',
    title: '/refine proposal whitelist validation (structural; channelized form Phase B)',
  },
  {
    id: 'crit/verify-eq31-tournament',
    tier: 'structured',
    title: 'LLM-as-a-Verifier PPT tournament with Eq3.1 expected-score extraction',
  },
  {
    id: 'crit/moa-aggregator',
    tier: 'open',
    title: 'MoA aggregator synthesis (unscored; can never promote to evidenced)',
  },
  {
    id: 'crit/freshness-clock',
    tier: 'deterministic',
    title: 'Freshness clocks: checkpoint comparison and event distance (mechanical)',
  },
  {
    id: 'crit/kernel-harness-write',
    tier: 'open',
    title: 'Kernel-side harness write relayed over the host bridge (model-authored; provisional only)',
  },
  {
    id: 'crit/audit-pass',
    tier: 'structured',
    title: 'Reverse-filtering audit: the different-model critic raised no objection (check judgment)',
  },
  {
    id: 'crit/audit-freeze',
    tier: 'structured',
    title: 'Reverse-filtering audit: arbiter rejected the criticism; trust gate frozen pending batch human review',
  },
  {
    id: 'crit/audit-release',
    tier: 'structured',
    title: 'Reverse-filtering audit: human batch review lifts the freeze (unfreeze)',
  },
  {
    id: 'crit/audit-objection',
    tier: 'structured',
    title: 'Reverse-filtering audit: fallback criterion when an accepted objection names none of its own',
  },
]

/**
 * Register the base criteria onto a store. Idempotent per instance.
 * @param store - the store to seed.
 * @returns the store, for chaining.
 */
export function withBaseCriteria(store: RlmStore): RlmStore {
  for (const criterion of BASE_CRITERIA) store.registerCriterion(criterion)
  return store
}
