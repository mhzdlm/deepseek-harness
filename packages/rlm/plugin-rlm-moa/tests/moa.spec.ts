/**
 * Orchestration unit tests for the `moa` tool. The transport is injected
 * (`callModel`), so no LLM runtime, adapter, or network participates; the
 * tests pin fan-out concurrency, prompt assembly, degraded-reference policy,
 * per-slot timeouts, preset resolution, tracing, and the render projection.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMoaTool, type MoaCallModel, type MoaModelRequest } from '../src/moa-tool.ts'
import { DEFAULT_PRESET_NAME, normalizePresets } from '../src/presets.ts'
import type { MoaResolvedPreset } from '../src/presets.ts'
import { redactReferenceText } from '@deepseek-ai/dsh-plugin-rlm-kernel/src/redact.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

function tmpRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-rlm-moa-'))
  roots.push(root)
  return root
}

function twoSlotPreset(overrides: Partial<MoaResolvedPreset> = {}): MoaResolvedPreset {
  return {
    name: 'panel',
    references: [
      { provider: 'p-a', model: 'model-a', label: 'model-a@p-a', mode: 'llm', providerFromDefault: false },
      { provider: 'p-b', model: 'model-b', label: 'model-b@p-b', mode: 'llm', providerFromDefault: false },
    ],
    aggregator: { provider: 'p-agg', model: 'agg', label: 'agg@p-agg', mode: 'llm', providerFromDefault: false },
    referenceMaxTokens: 512,
    referenceTimeoutMs: 120_000,
    degradedPolicy: 'loud',
    ...overrides,
  }
}

/** Narrowed shape of the moa tool's successful output, for typed assertions. */
interface MoaExecuteValue {
  synthesis: string
  preset: string
  references: Array<{ label: string; status: string }>
  failedLabels: string[]
  truncated: boolean
  judges?: Array<{ model: string; status: string }>
  fusedRanking?: number[]
}

function singlePreset(preset: MoaResolvedPreset): {
  resolvePreset: (name?: string) => MoaResolvedPreset
  availablePresets: () => string[]
} {
  const map = new Map([[preset.name, preset]])
  return {
    resolvePreset(name?: string) {
      const key = name ?? preset.name
      const found = map.get(key)
      if (!found) throw new Error(`moa: unknown preset '${key}'. Available presets: ${[...map.keys()].join(', ')}`)
      return found
    },
    availablePresets: () => [...map.keys()],
  }
}

interface CallRecord {
  slotLabel: string
  request: MoaModelRequest
  maxTokens: number | undefined
}

function okModel(answer: string): MoaCallModel {
  return async slot => ({ text: `${answer} [by ${slot.label}]` })
}

/** callModel that resolves only when its signal fires — simulates a hung provider. */
function hangingModel(): MoaCallModel {
  return (_slot, _request, signal) =>
    new Promise<never>((_resolve, reject) => {
      if (signal.aborted) {
        reject(new Error('aborted'))
        return
      }
      signal.addEventListener('abort', () => reject(new Error('timed out')), { once: true })
    })
}

async function runTool(
  options: Partial<Parameters<typeof createMoaTool>[0]>,
  args: Record<string, unknown>,
): Promise<{ value: MoaExecuteValue; calls: CallRecord[] }> {
  const calls: CallRecord[] = []
  const base = okModel('answer')
  const wrapped: MoaCallModel = async (slot, request, signal, maxTokens) => {
    calls.push({ slotLabel: slot.label, request, maxTokens })
    return base(slot, request, signal, maxTokens)
  }
  const tool = createMoaTool({
    resolvePreset: options.resolvePreset ?? (() => { throw new Error('no preset resolver in this test') }),
    availablePresets: options.availablePresets ?? (() => []),
    privacyFilter: options.privacyFilter ?? '',
    ...(options.redactReference !== undefined ? { redactReference: options.redactReference } : {}),
    ...(options.traceDir !== undefined ? { traceDir: options.traceDir } : {}),
    ...(options.callSubagent !== undefined ? { callSubagent: options.callSubagent } : {}),
    ...(options.trackSubagentController !== undefined ? { trackSubagentController: options.trackSubagentController } : {}),
    callModel: options.callModel ?? wrapped,
    ...(options.now !== undefined ? { now: options.now } : {}),
  })
  const value = (await tool.execute(args, {
    signal: new AbortController().signal,
  } as Parameters<typeof tool.execute>[1])) as MoaExecuteValue
  return { value, calls }
}

