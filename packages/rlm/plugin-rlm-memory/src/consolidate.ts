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

import { readFileSync, statSync, existsSync, writeFileSync, utimesSync } from 'node:fs'
import { join, sep } from 'node:path'
import {
  listDrafts,
  parseNote,
  deleteDraft,
  writePublished,
  listPublished,
  publishedRelFor,
  snapshotsDir,
  takeSnapshot,
  listSnapshots,
  restoreSnapshot,
  serializeNote,
  type Note,
  type NoteFrontmatter,
} from './storage.ts'
import { sourceLocatesInDialog } from './evidence.ts'
import { tokenize } from './search.ts'

/** Publish-gate mode (REME.md §5.3 D10 / §9 gateMode). */
export type GateMode = 'off' | 'observe' | 'enforce'

/** Consolidation options, resolved from plugin Config (no hardcoded tunables). */
export interface ConsolidateOptions {
  /** Publish-gate mode (default `'observe'`). */
  gateMode: GateMode
  /** Maximum published notes before promotion is skipped/rejected (default 200). */
  maxPublishedNotes: number
  /** Maximum total bytes across `published/` before promotion is skipped/rejected (default 5_000_000). */
  maxPublishedBytes: number
}

/** The decision reached for one draft during the decide step. */
export type DraftDecision =
  | { kind: 'promote'; note: Note; draftPath: string; publishedRel: string }
  | { kind: 'reject'; note: Note; draftPath: string; reason: string }
  | { kind: 'skip-budget'; note: Note; draftPath: string }

/** One line of a consolidation report (the audit trail returned by `consolidate`). */
export interface ConsolidateResult {
  /** Number of drafts scanned. */
  scanned: number
  /** Drafts promoted to published this round. */
  promoted: number
  /** Drafts rejected by the `enforce` gate (stay drafts). */
  rejected: number
  /** Drafts skipped because the growth budget was exceeded. */
  skippedBudget: number
  /** No-op under `gateMode: 'off'` (drafts untouched). */
  noop: boolean
  /** Warning lines (budget overruns under `observe`, flagged-but-promoted drafts). */
  warnings: string[]
  /** Per-draft decisions, for callers that want detail. */
  decisions: DraftDecision[]
}

/**
 * In-process single-flight lock keyed by target published relPath. Two concurrent
 * consolidations of the same note serialize through one promise (mirrors the `runs`
 * Map pattern in plugin-rlm-loop/src/loop-tool.ts: a shared `Map<key, Promise>` so a
 * second caller awaits the first instead of clobbering). Module-level: one lock per
 * process, which is the only place two consolidations can race.
 */
const locks = new Map<string, Promise<unknown>>()

/**
 * Run `fn` under a per-key single-flight lock. If a promise is already in flight for
 * `key`, await it instead of running `fn` (the in-flight work covers this request).
 * The lock is released (the key deleted) when the promise settles, so later calls run.
 * @param key - the locked resource identity (published relPath).
 * @param fn - the guarded async work.
 * @returns the result of `fn` (or of the in-flight promise it joined).
 */
