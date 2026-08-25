/**
 * Seam-engine unit tests for the `verify` tool. The transport is injected,
 * so provider traffic never happens; fixtures emit score-tag text plus
 * matching chosen-token logprobs and pin Eq 3.1 extraction, PPT selection
 * counts, slot-swap bias cancellation, on-error ties, auto_spawn truncation,
 * and the process-event sequence through a recording session.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { TokenLogprob } from '@deepseek-ai/dsh-llm'
import { Context } from '@deepseek-ai/cordis'
import * as PluginRlmVerifier from '@deepseek-ai/dsh-plugin-rlm-verifier'
import { createVerifyTool } from '../src/verify-tool.ts'
import type { VerifyCallModel, VerifyToolOptions } from '../src/verify-tool.ts'

const TAGS = ['<score_A> A </score_A>', '<score_B> T </score_B>'] as const

/** Transport that answers every scoring call with A=20 / T=1 distributions. */
function biasedToA(): { callModel: VerifyCallModel; prompts: string[] } {
  const prompts: string[] = []
  const callModel: VerifyCallModel = async (request) => {
    prompts.push(request.userText)
    const tokens: TokenLogprob[] = [
      { token: TAGS[0], logprob: -0.01 },
      { token: 'A', logprob: -0.02 },
      { token: TAGS[1], logprob: -0.01 },
      { token: 'T', logprob: -3.5 },
    ]
    return {
      text: `analysis\n${TAGS[0]}\n${TAGS[1]}`,
      logprobs: tokens,
    }
  }
  return { callModel, prompts }
}

function baseOptions(overrides: Partial<VerifyToolOptions> = {}): VerifyToolOptions {
  return {
    callModel: async () => ({ text: 'x', logprobs: [] }),
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    privacyFilter: '',
    ...overrides,
  }
}

const execStub = { signal: new AbortController().signal } as never

