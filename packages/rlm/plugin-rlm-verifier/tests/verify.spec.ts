import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as PluginRlmKernel from '@deepseek-ai/dsh-plugin-rlm-kernel'
import * as PluginRlmVerifier from '@deepseek-ai/dsh-plugin-rlm-verifier'
import { SessionId } from '@deepseek-ai/dsh-session'
import { CallId } from '@deepseek-ai/dsh-llm'
import { buildPythonProgram, parseResultJson } from '@deepseek-ai/dsh-plugin-rlm-verifier/src/python-bridge.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

async function setup() {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  const root = mkdtempSync(join(tmpdir(), 'dsh-rlm-verify-'))
  roots.push(root)
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(PluginRlmKernel, { dataDir: root })
  await ctx.plugin(PluginRlmVerifier, {})
  return { ctx, root }
}

describe('verify plugin host mount', () => {
  it('mounts and registers the verify tool', async () => {
    const { ctx } = await setup()
    const tool = ctx.tools.get('verify')
    expect(tool).toBeDefined()
    expect(tool?.name).toBe('verify')
  })

  it('exposes the rlm.kernels registry from plugin-rlm-kernel', async () => {
    const { ctx } = await setup()
    const kernels = ctx.get('rlm.kernels')
    expect(kernels).toBeDefined()
    expect(typeof kernels?.hasSession).toBe('function')
    expect(typeof kernels?.execute).toBe('function')
  })
})

describe('verify python bridge', () => {
  it('parses a VERIFY_RESULT line from python output', () => {
    const line = 'VERIFY_RESULT {"index":2,"scores":[0.3,0.5,0.9],"ranking":[2,1,0],"n_comparisons":8,"criteria":["Specification","Output","Errors"]}'
    const parsed = parseResultJson(line)
    expect(parsed.index).toBe(2)
    expect(parsed.scores).toEqual([0.3, 0.5, 0.9])
    expect(parsed.ranking).toEqual([2, 1, 0])
    expect(parsed.nComparisons).toBe(8)
  })

  it('tolerates surrounding text before the JSON payload', () => {
    const line = 'analysis noise...\nVERIFY_RESULT {"index":0,"scores":[0.7,0.6],"ranking":[0,1],"n_comparisons":3,"criteria":[]}'
    const parsed = parseResultJson(line)
    expect(parsed.index).toBe(0)
  })

  it('rejects output with no JSON payload', () => {
    expect(() => parseResultJson('no json here')).toThrow(/no JSON result/)
  })

  it('builds a python program that imports llm_verifier', () => {
    const program = buildPythonProgram()
    expect(program).toContain('import llm_verifier')
    expect(program).toContain('llm_verifier.select')
    expect(program).toContain('VERIFY_RESULT')
    expect(program).toContain('VERIFY_ERROR')
  })
})

// Direct tool-execution e2e: runs the verify tool end to end (venv python
// subprocess path) against real candidate texts. Requires a verifier backend
// credential (DEEPSEEK_API_KEY / OPENAI_BASE_URL / VERTEX_API_KEY); skipped
// when absent, mirroring the rlm e2e key gate.
describe.skipIf(!process.env.DEEPSEEK_API_KEY && !process.env.OPENAI_BASE_URL)('verify tool with-key e2e', () => {
  it('selects the correct reverse-string candidate via the verify tool', async () => {
    const { ctx } = await setup()
    const agent = ctx.agentLoop.create(SessionId('verify-e2e'), {
      provider: 'probe',
      model: 'probe',
    })

    const result = await ctx.tools.execute({
      name: 'verify',
      callId: CallId('verify-e2e-call'),
      arguments: {
        problem: 'Write a function that reverses a string.',
        candidates: [
          'def rev(s): return s[::-1]',
          'def rev(s): return s',
          "def rev(s): return ''.join(sorted(s))",
        ],
        criteria: '{"Correctness":"Does the code actually reverse the string?"}',
        n_evaluations: 1,
        pivots: 1,
        seed: 0,
      },
      agent,
      signal: new AbortController().signal,
    })

    // The tool returns { text, index, scores, ranking, nComparisons }.
    const value = result.value as { index: number; ranking: number[]; text: string }
    expect(value.index).toBe(0)
    expect(value.ranking[0]).toBe(0)
    expect(value.text).toContain('best = candidate[0]')
  }, 120_000)
})
