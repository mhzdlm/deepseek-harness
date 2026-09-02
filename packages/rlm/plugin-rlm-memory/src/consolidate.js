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
import { readFileSync, statSync, existsSync, writeFileSync, utimesSync } from 'node:fs';
import { join, sep } from 'node:path';
import { publishToMailbox, slug, syncMailboxProjection } from "./mailbox.js";
import { listDrafts, parseNote, deleteDraft, writePublished, writeEmbedding, listPublished, publishedRelFor, snapshotsDir, takeSnapshot, listSnapshots, restoreSnapshot, serializeNote, } from "./storage.js";
import { sourceLocatesInDialog } from "./evidence.js";
import { tokenize } from "./search.js";
/**
 * In-process single-flight lock keyed by target published relPath. Two concurrent
 * consolidations of the same note serialize through one promise (mirrors the `runs`
 * Map pattern in plugin-rlm-loop/src/loop-tool.ts: a shared `Map<key, Promise>` so a
 * second caller awaits the first instead of clobbering). Module-level: one lock per
 * process, which is the only place two consolidations can race.
 */
const locks = new Map();
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
export function withLock(key, fn) {
    void key;
    const inFlight = locks.get(GLOBAL_LOCK_KEY);
    const promise = (async () => {
        if (inFlight)
            await inFlight.catch(() => undefined);
        return await fn();
    })();
    const tracked = promise.finally(() => {
        // Only the tail of the chain clears the key, so a queued caller's lock is
        // never dropped while it is still pending.
        if (locks.get(GLOBAL_LOCK_KEY) === tracked)
            locks.delete(GLOBAL_LOCK_KEY);
    });
    locks.set(GLOBAL_LOCK_KEY, tracked);
    return promise;
}
/** The single global lock key (see {@link withLock}). */
const GLOBAL_LOCK_KEY = 'consolidate:promote';
/**
 * Compute the deterministic published relative path for a promoted draft. Delegates to
 * {@link publishedRelFor} from ./storage.ts, which derives the slug exactly as
 * {@link writePublished} does (REME.md §4 layout: `published/<kind>/<slug>.md`, slug from
 * the `source` reference), so the single-flight key and the dedup target agree with where
 * the note actually lands.
 * @param note - the draft note to be promoted.
 * @returns the relative published path.
 */
// (publishedRelFor is imported from ./storage.ts — see below in promoteDraft.)
/**
 * Count current published notes and total bytes (growth budget, REME.md §5.3 D2).
 * @param memoryDir - resolved memory root.
 * @returns the note count and the summed file size in bytes.
 */
function measureBudget(memoryDir) {
    const paths = listPublished(memoryDir);
    let bytes = 0;
    for (const p of paths) {
        try {
            bytes += statSync(p).size;
        }
        catch { /* missing mid-walk: ignore */ }
    }
    return { count: paths.length, bytes };
}
/**
 * Whether a draft's token overlap with an existing published note exceeds the dedup
 * threshold. Reuses `tokenize` from ./search.ts (embeddings deferred per §12 open
 * question 1, so dedup is lexical token-overlap, not semantic). Returns the relPath of
 * the best-overlap published note when its Jaccard-like overlap ≥ `threshold`, else null.
 * @param note - the draft note.
 * @param memoryDir - resolved memory root.
 * @param threshold - minimum overlap ratio (0..1) to treat as an overwrite target.
 * @returns the published relPath to overwrite, or null when no note overlaps enough.
 */
