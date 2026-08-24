/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-plugin-rlm-moa`.
 * @module @deepseek-ai/dsh-plugin-rlm-moa/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-plugin-rlm-moa'

/** Cordis companion plugin name. */
export const name = 'plugin-rlm-moa-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the moa tool is a stateless orchestrator over the
 * context's LLM seam — its only persisted output is the JSONL trace sidecar,
 * which is an observability log rather than a package-owned event or
 * snapshot relation a companion could observe.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
