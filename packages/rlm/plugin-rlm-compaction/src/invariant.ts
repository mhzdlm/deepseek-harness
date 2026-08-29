/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-plugin-rlm-compaction`.
 * @module @deepseek-ai/dsh-plugin-rlm-compaction/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-plugin-rlm-compaction'

/** Cordis companion plugin name. */
export const name = 'plugin-rlm-compaction-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the engine is a subclass of the official
 * `BasicCompactionEngine` and registers only through that base class's lifecycle;
 * no package-private state needs an invariant guard beyond the base contract.
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
