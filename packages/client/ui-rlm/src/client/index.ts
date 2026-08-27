/**
 * RLM tool rows plugin, browser half: registers the keyed `verify` and `moa`
 * toolviews. The host tools' renderers already name failed judges / references
 * in the result text; this row surfaces that degradation as a warning while
 * still disclosing the exact rendered output, replay-stable from each logged
 * call/result slice.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { RlmToolRow } from './RlmToolRow.tsx'
import { en, NS, zh, type RlmKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The verify / moa tool rows' copy. */
    rlm: RlmKey
  }
}

/** Required services: the slot and locale registries. */
export const inject = ['slots', 'locale']

/**
 * Client plugin body: register the keyed verify/moa tool rows and dictionaries.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-rlm: dictionaries')
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register(
    { name: 'tool.call.toolview', key: 'verify', locale: NS },
    RlmToolRow,
  ))
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register(
    { name: 'tool.call.toolview', key: 'moa', locale: NS },
    RlmToolRow,
  ))
}
