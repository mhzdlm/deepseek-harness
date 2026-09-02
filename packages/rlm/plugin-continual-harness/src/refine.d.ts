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
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { RlmStore } from '@deepseek-ai/dsh-plugin-rlm-store';
interface RawProposal {
    kind?: unknown;
    title?: unknown;
    content?: unknown;
    evidence?: unknown;
}
export interface RefineProposalOut {
    subject: string;
    title: string;
    content: string;
    evidence: string;
    supersededId?: string;
}
export interface RefineOutcome {
    text: string;
    landed: number;
    rejected: number;
}
/** Deterministic whitelist criterion: the cited evidence must appear in the transcript. */
export declare function validateProposal(raw: RawProposal, transcript: string): RefineProposalOut | string;
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
export declare function runRefineChannelized(ctx: Context, store: RlmStore, sessionId: string, agent: Agent, provider: string, signal: AbortSignal): Promise<RefineOutcome>;
export {};
//# sourceMappingURL=refine.d.ts.map