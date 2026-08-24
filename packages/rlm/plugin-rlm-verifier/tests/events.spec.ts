/**
 * Runtime emission tests for the verify process events, without any provider
 * traffic: `node:child_process.spawn` is mocked to fail immediately, so the
 * subprocess path rejects after dispatch — proving the request event is
 * written even when scoring fails and that no result event follows. Also
 * pins emitVerifyEvent's best-effort contract against a throwing session.
 */
import { describe, expect, it, vi } from 'vitest'
import { createVerifyTool } from '../src/verify-tool.ts'
import { emitVerifyEvent } from '../src/events.ts'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: vi.fn(() => { throw new Error('spawn blocked in test') }) }
})

function recordingSession() {
  const appended: Array<{ name: string; payload: Record<string, unknown> }> = []
  const session = {
    id: 'sess-verify-ev',
    append: (name: string, payload: unknown) => { appended.push({ name, payload: payload as Record<string, unknown> }) },
  }
  return { session, appended }
}

describe('verify process events', () => {
  it('emits the request event even when the scoring subprocess fails; no result follows', async () => {
    const { session, appended } = recordingSession()
    const tool = createVerifyTool({
      getKernels: () => undefined,
      model: 'deepseek-v4-flash',
      privacyFilter: '',
    })
    await expect(
      tool.execute({ problem: 'p', candidates: ['a', 'b'] }, { signal: new AbortController().signal, agent: { session } } as never),
    ).rejects.toThrow()
    const request = appended.find(e => e.name === 'session/verify-request')
    expect(request).toBeDefined()
    if (!request) return
    expect(request.payload.mode).toBe('subprocess')
    expect((request.payload.candidatesDigest as string[]).length).toBe(2)
  })

  it('emitVerifyEvent swallows persistence failures', () => {
    const throwing = { append: () => { throw new Error('disk full') } }
    expect(() =>
      emitVerifyEvent(throwing as never, 'session/verify-request', {
        mode: 'subprocess',
        models: ['m'],
        criteria: {},
        candidateCount: 2,
        candidatesDigest: [],
      }),
    ).not.toThrow()
    expect(() => emitVerifyEvent(null, 'session/verify-result', { models: [], index: -1, scores: [], ranking: [], nComparisons: 0, durationMs: 0 })).not.toThrow()
  })
})
