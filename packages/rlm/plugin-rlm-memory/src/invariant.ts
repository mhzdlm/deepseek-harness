/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-plugin-rlm-memory`.
 * @module @deepseek-ai/dsh-plugin-rlm-memory/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-plugin-rlm-memory'

/** Cordis companion plugin name. */
export const name = 'plugin-rlm-memory-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the evidence gate (REME.md §5.1 D6) is enforced at draft
 * write time inside {@link persistCapture} — a note without a `source` that
 * locates in its `dialog/<id>.jsonl` is dropped before it lands, so the durable
 * store is already guaranteed gate-clean. The gate relation is checked against
 * the resolved `memoryDir`, which lives in the plugin's resolved Config, not in
 * the companion's child fiber; re-resolving it here would duplicate the plugin's
 * path logic without adding a check the write path does not already perform.
 * Phase C (rollback/audit) will add a store-consistency check that belongs in the
 * consolidation path, where the gate relation is re-derived per operation.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
