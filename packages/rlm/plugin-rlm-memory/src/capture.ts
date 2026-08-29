/**
 * Host-owned capture pipeline: accumulate a completed session's turns in memory,
 * then on session disposal sanitize (strip tool results), persist
 * `dialog/<id>.jsonl`, and spawn a host-owned extraction subagent that proposes
 * draft notes. Drafts pass the evidence gate (./evidence.ts) before landing in
 * `drafts/`. The sanitized dialog is the durable artifact even when extraction
 * yields nothing (REME.md §5.1 D3/D5/D6; capture mirrors ReMe `runtime.capture`
 * but host-owned, like the other rlm plugins).
 *
 * @module @deepseek-ai/dsh-plugin-rlm-memory/capture
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import { sanitizeTurns, renderDialogJsonl, type CaptureTurn } from './sanitize.ts'
import { writeDialog, readDialog, writeDraft, type Note, type NoteFrontmatter } from './storage.ts'
import { admitByEvidence } from './evidence.ts'

/** One session's accumulated turns, keyed by session id in the buffer Map. */
export interface CaptureBufferEntry {
  sessionId: string
  turns: CaptureTurn[]
}

/**
 * Build the frontmatter for one draft note produced by extraction.
 * `source_conversation` points at the dialog jsonl so a reader can open the
 * original; `source` is the evidence-gate reference (validated by ./evidence.ts).
 * @param sessionId - the captured session id.
 * @param source - an evidence reference locating inside the dialog jsonl.
 * @param nowIso - ISO timestamp for created/updated/last_accessed.
 * @returns the frontmatter block for a fresh observe/pass draft.
 */
function draftFrontmatter(sessionId: string, source: string, nowIso: string): NoteFrontmatter {
  return {
    kind: 'personal',
    scope: 'session',
    session_id: sessionId,
    source,
    source_conversation: `dialog/${sessionId}.jsonl`,
    created_at: nowIso,
    updated_at: nowIso,
    version: 1,
    use_count: 0,
    last_accessed: nowIso,
    gate: { mode: 'observe', verdict: 'pass', reviewed_at: nowIso },
  }
}

/**
 * Parse the extraction subagent's JSON proposal text into candidate notes. The
 * subagent returns a JSON array of `{ title, source, body }`; any entry missing a
 * `source` or failing to parse is dropped (the gate enforces `source` later, but
 * a missing field is a structural rejection here). Returns notes WITHOUT a
 * `kind` set by default (`personal`) — the extraction prompt asks for the bucket
 * but the gate does not depend on it.
 * @param proposalText - the subagent's raw text output.
 * @param sessionId - the captured session id (used for slug + source_conversation).
 * @returns candidate notes ready for the evidence gate.
 */
export function parseExtractionProposal(proposalText: string, sessionId: string): Note[] {
  const nowIso = new Date().toISOString()
  let parsed: unknown
  try {
    parsed = JSON.parse(proposalText)
  } catch {
    // The subagent may wrap JSON in prose; extract the first [...] or {...}.
    const arr = /\[[\s\S]*\]/.exec(proposalText)
    const obj = /\{[\s\S]*\}/.exec(proposalText)
    const candidate = arr ? arr[0] : obj ? obj[0] : null
    if (!candidate) return []
    try {
      parsed = JSON.parse(candidate)
    } catch {
      return []
    }
  }
  const list = Array.isArray(parsed) ? parsed : []
  const notes: Note[] = []
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue
    const { title, source, body, kind } = item as Record<string, unknown>
    if (typeof source !== 'string' || source.length === 0) continue
    if (typeof title !== 'string' || typeof body !== 'string') continue
    const allowedKind = kind === 'procedure' || kind === 'wiki' ? kind : 'personal'
    notes.push({
      frontmatter: { ...draftFrontmatter(sessionId, source, nowIso), kind: allowedKind },
      body,
    })
  }
  return notes
}