function dedupTarget(note, memoryDir, threshold = 0.5) {
    const draftTerms = tokenize(`${note.frontmatter.source}\n${note.body}`);
    if (draftTerms.size === 0)
        return null;
    let best = null;
    for (const p of listPublished(memoryDir)) {
        const pub = parseNote(p);
        if (!pub)
            continue;
        const pubTerms = tokenize(`${pub.frontmatter.source}\n${pub.body}`);
        if (pubTerms.size === 0)
            continue;
        let inter = 0;
        for (const term of draftTerms.keys())
            if (pubTerms.has(term))
                inter += 1;
        const union = new Set([...draftTerms.keys(), ...pubTerms.keys()]).size;
        const overlap = union > 0 ? inter / union : 0;
        if (overlap >= threshold && (best === null || overlap > best.overlap)) {
            best = { rel: p.startsWith(memoryDir) ? p.slice(memoryDir.length).replace(/^[\\/]/, '').split(sep).join('/') : p, overlap };
        }
    }
    return best ? best.rel : null;
}
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
export async function promoteDraft(memoryDir, draftPath, options) {
    const note = parseNote(draftPath);
    if (!note) {
        // Phase 8: an unparseable draft is not a budget skip — name it as such so
        // the audit trail is accurate (the draft stays on disk either way).
        return { kind: 'skip-budget', note: emptyNote(), draftPath, reason: 'unreadable' };
    }
    const rel = publishedRelFor(note);
    return withLock(rel, async () => {
        // Dedup/overwrite target: if token overlap with an existing published note is high,
        // this promotion overwrites that note (still reverse-snapshot first).
        // Phase 8: computed INSIDE the lock — the candidate set changes while
        // callers queue, so a target derived before the lock could be stale (T7.8's
        // "read-decide not fully in-lock" registration).
        const overwriteRel = dedupTarget(note, memoryDir);
        const targetRel = overwriteRel ?? rel;
        // Budget check (REME.md §5.3 D2): over budget, a NEW note is blocked; an overwrite of
        // an existing note is not new growth, so it is allowed through.
        const budget = measureBudget(memoryDir);
        const isNewGrowth = !overwriteRel;
        if (isNewGrowth && (budget.count >= options.maxPublishedNotes || budget.bytes >= options.maxPublishedBytes)) {
            if (options.gateMode === 'enforce') {
                const reason = `growth budget exceeded (count=${budget.count}/${options.maxPublishedNotes}, bytes=${budget.bytes}/${options.maxPublishedBytes})`;
                const rejected = markRejected(note, reason);
                writeRejectedDraft(draftPath, rejected);
                return { kind: 'reject', note: rejected, draftPath, reason };
            }
            return { kind: 'skip-budget', note, draftPath, reason: 'budget' };
        }
        // Gate decision.
        if (options.gateMode === 'enforce') {
            const dialogTurns = readDialogTurns(memoryDir, note.frontmatter.source_conversation);
            if (!sourceLocatesInDialog(note.frontmatter.source, dialogTurns)) {
                const rejected = markRejected(note, `enforce gate: source "${note.frontmatter.source}" does not locate in ${note.frontmatter.source_conversation}`);
                // Persist the rejection note into the draft so it is recorded (stays a draft).
                writeRejectedDraft(draftPath, rejected);
                return { kind: 'reject', note: rejected, draftPath, reason: rejected.frontmatter.rejection ?? 'enforce gate failed' };
            }
        }
        // ── Phase C authority flip: with a store, published/ is a projection —
        // the promotion lands as a mailbox belief (a PROVISIONAL nomination; the
        // gate above already decided admission) and the projection re-renders it.
        // No file write and no reverse snapshot here: the mailbox stream's
        // supersedes chain is the rollback face. Embedding cache is skipped on
        // this path (the projection file owns recall; BUILD.md Phase C limitation).
        if (options.store) {
            const overwriteNote = overwriteRel ? parseNote(join(memoryDir, overwriteRel)) : null;
            const overwriteSubject = typeof overwriteNote?.frontmatter.subject === 'string' && overwriteNote.frontmatter.subject !== ''
                ? overwriteNote.frontmatter.subject
                : null;
            const subject = overwriteSubject
                ?? `note:${slug(note.frontmatter.title ?? '') || slug(note.frontmatter.source)}`;
            const sessionId = options.sessionId ?? 'consolidate';
            await publishToMailbox(options.store, {
                gateMode: 'enforce',
                sessionId,
                sessionScope: options.sessionScope ?? { kind: 'session', id: sessionId },
            }, [{
                    subject,
                    title: note.frontmatter.title ?? subject,
                    content: note.body,
                    kind: note.frontmatter.kind === 'procedure' ? 'procedural' : 'declarative',
                    evidence: `${note.frontmatter.source} in ${note.frontmatter.source_conversation}`,
                    // A dedup hit means this promotion replaces a note of the same
                    // subject — declare the revision so the previous mailbox belief is
                    // superseded instead of left active as a conflict set.
                    ...(overwriteRel !== null ? { revision: true } : {}),
                }]);
            deleteDraft(memoryDir, draftPath);
            return { kind: 'promote', note, draftPath, publishedRel: `mailbox:${subject}` };
        }
        // Reverse-snapshot any existing published note this promotion would overwrite (D11).
        const targetAbs = join(memoryDir, targetRel);
        let snapshotPath = null;
        if (existsSync(targetAbs)) {
            snapshotPath = takeSnapshot(memoryDir, targetRel, readFileSync(targetAbs, 'utf8'));
        }
        // Bump version on rewrite; preserve the draft body. `observe` flags gate.mode='observe'
        // (non-blocking even when the source is not strictly valid); `enforce` only reaches here
        // when the source located.
        // Phase 8 (review round 6): a dedup overwrite UPDATES an existing note —
        // carry its provenance (created_at/use_count/last_accessed) instead of the
        // draft's zeroed values, so a heavily-cited note is not silently
        // rejuvenated into a retire candidate.
        const now = new Date().toISOString();
        const existing = existsSync(targetAbs) ? parseNote(targetAbs) : null;
        const version = existing ? existing.frontmatter.version + 1 : 1;
        const promoted = {
            frontmatter: {
                ...note.frontmatter,
                ...(existing
                    ? {
                        created_at: existing.frontmatter.created_at,
                        last_accessed: existing.frontmatter.last_accessed,
                        use_count: existing.frontmatter.use_count,
                    }
                    : {}),
                updated_at: now,
                version,
                gate: {
                    mode: options.gateMode,
                    verdict: 'pass',
                    reviewed_at: now,
                },
            },
            body: note.body,
        };
        writePublished(memoryDir, promoted, targetRel);
        // Phase E embedding cache (REME.md §12.1): cache the promoted note's vector so
        // hybridSearch can fuse it with lexical BM25. Best-effort — a failure must never
        // fail promotion.
        if (options.embeddingService) {
            try {
                const [vec] = await options.embeddingService.embed([`${promoted.frontmatter.source}\n${promoted.body}`]);
                if (vec)
                    writeEmbedding(memoryDir, targetRel, vec);
            }
            catch {
                // embedding cache is observability for recall; ignore on failure
            }
        }
        // Stamp the reverse-snapshot slightly after the published file's post-write mtime so
        // the override-warning (rollbackNote) treats OUR write as the baseline, not the
        // snapshot-read time — a genuine user edit (mtime after our write) is warned; our own
        // write is not. The +100ms margin absorbs any sub-millisecond disk-flush jitter
        // between writePublished and this stat. `utimesSync` takes seconds, so convert from
        // the `mtimeMs` stat (D11, mirrors harness-file.ts writeHarnessStates CAS, which keys
        // on the mtime observed at the authoritative write, not at read).
        if (snapshotPath) {
            try {
                const mtimeSec = (statSync(targetAbs).mtimeMs + 100) / 1000;
                utimesSync(snapshotPath, mtimeSec, mtimeSec);
            }
            catch {
                // Snapshot mtime sync is best-effort; the warning still functions (just may flag our write).
            }
        }
        deleteDraft(memoryDir, draftPath);
        return { kind: 'promote', note: promoted, draftPath, publishedRel: targetRel };
    });
}
/** A minimal note used only for absent/missing-draft decisions. */
function emptyNote() {
    const now = new Date().toISOString();
    return {
        frontmatter: {
            kind: 'personal', scope: 'session', session_id: '', source: '',
            source_conversation: '', created_at: now, updated_at: now, version: 0,
            use_count: 0, last_accessed: now,
            gate: { mode: 'observe', verdict: 'pass', reviewed_at: now },
        },
        body: '',
    };
}
/**
 * Read the dialog jsonl referenced by a `source_conversation` field as `{ content }` turns.
 * @param memoryDir - resolved memory root.
 * @param sourceConversation - the relative dialog path (e.g. `dialog/<id>.jsonl`).
 * @returns parsed turns; `[]` when absent or unparseable.
 */
