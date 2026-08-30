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

  it('rejects over-long patterns outright', async () => {
    await expect(query({ op: 'grep', pattern: 'a'.repeat(201) })).rejects.toThrow(/pattern exceeds 200 characters/)
    await expect(query({ op: 'grep', pattern: 'a'.repeat(200) })).resolves.toBeDefined()
  })

  it('rejects catastrophic-backtracking patterns outright (T7.6)', async () => {
    // Exponential families: an unbounded quantifier over a group whose content
    // quantifies or alternates.
    await expect(query({ op: 'grep', pattern: '(a+)+' })).rejects.toThrow(/quantified group/)
    await expect(query({ op: 'grep', pattern: '(a|b)*' })).rejects.toThrow(/quantified group/)
    await expect(query({ op: 'grep', pattern: '(a{1,2})*' })).rejects.toThrow(/quantified group/)
    // Polynomial families: the same quantified atom repeated 3+ times.
    await expect(query({ op: 'grep', pattern: 'a*a*a*' })).rejects.toThrow(/repeats the same quantified atom/)
    await expect(query({ op: 'grep', pattern: '\\d+\\d+\\d+' })).rejects.toThrow(/repeats the same quantified atom/)
  })

  it('checks every quantified group, not just the first (Phase 8)', async () => {
    // The pre-Phase-8 guard exec'd only the FIRST quantified group, so a
    // leading benign group (`(ab)+`) laundered the trailing `(a+)+` past it.
    await expect(query({ op: 'grep', pattern: '(ab)+(a+)+' })).rejects.toThrow(/quantified group/)
    // Nested groups: the outer unbounded quantifier over `(a)+` (which nests a
    // group) is exponential even though the inner group itself is clean.
    await expect(query({ op: 'grep', pattern: '((a)+)+' })).rejects.toThrow(/quantified group/)
    await expect(query({ op: 'grep', pattern: '((ab)+)+' })).rejects.toThrow(/quantified group/)
    // An unbounded group containing an optional nested group is ambiguous too.
    await expect(query({ op: 'grep', pattern: '((a)?)+' })).rejects.toThrow(/quantified group/)
  })

  it('treats repeated quantified character classes like repeated atoms (Phase 8)', async () => {
    // Class content used to hide the repetition from the 3x rule.
    await expect(query({ op: 'grep', pattern: '[a-z]+[a-z]+[a-z]+' })).rejects.toThrow(/repeats the same quantified atom/)
    await expect(query({ op: 'grep', pattern: '[\\s\\S]*[\\s\\S]*[\\s\\S]*' })).rejects.toThrow(/repeats the same quantified atom/)
    // Two quantified classes stay allowed (below the ambiguity bar).
    await expect(query({ op: 'grep', pattern: '[a-z]+[a-z]+' })).resolves.toBeDefined()
  })

  it('allows bounded quantified forms that are not ReDoS-shaped (T7.6)', async () => {
    // A bounded outer quantifier and disjoint quantified atoms stay linear.
    await expect(query({ op: 'grep', pattern: '(1|2)?\\d' })).resolves.toBeDefined()
    await expect(query({ op: 'grep', pattern: '(ab)+' })).resolves.toBeDefined()
    await expect(query({ op: 'grep', pattern: '\\d+\\s*\\d+' })).resolves.toBeDefined()
    // Common real-world grep shapes must keep working (Phase 8 guard rewrite).
    await expect(query({ op: 'grep', pattern: '(\\w+)@(\\w+\\.\\w+)' })).resolves.toBeDefined()
    await expect(query({ op: 'grep', pattern: '.*error.*failed' })).resolves.toBeDefined()
  })

  it('marks grep truncated when the scan budget is exhausted', async () => {
    // Budget is 400k rendered characters; 50 messages of ~10k (the per-message
    // cap) total ~500k, so the budget cuts the scan before every message runs
    // under the regex.
    const big = 'z'.repeat(10_000)
    const messages: FakeMessage[] = Array.from({ length: 50 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: [{ type: 'text', text: `hit-${i} ${big}` }],
    }))
    const result = await query(
      { op: 'grep', pattern: 'hit-(1|2)?\\d', limit: 100, maxChars: 10_000 },
      messages,
    )
    expect(result.truncated).toBe(true)
    expect(result.messages.length).toBeGreaterThan(0)
    expect(result.messages.length).toBeLessThan(50)
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
