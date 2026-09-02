/**
 * Phase C consolidation: the publish gate + deterministic promotion + reverse-snapshot
 * rollback + growth budget (REME.md §5.3, §10 Phase C acceptance). Borrows from the
 * design's cited precedents:
 *
 * - Consolidation + lightweight dedup borrow ReMe `auto_dream`/`auto_memory` merge
 *   discipline + the paper's growth-evaluation/retrieval-quality policy (arXiv
 *   2605.09998): the four-step scan→decide→reverse-snapshot→write is a deterministic,
 *   no-LLM simplification of auto_dream's topics→extract→integrate→finish; the paper's
 *   growth evaluation is the budget that makes a round merge-only when over quota
 *   (D2 growth budget; D9 consolidation).
 * - The publish gate `enforce` reuses the Phase A evidence locator verbatim
 *   (`admitByEvidence` from ./evidence.ts, accepting `turn:N`/`turn:N-M`/`contains:<text>`
 *   that locate in the draft's `source_conversation` dialog — D6). `observe` promotes
 *   every eligible draft but flags gate:'observe' (non-blocking, logged); `off` is a
 *   logged no-op (REME.md §5.3 D10).
 * - Reverse-snapshot rollback borrows the harness `writeHarnessStates` override-warning
 *   pattern (plugin-continual-harness/src/harness-file.ts): before overwriting a file,
 *   snapshot its current content; `rollbackNote` warns when the live published note was
 *   edited after our last write (mtime newer than the latest snapshot) and refuses to
 *   clobber unless `force` is given (D11).
 * - Growth budget (`maxPublishedNotes`/`maxPublishedBytes`) borrows the paper's growth
 *   evaluation (D2): over budget, `observe` logs+skips, `enforce` rejects — the round
 *   only merges, never grows unbounded.
 * - Embeddings are deferred per REME.md §12 open question 1 (no dsh embeddings seam), so
 *   dedup is token-overlap (reuse `tokenize` from ./search.ts), not semantic.
 *
 * Single-flight lock (an in-process `Map<string, Promise>` keyed by target published
 * relPath, mirroring the `runs` Map in plugin-rlm-loop/src/loop-tool.ts) prevents two
 * concurrent consolidations of the same note from clobbering each other.
 *
 * @module @deepseek-ai/dsh-plugin-rlm-memory/consolidate
 */
import type { RlmScope, RlmStore } from '@deepseek-ai/dsh-plugin-rlm-store';
import type { EmbeddingService } from './embedding.ts';
import { snapshotsDir, type Note } from './storage.ts';
/** Publish-gate mode (REME.md §5.3 D10 / §9 gateMode). */
export type GateMode = 'off' | 'observe' | 'enforce';
/** Consolidation options, resolved from plugin Config (no hardcoded tunables). */
export interface ConsolidateOptions {
    /** Publish-gate mode (default `'observe'`). */
    gateMode: GateMode;
    /** Maximum published notes before promotion is skipped/rejected (default 200). */
    maxPublishedNotes: number;
    /** Maximum total bytes across `published/` before promotion is skipped/rejected (default 5_000_000). */
    maxPublishedBytes: number;
    /**
     * Optional embedding provider (Phase E, REME.md §12.1). When present, `promoteDraft`
     * caches the promoted note's embedding (best-effort) so `hybridSearch` can fuse it with
     * lexical BM25. Absent = no embedding cache (lexical fallback in search).
     */
    embeddingService?: EmbeddingService;
    /**
     * Phase C authority flip (docs 仓 ARCHITECTURE.md §9): when the unified store is
     * present, a promotion lands as a MAILBOX belief (provisional nomination) through
     * `publishToMailbox` instead of a direct `published/` file write — `published/`
     * becomes a projection the caller re-renders (`syncMailboxProjection`, run by
     * `consolidate` itself and the session bootstrap). The evidence gate and growth
     * budget semantics above are unchanged; the reverse-snapshot step is skipped
     * (the mailbox stream's supersedes chain is the rollback face), and the
     * embedding cache is skipped for mailbox landings (accepted limitation,
     * BUILD.md Phase C). Absent = the legacy direct-file promotion (tests, hosts
     * without the store plugin).
     */
    store?: RlmStore | undefined;
    /** The acting session's store scope (publish-side handover record). */
    sessionScope?: RlmScope | undefined;
    /** The acting session's id (publish provenance note). */
    sessionId?: string | undefined;
}
/**
 * The decision reached for one draft during the decide step. `skip-budget`
 * carries a `reason` so callers can distinguish a genuine budget skip from an
 * unreadable (unparseable) draft file (Phase 8: the old report called both
 * "growth budget", which misaudited corrupt drafts).
 */
