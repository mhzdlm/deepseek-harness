/**
 * The store's own event catalog, following the persistence-catalog pattern:
 * the read path refuses a stream containing a type outside this catalog, so
 * adding a member to RLM_EVENT_TYPES without a catalog entry fails the pinning
 * test in tests/catalog.spec.ts instead of silently diverging.
 *
 * @module @deepseek-ai/dsh-plugin-rlm-store/catalog
 */

import type { RlmEventType, RlmScopeKind } from './events.ts'

export interface RlmEventCatalogEntry {
  description: string
  /** Scopes whose stream may legally contain this type. */
  scopes: readonly RlmScopeKind[]
}

/**
 * Catalog of every event type the store accepts, keyed by event type. A stream
 * line whose type is absent here, or whose scope is not listed in `scopes`,
 * makes the stream unloadable (RlmStoreFormatError) rather than silently
 * extendable — forward-compat is a decision, not an accident.
 */
export const RLM_EVENT_CATALOG: Readonly<Record<RlmEventType, RlmEventCatalogEntry>> = {
  'rlm/observation': {
    description: 'A raw observation entering state (user message, tool result, world-reconciliation delta).',
    scopes: ['session'],
  },
  'rlm/mechanical': {
    description: 'A code-recorded trace with no semantic upgrade (cell execution, touched-file note, snapshot event).',
    scopes: ['session'],
  },
  'rlm/action-boundary': {
    description: 'A goal-scoped action boundary (delegation down/up, loop begin/record, explicit command).',
    scopes: ['session'],
  },
  'rlm/judgment': {
    description: 'The only belief-writing event; produced exclusively through judge() with the four formal requirements.',
    scopes: ['session', 'mailbox'],
  },
  'rlm/handoff': {
    description: 'Copy-protocol handoff: the session stream records "decided to hand over", the mailbox records "published".',
    scopes: ['session', 'mailbox'],
  },
  'rlm/rollback': {
    description: 'A rollback executed by code from a rollback verdict: target version plus reason; the world is never rolled back.',
    scopes: ['session'],
  },
  'rlm/human-revision': {
    description: 'A human semantic-exempt revision; mailbox-only (r9 §9) — physically detected via mailbox file drift.',
    scopes: ['mailbox'],
  },
}

const CATALOG_TYPES = new Set<string>(Object.keys(RLM_EVENT_CATALOG))

/**
 * Guard that an event type is known to the catalog.
 * @param type - the event type to check.
 * @returns true when the type has a catalog entry.
 */
export function isKnownEventType(type: string): type is RlmEventType {
  return CATALOG_TYPES.has(type)
}