function readDialogTurns(memoryDir, sourceConversation) {
    const path = sourceConversation.startsWith(memoryDir) ? sourceConversation : join(memoryDir, sourceConversation.split('/').join(sep));
    if (!existsSync(path))
        return [];
    const out = [];
    for (const line of readFileSync(path, 'utf8').split('\n')) {
        const t = line.trim();
        if (!t)
            continue;
        try {
            const obj = JSON.parse(t);
            out.push({ content: obj.content ?? '' });
        }
        catch {
            // A malformed dialog line is skipped — the evidence gate only needs locatable lines.
        }
    }
    return out;
}
/**
 * Stamp a draft note with `rejected_at`/`rejection` frontmatter, leaving it a draft.
 * @param note - the draft note that failed the enforce gate.
 * @param reason - the human-readable rejection reason.
 * @returns a copy of the note with rejection fields added.
 */
function markRejected(note, reason) {
    const now = new Date().toISOString();
    return {
        frontmatter: {
            ...note.frontmatter,
            rejected_at: now,
            rejection: reason,
        },
        body: note.body,
    };
}
/**
 * Rewrite a draft note on disk with rejection frontmatter (it stays under `drafts/`).
 * @param draftPath - absolute draft path.
 * @param rejected - the stamped note.
 */
function writeRejectedDraft(draftPath, rejected) {
    // Reuse the draft file in place: serialize with the rejection fields present.
    writeFileSync(draftPath, serializeNote(rejected), 'utf8');
}
/**
 * Consolidate every draft under `memoryDir` into published notes under the given gate
 * and budget (REME.md §5.3 four-step, deterministic, no LLM). Single-flight per target
 * note via {@link withLock} inside {@link promoteDraft}. Returns an audit report.
 * @param memoryDir - resolved memory root.
 * @param options - resolved gate + budget options.
 * @returns the consolidation result (counts + warnings + per-draft decisions).
 */
