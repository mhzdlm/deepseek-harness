/**
 * Keyless contract test for the mounted scoring chain:
 * `apply()` → `callSeamModel` (BlockAssembler over real StreamChunk shapes)
 * → chosen-token logprobs → extractScore → PPT selection.
 *
 * The v1 LLM seam serves chosen-token logprobs only — one alternative per
 * position — so Eq 3.1's expectation equals the chosen letter's scale value.
 * These cases pin that end-to-end reality (chunk shapes, the logprobs opt-in,
 * route propagation, and the degenerate-extraction semantics) so a future
 * variant-serving seam changes behavior consciously instead of silently.
 *
 * The fake judge is SLOT-AWARE on purpose: scorePairOnSeam swaps the prompt
 * slots on odd repetitions and maps rewards back, so a static reply would
 * average to 0.5/0.5 across reps. Reading which candidate sits in each slot
 * keeps every repetition voting for the same candidate.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { apply } from '../src/index.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** One realistic chosen-token-only seam response: one text block plus one
 * logprob entry per character — exactly one alternative per position. */
function scoringStream(text: string, verdictLogprob: number): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'logprobs', index: 0, tokens: [...text].map(ch => ({ token: ch, logprob: verdictLogprob })) },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** Slot-aware judge reply: always awards the better letter to `winner`. */
function judgeReply(userText: string, winner: 'sol-a' | 'sol-b'): string {
  const aInSlotA = /\*\*Trajectory A:\*\*\nsol-a\b/.test(userText)
  const winnerInSlotA = winner === 'sol-a' ? aInSlotA : !aInSlotA
  const scoreA = winnerInSlotA ? 'A' : 'T'
  const scoreB = winnerInSlotA ? 'T' : 'A'
  return `Analysis.\n<score_A> ${scoreA} </score_A>\n<score_B> ${scoreB} </score_B>`
}

interface VerifyToolShape {
  execute: (args: unknown, exec: unknown) => Promise<{
    index: number
    scores: number[]
    ranking: number[]
    nComparisons: number
  }>
}

function mountSeam(winner: 'sol-a' | 'sol-b', verdictLogprob: number) {
  const calls: GenerateOptions[] = []
  const registered: unknown[] = []
  const dataDir = mkdtempSync(path.join(tmpdir(), 'dsh-rlm-seamcontract-'))
  roots.push(dataDir)
  const ctx = {
    on: () => () => undefined,
    get: () => undefined,
    effect: (fn: () => () => void) => fn(),
    tools: {
      register: (definition: unknown) => {
        registered.push(definition)
        return () => undefined
      },
    },
    llm: {
      async *stream(options: GenerateOptions) {
        calls.push(options)
        const blocks = (options.messages?.[0]?.content ?? []) as Array<{ type: string; text?: string }>
        const userText = blocks.map(block => (block.type === 'text' ? (block.text ?? '') : '')).join('')
        yield* scoringStream(judgeReply(userText, winner), verdictLogprob)
      },
    },
  }
  apply(ctx as never, { dataDir })
  const tool = registered[0] as VerifyToolShape
  expect(tool).toBeDefined()
  return { calls, tool }
}

describe('mounted verify tool over a realistic seam stream', () => {
  it('extracts verdict letters from chosen-token logprobs and ranks the winner first', async () => {
    const { tool } = mountSeam('sol-a', -0.05)
    const result = await tool.execute({ problem: 'p', candidates: ['sol-a', 'sol-b'] }, {})
    expect(result.index).toBe(0)
    expect(result.ranking[0]).toBe(0)
    expect(result.scores).toHaveLength(2)
    expect(result.scores[0]).toBeGreaterThan(result.scores[1])
    expect(result.nComparisons).toBeGreaterThan(0)
  })

  it('requests chosen-token logprobs on every scoring call and routes through the configured seam', async () => {
    const { calls, tool } = mountSeam('sol-a', -0.05)
    await tool.execute({ problem: 'p', candidates: ['sol-a', 'sol-b'] }, {})
    expect(calls.length).toBeGreaterThan(0)
    for (const options of calls) {
      expect(options.logprobs).toEqual({ topLogprobs: 20 })
      expect(options.provider).toBe('deepseek-official')
      expect(options.model).toBe('deepseek-v4-flash')
    }
  })

  it('flips the winner when the judge prefers the other candidate', async () => {
    const { tool } = mountSeam('sol-b', -0.05)
    const result = await tool.execute({ problem: 'p', candidates: ['sol-a', 'sol-b'] }, {})
    expect(result.index).toBe(1)
    expect(result.scores[1]).toBeGreaterThan(result.scores[0])
  })

  it('keeps scores identical under wildly different verdict logprobs (v1 single-alternative degeneration)', async () => {
    const quiet = mountSeam('sol-a', -0.01)
    const loud = mountSeam('sol-a', -4)
    const a = await quiet.tool.execute({ problem: 'p', candidates: ['sol-a', 'sol-b'] }, {})
    const b = await loud.tool.execute({ problem: 'p', candidates: ['sol-a', 'sol-b'] }, {})
    // One alternative per position: p = exp(logprob) normalizes away, so the
    // expectation collapses to the chosen letter's scale value either way.
    expect(b.scores).toEqual(a.scores)
    expect(b.ranking).toEqual(a.ranking)
  })
})
