/**
 * Mount-path regression for the plugin entry (`src/index.ts` `apply()`).
 *
 * The T2.6 detail-archive wiring passes the kernel package's shared
 * `redactReferenceText` into the tool whenever `privacyFilter: 'full'`. That
 * reference once shipped without an import: tsc went red and any mount with
 * the `full` tier threw a ReferenceError at apply time, while every existing
 * suite stayed green because they either use the default tier or call
 * `createVerifyTool` directly. These cases drive the real `apply()` through a
 * minimal context so the mounted path cannot regress silently again.
 */
import { describe, expect, it } from 'vitest'
import { apply } from '../src/index.ts'

function fakeCtx() {
  const registered: unknown[] = []
  const effects: Array<() => void> = []
  const disposedHandlers: Array<(session: { id: string | number }) => void> = []
  const ctx = {
    on: (event: string, handler: (session: { id: string | number }) => void) => {
      if (event === 'session/disposed') disposedHandlers.push(handler)
      return () => undefined
    },
    get: () => undefined,
    effect: (fn: () => () => void, _label?: string) => {
      effects.push(fn)
      return fn()
    },
    tools: {
      register: (definition: unknown) => {
        registered.push(definition)
        return () => undefined
      },
    },
  }
  return { ctx, registered, disposedHandlers }
}

describe('verify plugin apply()', () => {
  it('mounts with privacyFilter "full" without throwing (redactor import regression)', () => {
    const { ctx, registered } = fakeCtx()
    expect(() => apply(ctx as never, { privacyFilter: 'full' })).not.toThrow()
    expect(registered).toHaveLength(1)
  })

  it('mounts with the default config and registers exactly the verify tool', () => {
    const { ctx, registered } = fakeCtx()
    expect(() => apply(ctx as never, {})).not.toThrow()
    expect(registered).toHaveLength(1)
  })
})
