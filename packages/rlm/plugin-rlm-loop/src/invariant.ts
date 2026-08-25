/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-plugin-rlm-loop`.
 * @module @deepseek-ai/dsh-plugin-rlm-loop/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-plugin-rlm-loop'

/** Cordis companion plugin name. */
export const name = 'plugin-rlm-loop-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the loop tool is a stateless recorder over the shared
 * harness CAS pipeline, and its durable facts live in the session log events
 * plus harness state files that existing invariants already observe.
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
