/**
 * ui-rlm browser half: keyed verify/moa toolview registration + locale
 * dictionaries + fiber-teardown removal (HMR safety) against the real slot
 * registry.
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { apply, inject } from '../src/client/index.ts'
import { RlmToolRow } from '../src/client/RlmToolRow.tsx'

interface PresentationCapture {
  slots: SlotRegistry
  dictionaries: Array<{ namespace: string; dictionaries: unknown }>
}

/** Provide the presentation registries and capture the plugin's registrations. */
function providePresentation(ctx: Context): PresentationCapture {
  const slots = new SlotRegistry(ctx)
  slots.register({
    name: 'root',
    children: { 'tool.call.toolview': { kind: 'keyed', scope: 'session' } },
  } as never, () => null)
  const dictionaries: Array<{ namespace: string; dictionaries: unknown }> = []
  ctx.provide('locale', {
    register(namespace: string, dictionaries_: unknown) {
      dictionaries.push({ namespace, dictionaries: dictionaries_ })
      return () => {}
    },
    bind: () => (key: string) => key,
  })
  return { slots, dictionaries }
}

describe('apply', () => {
  it('declares the services it binds', () => {
    expect(inject).toEqual(['slots', 'locale'])
  })

  it('registers the verify and moa tool rows and their dictionaries', async () => {
    const ctx = new Context()
    const presentation = providePresentation(ctx)
    await ctx.plugin({ inject: [...inject], apply }).await()
    const entries = presentation.slots.entries('tool.call.toolview')
    expect(entries.map(entry => entry.options.key)).toEqual(['verify', 'moa'])
    expect(entries.every(entry => entry.component === RlmToolRow)).toBe(true)
    expect(entries.every(entry => entry.locale === 'rlm')).toBe(true)
    expect(presentation.dictionaries).toHaveLength(1)
    expect(presentation.dictionaries[0]?.namespace).toBe('rlm')
    const zh = presentation.dictionaries[0]?.dictionaries as { zh: Record<string, string> }
    expect(zh.zh['row.degraded']).toBe('已降级')
  })

  it('removes both toolviews on fiber teardown (HMR safety)', async () => {
    const ctx = new Context()
    const presentation = providePresentation(ctx)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(presentation.slots.entries('tool.call.toolview')).toHaveLength(2)
    await fiber.dispose()
    expect(presentation.slots.entries('tool.call.toolview')).toHaveLength(0)
  })
})
