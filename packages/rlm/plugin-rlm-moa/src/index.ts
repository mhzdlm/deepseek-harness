/**
 * Mixture-of-Agents plugin: registers the `moa` tool and the `/moa`
 * management command. The panel runs entirely on this context's LLM seam
 * (`ctx.llm.stream`) — reference slots answer independently as pure model
 * calls and one aggregator synthesizes. Pairs with the other RLM plugins.
 * @module @deepseek-ai/dsh-plugin-rlm-moa
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, LlmRuntime } from '@deepseek-ai/dsh-llm'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { CommandInvocation } from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-subagent'
import z from '@deepseek-ai/schemastery'
import type { MoaResolvedSlot } from './presets.ts'
import type { MoaModelRequest } from './moa-tool.ts'
import { createMoaTool } from './moa-tool.ts'
import { createPresetView } from './preset-store.ts'
import { redactReferenceText } from '@deepseek-ai/dsh-plugin-rlm-kernel'
import { listMoaPresetsText, removeManagedMoaPreset, showMoaPresetText, useMoaPresetDefault } from './moa-cmd.ts'

/** Plugin id registered with the Cordis loader; also used as the trace/store namespace. */
export const name = 'plugin-rlm-moa'
/** Service dependencies this plugin requires before `apply` runs. */
export const inject = ['tools', 'llm', 'commands', 'subagents']

/** One named panel: reference slots plus an aggregator slot. */
export interface MoaPresetConfig {
  /**
   * Reference slots; every enabled entry answers independently. A slot with
   * `mode:'subagent'` runs as a spawned tool-capable child instead of a plain
   * completion (`provider` names the subagent provider).
   */
  referenceModels?: Array<{
    /** Subagent provider for `mode:'subagent'` slots; other modes ignore it. */
    provider?: string
    /** Model id this reference slot queries. */
    model?: string
    /** Whether the slot answers this round (default true). */
    enabled?: boolean
    /** `'completion'` (plain model call) or `'subagent'` (tool-capable spawned child). */
    mode?: string
  }>
  /** The synthesizing slot. */
  aggregator?: {
    /** Provider for the synthesizing slot; omitted inherits the default LLM provider. */
    provider?: string
    /** Model id for the synthesizing slot. */
    model?: string
  }
  /** Per-reference token ceiling (default 4096). Never applied to the aggregator or subagent slots. */
  referenceMaxTokens?: number
  /** Per-reference wall-clock budget in ms (default 120000). */
  referenceTimeoutMs?: number
  /** Whether failed references are announced to the aggregator (default loud). */
  degradedPolicy?: string
}

/** Top-level plugin configuration: artifact paths, preset definitions, privacy, tracing, and subagent defaults. */
export interface Config {
  /** Artifact root for traces and the managed preset store; defaults to `~/.dsh/rlm`. */
  dataDir?: string
  /** Named MoA preset definitions, keyed by preset id; the active one is chosen by `defaultPreset`. */
  presets?: Record<string, MoaPresetConfig>
  /** Preset id applied when a cell does not name one (default: none → built-in default panel). */
  defaultPreset?: string
  /**
   * `''` (off), `'display'` (render provenance labels), or `'full'` (also
   * mask credential/PII material in advisor text before aggregation).
   */
  privacyFilter?: string
  /** Write JSONL traces under `<dataDir>/moa-traces/` (default true). */
  trace?: boolean
  /** Subagent provider used by `mode:'subagent'` slots without their own provider (default 'spawn'). */
  subagentProvider?: string
  /** Per-child captured text ceiling for subagent reference slots (default 20000). */
  maxChildChars?: number
}

/** Schema for the plugin's `Config`; all fields mirror the {@link Config} interface. */
export const Config: z<Config> = z.object({
  dataDir: z.string(),
  presets: z.dict(z.object({
    referenceModels: z.array(z.object({
      provider: z.string(),
      model: z.string().required(),
      enabled: z.boolean(),
      mode: z.string(),
    })),
    aggregator: z.object({
      provider: z.string(),
      model: z.string().required(),
    }),
    referenceMaxTokens: z.natural(),
    referenceTimeoutMs: z.natural(),
    degradedPolicy: z.string(),
  })),
  defaultPreset: z.string(),
  privacyFilter: z.string(),
  trace: z.boolean(),
  subagentProvider: z.string(),
  maxChildChars: z.natural(),
})

/**
 * Run one slot through the context's LLM seam and reduce the stream to text.
 * Mirrors the compaction summarizer's call shape: a single hand-built user
 * message, finish normalization, and text-block extraction. Exported for
 * tests and custom wirings that bypass {@link createMoaTool}'s injection.
 * @param llm - LLM runtime used to stream the completion.
 * @param slot - Resolved reference/aggregator slot describing provider, model, and label.
 * @param request - User text and system prompt sent to the model.
 * @param signal - Abort signal cancelling the in-flight stream.
 * @param maxTokens - Optional per-call token ceiling; undefined applies no limit.
 * @param sessionId - Optional session id for token-meter/observability attribution.
 * @returns The assembled text and a `truncated` flag when the slot hit `maxTokens`.
 */
