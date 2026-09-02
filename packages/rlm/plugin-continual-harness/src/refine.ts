/**
 * `/refine`, channelized (BUILD.md Phase B item 6): a session-end review whose
 * findings land through the judgment channel — never by writing the harness
 * projection directly.
 *
 * Pipeline: recent transcript → extraction subagent (host seam) → JSON
 * proposals → the deterministic whitelist criterion (`crit/refine-whitelist`:
 * every proposal's evidence must be LOCATABLE in the transcript it cites —
 * the same admitByEvidence semantics as the memory gate) → one judgment per
 * admitted proposal (`crit/refine-whitelist`, conclusion, procedural belief,
 * subject `harness:memory:<slug>`). An existing belief on the same subject is
 * superseded (the reducer voids it mechanically).
 *
 * No reverse snapshots: the harness file is a projection; retracted content
 * is voided in the store and disappears from the next render.
 *
 * @module @deepseek-ai/dsh-plugin-continual-harness/refine
 */

import type { Context } from '@deepseek-ai/cordis'
// Pulls the subagents Context augmentation so `ctx.subagents` type-checks here.
import type {} from '@deepseek-ai/dsh-subagent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { RlmScope, RlmStore } from '@deepseek-ai/dsh-plugin-rlm-store'

/** How much of the recent transcript the extractor sees. */
const TRANSCRIPT_WINDOW = 24
/** Budget caps mirroring the projection renderer's hints-only philosophy. */
const MAX_PROPOSALS = 6
const MAX_CONTENT_CHARS = 1200

interface RawProposal {
  kind?: unknown
  title?: unknown
  content?: unknown
  evidence?: unknown
}

export interface RefineProposalOut {
  subject: string
  title: string
  content: string
  evidence: string
  supersededId?: string
}

export interface RefineOutcome {
  text: string
  landed: number
  rejected: number
}

function extractorPrompt(transcript: string): string {
  return [
    'You are the harness refiner. Review the transcript excerpt and propose durable,',
    'evidence-backed updates to the agent\'s memory (facts worth keeping across turns).',
    'Rules:',
    '- Propose at most ' + String(MAX_PROPOSALS) + ' updates; skip anything transient or already captured.',
    '- Every proposal MUST cite `evidence`: a verbatim snippet (20+ chars) from the transcript that supports it.',
    '- Reply with ONLY a JSON array, no prose: [{"kind":"memory","title":"...","content":"...","evidence":"..."}].',
    '',
    '--- TRANSCRIPT EXCERPT ---',
    transcript,
  ].join('\n')
}

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'entry'
  )
}

/** Deterministic whitelist criterion: the cited evidence must appear in the transcript. */
export function validateProposal(raw: RawProposal, transcript: string): RefineProposalOut | string {
  const title = typeof raw.title === 'string' ? raw.title.trim() : ''
  const content = typeof raw.content === 'string' ? raw.content.trim() : ''
  const evidence = typeof raw.evidence === 'string' ? raw.evidence.trim() : ''
  if (title === '' || content === '') return 'rejected: title/content missing'
  if (evidence.length < 20) return `rejected: evidence too short for "${title.slice(0, 40)}"`
  const normalizedTranscript = transcript.replace(/\s+/g, ' ')
  const normalizedEvidence = evidence.replace(/\s+/g, ' ')
  if (!normalizedTranscript.includes(normalizedEvidence)) {
    return `rejected: evidence not locatable in the transcript for "${title.slice(0, 40)}"`
  }
  if (content.length > MAX_CONTENT_CHARS) {
    return `rejected: content over ${String(MAX_CONTENT_CHARS)} chars for "${title.slice(0, 40)}"`
  }
  return {
    subject: `harness:memory:${slug(title)}`,
    title: `[refine] ${title}`,
    content,
    evidence,
  }
}

