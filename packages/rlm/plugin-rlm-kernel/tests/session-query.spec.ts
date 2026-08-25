/**
 * Unit tests for the `session.query` bridge handler: tail/grep reads over the
 * owning session's derived transcript, per-message and total output caps,
 * invalid-pattern refusal, and the owning-session requirement. The session is
 * structurally faked — the handler only touches `ctx.agents` (and never
 * writes).
 */
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { createHostHandlers } from '../src/host-handlers.ts'

interface FakeMessage {
  role: string
  content: Array<{ type: string; text?: string }>
}

function fakeCtx(messages: FakeMessage[], engine?: { searchSessions: (request: unknown) => Promise<unknown> }) {
  const ctx = {
    agents: {
      currentInitiator: () => ({
        session: { id: 'sess-q', deriveMessages: () => messages },
        options: { provider: 'p', model: 'm' },
      }),
    },
    get(name: string) {
      return name === 'sessionQuery' ? engine : undefined
    },
  }
  return ctx as unknown as Context
}

async function query(
  payload: Record<string, unknown>,
  messages: FakeMessage[] = [
    { role: 'user', content: [{ type: 'text', text: 'hello world' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'greetings WORLD again' }] },
    { role: 'user', content: [{ type: 'text', text: 'unrelated third' }] },
  ],
  engine?: { searchSessions: (request: unknown) => Promise<unknown> },
) {
  const { handlers } = createHostHandlers(fakeCtx(messages, engine), 'spawn', 'unused')
  const requireHandler = (name: string) => {
    const handler = handlers[name]
    if (!handler) throw new Error(`missing handler ${name}`)
    return handler
  }
  return (await requireHandler('session.query')(payload)) as {
    messages: Array<{ role: string; text: string }>
    truncated: boolean
    total: number
  }
}

describe('session.query bridge', () => {
  it('tail returns the most recent n rendered messages', async () => {
    const result = await query({ op: 'tail', n: 2 })
    expect(result.messages).toHaveLength(2)
    expect(result.messages[0]).toEqual({ role: 'assistant', text: 'greetings WORLD again' })
    expect(result.messages[1]).toEqual({ role: 'user', text: 'unrelated third' })
    expect(result.truncated).toBe(false)
    expect(result.total).toBe(3)
  })

  it('grep filters case-insensitively by regex and honors limit', async () => {
    const result = await query({ op: 'grep', pattern: 'world', limit: 10 })
    expect(result.messages).toHaveLength(2)
    expect(result.truncated).toBe(false)

    const capped = await query({ op: 'grep', pattern: 'world', limit: 1 })
    expect(capped.messages).toHaveLength(1)
    expect(capped.truncated).toBe(true)
  })

  it('caps each message and the total payload, flagging truncation', async () => {
    const long = 'y'.repeat(300)
    const result = await query(
      { op: 'tail', n: 50, maxChars: 200, maxTotal: 450 },
      [
        { role: 'user', content: [{ type: 'text', text: long }] },
        { role: 'assistant', content: [{ type: 'text', text: long }] },
        { role: 'user', content: [{ type: 'text', text: long }] },
      ],
    )
    // 200 + 200 fit inside the 450 total; the third would exceed it and is dropped.
    expect(result.messages).toHaveLength(2)
    expect(result.messages.every(m => m.text.length <= 200)).toBe(true)
    expect(result.truncated).toBe(true)
  })

  it('refuses an invalid regex loudly instead of returning everything', async () => {
    await expect(query({ op: 'grep', pattern: '[unclosed' })).rejects.toThrow(/invalid pattern/)
    await expect(query({ op: 'grep', pattern: '   ' })).rejects.toThrow(/non-empty pattern/)
  })

  it('requires an owning agent session', async () => {
    const { handlers } = createHostHandlers({ agents: { currentInitiator: () => undefined } } as unknown as Context, 'spawn', 'unused')
    await expect(handlers['session.query']!({ op: 'tail' })).rejects.toThrow(/owning agent/)
  })

  it('drops empty-text messages from the transcript view', async () => {
    const result = await query({ op: 'tail' }, [
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1' } as never] },
      { role: 'user', content: [{ type: 'text', text: 'visible' }] },
    ])
    expect(result.messages).toEqual([{ role: 'user', text: 'visible' }])
  })

  it('search maps cross-session hits through the optional engine (T1.1b)', async () => {
    const engine = {
      searchSessions: async (_request: unknown) => ({
        items: [
          { header: { id: 'sess-a', title: 'Auth work' }, bestMatch: { snippet: 'jwt rotation snippet' }, live: true },
          { header: { id: 'sess-b' }, bestMatch: { snippet: 'older jwt note' }, live: false },
        ],
        nextCursor: 'cursor-1',
      }),
    }
    const result = await query({ op: 'search', pattern: 'jwt', limit: 5 }, [], engine)
    expect(result.messages).toHaveLength(2)
    expect(result.messages[0]).toMatchObject({ sessionId: 'sess-a', title: 'Auth work', snippet: 'jwt rotation snippet', live: true })
    // A continuation cursor means more pages exist → flagged as truncated.
    expect(result.truncated).toBe(true)
  })

  it('fails loud when the session-query service is not mounted', async () => {
    await expect(query({ op: 'search', pattern: 'jwt' }, [])).rejects.toThrow(/session-query service/)
  })
})