export type DraftDecision = {
    kind: 'promote';
    note: Note;
    draftPath: string;
    publishedRel: string;
} | {
    kind: 'reject';
    note: Note;
    draftPath: string;
    reason: string;
} | {
    kind: 'skip-budget';
    note: Note;
    draftPath: string;
    reason?: 'budget' | 'unreadable';
};
/** One line of a consolidation report (the audit trail returned by `consolidate`). */
export interface ConsolidateResult {
    /** Number of drafts scanned. */
    scanned: number;
    /** Drafts promoted to published this round. */
    promoted: number;
    /** Drafts rejected by the `enforce` gate (stay drafts). */
    rejected: number;
    /** Drafts skipped because the growth budget was exceeded. */
    skippedBudget: number;
    /** No-op under `gateMode: 'off'` (drafts untouched). */
    noop: boolean;
    /** Warning lines (budget overruns under `observe`, flagged-but-promoted drafts). */
    warnings: string[];
    /** Per-draft decisions, for callers that want detail. */
    decisions: DraftDecision[];
}
/**
 * Run `fn` under the consolidate single-flight lock. Phase 8 (review round 6):
 * the lock is a single global queue rather than a per-key join. The old join
 * semantics returned the FIRST caller's promise to a second caller that hit the
 * lock — the second draft was reported promoted while its own file work never
 * ran (its draft file stayed behind and the promoted count over-counted). A
 * global key is honest here: promotions are user-command-frequency events and
 * every promotion scans/writes the shared `published/` tree.
 * @param key - reserved for future keyed use (kept for call-site clarity).
 * @param fn - the guarded async work.
 * @returns the result of THIS caller's `fn` (queued behind any in-flight work).
 */
export declare function withLock<T>(key: string, fn: () => Promise<T>): Promise<T>;
/**
 * Promote a single eligible draft to `published/`: gate + budget + reverse-snapshot +
 * write, then remove the consumed draft. Runs under {@link withLock} on the target
 * published relPath so concurrent promotions of the same note cannot clobber.
 *
 * - gate `off`: returns a `skip`-style result without writing (the caller's `consolidate`
 *   treats `off` as a logged no-op and never calls this for promotion).
 * - gate `observe`: write with `gate.mode:'observe'`; a draft lacking a valid `source`
 *   is still promoted but flagged (non-blocking, `warnings`).
 * - gate `enforce`: only write when `admitByEvidence` accepts the draft against its
 *   `source_conversation` dialog; failures stay as drafts with `rejected_at`/`rejection`.
 * @param memoryDir - resolved memory root.
 * @param draftPath - absolute path of the draft note to promote.
 * @param options - resolved gate + budget options.
 * @returns the decision taken for this draft.
 */
export declare function promoteDraft(memoryDir: string, draftPath: string, options: ConsolidateOptions): Promise<DraftDecision>;
/**
 * Consolidate every draft under `memoryDir` into published notes under the given gate
 * and budget (REME.md §5.3 four-step, deterministic, no LLM). Single-flight per target
 * note via {@link withLock} inside {@link promoteDraft}. Returns an audit report.
 * @param memoryDir - resolved memory root.
 * @param options - resolved gate + budget options.
 * @returns the consolidation result (counts + warnings + per-draft decisions).
 */
export declare function consolidate(memoryDir: string, options: ConsolidateOptions): Promise<ConsolidateResult>;
/** Outcome of a reverse-snapshot rollback (REME.md §5.3 D11). */
export interface RollbackOutcome {
    /** Relative published note path restored (or that would be). */
    noteId: string;
    /** Whether the live note was edited after our last snapshot (override-warning). */
    warnedUserEdit: boolean;
    /** Whether a restore actually happened (false when warnedUserEdit && !force). */
    restored: boolean;
    /** Human-readable message for the command output. */
    message: string;
}
/**
 * Restore the latest `snapshots/<noteId>/<iso>.md` over the published note. Implements
 * the harness `writeHarnessStates` override-warning discipline (harness-file.ts): if the
 * published note's current mtime is NEWER than the latest snapshot's mtime (a user/extern
 * edit landed after our last write), return `warnedUserEdit: true` and do NOT overwrite
 * unless `force` is given; with `force`, restore the snapshot (REME.md §5.3 D11).
 * @param memoryDir - resolved memory root.
 * @param noteId - the relative published note path to roll back.
 * @param force - when true, overwrite even a user-edited note.
 * @returns the rollback outcome (warning flag + whether restored + message).
 */
export declare function rollbackNote(memoryDir: string, noteId: string, force: boolean): Promise<RollbackOutcome>;
/** Re-export for callers that need the snapshots dir path. */
export { snapshotsDir };
//# sourceMappingURL=consolidate.d.ts.map