export async function callViaLlm(
  llm: LlmRuntime,
  slot: MoaResolvedSlot,
  request: MoaModelRequest,
  signal: AbortSignal,
  maxTokens: number | undefined,
  sessionId?: GenerateOptions['sessionId'],
): Promise<{ text: string; truncated?: boolean }> {
  const assembler = new BlockAssembler()
  const options: GenerateOptions = {
    provider: slot.provider,
    model: slot.model,
    messages: [
      createUserMessage({
        content: [{ type: 'text', text: request.userText }],
        source: { kind: 'plugin', plugin: 'dsh-plugin-rlm-moa' },
      }),
    ],
    system: request.system,
    // Attribution for token-meter/observability: panel calls are auxiliary,
    // never agent-loop steps. Adapters without moa-specific policy ignore it.
    purpose: 'moa',
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
    signal,
  }
  for await (const chunk of llm.stream(options)) assembler.push(chunk)
  const finish = assembler.finish
  if (finish.kind === 'error') throw new Error(`moa: ${slot.label} failed: ${finish.failure.message}`)
  if (finish.kind === 'aborted') throw new Error(`moa: ${slot.label} aborted`)
  const text = assembler
    .blocks()
    .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
  return finish.kind === 'max-tokens' ? { text, truncated: true } : { text }
}

/**
 * Plugin entry point: registers the `moa` tool and the `/moa` management
 * command, wiring preset views, privacy filtering, and trace output.
 * @param ctx - Cordis context providing tool, llm, command, and subagent services.
 * @param config - Resolved plugin configuration.
 * @returns void
 */
export function apply(ctx: Context, config: Config): void {
  const dataDir = config.dataDir ?? join(homedir(), '.dsh', 'rlm')
  const storePath = join(dataDir, 'moa-presets.json')
  // Layered view re-reads the managed store per call, so `/moa use` takes
  // effect immediately for subsequent tool executions.
  const view = createPresetView(config.presets, config.defaultPreset, storePath)
  const privacyFilter = config.privacyFilter === 'display' || config.privacyFilter === 'full' ? config.privacyFilter : ''
  const traceOn = config.trace ?? true

  // P3: subagent-mode reference slots. Controllers are registered BEFORE
  // start (mirrors host-handlers/verifier) and aborted on session disposal so
  // panel children cannot outlive their parent session.
  const sessionControllers = new Map<string, Set<AbortController>>()
  const trackController = (sessionId: string, controller: AbortController): (() => void) => {
    let controllers = sessionControllers.get(sessionId)
    if (!controllers) {
      controllers = new Set<AbortController>()
      sessionControllers.set(sessionId, controllers)
    }
    controllers.add(controller)
    return () => {
      controllers?.delete(controller)
      if (controllers?.size === 0) sessionControllers.delete(sessionId)
    }
  }
  const abortSubagentSession = (sessionId: string): void => {
    const controllers = sessionControllers.get(sessionId)
    if (controllers) {
      for (const controller of [...controllers]) controller.abort()
      sessionControllers.delete(sessionId)
    }
  }
  ctx.on('session/disposed', (session) => {
    abortSubagentSession(String(session.id))
  })

  const maxChildChars = config.maxChildChars ?? 20_000
  const subagentProviderDefault = config.subagentProvider ?? 'spawn'
  ctx.effect(
    () =>
      ctx.tools.register(
        createMoaTool({
          resolvePreset: name => view.resolve(name),
          availablePresets: () => view.available(),
          privacyFilter,
          ...(privacyFilter === 'full' ? { redactReference: redactReferenceText } : {}),
          ...(traceOn ? { traceDir: join(dataDir, 'moa-traces') } : {}),
          callModel: (slot, request, signal, maxTokens, sessionId) =>
            callViaLlm(ctx.llm, slot, request, signal, maxTokens, sessionId),
          trackSubagentController: trackController,
          callSubagent: async (slot, request, signal, owner) => {
            // `owner` is the tool execution's owning Agent instance; the cast
            // narrows the tool-seam boundary to the subagent service's parent
            // parameter — the same runtime object verify-tool forwards.
            const provider = slot.providerFromDefault ? subagentProviderDefault : slot.provider
            const run = await ctx.subagents.start(provider, {
              prompt: [{ type: 'text', text: `${request.system}\n\n${request.userText}` }],
              parent: owner as never,
              label: `moa-${slot.model}`,
              signal,
            })
            const result = await run.result
            const text = (result.output ?? [])
              .map(block => (block.type === 'text' ? (block.text ?? '') : ''))
              .join('\n')
              .trim()
              .slice(0, maxChildChars)
            if (!text) throw new Error(`moa: subagent slot ${slot.label} produced no text`)
            return { text }
          },
        }),
      ),
    'register moa tool',
  )

  ctx.commands.register({
    name: 'moa',
    description: 'Manage MoA panels: /moa list, /moa show <name>, /moa use <name>, /moa remove <name>',
    input: { hint: 'list | show <name> | use <name> | remove <name>' },
    handler: async (invocation: CommandInvocation) => {
      void invocation.signal
      const [subcommand, arg] = invocation.rawInput.trim().split(/\s+/, 2)
      switch (subcommand ?? 'list') {
        case 'list':
          return { kind: 'success' as const, text: listMoaPresetsText(view) }
        case 'show':
          if (!arg) return { kind: 'error' as const, text: 'Usage: /moa show <name>' }
          return { kind: 'success' as const, text: showMoaPresetText(view, arg) }
        case 'use':
          if (!arg) return { kind: 'error' as const, text: 'Usage: /moa use <name>' }
          return { kind: 'success' as const, text: useMoaPresetDefault(storePath, view, arg) }
        case 'remove':
          if (!arg) return { kind: 'error' as const, text: 'Usage: /moa remove <name>' }
          return { kind: 'success' as const, text: removeManagedMoaPreset(storePath, arg) }
        default:
          return { kind: 'error' as const, text: `Unknown /moa subcommand "${subcommand}" (list|show|use|remove)` }
      }
    },
  })
}

/** Re-exported slot shape resolved from a preset; describes provider, model, and label. */
export type { MoaResolvedSlot }