export function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const inFlight = locks.get(key) as Promise<T> | undefined
  if (inFlight) return inFlight
  const promise = (async () => {
    try {
      return await fn()
    } finally {
      if (locks.get(key) === promise) locks.delete(key)
    }
  })()
  locks.set(key, promise)
  return promise
}

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
function measureBudget(memoryDir: string): { count: number; bytes: number } {
  const paths = listPublished(memoryDir)
  let bytes = 0
  for (const p of paths) {
    try { bytes += statSync(p).size } catch { /* missing mid-walk: ignore */ }
  }
  return { count: paths.length, bytes }
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
function dedupTarget(note: Note, memoryDir: string, threshold = 0.5): string | null {
  const draftTerms = tokenize(`${note.frontmatter.source}\n${note.body}`)
  if (draftTerms.size === 0) return null
  let best: { rel: string; overlap: number } | null = null
  for (const p of listPublished(memoryDir)) {
    const pub = parseNote(p)
    if (!pub) continue
    const pubTerms = tokenize(`${pub.frontmatter.source}\n${pub.body}`)
    if (pubTerms.size === 0) continue
    let inter = 0
    for (const term of draftTerms.keys()) if (pubTerms.has(term)) inter += 1
    const union = new Set([...draftTerms.keys(), ...pubTerms.keys()]).size
    const overlap = union > 0 ? inter / union : 0
    if (overlap >= threshold && (best === null || overlap > best.overlap)) {
      best = { rel: p.startsWith(memoryDir) ? p.slice(memoryDir.length).replace(/^[\\/]/, '').split(sep).join('/') : p, overlap }
    }
  }
  return best ? best.rel : null
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
export async function promoteDraft(memoryDir: string, draftPath: string, options: ConsolidateOptions): Promise<DraftDecision> {
  const note = parseNote(draftPath)
  if (!note) {
    return { kind: 'skip-budget', note: emptyNote(), draftPath }
  }
  const rel = publishedRelFor(note)

  // Dedup/overwrite target: if token overlap with an existing published note is high,
  // this promotion overwrites that note (still reverse-snapshot first).
  const overwriteRel = dedupTarget(note, memoryDir)
  const targetRel = overwriteRel ?? rel

  return withLock(targetRel, async (): Promise<DraftDecision> => {
    // Budget check (REME.md §5.3 D2): over budget, a NEW note is blocked; an overwrite of
    // an existing note is not new growth, so it is allowed through.
    const budget = measureBudget(memoryDir)
    const isNewGrowth = !overwriteRel
    if (isNewGrowth && (budget.count >= options.maxPublishedNotes || budget.bytes >= options.maxPublishedBytes)) {
      if (options.gateMode === 'enforce') {
        const reason = `growth budget exceeded (count=${budget.count}/${options.maxPublishedNotes}, bytes=${budget.bytes}/${options.maxPublishedBytes})`
        const rejected = markRejected(note, reason)
        writeRejectedDraft(memoryDir, draftPath, rejected)
        return { kind: 'reject', note: rejected, draftPath, reason }
      }
      return { kind: 'skip-budget', note, draftPath }
    }

    // Gate decision.
    if (options.gateMode === 'enforce') {
      const dialogTurns = readDialogTurns(memoryDir, note.frontmatter.source_conversation)
      if (!sourceLocatesInDialog(note.frontmatter.source, dialogTurns)) {
        const rejected = markRejected(note, `enforce gate: source "${note.frontmatter.source}" does not locate in ${note.frontmatter.source_conversation}`)
        // Persist the rejection note into the draft so it is recorded (stays a draft).
        writeRejectedDraft(memoryDir, draftPath, rejected)
        return { kind: 'reject', note: rejected, draftPath, reason: rejected.frontmatter.rejection ?? 'enforce gate failed' }
      }
    }

    // Reverse-snapshot any existing published note this promotion would overwrite (D11).
    const targetAbs = join(memoryDir, targetRel)
    let snapshotPath: string | null = null
    if (existsSync(targetAbs)) {
      snapshotPath = takeSnapshot(memoryDir, targetRel, readFileSync(targetAbs, 'utf8'))
    }

    // Bump version on rewrite; preserve the draft body. `observe` flags gate.mode='observe'
    // (non-blocking even when the source is not strictly valid); `enforce` only reaches here
    // when the source located.
    const now = new Date().toISOString()
    const existing = existsSync(targetAbs) ? parseNote(targetAbs) : null
    const version = existing ? existing.frontmatter.version + 1 : 1
    const promoted: Note = {
      frontmatter: {
        ...note.frontmatter,
        updated_at: now,
        version,
        gate: {
          mode: options.gateMode,
          verdict: 'pass',
          reviewed_at: now,
        },
      } satisfies NoteFrontmatter,
      body: note.body,
    }
    writePublished(memoryDir, promoted)
    // Stamp the reverse-snapshot slightly after the published file's post-write mtime so
    // the override-warning (rollbackNote) treats OUR write as the baseline, not the
    // snapshot-read time — a genuine user edit (mtime after our write) is warned; our own
    // write is not. The +100ms margin absorbs any sub-millisecond disk-flush jitter
    // between writePublished and this stat. `utimesSync` takes seconds, so convert from
    // the `mtimeMs` stat (D11, mirrors harness-file.ts writeHarnessStates CAS, which keys
    // on the mtime observed at the authoritative write, not at read).
    if (snapshotPath) {
      try {
        const mtimeSec = (statSync(targetAbs).mtimeMs + 100) / 1000
        utimesSync(snapshotPath, mtimeSec, mtimeSec)
      } catch {
        // Snapshot mtime sync is best-effort; the warning still functions (just may flag our write).
      }
    }
    deleteDraft(memoryDir, draftPath)
    return { kind: 'promote', note: promoted, draftPath, publishedRel: targetRel }
  })
}

/** A minimal note used only for absent/missing-draft decisions. */
function emptyNote(): Note {
  const now = new Date().toISOString()
  return {
    frontmatter: {
      kind: 'personal', scope: 'session', session_id: '', source: '',
      source_conversation: '', created_at: now, updated_at: now, version: 0,
      use_count: 0, last_accessed: now,
      gate: { mode: 'observe', verdict: 'pass', reviewed_at: now },
    },
    body: '',
  }
}

/**
 * Read the dialog jsonl referenced by a `source_conversation` field as `{ content }` turns.
 * @param memoryDir - resolved memory root.
 * @param sourceConversation - the relative dialog path (e.g. `dialog/<id>.jsonl`).
 * @returns parsed turns; `[]` when absent or unparseable.
 */
function readDialogTurns(memoryDir: string, sourceConversation: string): Array<{ content: string }> {
  const path = sourceConversation.startsWith(memoryDir) ? sourceConversation : join(memoryDir, sourceConversation.split('/').join(sep))
  if (!existsSync(path)) return []
  const out: Array<{ content: string }> = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      const obj = JSON.parse(t) as { content?: string }
      out.push({ content: obj.content ?? '' })
    } catch {
      // A malformed dialog line is skipped — the evidence gate only needs locatable lines.
    }
  }
  return out
}