describe('verify seam engine', () => {
  it('selects the logprobs-favored candidate via the PPT', async () => {
    const { callModel, prompts } = biasedToA()
    const tool = createVerifyTool(baseOptions({ callModel }))
    const value = (await tool.execute(
      { problem: 'reverse a string', candidates: ['good', 'bad'] },
      execStub,
    )) as { index: number; scores: number[]; ranking: number[]; nComparisons: number }

    expect(value.index).toBe(0)
    expect(value.ranking).toEqual([0, 1])
    // N=2, k clamped to 2: ring(2) + pivot pair(1) = 3 directed comparisons.
    expect(value.nComparisons).toBe(3)
    expect(prompts.length).toBeGreaterThanOrEqual(3)
    expect(prompts[0]).toContain('<score_A> LETTER_A_TO_T </score_A>')
  })

  it('swaps prompt slots on odd repetitions so first-slot bias cancels', async () => {
    // Judge always prefers whoever sits in slot A — with K=2 reps the bias
    // cancels and both candidates end at mean 0.5.
    const seenOrders: string[] = []
    const callModel: VerifyCallModel = async (_request) => {
      void _request
      return { text: `${TAGS[0]}\n${TAGS[1]}`, logprobs: [] }
    }
    const instrumented: VerifyCallModel = async (request) => {
      const segment = (request.userText.split('**Trajectory A:**')[1] ?? '').split('**Trajectory B:**')[0] ?? ''
      seenOrders.push(segment.includes('CAND_A') ? 'A-first' : 'B-first')
      return callModel(request)
    }
    const candidates = ['traj CAND_A', 'traj CAND_B']
    const tool = createVerifyTool(baseOptions({
      callModel: instrumented,
      maxTokens: 4_096,
    }))
    const value = (await tool.execute(
      { problem: 'p', candidates, n_evaluations: 2 },
      execStub,
    )) as { scores: number[] }

    expect(seenOrders).toContain('A-first')
    expect(seenOrders).toContain('B-first')
    expect(Math.abs((value.scores[0] ?? 0) - 0.5)).toBeLessThan(1e-9)
  })

  it('scores failed calls as neutral ties instead of failing the run', async () => {
    const callModel: VerifyCallModel = async () => {
      throw new Error('route down')
    }
    const tool = createVerifyTool(baseOptions({ callModel }))
    const value = (await tool.execute(
      { problem: 'p', candidates: ['a', 'b'] },
      execStub,
    )) as { scores: number[]; nComparisons: number }
    expect(value.scores[0]).toBeCloseTo(0.5)
    expect(value.scores[1]).toBeCloseTo(0.5)
    expect(value.nComparisons).toBeGreaterThan(0)
  })

  it('fuses two judge panels and records request/result events', async () => {
    const appended: Array<{ name: string; payload: Record<string, unknown> }> = []
    const session = {
      id: 'sess-j',
      append: (name: string, payload: unknown) => { appended.push({ name, payload: payload as Record<string, unknown> }) },
    }
    const callModel: VerifyCallModel = async (request) => {
      const prefersA = request.route.model === 'judge-a'
      return {
        text: prefersA ? `${TAGS[0]}\n${TAGS[1]}` : `${TAGS[1]}\n${TAGS[0]}`,
        logprobs: [
          { token: TAGS[0], logprob: -0.01 },
          { token: prefersA ? 'A' : 'T', logprob: -0.02 },
          { token: TAGS[1], logprob: -0.03 },
          { token: prefersA ? 'T' : 'A', logprob: -2 },
        ],
      }
    }
    const tool = createVerifyTool(baseOptions({
      callModel,
      judgeProfiles: {
        'judge-a': { model: 'model-a' },
        'judge-b': { model: 'model-b' },
      },
    }))
    const value = (await tool.execute(
      { problem: 'p', candidates: ['cand-A', 'cand-B'], judges: ['judge-a', 'judge-b'] },
      { signal: new AbortController().signal, agent: { session } } as never,
    )) as { judges: Array<{ model: string; status: string }>; nComparisons: number }

    expect(value.judges.map(j => j.status)).toEqual(['ok', 'ok'])
    expect(value.nComparisons).toBeGreaterThan(0)
    const names = appended.map(a => a.name)
    expect(names[0]).toBe('session/verify-request')
    expect(names.at(-1)).toBe('session/verify-result')
    const request = appended[0]?.payload as { models: string[] } | undefined
    expect(request?.models).toEqual(['model-a', 'model-b'])
  })

  it('auto_spawn builds the candidate pool from spawned children', async () => {
    const started: string[] = []
    const subagents = {
      start: async (_provider: string, request: { label?: string }) => {
        started.push(request.label ?? '')
        return {
          id: `run-${started.length}`,
          result: Promise.resolve({
            output: [{ type: 'text' as const, text: `child answer ${request.label}` }],
          }),
        }
      },
    }
    const prompts: string[] = []
    const tool = createVerifyTool(baseOptions({
      subagents: subagents as never,
      maxChildChars: 1000,
      callModel: async (request) => {
        prompts.push(request.userText)
        return { text: 'x', logprobs: [] }
      },
    }))
    const execWithAgent = { signal: new AbortController().signal, agent: { session: { id: 'sess-auto' } } }
    await tool.execute({ problem: 'p', candidates: [], auto_spawn: 2 }, execWithAgent as never)
    expect(started).toEqual(['verify-child-1', 'verify-child-2'])
    expect(prompts.join('\n')).toContain('child answer verify-child-1')
    expect(prompts.join('\n')).toContain('child answer verify-child-2')
  })

  it('truncates each auto_spawn child result to maxChildChars', async () => {
    const longAnswer = `${'A'.repeat(20)}MARKER-BEYOND-LIMIT`
    const subagents = {
      start: async () => ({
        result: Promise.resolve({ output: [{ type: 'text' as const, text: longAnswer }] }),
      }),
    }
    const prompts: string[] = []
    const tool = createVerifyTool(baseOptions({
      subagents: subagents as never,
      maxChildChars: 20,
      callModel: async (request) => {
        prompts.push(request.userText)
        return { text: TAGS[0], logprobs: [{ token: 'A', logprob: -0.01 }] }
      },
    }))
    await tool.execute(
      { problem: 'p', candidates: [], auto_spawn: 2 },
      { signal: new AbortController().signal, agent: { session: { id: 'sess-trunc' } } } as never,
    )
    const joined = prompts.join('\n')
    expect(joined).toContain('A'.repeat(20))
    expect(joined).not.toContain('MARKER-BEYOND-LIMIT')
  })

  it('full privacy mode masks keys in event digests but not in scoring prompts', async () => {
    const appended: Array<{ name: string; payload: Record<string, unknown> }> = []
    const session = {
      id: 'sess-redact',
      append: (name: string, payload: unknown) => { appended.push({ name, payload: payload as Record<string, unknown> }) },
    }
    const secret = 'sk-abcd1234567890xyz'
    const prompts: string[] = []
    const tool = createVerifyTool(baseOptions({
      privacyFilter: 'full',
      callModel: async (request) => {
        prompts.push(request.userText)
        return { text: TAGS[0], logprobs: [{ token: 'A', logprob: -0.01 }] }
      },
    }))
    await tool.execute(
      { problem: 'p', candidates: [`candidate with ${secret} embedded`, 'plain candidate'] },
      { signal: new AbortController().signal, agent: { session } } as never,
    )

    const requestEvent = appended.find(a => a.name === 'session/verify-request')?.payload as
      | { candidatesDigest?: string[] }
      | undefined
    expect(requestEvent?.candidatesDigest?.join('\n')).toContain('[redacted key]')
    expect(requestEvent?.candidatesDigest?.join('\n')).not.toContain(secret)
    // The scoring prompt itself intentionally keeps the raw text (STATUS: full 档只脱敏事件面).
    expect(prompts.join('\n')).toContain(secret)
  })

  it('display privacy mode annotates judge provenance in the rendered output', async () => {
    const callModel: VerifyCallModel = async () => ({
      text: TAGS[0],
      logprobs: [{ token: 'A', logprob: -0.01 }],
    })
    const tool = createVerifyTool(baseOptions({
      privacyFilter: 'display',
      callModel,
      judgeProfiles: { 'judge-a': { model: 'model-a' } },
    }))
    const value = (await tool.execute(
      { problem: 'p', candidates: ['c1', 'c2'], judges: ['judge-a'] },
      execStub,
    )) as { judges: Array<{ model: string; status: string }> }

    const definition = tool as unknown as {
      output: { render: (args: unknown, value: unknown) => Array<{ type: string; text: string }> }
    }
    const blocks = definition.output.render({}, value)
    const text = blocks.map(b => b.text).join('\n')
    expect(text).toContain('verify panel (1 judges)')
    expect(text).toMatch(/✓ model-a/)
  })

  it('session/disposed aborts an in-flight auto_spawn child (AUDIT P1-1 regression)', async () => {
    const signals: AbortSignal[] = []
    const subagents = {
      start: async (_provider: string, request: { signal: AbortSignal }) => {
        signals.push(request.signal)
        const result = new Promise((_resolve, reject) => {
          request.signal.addEventListener('abort', () => reject(new Error('child cancelled by disposal')))
        })
        return { result }
      },
    }

    // Mount the real plugin apply() with minimal service stubs so the
    // trackController + session/disposed wiring under test is shipped code.
    let registeredTool: { execute: (args: Record<string, unknown>, exec: unknown) => Promise<unknown> } | undefined
    const ctx = new Context()
    ctx.provide('tools', {
      register: (definition: typeof registeredTool) => {
        registeredTool = definition
        return () => undefined
      },
    })
    ctx.provide('llm', {})
    ctx.provide('subagents', subagents)
    await ctx.plugin(PluginRlmVerifier, {})
    expect(registeredTool).toBeDefined()

    const exec = { signal: new AbortController().signal, agent: { session: { id: 'sess-dispose-v' } } }
    const pending = registeredTool?.execute({ problem: 'p', candidates: [], auto_spawn: 1 }, exec)
    await new Promise(resolve => setTimeout(resolve, 0))

    ctx.emit('session/disposed', { id: 'sess-dispose-v' } as never)
    await expect(pending).rejects.toThrow(/child cancelled by disposal/)
    expect(signals[0]?.aborted).toBe(true)
  })

  it('writes a full-detail file and links auto_spawn child sessions (T2.6)', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'dsh-rlm-vdetail-'))
    const cleanupRoots = [root]
    afterEach(() => {
      for (const dir of cleanupRoots.splice(0)) rmSync(dir, { recursive: true, force: true })
    })
    const artifactRoot = path.join(root, 'session-artifacts')
    const appended: Array<{ name: string; payload: Record<string, unknown> }> = []
    const session = {
      id: 'sess-detail',
      append: (name: string, payload: unknown) => { appended.push({ name, payload: payload as Record<string, unknown> }) },
    }
    const subagents = {
      start: async (_provider: string, request: { label?: string }) => ({
        id: `child-${request.label}`,
        result: Promise.resolve({
          output: [{ type: 'text' as const, text: `answer for ${request.label} holding sk-secret123456789012` }],
        }),
      }),
    }
    const tool = createVerifyTool(baseOptions({
      callModel: async () => ({ text: 'x', logprobs: [{ token: 'x', logprob: -0.5 }] }),
      subagents: subagents as never,
      maxChildChars: 5000,
      privacyFilter: 'full',
      artifactRoot,
    }))
    const execWithAgent = { signal: new AbortController().signal, agent: { session } }
    await tool.execute(
      { problem: 'p', candidates: [], auto_spawn: 2 },
      execWithAgent as never,
    )

    const result = appended.find(a => a.name === 'session/verify-result')
    expect(result).toBeDefined()
    const payload = result!.payload as { childSessionIds?: string[]; detailPath?: string }
    expect(payload.childSessionIds).toEqual(['child-verify-child-1', 'child-verify-child-2'])
    expect(payload.detailPath).toBeTruthy()
    expect(existsSync(payload.detailPath!)).toBe(true)

    const detail = JSON.parse(readFileSync(payload.detailPath!, 'utf8')) as {
      candidates: unknown
      calls: Array<{ rawText: string }>
    }
    // privacy 'full': credential material masked in archived candidates
    expect(JSON.stringify(detail.candidates)).not.toContain('sk-secret123456789012')
    expect((detail.calls ?? []).length).toBeGreaterThan(0)
  })
})
