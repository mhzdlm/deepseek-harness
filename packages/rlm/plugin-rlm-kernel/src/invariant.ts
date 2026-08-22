/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-plugin-rlm-kernel`.
 * @module @deepseek-ai/dsh-plugin-rlm-kernel/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-plugin-rlm-kernel'

/** Cordis companion plugin name. */
export const name = 'plugin-rlm-kernel-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the kernel lifetime and host-bridge handler map are
 * private to the plugin's own `apply` fiber and expose no package-owned event
 * or snapshot that an independent companion can observe.
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
