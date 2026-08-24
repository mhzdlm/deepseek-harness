/**
 * Runtime emission tests for the verify process events, with the transport
 * injected: a failing callModel proves the request event is written even
 * when scoring fails and that no result event follows. Also pins
 * emitVerifyEvent's best-effort contract against a throwing session.
 */
import { describe, expect, it } from 'vitest'
import { createVerifyTool } from '../src/verify-tool.ts'
import { emitVerifyEvent } from '../src/events.ts'

function recordingSession() {
  const appended: Array<{ name: string; payload: Record<string, unknown> }> = []
  const session = {
    id: 'sess-verify-ev',
    append: (name: string, payload: unknown) => { appended.push({ name, payload: payload as Record<string, unknown> }) },
  }
  return { session, appended }
}

describe('verify process events', () => {
  it('emits the request event even when scoring fails; no result follows', async () => {
    const { session, appended } = recordingSession()
    const tool = createVerifyTool({
      callModel: async () => { throw new Error('route down') },
      provider: 'probe',
      model: 'probe-model',
      privacyFilter: '',
    })
    await expect(
      tool.execute({ problem: 'p', candidates: ['a', 'b'] }, { signal: new AbortController().signal, agent: { session } } as never),
    ).resolves.toBeDefined()
    // on_error tie semantics: failed calls become 0.5/0.5 ties, so both the
    // request and the result event land in the log.
    expect(appended.map(e => e.name)).toEqual(['session/verify-request', 'session/verify-result'])
    const request = appended[0]?.payload as { engine: string; models: string[] } | undefined
    expect(request?.engine).toBe('seam')
    expect(request?.models).toEqual(['probe-model'])
  })

  it('emitVerifyEvent swallows persistence failures and skips null sessions', () => {
    const throwing = { append: () => { throw new Error('disk full') } }
    expect(() =>
      emitVerifyEvent(throwing as never, 'session/verify-request', {
        engine: 'seam',
        models: ['m'],
        criteria: {},
        candidateCount: 2,
        candidatesDigest: [],
      }),
    ).not.toThrow()
    expect(() =>
      emitVerifyEvent(null, 'session/verify-result', {
        engine: 'seam',
        models: [],
        index: -1,
        scores: [],
        ranking: [],
        nComparisons: 0,
        durationMs: 0,
      }),
    ).not.toThrow()
  })
})