export async function consolidate(memoryDir, options) {
    const result = {
        scanned: 0,
        promoted: 0,
        rejected: 0,
        skippedBudget: 0,
        noop: options.gateMode === 'off',
        warnings: [],
        decisions: [],
    };
    if (options.gateMode === 'off') {
        result.warnings.push('gateMode=off: consolidation is a no-op; drafts remain drafts');
        return result;
    }
    const drafts = listDrafts(memoryDir);
    result.scanned = drafts.length;
    for (const draftPath of drafts) {
        const decision = await promoteDraft(memoryDir, draftPath, options);
        result.decisions.push(decision);
        if (decision.kind === 'promote') {
            result.promoted += 1;
        }
        else if (decision.kind === 'reject') {
            result.rejected += 1;
        }
        else if (decision.reason === 'unreadable') {
            result.skippedBudget += 1;
            result.warnings.push(`unreadable draft skipped (parse failure, not promoted or deleted): ${draftPath}`);
        }
        else {
            result.skippedBudget += 1;
            result.warnings.push(`growth budget skipped promotion of ${draftPath}`);
        }
    }
    // Phase C: when the promotions landed in the mailbox, re-render the
    // published/ projection so recall sees them immediately.
    if (options.store)
        await syncMailboxProjection(options.store, memoryDir);
    return result;
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
export async function rollbackNote(memoryDir, noteId, force) {
    const relId = noteId.split(sep).join('/');
    const snaps = listSnapshots(memoryDir, relId);
    const latest = snaps[0];
    if (!latest) {
        return { noteId: relId, warnedUserEdit: false, restored: false, message: `No snapshot found for ${relId}; nothing to roll back.` };
    }
    const publishedAbs = join(memoryDir, relId);
    let warnedUserEdit = false;
    if (existsSync(publishedAbs)) {
        try {
            const liveMtime = statSync(publishedAbs).mtimeMs;
            const snapMtime = statSync(latest).mtimeMs;
            // Published note is materially newer than the latest snapshot => a user/extern edit
            // after our last write. A 1ms epsilon absorbs sub-tick mtime granularity between our
            // write and the snapshot-stamp (both reflect the same authoritative write); warn and
            // refuse unless forced (harness-file.ts override-warning shape, REME.md §5.3 D11).
            if (liveMtime > snapMtime + 1)
                warnedUserEdit = true;
        }
        catch {
            // Stat failure: treat as no override (best-effort; restore proceeds).
        }
    }
    if (warnedUserEdit && !force) {
        return {
            noteId: relId,
            warnedUserEdit: true,
            restored: false,
            message: `Override warning: ${relId} was edited after the latest snapshot; pass force to roll back anyway.`,
        };
    }
    restoreSnapshot(memoryDir, relId, latest);
    return {
        noteId: relId,
        warnedUserEdit,
        restored: true,
        message: warnedUserEdit
            ? `Force-restored ${relId} from snapshot ${latest.split(/[\\/]/).pop()} (overriding a user edit).`
            : `Rolled back ${relId} from snapshot ${latest.split(/[\\/]/).pop()}.`,
    };
}
/** Re-export for callers that need the snapshots dir path. */
export { snapshotsDir };
//# sourceMappingURL=consolidate.js.map