describe('moa orchestration', () => {
  it('fans the task out to every enabled reference slot', async () => {
    const { value } = await runTool(
      { ...singlePreset(twoSlotPreset()), privacyFilter: '' },
      { problem: 'derive x' },
    )
    expect(value.preset).toBe('panel')
    expect(value.references.map(r => r.status)).toEqual(['ok', 'ok'])
    expect(value.failedLabels).toEqual([])
  })

  it('feeds each advisor answer to the aggregator as a labelled block', async () => {
    let aggregatorRequest: MoaModelRequest | undefined
    const callModel: MoaCallModel = async (slot) => {
      if (slot.label === 'agg@p-agg') {
        return { text: 'final' }
      }
      return { text: `advice-${slot.label}` }
    }
    const instrumented: MoaCallModel = async (slot, request, signal, maxTokens) => {
      if (slot.label === 'agg@p-agg') aggregatorRequest = request
      return callModel(slot, request, signal, maxTokens)
    }
    await runTool(
      { ...singlePreset(twoSlotPreset()), privacyFilter: '', callModel: instrumented },
      { problem: 'derive x', context: 'ctx-material' },
    )
    expect(aggregatorRequest).toBeDefined()
    expect(aggregatorRequest?.userText).toContain('## Task')
    expect(aggregatorRequest?.userText).toContain('derive x')
    expect(aggregatorRequest?.userText).toContain('ctx-material')
    expect(aggregatorRequest?.userText).toContain('Reference 1 — model-a@p-a:')
    expect(aggregatorRequest?.userText).toContain('Reference 2 — model-b@p-b:')
  })

  it('loud policy announces failed references to the aggregator; quiet omits them', async () => {
    const seen: string[] = []
    const callModel: MoaCallModel = async (slot, request) => {
      if (slot.label === 'agg@p-agg') {
        seen.push(request.userText)
        return { text: 'final' }
      }
      if (slot.label === 'model-a@p-a') throw new Error('provider down')
      return { text: 'advice-b' }
    }
    for (const policy of ['loud', 'quiet'] as const) {
      seen.length = 0
      await runTool(
        {
          ...singlePreset(twoSlotPreset({ degradedPolicy: policy })),
          privacyFilter: '',
          callModel,
        },
        { problem: 'p' },
      )
      if (policy === 'loud') expect(seen[0] ?? '').toContain('Reference failed: model-a@p-a.')
      else expect(seen[0] ?? '').not.toContain('Reference failed')
    }
  })

  it('throws without calling the aggregator when every reference fails', async () => {
    let aggregatorCalled = false
    const callModel: MoaCallModel = async (slot) => {
      if (slot.label === 'agg@p-agg') {
        aggregatorCalled = true
        return { text: 'final' }
      }
      throw new Error('down')
    }
    const tool = createMoaTool({
      ...singlePreset(twoSlotPreset()),
      privacyFilter: '',
      callModel,
    })
    await expect(tool.execute({ problem: 'p' }, { signal: new AbortController().signal } as never)).rejects.toThrow(
      /all 2 references failed/,
    )
    expect(aggregatorCalled).toBe(false)
  })

  it('a reference that exceeds its wall-clock budget fails while siblings succeed', async () => {
    const callModel: MoaCallModel = async (slot, _request, signal) => {
      if (slot.label === 'model-a@p-a') {
        return hangingModel()(slot, { system: '', userText: '' }, signal, undefined)
      }
      return { text: 'fast advice' }
    }
    const { value } = await runTool(
      {
        ...singlePreset(twoSlotPreset({ referenceTimeoutMs: 60 })),
        privacyFilter: '',
        callModel,
      },
      { problem: 'p' },
    )
    expect(value.failedLabels).toEqual(['model-a@p-a'])
    expect(value.synthesis).toBe('fast advice')
  }, 10_000)

  it('candidates mode numbers each draft and asks for independent verdicts', async () => {
    let referencePrompt = ''
    const callModel: MoaCallModel = async (slot, request) => {
      if (referencePrompt === '' && slot.label !== 'agg@p-agg') referencePrompt = request.userText
      return { text: 'note' }
    }
    await runTool(
      { ...singlePreset(twoSlotPreset()), privacyFilter: '', callModel },
      { problem: 'pick one', candidates: ['draft A', 'draft B'] },
    )
    expect(referencePrompt).toContain('### Candidate 1\ndraft A')
    expect(referencePrompt).toContain('### Candidate 2\ndraft B')
    expect(referencePrompt).toContain('adopt-with-fixes')
  })

  it('rejects an unknown preset naming the available ones', async () => {
    const tool = createMoaTool({
      ...singlePreset(twoSlotPreset()),
      privacyFilter: '',
      callModel: okModel('x'),
    })
    await expect(tool.execute({ problem: 'p', preset: 'nope' }, { signal: new AbortController().signal } as never)).rejects.toThrow(
      /unknown preset 'nope'.*panel/s,
    )
  })

  it('caps references at referenceMaxTokens but leaves the aggregator uncapped', async () => {
    const caps: Array<string | undefined> = []
    const callModel: MoaCallModel = async (slot, _request, _signal, maxTokens) => {
      caps.push(maxTokens === undefined ? undefined : String(maxTokens))
      void slot
      return { text: 't' }
    }
    await runTool(
      { ...singlePreset(twoSlotPreset({ referenceMaxTokens: 777 })), privacyFilter: '', callModel },
      { problem: 'p' },
    )
    expect(caps).toEqual(['777', '777', undefined])
  })

  it('writes one parseable JSONL trace line per run', async () => {
    const root = tmpRoot()
    const traceDir = join(root, 'moa-traces')
    await runTool(
      { ...singlePreset(twoSlotPreset()), privacyFilter: '', traceDir, callModel: okModel('a') },
      { problem: 'traced problem' },
    )
    const content = readFileSync(join(traceDir, 'anonymous.jsonl'), 'utf8').trim()
    const entry = JSON.parse(content) as Record<string, unknown>
    expect(entry.preset).toBe('panel')
    expect(entry.problemChars).toBe('traced problem'.length)
    expect((entry.references as unknown[]).length).toBe(2)
    expect(entry.synthesisChars).toBeGreaterThan(0)
  })

  it('full privacy mode masks advisor text before the aggregator prompt', async () => {
    let aggregatorRequest: MoaModelRequest | undefined
    const callModel: MoaCallModel = async (slot, request) => {
      if (slot.label === 'agg@p-agg') {
        aggregatorRequest = request
        return { text: 'final' }
      }
      return { text: 'contact bob@corp.io or sk-proj-abc123def456789' }
    }
    await runTool(
      { ...singlePreset(twoSlotPreset()), privacyFilter: 'full', redactReference: redactReferenceText, callModel },
      { problem: 'p' },
    )
    expect(aggregatorRequest?.userText).toContain('[redacted email]')
    expect(aggregatorRequest?.userText).toContain('[redacted key]')
    expect(aggregatorRequest?.userText).not.toContain('bob@corp.io')
    expect(aggregatorRequest?.userText).not.toContain('sk-proj-abc123def456789')
  })

  it('routes subagent-mode slots through callSubagent with folded prompts', async () => {
    const preset = twoSlotPreset()
    preset.references[0] = { provider: 'spawn', model: 'researcher', label: 'agent:researcher@spawn', mode: 'subagent', providerFromDefault: false }
    const subCalls: Array<{ label: string; userText: string; owner: unknown }> = []
    const callModel: MoaCallModel = async (slot, _request) => {
      if (slot.label === 'agg@p-agg') return { text: 'final' }
      if (slot.mode === 'llm') return { text: `llm advice ${slot.label}` }
      return { text: 'unused' }
    }
    const callSubagent = async (slot: typeof preset.references[number], request: MoaModelRequest, _signal: AbortSignal, owner: unknown) => {
      subCalls.push({ label: slot.label, userText: request.userText, owner })
      void request.system
      return { text: `agent advice ${slot.label}` }
    }
    const exec = { signal: new AbortController().signal, agent: { session: { id: 'sess-moa' } } }
    const tool = createMoaTool({
      ...singlePreset(preset),
      privacyFilter: '',
      callModel,
      callSubagent,
    })
    const value = (await tool.execute({ problem: 'panel task' }, exec as never)) as { failedLabels: string[] }
    expect(value.failedLabels).toEqual([])
    expect(subCalls.length).toBe(1)
    expect(subCalls[0]?.label).toBe('agent:researcher@spawn')
    // The child prompt folds the reference persona into the task text at the
    // wiring boundary (index.ts); here the pieces are asserted separately.
    expect(subCalls[0]?.userText).toContain('panel task')
  })

  it('an unwired callSubagent degrades its slot instead of failing the panel', async () => {
    const preset = twoSlotPreset()
    preset.references[0] = { provider: 'spawn', model: 'researcher', label: 'agent:researcher@spawn', mode: 'subagent', providerFromDefault: false }
    const { value } = await runTool(
      { ...singlePreset(preset), privacyFilter: '' },
      { problem: 'p' },
    )
    expect(value.failedLabels).toEqual(['agent:researcher@spawn'])
    expect(value.synthesis).toContain('answer [by agg@p-agg]')
  })

  it('subagent slots require an owning agent', async () => {
    const preset = twoSlotPreset()
    preset.references = [{ provider: 'spawn', model: 'solo', label: 'agent:solo@spawn', mode: 'subagent', providerFromDefault: false }]
    let called = 0
    const tool = createMoaTool({
      ...singlePreset(preset),
      privacyFilter: '',
      callModel: okModel('unused'),
      callSubagent: async () => {
        called++
        return { text: 'x' }
      },
    })
    await expect(tool.execute({ problem: 'p' }, { signal: new AbortController().signal } as never)).rejects.toThrow(
      /all 1 references failed/,
    )
    expect(called).toBe(0)
  })

  it('emits durable reference and synthesis events through the session', async () => {
    const appended: Array<{ name: string; payload: Record<string, unknown> }> = []
    const exec = {
      signal: new AbortController().signal,
      agent: { session: { id: 'sess-ev', append: (name: string, payload: unknown) => { appended.push({ name, payload: payload as Record<string, unknown> }) } } },
    }
    const tool = createMoaTool({
      ...singlePreset(twoSlotPreset()),
      privacyFilter: '',
      callModel: okModel('advice'),
    })
    await tool.execute({ problem: 'p' }, exec as never)
    const names = appended.map(a => a.name)
    expect(names).toEqual(['session/moa-reference', 'session/moa-reference', 'session/moa-synthesis'])
    const synthesis = appended.find(a => a.name === 'session/moa-synthesis')
    expect(synthesis).toBeDefined()
    if (synthesis) expect(synthesis.payload.preset).toBe('panel')
    const firstRef = appended[0]
    expect(firstRef?.payload.status).toBe('ok')
  })

  it('render annotates provenance under the display privacy filter', async () => {
    const tool = createMoaTool({
      ...singlePreset(twoSlotPreset()),
      privacyFilter: 'display',
      callModel: okModel('a'),
    })
    const value = (await tool.execute({ problem: 'p' }, { signal: new AbortController().signal } as never)) as {
      synthesis: string
      references: Array<{ label: string; status: string }>
      truncated: boolean
    }
    const rendered = tool.output.render({}, value)
    const text = rendered.map(block => ('text' in block ? block.text : '')).join('\n')
    expect(text).toContain('✓ model-a@p-a')
    expect(text).toContain('✓ model-b@p-b')
    expect(text).toContain(value.synthesis)
  })
})

