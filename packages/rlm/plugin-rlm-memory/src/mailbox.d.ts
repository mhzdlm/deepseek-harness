/**
 * The mailbox surface (BUILD.md Phase C, ARCHITECTURE.md §9): the store's
 * mailbox scope as the cross-session authority, with `published/` Markdown
 * files demoted to its projection.
 *
 * - `publishToMailbox` — the two-sided publish: the mailbox stream records
 *   "published" FIRST (so no "session thinks it published but the mailbox has
 *   no record" state can exist), then the session stream records "decided to
 *   hand over". A missed session-side line is a path-bookkeeping gap the
 *   mirroring fallback can repair — never a lost publication.
 * - `renderMailboxProjection` / `syncMailboxProjection` — published/ files are
 *   a pure function of the mailbox view (plus the preserved local use-signal
 *   frontmatter fields, which are usage counters, not belief content).
 * - `importLegacyNotes` — pre-Phase-C notes are imported as human-revision
 *   events: conservative, auditable, idempotent.
 * - `detectHumanRevisions` — a direct file edit is the human semantic-exempt
 *   write; the watcher turns it into an `rlm/human-revision` event (the
 *   physical path is still the stream).
 * - `pickupMailboxSeeds` — continuation pickup: mailbox beliefs join the
 *   session scope as PROVISIONAL nominations (mailbox evidenced is a
   * nomination, never a grade); same-subject conflicts are all picked up and
 *   explicitly marked.
 * - `proposeCriterion` / `approveCriterion` — criterion-revision track: an
 *   overturning revision parks in the mailbox for human approval (r9 §7).
 *
 * @module @deepseek-ai/dsh-plugin-rlm-memory/mailbox
 */
import { type FSWatcher } from 'node:fs';
import type { RlmScope, RlmStore } from '@deepseek-ai/dsh-plugin-rlm-store';
/** The mailbox scope (single, family-wide). */
export declare const MAILBOX_SCOPE: RlmScope;
export interface MailboxPublishInput {
    subject: string;
    title: string;
    content: string;
    kind: 'declarative' | 'procedural';
    /** Evidence/provenance note (where this came from). */
    evidence: string;
    /** True when this is a new revision of the same subject by the same author. */
    revision?: boolean;
}
export interface MailboxGateConfig {
    gateMode: 'off' | 'observe' | 'enforce';
    sessionId: string;
    sessionScope: RlmScope;
    mailboxScope?: RlmScope;
}
export interface MailboxPublishReport {
    published: number;
    observed: number;
    subjects: string[];
    conflicts: string[];
    /**
     * Phase D freeze lock: subjects whose latest mailbox belief is frozen skip
     * publication — re-publishing would route around the audit freeze. A newer
     * active belief (a human revision) means the freeze was already resolved.
     */
    frozenSkips: string[];
}
/** Filename slug shared by the projection renderer and the mailbox-aware consolidation path. */
export declare function slug(text: string): string;
/**
 * Publish proposals into the mailbox under the gate. Trust semantics: the
 * landing judgment grades PROVISIONAL (publish is a hand-off, not a
 * verification); promotion happens only through a real check later.
 * @param store - the unified store.
 * @param gate - gate mode + scoping.
 * @param inputs - the proposals to publish.
 * @returns the publish report (counts + subjects + conflict subjects).
 */
export declare function publishToMailbox(store: RlmStore, gate: MailboxGateConfig, inputs: readonly MailboxPublishInput[]): Promise<MailboxPublishReport>;
/**
 * Render the mailbox view into the published/ projection. Titled active
 * beliefs become Markdown notes; per-file `use_count` / `last_accessed` are
 * usage counters, preserved from any existing file (they are not belief
 * content and a re-render must not erase them).
 * @param store - the unified store.
 * @param memoryDir - the memory root holding `published/`.
 * @returns the number of notes rendered (including removals of retracted ones).
 */
export declare function syncMailboxProjection(store: RlmStore, memoryDir: string): Promise<number>;
/**
 * Import pre-Phase-C published notes into the mailbox as human-revision
 * events. Idempotent: a note whose subject already has an ACTIVE mailbox
 * belief with identical content is skipped.
 * @param store - the unified store.
 * @param memoryDir - the memory root.
 * @returns the number of notes imported.
 */
export declare function importLegacyNotes(store: RlmStore, memoryDir: string): Promise<number>;
/**
 * One reconciliation pass over `published/`: any file whose content differs
 * from the mailbox view's render (or that vanished) becomes an
 * `rlm/human-revision` event — the human semantic-exempt write, captured into
 * the stream instead of silently diverging.
 * @param store - the unified store.
 * @param memoryDir - the memory root.
 * @returns the number of revision events appended.
 */
export declare function detectHumanRevisions(store: RlmStore, memoryDir: string): Promise<number>;
/**
 * Watch the published/ projection and reconcile human edits into the stream.
 * @param store - the unified store.
 * @param memoryDir - the memory root.
 * @returns the watcher (call `.close()` on dispose).
 */
export declare function watchMailboxProjection(store: RlmStore, memoryDir: string): FSWatcher | null;
export interface MailboxPickupReport {
    picked: number;
    conflicts: string[];
    byId: Map<string, string>;
}
/**
 * Continuation pickup (r9 §9): mailbox beliefs join the session scope as
 * PROVISIONAL nominations — mailbox evidenced is a nomination, never a grade.
 * Same-subject conflict sets are all picked up and explicitly marked.
 * @param store - the unified store.
 * @param sessionScope - the continuing session's scope.
 * @returns the pickup report.
 */
export declare function pickupMailboxSeeds(store: RlmStore, sessionScope: RlmScope): Promise<MailboxPickupReport>;
export interface CriterionProposal {
    id: string;
    tier: 'deterministic' | 'structured' | 'open';
    title: string;
    reason: string;
}
/**
 * Park a criterion-revision proposal in the mailbox for human approval
 * (r9 §7 — overturning revisions need the human channel; the approval power
 * is never delegated to bandwidth).
 * @param store - the unified store.
 * @param sessionScope - the proposing session.
 * @param proposal - the proposed criterion revision.
 * @returns the mailbox belief id of the parked proposal.
 */
export declare function proposeCriterion(store: RlmStore, sessionScope: RlmScope, proposal: CriterionProposal): Promise<string>;
/**
 * Human approval of a parked criterion proposal: registers the criterion on
 * the store (effective immediately) and records the approval event in the
 * mailbox stream. The registration is runtime-only for now — a persistent
 * approved-criteria store lands with the Phase D audit surface.
 * @param store - the unified store.
 * @param proposal - the approved proposal (id/tier/title as proposed).
 * @returns void
 */
export declare function approveCriterion(store: RlmStore, proposal: CriterionProposal): Promise<void>;
//# sourceMappingURL=mailbox.d.ts.map