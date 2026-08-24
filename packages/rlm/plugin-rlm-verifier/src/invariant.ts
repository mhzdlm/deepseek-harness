/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-plugin-rlm-verifier`.
 * @module @deepseek-ai/dsh-plugin-rlm-verifier/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-plugin-rlm-verifier'

/** Cordis companion plugin name. */
export const name = 'plugin-rlm-verifier-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the verify tool is a stateless wrapper around the
 * TypeScript scoring/tournament engine on the host LLM seam, so there is no
 * package-owned event or snapshot for a companion to observe.
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
