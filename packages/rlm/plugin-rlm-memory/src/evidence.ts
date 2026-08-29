/**
 * Evidence gate for draft notes: a note's `source` MUST locate inside its
 * originating `dialog/<sessionId>.jsonl` (REME.md §5.1 D6). Borrow: the paper's
 * "small, evidence-backed updates" + our /refine FIX-8 evidence-required rule;
 * locate semantics mirror ReMe `DreamUnit.paths` (a proposal names the record it
 * derives from). The gate runs before a draft is written — unlocated sources are
 * rejected so every persisted draft is traceable to a stored turn.
 *
 * @module @deepseek-ai/dsh-plugin-rlm-memory/evidence
 */

import type { Note } from './storage.ts'

/** A parsed `source` reference the gate understands. */
export type SourceRef =
  | { kind: 'turn'; index: number }
  | { kind: 'span'; start: number; end: number }
  | { kind: 'contains'; text: string }

/**
 * Parse a `source` string into a structured reference. Accepted forms:
 * - `turn:N` — the Nth dialog line (0-based).
 * - `turn:N-M` — the inclusive line span N..M.
 * - `contains:<substring>` — a dialog line containing the substring.
 * Anything else is unsupported and the gate rejects it.
 * @param source - the note's `source` frontmatter value.
 * @returns the structured reference, or null when the syntax is unrecognized.
 */
export function parseSource(source: string): SourceRef | null {
  const turn = /^turn:(\d+)$/.exec(source)
  if (turn) return { kind: 'turn', index: Number(turn[1]) }
  const span = /^turn:(\d+)-(\d+)$/.exec(source)
  if (span) {
    const start = Number(span[1])
    const end = Number(span[2])
    if (end >= start) return { kind: 'span', start, end }
    return null
  }
  const contains = /^contains:(.+)$/.exec(source)
  if (contains) return { kind: 'contains', text: contains[1] ?? '' }
  return null
}

/**
 * Whether a `source` reference locates a real line in the stored dialog jsonl.
 * The dialog is passed as parsed `{ content }` turns (already tool-stripped by
 * ./sanitize.ts). A `turn`/`span` ref is valid when its indices are in range; a
 * `contains` ref is valid when some line's content includes the substring.
 * @param source - the note's `source` frontmatter value.
 * @param dialogTurns - parsed dialog turns (role + content).
 * @returns true when the source resolves to at least one dialog line.
 */
export function sourceLocatesInDialog(source: string, dialogTurns: ReadonlyArray<{ content: string }>): boolean {
  const ref = parseSource(source)
  if (ref === null) return false
  if (ref.kind === 'turn') {
    return ref.index >= 0 && ref.index < dialogTurns.length
  }
  if (ref.kind === 'span') {
    return ref.start >= 0 && ref.end < dialogTurns.length
  }
  return dialogTurns.some(turn => turn.content.includes(ref.text))
}

/**
 * Validate every note in a proposed draft set against the evidence gate.
 * @param notes - candidate notes (each with a `source` frontmatter).
 * @param dialogTurns - parsed dialog turns the sources must locate within.
 * @returns the notes whose `source` locates in the dialog (admitted); rejected
 *   notes are silently dropped, mirroring /refine's validated-proposal filter.
 */
export function admitByEvidence(notes: readonly Note[], dialogTurns: ReadonlyArray<{ content: string }>): Note[] {
  const out: Note[] = []
  for (const note of notes) {
    if (sourceLocatesInDialog(note.frontmatter.source, dialogTurns)) out.push(note)
  }
  return out
}
