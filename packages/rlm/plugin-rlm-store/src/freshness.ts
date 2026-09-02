/**
 * Freshness (ARCHITECTURE.md §7 as amended in r11): the single axis is
 * "transitively depends on external objects", derived MECHANICALLY from the
 * belief's provenance event range ∪ the scope's touch ledger — never from
 * declared edges. A missed based_on edge degrades revision-propagation
 * recall, not freshness correctness.
 *
 * Two clocks:
 * - external: any key in the derived dependency set whose checkpoint changed
 *   after the belief's verification snapshot → stale;
 * - internal: no external dependency → distance between the verification
 *   position (or creation) and the stream head exceeding the configured
 *   distance → stale (experience products age with the process);
 * - analytic beliefs (no last_verified, no touches, no dependencies) are not
 *   time-degradable — only supersedes can overturn them.
 *
 * @module @deepseek-ai/dsh-plugin-rlm-store/freshness
 */

import type { RlmBeliefNode } from './beliefs.ts'
import type { RlmMaterializedView } from './store.ts'

/** Verdict of one freshness evaluation. */
export interface FreshnessVerdict {
  beliefId: string
  /** Which clock governs this belief after mechanical derivation. */
  clock: 'external' | 'internal' | 'analytic'
  /** True when the clock says the belief must be demoted. */
  stale: boolean
  /** Mechanical reasons (audit surface). */
  reasons: string[]
}

export interface FreshnessOptions {
  /** Internal-clock distance: verification-to-head event distance past which experience beliefs go stale. */
  internalClockDistance: number
}

/**
 * Collect the belief's transitive basedOn dependencies — the UPSTREAM closure
 * (what the belief rests on), self included. Both consumers need this
 * direction: freshness inheritance ("a dependency on an externally clocked
 * belief makes this one externally clocked") and the F4 invariant ("no active
 * belief may rest on a voided foundation"). Downstream flooding — voiding's
 * dependent propagation — is a separate walk in the reducer.
 * @param view - the scope's materialized view.
 * @param belief - the belief to expand.
 * @returns dependency ids, self included.
 */
export function dependencyClosure(view: RlmMaterializedView, belief: RlmBeliefNode): Set<string> {
  const seen = new Set<string>([belief.id])
  const queue = [...belief.basedOn]
  while (queue.length > 0) {
    const current = queue.shift()
    if (current === undefined || seen.has(current)) continue
    seen.add(current)
    const dep = view.beliefs.find(b => b.id === current)
    if (dep) queue.push(...dep.basedOn)
  }
  return seen
}

/**
 * External touch keys implied by a belief: the touch keys recorded by events
 * inside its provenance range (mechanical derivation over the stream).
 * @param view - the scope's materialized view.
 * @param belief - the belief whose provenance range to scan.
 * @returns touch keys, deduplicated.
 */
export function provenanceTouchKeys(view: RlmMaterializedView, belief: RlmBeliefNode): Set<string> {
  const keys = new Set<string>()
  for (const touch of view.touchLedger) {
    if (touch.seq >= belief.provenanceFrom && touch.seq <= belief.provenanceTo) keys.add(touch.key)
  }
  return keys
}

/**
 * Evaluate one belief's freshness (r11 single-axis, mechanical).
 * @param view - the scope's materialized view.
 * @param belief - the belief to evaluate.
 * @param options - freshness thresholds.
 * @returns the verdict with clock attribution and reasons.
 */
export function evaluateBeliefFreshness(
  view: RlmMaterializedView,
  belief: RlmBeliefNode,
  options: FreshnessOptions,
): FreshnessVerdict {
  const reasons: string[] = []

  // Self external dependencies: keys touched inside the provenance range.
  const ownKeys = provenanceTouchKeys(view, belief)

  // Transitively inherited dependencies: any dependency on an externally
  // clocked belief makes this belief externally clocked (pessimistic mix).
  let inheritedExternal = false
  for (const depId of dependencyClosure(view, belief)) {
    if (depId === belief.id) continue
    const dep = view.beliefs.find(b => b.id === depId)
    if (dep && provenanceTouchKeys(view, dep).size > 0) inheritedExternal = true
  }

  const externallyClocked = ownKeys.size > 0 || inheritedExternal

  if (!externallyClocked) {
    // No external dependency. Analytic beliefs (declared by the producer with
    // channel 'analytic' — mathematics and pure internal method) are never
    // time-degradable; everything else is an experience product and ages on
    // the internal clock.
    const declaredAnalytic = belief.lastVerified?.channel === 'analytic'
    if (belief.basedOn.length === 0 && declaredAnalytic) {
      return { beliefId: belief.id, clock: 'analytic', stale: false, reasons: [] }
    }
    const verifiedAt = belief.lastVerified?.eventPos ?? belief.createdAt
    const distance = view.seq - verifiedAt
    if (distance > options.internalClockDistance) {
      reasons.push(`internal clock: ${distance} events since verification (threshold ${options.internalClockDistance})`)
      return { beliefId: belief.id, clock: 'internal', stale: true, reasons }
    }
    return { beliefId: belief.id, clock: 'internal', stale: false, reasons: [] }
  }

  // External clock: compare the belief's verification snapshot of each key's
  // checkpoint against the ledger's current checkpoint.
  const keys = new Set(ownKeys)
  for (const depId of dependencyClosure(view, belief)) {
    const dep = depId === belief.id ? undefined : view.beliefs.find(b => b.id === depId)
    if (!dep) continue
    for (const key of provenanceTouchKeys(view, dep)) keys.add(key)
  }
  for (const key of keys) {
    const current = [...view.touchLedger].reverse().find(t => t.key === key)
    const verified = belief.lastVerified?.touchpoints?.[key]
    if (current && verified !== undefined && current.checkpoint !== verified) {
      reasons.push(`external clock: touch '${key}' checkpoint changed after verification (${verified} → ${current.checkpoint})`)
    }
  }
  if (reasons.length > 0) return { beliefId: belief.id, clock: 'external', stale: true, reasons }
  return { beliefId: belief.id, clock: 'external', stale: false, reasons: [] }
}

/**
 * F4 invariant (RETREE / BUILD.md Phase B): every belief whose dependency
 * closure contains a voided belief is itself voided — no active belief may
 * rest on a retracted foundation.
 * @param view - the scope's materialized view.
 * @returns violating belief ids (must be empty on a healthy view).
 */
export function closureInvariantViolations(view: RlmMaterializedView): string[] {
  const violations: string[] = []
  for (const belief of view.beliefs) {
    if (belief.status !== 'active') continue
    for (const depId of dependencyClosure(view, belief)) {
      const dep = depId === belief.id ? undefined : view.beliefs.find(b => b.id === depId)
      if (dep && dep.status === 'voided') {
        violations.push(belief.id)
        break
      }
    }
  }
  return violations
}
