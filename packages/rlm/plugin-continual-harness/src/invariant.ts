/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-plugin-continual-harness`.
 * @module @deepseek-ai/dsh-plugin-continual-harness/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-plugin-continual-harness'

/** Cordis companion plugin name. */
export const name = 'plugin-continual-harness-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: harness state is file-backed (`harness_state.json`,
 * owned by the kernel runtime) and the section/command registrations are
 * private to the plugin's own apply fiber.
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