function parseProposals(resultText: string): RawProposal[] {
  const start = resultText.indexOf('[')
  const end = resultText.lastIndexOf(']')
  if (start < 0 || end <= start) return []
  try {
    const parsed: unknown = JSON.parse(resultText.slice(start, end + 1))
    return Array.isArray(parsed) ? (parsed as RawProposal[]).slice(0, MAX_PROPOSALS) : []
  } catch {
    return []
  }
}

/**
 * Run the channelized session-end review. Proposals that fail the whitelist
 * criterion are named in the summary (rejected proposals are information, not
 * errors); admitted ones land as judgments.
 * @param ctx - Cordis context (subagent seam).
 * @param store - the unified store.
 * @param sessionId - the reviewing session's id.
 * @param agent - the reviewing agent (its session provides the transcript).
 * @param provider - the extraction subagent provider name.
 * @param signal - cancellation signal.
 * @returns the human-readable summary.
 */
export async function runRefineChannelized(
  ctx: Context,
  store: RlmStore,
  sessionId: string,
  agent: Agent,
  provider: string,
  signal: AbortSignal,
): Promise<RefineOutcome> {
  const scope: RlmScope = { kind: 'session', id: sessionId }
  const messages: Array<{ role?: string; content?: unknown }> =
    agent.session.deriveMessages().slice(-TRANSCRIPT_WINDOW)
  const transcript = messages
    .map(m => `[${typeof m.role === 'string' ? m.role : 'unknown'}] ${
      typeof m.content === 'string'
        ? m.content
        : Array.isArray(m.content)
          ? m.content.map(part => (typeof part === 'object' && part !== null && 'text' in part ? String((part as { text?: unknown }).text ?? '') : '')).join('')
          : ''
    }`)
    .join('\n')
  if (transcript.trim() === '') {
    return { text: '/refine: nothing to review — the transcript window is empty.', landed: 0, rejected: 0 }
  }

  const run = await ctx.subagents.start(provider, {
    prompt: [{ type: 'text', text: extractorPrompt(transcript) }],
    parent: agent,
    label: 'refine-extractor',
    signal,
  })
  const resultText = await run.result.then(
    (r: unknown) => (typeof r === 'string' ? r : Array.isArray(r) ? r.map((p: unknown) => (typeof p === 'object' && p !== null && 'text' in p ? String((p as { text?: unknown }).text ?? '') : '')).join('') : ''),
    () => '',
  )
  const raw = parseProposals(resultText)
  if (raw.length === 0) {
    return { text: '/refine: the extractor proposed nothing durable — no judgments landed.', landed: 0, rejected: 0 }
  }

  const lines: string[] = []
  let landed = 0
  let rejected = 0
  for (const item of raw) {
    const checked = validateProposal(item, transcript)
    if (typeof checked === 'string') {
      rejected += 1
      lines.push(checked)
      continue
    }
    // The review itself is an observation: on an empty stream it anchors the
    // judgments' provenance.
    if (store.view(scope).seq === 0) {
      await store.append(scope, 'rlm/observation', { kind: 'refine-review', session: sessionId })
    }
    const existing = store.beliefs(scope).find(b => b.subject === checked.subject)
    await store.judge(scope, {
      criterionRef: 'crit/refine-whitelist',
      verdict: 'conclusion',
      belief: {
        kind: 'procedural',
        content: checked.content,
        title: checked.title,
        subject: checked.subject,
        basedOn: [],
        lastVerified: { channel: 'refine-whitelist', eventPos: store.view(scope).seq },
        ...(existing ? { supersedes: { id: existing.id, reason: 'refine revision' } } : {}),
      },
      dataSupport: { summary: 'evidence locatable in transcript', refs: [checked.evidence] },
      provenance: { eventRange: [1, store.view(scope).seq] },
    })
    landed += 1
    lines.push(`landed: ${checked.title} (subject ${checked.subject})`)
  }
  return { text: `/refine: ${String(landed)} landed, ${String(rejected)} rejected.\n${lines.join('\n')}`, landed, rejected }
}
