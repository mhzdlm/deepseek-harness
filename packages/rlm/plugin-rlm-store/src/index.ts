/**
 * Unified RLM storage core plugin (docs 仓 BUILD.md §1): exposes the per-scope
 * event streams, the materialized views, and the judgment channel as the
 * `rlm.store` Cordis service. Dependency-graph root of the rlm family —
 * imports no other rlm package; the other seven consume this service.
 *
 * @module @deepseek-ai/dsh-plugin-rlm-store
 */

import { homedir } from 'node:os'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { RlmStore } from './store.ts'
import { withBaseCriteria } from './criteria.ts'

export {
  RLM_EVENT_TYPES,
  RLM_VERDICT_FORMS,
  RLM_CRITERION_TIERS,
  RLM_GRADES,
  CREATING_VERDICTS,
  TARGET_VERDICTS,
  EVENT_ONLY_VERDICTS,
} from './events.ts'
export type {
  RlmEventType,
  RlmVerdictForm,
  RlmCriterionTier,
  RlmGrade,
  RlmBeliefKind,
  RlmCriterion,
  RlmEventPayload,
  RlmJudgmentPayload,
  RlmJudgmentBelief,
} from './events.ts'
export { RLM_EVENT_CATALOG, isKnownEventType } from './catalog.ts'
export { BASE_CRITERIA, withBaseCriteria } from './criteria.ts'
export { landToolOutcome, LANDING_CONTENT_CAP } from './land.ts'
export type { ToolLandingInput } from './land.ts'
export { observeReport, renderObserveReport } from './observe.ts'
export type {
  RlmObserveReport,
  ObserveScopeReport,
  ObserveDensityStats,
  ObserveNominationStats,
  ObserveFreshnessItem,
  ObserveMailboxStats,
  ObserveAuditStats,
} from './observe.ts'
export { beliefIdOf } from './beliefs.ts'
export type { RlmBeliefNode, RlmBeliefStatus, RlmLastVerified } from './beliefs.ts'
export { runAudit, listFrozenForReview, releaseAuditFreeze } from './audit.ts'
export type {
  RlmAuditCallCritic,
  RlmAuditOptions,
  RlmAuditOutcome,
  RlmAuditResult,
  RlmCriticReply,
  RlmFrozenReviewItem,
} from './audit.ts'
export {
  RlmStore,
  RlmStoreFormatError,
  RlmJudgmentError,
} from './store.ts'
export type { RlmScope, RlmJudgmentInput, RlmMaterializedView, RlmStoreListener } from './store.ts'

/** Plugin manifest name, matching the npm package identifier. */
export const name = 'plugin-rlm-store'
/** Cordis services this plugin requires at activation. */
export const inject: string[] = []

/** Plugin configuration for the unified store. */
export interface Config {
  /**
   * Base dir for the store's scope streams. Must match the family `dataDir`
   * (`~/.dsh/rlm`) so producers and projections agree on one authority.
   */
  dataDir?: string
}

/** Schemastery schema validating {@link Config} at plugin load. */
export const Config: z<Config> = z.object({
  dataDir: z.string(),
})

function expandHome(dir: string): string {
  if (dir === '~' || dir.startsWith('~/') || dir.startsWith('~\\')) {
    return `${homedir()}${dir.slice(1)}`
  }
  return dir
}

/**
 * Activates the plugin: exposes the store as the `rlm.store` service, seeded
 * with the base criteria (BUILD.md R4 — the shipped human-seeded set).
 * @param ctx - Cordis context used to provide the service.
 * @param config - Resolved plugin configuration.
 * @returns void
 */
export function apply(ctx: Context, config: Config): void {
  const dataDir = expandHome(config.dataDir?.trim() ? config.dataDir : '~/.dsh/rlm')
  ctx.provide('rlm.store', withBaseCriteria(new RlmStore(path.join(dataDir, 'store'))))
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Unified RLM store (event streams + judgment channel) provided by plugin-rlm-store. */
    'rlm.store'?: RlmStore
  }
}
