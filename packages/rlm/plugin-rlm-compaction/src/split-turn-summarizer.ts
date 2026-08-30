/**
 * RLM-specific compaction summarizer.
 *
 * This module is intentionally independent of `@deepseek-ai/dsh-compaction-basic`'s
 * private `summarizer.ts`: it does NOT import `COMPACTION_INSTRUCTION` or
 * `summarizeWithLlm`. Instead it re-implements the same replay-aware, prefix-cache
 * LLM protocol (so the provider KV cache is not invalidated) but with two RLM-
 * specific additions layered on top of the standard eight-section summary:
 *
 *  1. **Split-turn prefix** (P1-B): when the condensed region begins mid-turn
 *     (the first replayed message is an assistant continuation rather than a user
 *     message opening the turn), the model first writes a `## Turn Prefix`
 *     section capturing what the in-progress turn was doing before the cut
 *     (prime's `TURN_PREFIX_SUMMARIZATION_PROMPT`). This preserves the context
 *     of a turn that the compaction cut through, instead of silently dropping
 *     its opening.
 *  2. **Files Touched** (P1-A, RLM-only): the `## Files Touched` section and its
 *     cross-round carry live entirely in this provider — the shared
 *     `compaction-basic` package is left untouched. `priorFilesTouched` is read
 *     from the session's own durable `compaction/summary` log so later summaries
 *     inherit the cumulative file context (prime's `readFiles`/`modifiedFiles`).
 *
 * @module @deepseek-ai/dsh-plugin-rlm-compaction/split-turn-summarizer
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock,
  GenerateOptions,
  Message,
  TokenUsage,
} from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SummarizationInput, SummaryResult } from '@deepseek-ai/dsh-compaction-basic/src/summarizer.ts'
import type { BasicCompactionConfig } from '@deepseek-ai/dsh-compaction-basic/src/types.ts'

/**
 * Local view of `SummarizationInput` that adds the RLM-specific
 * `priorFilesTouched` carry. Declared here (not imported from compaction-basic)
 * so this package stays independent of whether the shared package has been
 * rebuilt with its own P1-A change.
 */
export type RlmSummarizationInput = SummarizationInput & {
  priorFilesTouched?: { read: string[]; modified: string[] }
}

/**
 * Local view of `SummaryResult` that adds the RLM-parsed `filesTouched` and
 * `turnPrefix`. Structurally compatible with the official `SummaryResult`, so a
 * value can be returned through the base `summarize` override after a cast.
 */
type RlmSummaryResult = SummaryResult & {
  filesTouched: { read: string[]; modified: string[] }
  turnPrefix?: string
}

/** A resolved compaction config (the shape `summarizeWithLlm` reads in compaction-basic). */
export type ResolvedCompactionConfig = BasicCompactionConfig & {
  summarizationProvider: string
  summarizationModel: string
  maxTokens: number
}

const SUMMARY_OPEN_TAG = '<compacted-summary>'

/**
 * Build the RLM compaction instruction. The base eight sections mirror the
 * structure `compaction-basic` emits; this copy is maintained independently so
 * the RLM provider never drifts the shared package. Two RLM-specific sections
 * are appended: `## Turn Prefix` (only when `midTurn`) and `## Files Touched`.
 * @param midTurn - whether the condensed region starts mid-assistant-turn.
 * @param priorFilesTouched - read/modified files from prior compactions.
 * @returns the full instruction text.
 */
export function buildRlmInstruction(
  midTurn: boolean,
  priorFilesTouched?: { read: string[]; modified: string[] },
): string {
  const sections = [
    'You are condensing a portion of a long conversation into a single concise summary that will replace those messages. Write the summary inside one <compacted-summary> block.',
    '',
    '## Primary Request and Intent',
    '- [what the user ultimately wants and the key constraints/decisions that shape the approach]',
    '',
    '## Key Technical Context',
    '- [commands run, files/paths, APIs, data shapes, errors encountered and how resolved]',
    '',
    '## Decisions and Trade-offs',
    '- [choices made, alternatives considered, and why the chosen path won]',
    '',
    '## Open Questions and Next Steps',
    '- [unresolved issues and the immediate next action]',
    '',
    '## Critical Context',
    '- [decisions and their rationale, constraints, user preferences, open questions, data needed to continue]',
    '',
    '## Files Touched',
    '- [files read or modified this task, as "path: why it matters"; keep this list across rounds so later summaries inherit prior context and avoid re-reading]',
    '',
  ]
  if (midTurn) {
    sections.push(
      '## Turn Prefix',
      '- [the condensed region begins in the MIDDLE of an assistant turn — the opening user request and early progress are NOT included. Summarize, in 2–4 lines, what this in-progress turn was doing before the cut: the original request it served, the early progress already made, and the context the suffix will need to continue. Keep this distinct from the main summary above.]',
      '',
    )
  }
  sections.push(
    'Rules:',
    '- Write concise English engineering prose. Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.',
    '- Capture user feedback and explicit instructions faithfully, especially corrections.',
    '- Do NOT mention this summarization request or that the context was compacted.',
    '- Output only the checkpoint text: do not call any tool or take any other action.',
    `- If the conversation already contains a ${SUMMARY_OPEN_TAG} block, it is a PRIOR checkpoint. Do not copy it forward verbatim: preserve still-true facts, drop stale ones, and merge newer information into a single consolidated summary under the same structure.`,
    '- If a PREVIOUS FILES TOUCHED hint is supplied below, merge it into the new Files Touched list, dropping entries that are no longer relevant.',
  )
  let instruction = sections.join('\n')
  if (priorFilesTouched?.read.length || priorFilesTouched?.modified.length) {
    const lines = [
      ...priorFilesTouched.read.map(p => `- read: ${p}`),
      ...priorFilesTouched.modified.map(p => `- modified: ${p}`),
    ]
    instruction += `\n\nPREVIOUS FILES TOUCHED (inherit into the new Files Touched list):\n${lines.join('\n')}`
  }
  return instruction
}