/**
 * Stamp a draft note with `rejected_at`/`rejection` frontmatter, leaving it a draft.
 * @param note - the draft note that failed the enforce gate.
 * @param reason - the human-readable rejection reason.
 * @returns a copy of the note with rejection fields added.
 */
function markRejected(note: Note, reason: string): Note {
  const now = new Date().toISOString()
  return {
    frontmatter: {
      ...note.frontmatter,
      rejected_at: now,
      rejection: reason,
    } as NoteFrontmatter,
    body: note.body,
  }
}

/**
 * Rewrite a draft note on disk with rejection frontmatter (it stays under `drafts/`).
 * @param memoryDir - resolved memory root (unused; kept for signature symmetry).
 * @param draftPath - absolute draft path.
 * @param rejected - the stamped note.
 */
function writeRejectedDraft(memoryDir: string, draftPath: string, rejected: Note): void {
  // Reuse the draft file in place: serialize with the rejection fields present.
  writeFileSync(draftPath, serializeNote(rejected), 'utf8')
  void memoryDir
}

/**
 * Consolidate every draft under `memoryDir` into published notes under the given gate
 * and budget (REME.md §5.3 four-step, deterministic, no LLM). Single-flight per target
 * note via {@link withLock} inside {@link promoteDraft}. Returns an audit report.
 * @param memoryDir - resolved memory root.
 * @param options - resolved gate + budget options.
 * @returns the consolidation result (counts + warnings + per-draft decisions).
 */
export async function consolidate(memoryDir: string, options: ConsolidateOptions): Promise<ConsolidateResult> {
  const result: ConsolidateResult = {
    scanned: 0,
    promoted: 0,
    rejected: 0,
    skippedBudget: 0,
    noop: options.gateMode === 'off',
    warnings: [],
    decisions: [],
  }

  if (options.gateMode === 'off') {
    result.warnings.push('gateMode=off: consolidation is a no-op; drafts remain drafts')
    return result
  }

  const drafts = listDrafts(memoryDir)
  result.scanned = drafts.length
  for (const draftPath of drafts) {
    const decision = await promoteDraft(memoryDir, draftPath, options)
    result.decisions.push(decision)
    if (decision.kind === 'promote') {
      result.promoted += 1
    } else if (decision.kind === 'reject') {
      result.rejected += 1
    } else {
      result.skippedBudget += 1
      result.warnings.push(`growth budget skipped promotion of ${draftPath}`)
    }
  }
  return result
}

/** Outcome of a reverse-snapshot rollback (REME.md §5.3 D11). */
export interface RollbackOutcome {
  /** Relative published note path restored (or that would be). */
  noteId: string
  /** Whether the live note was edited after our last snapshot (override-warning). */
  warnedUserEdit: boolean
  /** Whether a restore actually happened (false when warnedUserEdit && !force). */
  restored: boolean
  /** Human-readable message for the command output. */
  message: string
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
export async function rollbackNote(memoryDir: string, noteId: string, force: boolean): Promise<RollbackOutcome> {
  const relId = noteId.split(sep).join('/')
  const snaps = listSnapshots(memoryDir, relId)
  const latest = snaps[0]
  if (!latest) {
    return { noteId: relId, warnedUserEdit: false, restored: false, message: `No snapshot found for ${relId}; nothing to roll back.` }
  }
  const publishedAbs = join(memoryDir, relId)
  let warnedUserEdit = false
  if (existsSync(publishedAbs)) {
    try {
      const liveMtime = statSync(publishedAbs).mtimeMs
      const snapMtime = statSync(latest).mtimeMs
      // Published note is materially newer than the latest snapshot => a user/extern edit
      // after our last write. A 1ms epsilon absorbs sub-tick mtime granularity between our
      // write and the snapshot-stamp (both reflect the same authoritative write); warn and
      // refuse unless forced (harness-file.ts override-warning shape, REME.md §5.3 D11).
      if (liveMtime > snapMtime + 1) warnedUserEdit = true
    } catch {
      // Stat failure: treat as no override (best-effort; restore proceeds).
    }
  }

  if (warnedUserEdit && !force) {
    return {
      noteId: relId,
      warnedUserEdit: true,
      restored: false,
      message: `Override warning: ${relId} was edited after the latest snapshot; pass force to roll back anyway.`,
    }
  }

  restoreSnapshot(memoryDir, relId, latest)
  return {
    noteId: relId,
    warnedUserEdit,
    restored: true,
    message: warnedUserEdit
      ? `Force-restored ${relId} from snapshot ${latest.split(/[\\/]/).pop()} (overriding a user edit).`
      : `Rolled back ${relId} from snapshot ${latest.split(/[\\/]/).pop()}.`,
  }
}

/** Re-export for callers that need the snapshots dir path. */
export { snapshotsDir }