/**
 * Persist the captured dialog and land admission-gated drafts for one session.
 * The dialog is written FIRST and unconditionally; drafts follow only after the
 * evidence gate admits them. Returns the landing summary for the audit event.
 * @param memoryDir - resolved memory root.
 * @param entry - the accumulated capture buffer entry.
 * @param proposals - candidate notes from the extraction subagent (may be empty).
 * @returns counts for the `session/memory-captured` event payload.
 */
export function persistCapture(
  memoryDir: string,
  entry: CaptureBufferEntry,
  proposals: readonly Note[],
): { dialogTurns: number; draftsAdmitted: number; draftChars: number } {
  const sanitized = sanitizeTurns(entry.turns)
  const jsonl = renderDialogJsonl(sanitized)
  writeDialog(memoryDir, entry.sessionId, jsonl)
  // Re-read the stored dialog so the gate checks the same bytes we persisted.
  const dialogTurns = readDialog(memoryDir, entry.sessionId)
  const admitted = admitByEvidence(proposals, dialogTurns)
  let draftChars = 0
  for (const note of admitted) {
    writeDraft(memoryDir, note, entry.sessionId, note.body.slice(0, 48) || note.frontmatter.source)
    draftChars += note.body.length
  }
  return { dialogTurns: sanitized.length, draftsAdmitted: admitted.length, draftChars }
}

/**
 * Run the extraction subagent for one completed session. Spawns a host-owned
 * non-reasoning child (provider `'spawn'`) whose parent is the captured
 * session's owning Agent, following the moa/verifier subagent-call shape. The
 * call is best-effort: any failure resolves to `[]` so the durable dialog still
 * lands. Extra subagent request fields are NOT added (REME.md Phase A: keep the
 * call minimal — `{ prompt, parent, signal }`).
 * @param subagents - the `ctx.subagents` runtime.
 * @param parent - the captured session's owning Agent (the extraction parent).
 * @param sessionId - the captured session id.
 * @param dialogText - the sanitized dialog text the subagent reads.
 * @param signal - caller cancellation.
 * @returns the candidate notes, or `[]` on any extraction failure.
 */
export async function extractDrafts(
  subagents: SubagentRuntime,
  parent: Agent,
  sessionId: string,
  dialogText: string,
  signal: AbortSignal,
): Promise<Note[]> {
  if (dialogText.trim().length === 0) return []
  const prompt = [
    { type: 'text' as const, text: extractionPrompt(sessionId, dialogText) },
  ]
  try {
    const run = await subagents.start('spawn', { prompt, parent, signal })
    const result = await run.result
    const text = (result.output ?? [])
      .map(block => (block.type === 'text' ? (block.text ?? '') : ''))
      .join('')
      .trim()
    return parseExtractionProposal(text, sessionId)
  } catch {
    // Extraction is auxiliary; a failure must not block the durable dialog write.
    return []
  }
}

/** Build the extraction subagent's prompt (host-owned, deterministic spec). */
function extractionPrompt(sessionId: string, dialogText: string): string {
  return [
    'You are extracting cross-session knowledge notes from a completed agent conversation.',
    'The conversation below is the sanitized dialog (tool results already removed).',
    '',
    `Session id: ${sessionId}`,
    '',
    'Return ONLY a JSON array of note objects. Each note:',
    '  { "title": string, "kind": "procedure"|"personal"|"wiki", "source": string, "body": string }',
    'The "source" field MUST be an evidence reference that locates inside the dialog:',
    '  use "turn:N" (0-based line index) or "turn:N-M" (inclusive span) or "contains:<substring>".',
    'Do NOT cite anything not present in the dialog; every note needs a source that resolves.',
    'Prefer a few high-signal notes over many trivial ones.',
    '',
    '--- DIALOG START ---',
    dialogText,
    '--- DIALOG END ---',
  ].join('\n')
}