/** Extract `## Files Touched` and `## Turn Prefix` from a consolidated summary. */
export function parseRlmSummary(text: string): {
  filesTouched: { read: string[]; modified: string[] }
  turnPrefix: string | undefined
} {
  const filesTouched = parseFilesTouched(text)
  const turnPrefix = parseTurnPrefix(text)
  return { filesTouched, turnPrefix }
}

function parseFilesTouched(text: string): { read: string[]; modified: string[] } {
  const read: string[] = []
  const modified: string[] = []
  const lines = text.split('\n')
  let inFiles = false
  for (const raw of lines) {
    const line = raw.trim()
    if (/^##\s+files touched/i.test(line)) { inFiles = true; continue }
    if (/^##\s+/.test(line)) { if (inFiles) break; continue }
    if (!inFiles) continue
    if (!line || line.startsWith('- [') || line === '(none)') continue
    const cleaned = line.replace(/^[-*]\s*/, '')
    const lower = cleaned.toLowerCase()
    if (lower.startsWith('read:') || lower.startsWith('modified:')) {
      const bucket = lower.startsWith('read:') ? read : modified
      const val = cleaned.slice(cleaned.indexOf(':') + 1).trim()
      if (val) bucket.push(val)
    } else if (cleaned.includes(':')) {
      modified.push(cleaned.slice(0, cleaned.indexOf(':')).trim())
    } else if (cleaned) {
      modified.push(cleaned)
    }
  }
  return { read, modified }
}

function parseTurnPrefix(text: string): string | undefined {
  const lines = text.split('\n')
  let inPrefix = false
  const collected: string[] = []
  for (const raw of lines) {
    const line = raw.trim()
    if (/^##\s+turn prefix/i.test(line)) { inPrefix = true; continue }
    if (/^##\s+/.test(line)) { if (inPrefix) break; continue }
    if (inPrefix && line) collected.push(line)
  }
  const joined = collected.join('\n').trim()
  return joined.length > 0 ? joined : undefined
}

/**
 * Scan a session's durable event log for the most recent `compaction/summary`
 * that recorded a `## Files Touched` section, and return its parsed read/modified
 * sets so the next summary can inherit the cumulative file context
 * (prime's `readFiles`/`modifiedFiles` cross-round carry). Returns undefined when
 * no prior summary has the section.
 * @param session - session whose event log supplies prior compaction summaries.
 * @returns the prior files-touched sets, or undefined.
 */
export function priorFilesTouched(session: Session): { read: string[]; modified: string[] } | undefined {
  const events = session.events
  for (let index = events.length - 1; index >= 0; index -= 1) {
    // oxlint-disable-next-line typescript/no-non-null-assertion
    const event = events[index]!
    if (event.type !== 'compaction/summary') continue
    const blocks = (event.data as { summary?: unknown }).summary
    if (!Array.isArray(blocks)) continue
    const text = blocks
      .filter((b): b is { type: 'text'; text: string } => typeof b === 'object' && b !== null && (b as { type?: string }).type === 'text')
      .map(b => (b as { text: string }).text)
      .join('\n')
    if (!/##\s+files touched/i.test(text)) continue
    const parsed = parseFilesTouched(text)
    if (parsed.read.length === 0 && parsed.modified.length === 0) continue
    return parsed
  }
  return undefined
}

/** A minimal text-only block assembler, mirroring compaction-basic's BlockAssembler needs. */
class TextAssembler {
  private readonly blocks: ContentBlock[] = []
  private finishReason: { kind: string; failure?: { message: string; code?: string } } = { kind: 'stop' }

  push(chunk: { type: string; text?: string; [key: string]: unknown }): void {
    if (chunk.type === 'text' && typeof chunk.text === 'string') {
      const last = this.blocks.at(-1)
      if (last && last.type === 'text') {
        ;(last as { text: string }).text += chunk.text
      } else {
        this.blocks.push({ type: 'text', text: chunk.text })
      }
    } else if (chunk.type === 'finish') {
      const f = chunk as { reason?: { kind: string; failure?: { message: string; code?: string } } }
      if (f.reason) this.finishReason = f.reason
    }
  }

  get result(): ContentBlock[] { return this.blocks }
  get finish(): { kind: string; failure?: { message: string; code?: string } } { return this.finishReason }
  get usage(): TokenUsage | undefined { return undefined }
}

function finishError(finish: { kind: string; failure?: { message: string; code?: string } }): Error | undefined {
  switch (finish.kind) {
    case 'error':
    case 'aborted': {
      const error = new Error(finish.failure?.message ?? 'summarization failed') as Error & { code?: string }
      if (finish.failure?.code !== undefined) error.code = finish.failure.code
      return error
    }
    case 'max-tokens': {
      const error = new Error('summarization truncated at the token cap (incomplete checkpoint)') as Error & { code?: string }
      error.code = 'MAX_TOKENS'
      return error
    }
    default:
      return undefined
  }
}

function summaryText(blocks: readonly ContentBlock[]): Array<Extract<ContentBlock, { type: 'text' }>> {
  return blocks.filter(
    (block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text',
  )
}

/**
 * Summarize the replayed region through a direct `ctx.llm.stream()` call whose
 * prefix reuses the conversation's own system prompt, tools, and messages so the
 * provider KV cache is preserved. This is the RLM-specific override hook called
 * by {@link RlmSplitTurnCompactionEngine.summarize}.
 * @param ctx - Cordis context supplying `ctx.llm`.
 * @param config - resolved compaction config naming the summarization target.
 * @param input - replayed conversation prefix plus optional prior files.
 * @param agent - supplies the session id and routing fallback.
 * @param signal - optional cancellation forwarded to the adapter.
 * @returns the summary result with parsed files/turn-prefix metadata.
 */
export async function summarizeRlm(
  ctx: Context,
  config: ResolvedCompactionConfig,
  input: RlmSummarizationInput,
  agent: Agent,
  signal?: AbortSignal,
): Promise<RlmSummaryResult> {
  const target = config.summarizationProvider && config.summarizationModel
    ? { provider: config.summarizationProvider, model: config.summarizationModel }
    : (agent.options.provider && agent.options.model
      ? { provider: agent.options.provider, model: agent.options.model }
      : undefined)
  if (target === undefined) {
    throw new Error(
      'no provider/model available for RLM summarization: set both summarizationProvider/summarizationModel or AgentOptions',
    )
  }

  const midTurn = input.messages.length > 0
    && (input.messages[0] as { role?: string } | undefined)?.role === 'assistant'

  const instruction = buildRlmInstruction(midTurn, input.priorFilesTouched)
  const assembler = new TextAssembler()
  const messages: Message[] = [
    ...input.messages,
    createUserMessage({
      content: [{ type: 'text', text: instruction }],
      source: { kind: 'plugin', plugin: 'dsh-rlm-compaction' },
    }),
  ]
  const options: GenerateOptions = {
    provider: target.provider,
    model: target.model,
    messages,
    ...input.system === undefined ? {} : { system: input.system },
    ...input.tools === undefined ? {} : { tools: [...input.tools] },
    maxTokens: config.maxTokens,
    sessionId: agent.session.id,
    purpose: 'compaction',
    ...signal === undefined ? {} : { signal },
  }
  // The adapter yields async chunks; collect them through the assembler.
  const stream = (ctx.llm as unknown as {
    stream(opts: GenerateOptions): AsyncIterable<{ type: string; [key: string]: unknown }>
  }).stream(options)
  for await (const chunk of stream) assembler.push(chunk)

  const error = finishError(assembler.finish)
  if (error !== undefined) throw error

  const rawOutput = assembler.result
  const summary = summaryText(rawOutput)
  if (!summary.some(block => block.text.trim().length > 0)) {
    throw new Error('RLM summarization produced no text summary content')
  }
  const fullText = summary.map(block => block.text).join('\n')
  const { filesTouched } = parseRlmSummary(fullText)
  return {
    summary,
    rawOutput,
    llmStreamCall: true,
    provider: options.provider,
    model: options.model,
    maxTokens: config.maxTokens,
    filesTouched,
    ...assembler.usage === undefined ? {} : { usage: assembler.usage },
  }
}
