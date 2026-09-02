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
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { SubagentRuntime } from '@deepseek-ai/dsh-subagent';
import { type CaptureTurn } from './sanitize.ts';
import { type Note } from './storage.ts';
/** One session's accumulated turns, keyed by session id in the buffer Map. */
export interface CaptureBufferEntry {
    sessionId: string;
    turns: CaptureTurn[];
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
export declare function parseExtractionProposal(proposalText: string, sessionId: string): Note[];
/**
 * Persist the captured dialog and land admission-gated drafts for one session.
 * The dialog is written FIRST and unconditionally; drafts follow only after the
 * evidence gate admits them. Returns the landing summary for the audit event.
 *
 * Phase 8 (review round 6): the write is CUMULATIVE — the stored dialog is
 * re-read and the sanitized window appended, then the whole file rewritten.
 * The old whole-file overwrite meant each `intervalTurns` flush (and a dispose
 * after interval flushes) erased every earlier window, so `turn:N` evidence
 * references in older drafts stopped resolving and the enforce gate wrongly
 * rejected them. Cumulative text also keeps extraction and gate byte-aligned:
 * the extractor sees the same cumulative dialog the gate re-reads.
 * @param memoryDir - resolved memory root.
 * @param entry - the accumulated capture buffer entry.
 * @param proposals - candidate notes from the extraction subagent (may be empty).
 * @returns counts for the `session/memory-captured` event payload.
 */
export declare function persistCapture(memoryDir: string, entry: CaptureBufferEntry, proposals: readonly Note[]): {
    dialogTurns: number;
    draftsAdmitted: number;
    draftChars: number;
};
/**
 * Run the extraction subagent for one completed session. Spawns a host-owned
 * non-reasoning child (provider `'spawn'`) whose parent is the captured
 * session's owning Agent, following the moa/verifier subagent-call shape. An
 * empty dialog resolves to `[]` without spawning; anything else is
 * fail-loud — see `@returns`. Extra subagent request fields are NOT added
 * (REME.md Phase A: keep the call minimal — `{ prompt, parent, signal }`).
 * @param subagents - the `ctx.subagents` runtime.
 * @param parent - the captured session's owning Agent (the extraction parent).
 * @param sessionId - the captured session id.
 * @param dialogText - the sanitized dialog text the subagent reads.
 * @param signal - caller cancellation.
 * @param timeoutMs - wall-clock budget for the child's run (default 120_000); an
 * expired budget aborts the child.
 * @returns the candidate notes; `[]` only when the dialog is empty or
 * extraction found nothing. A child failure (spawn error, rejected run) is
 * rethrown — a failed extraction must be auditable as a failure, never reads
 * as "nothing to extract" (the runCapture caller catches, warns, and records
 * `extractionRan: false`; the dialog still lands).
 */
export declare function extractDrafts(subagents: SubagentRuntime, parent: Agent, sessionId: string, dialogText: string, signal: AbortSignal, timeoutMs?: number): Promise<Note[]>;
//# sourceMappingURL=capture.d.ts.map