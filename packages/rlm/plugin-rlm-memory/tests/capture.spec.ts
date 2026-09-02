/**
 * T7.3: the capture extraction child runs under a wall-clock budget — a child
 * that never settles resolves `[]` after the budget instead of dangling the
 * capture pipeline (the durable dialog still lands via `persistCapture`).
 */
import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import { extractDrafts, parseExtractionProposal } from '../src/capture.ts'

/** start() whose run result never settles unless its signal aborts. */
function hangingSubagents(): SubagentRuntime {
  return {
    start: (_provider: string, req: { signal: AbortSignal }) => ({
      result: new Promise<never>((_resolve, reject) => {
        if (req.signal.aborted) {
          reject(new Error('aborted'))
          return
        }
        req.signal.addEventListener('abort', () => reject(new Error('timed out')), { once: true })
      }),
    }),
  } as unknown as SubagentRuntime
}

const parent = { session: null } as unknown as Agent

describe('extractDrafts wall-clock budget (T7.3) and failure honesty (T7.5)', () => {
  it('rejects when the extraction child exceeds the budget', async () => {
    const started = Date.now()
    await expect(
      extractDrafts(hangingSubagents(), parent, 's1', 'dialog text', new AbortController().signal, 30),
    ).rejects.toThrow()
    // The budget, not the hung child, ends extraction.
    expect(Date.now() - started).toBeLessThan(5_000)
  }, 10_000)

  it('returns [] for an empty dialog without spawning a child', async () => {
    let spawned = false
    const runtime = {
      start: () => {
        spawned = true
        throw new Error('should not spawn')
      },
    } as unknown as SubagentRuntime
    const notes = await extractDrafts(runtime, parent, 's1', '   ', new AbortController().signal)
    expect(notes).toEqual([])
    expect(spawned).toBe(false)
  })

  it('rejects on a spawn error, distinguishing failure from a genuinely empty extraction', async () => {
    const runtime = {
      start: () => {
        throw new Error('child provider unavailable')
      },
    } as unknown as SubagentRuntime
    // A failed child must surface as a failure (runCapture audits
    // extractionRan=false), never fold into the empty-extraction `[]` result.
    await expect(
      extractDrafts(runtime, parent, 's1', 'dialog text', new AbortController().signal),
    ).rejects.toThrow(/child provider unavailable/)
  })

  it('returns [] for a child that ran clean but produced no notes', async () => {
    const runtime = {
      start: () => ({ result: Promise.resolve({ output: [{ type: 'text', text: 'Nothing worth remembering.' }] }) }),
    } as unknown as SubagentRuntime
    const notes = await extractDrafts(runtime, parent, 's1', 'dialog text', new AbortController().signal)
    expect(notes).toEqual([])
  })
})

describe('parseExtractionProposal', () => {
  it('parses a bare JSON array and drops entries without a source', () => {
    const text = JSON.stringify([
      { title: 't1', kind: 'procedure', source: 'turn:0', body: 'b1' },
      { title: 't2', body: 'no source' },
    ])
    const notes = parseExtractionProposal(text, 's1')
    expect(notes).toHaveLength(1)
    expect(notes[0]?.frontmatter.kind).toBe('procedure')
    expect(notes[0]?.frontmatter.source).toBe('turn:0')
  })

  it('recovers JSON fenced inside prose', () => {
    const text = 'Here are my notes:\n[{"title":"t","source":"contains:deploy","body":"b"}]\nDone.'
    const notes = parseExtractionProposal(text, 's1')
    expect(notes).toHaveLength(1)
    expect(notes[0]?.frontmatter.source).toBe('contains:deploy')
  })

  it('lands the model-generated title in the frontmatter (Phase 10, T6.19)', () => {
    const text = JSON.stringify([
      { title: 'Deploy rollback steps', source: 'turn:2', body: 'body one' },
      { title: '', source: 'turn:3', body: 'body two' },
    ])
    const notes = parseExtractionProposal(text, 's1')
    expect(notes).toHaveLength(2)
    // A non-empty title survives into the frontmatter instead of being
    // validated and dropped; an empty one is omitted entirely.
    expect(notes[0]?.frontmatter.title).toBe('Deploy rollback steps')
    expect(notes[1]?.frontmatter.title).toBeUndefined()
    // The title is descriptive only — the body is untouched.
    expect(notes[0]?.body).toBe('body one')
  })
})