describe('preset normalization', () => {
  it('falls back to the built-in default preset when none configure', () => {
    const { presets, defaultName } = normalizePresets(undefined)
    expect(defaultName).toBe(DEFAULT_PRESET_NAME)
    const fallback = presets.get(DEFAULT_PRESET_NAME)!
    expect(fallback.references.length).toBeGreaterThanOrEqual(2)
    expect(fallback.aggregator.model).toContain('deepseek')
  })

  it('drops disabled slots and invalid entries silently', () => {
    const { presets } = normalizePresets({
      panel: {
        referenceModels: [
          { model: 'm1' },
          { model: 'm2', enabled: false },
          { model: '' },
        ],
        aggregator: { model: 'agg' },
      },
      broken: { referenceModels: [{ model: 'x' }] },
    })
    expect([...presets.keys()]).toEqual(['panel'])
    const panel = presets.get('panel')!
    expect(panel.references.map(r => r.model)).toEqual(['m1'])
  })

  it('labels slots as model@provider with the default route filled in', () => {
    const { presets } = normalizePresets({
      p: { referenceModels: [{ model: 'm1' }], aggregator: { model: 'a1', provider: 'custom-route' } },
    })
    const preset = presets.get('p')!
    expect(preset.references[0]).toMatchObject({ provider: 'deepseek-official', label: 'm1@deepseek-official' })
    expect(preset.aggregator.label).toBe('a1@custom-route')
  })
})
