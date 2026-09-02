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

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, watch as fsWatch, writeFileSync, type FSWatcher } from 'node:fs'
import path from 'node:path'
import type { RlmBeliefNode, RlmScope, RlmStore } from '@deepseek-ai/dsh-plugin-rlm-store'
import { parseNote, publishedDir } from './storage.ts'

/** The mailbox scope (single, family-wide). */
export const MAILBOX_SCOPE: RlmScope = { kind: 'mailbox' }

export interface MailboxPublishInput {
  subject: string
  title: string
  content: string
  kind: 'declarative' | 'procedural'
  /** Evidence/provenance note (where this came from). */
  evidence: string
  /** True when this is a new revision of the same subject by the same author. */
  revision?: boolean
}

export interface MailboxGateConfig {
  gateMode: 'off' | 'observe' | 'enforce'
  sessionId: string
  sessionScope: RlmScope
  mailboxScope?: RlmScope
}

export interface MailboxPublishReport {
  published: number
  observed: number
  subjects: string[]
  conflicts: string[]
  /**
   * Phase D freeze lock: subjects whose latest mailbox belief is frozen skip
   * publication — re-publishing would route around the audit freeze. A newer
   * active belief (a human revision) means the freeze was already resolved.
   */
  frozenSkips: string[]
}

/** Filename slug shared by the projection renderer and the mailbox-aware consolidation path. */
export function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'entry'
  )
}

/**
 * Publish proposals into the mailbox under the gate. Trust semantics: the
 * landing judgment grades PROVISIONAL (publish is a hand-off, not a
 * verification); promotion happens only through a real check later.
 * @param store - the unified store.
 * @param gate - gate mode + scoping.
 * @param inputs - the proposals to publish.
 * @returns the publish report (counts + subjects + conflict subjects).
 */
export async function publishToMailbox(
  store: RlmStore,
  gate: MailboxGateConfig,
  inputs: readonly MailboxPublishInput[],
): Promise<MailboxPublishReport> {
  const mailbox = gate.mailboxScope ?? MAILBOX_SCOPE
  const report: MailboxPublishReport = { published: 0, observed: 0, subjects: [], conflicts: [], frozenSkips: [] }
  if (gate.gateMode === 'off') return report
  // Cold-start honesty: the freeze lock and conflict detection below read the
  // view synchronously; on a fresh instance that view is empty until loaded.
  await store.loadOnce(mailbox)

  for (const input of inputs) {
    if (gate.gateMode === 'observe') {
      report.observed += 1
      continue
    }
    // Phase D freeze lock: the latest live belief of a frozen subject holds
    // the trust gate — no publish until a human release or revision. (Read
    // the full view: `beliefs()` filters to active nodes only.)
    const live = store.view(mailbox).beliefs.filter(b => b.subject === input.subject && b.status !== 'voided')
    if (live.at(-1)?.status === 'frozen') {
      report.frozenSkips.push(input.subject)
      continue
    }
    // Mailbox first: the publication exists when the mailbox stream has it.
    const handoff = await store.append(mailbox, 'rlm/handoff', {
      action: 'publish',
      sessionId: gate.sessionId,
      subject: input.subject,
      title: input.title,
      content: input.content,
      evidence: input.evidence,
    })
    const existing = store.beliefs(mailbox).filter(b => b.subject === input.subject)
    const previous = existing.length > 0 ? existing[existing.length - 1] : undefined
    await store.judge(mailbox, {
      criterionRef: 'crit/refine-whitelist',
      verdict: 'conclusion',
      belief: {
        kind: input.kind,
        content: input.content,
        title: input.title,
        subject: input.subject,
        basedOn: [],
        lastVerified: { channel: 'mailbox-publish', eventPos: handoff.seq, note: `from session ${gate.sessionId}` },
        // A declared revision replaces the previous version; an undeclared
        // one may disagree with it — both stay active so pickup surfaces the
        // conflict set instead of silently picking a winner.
        ...(input.revision === true && previous
          ? { supersedes: { id: previous.id, reason: 'mailbox revision' } }
          : {}),
      },
      dataSupport: { summary: input.evidence },
      provenance: { eventRange: [handoff.seq, handoff.seq] },
    })
    report.published += 1
    if (!input.revision && existing.length > 0) report.conflicts.push(input.subject)
    if (!report.subjects.includes(input.subject)) report.subjects.push(input.subject)
  }

  // The session side records the decision (path bookkeeping; mailbox-first
  // ordering means the publication itself can never be lost here).
  if (report.subjects.length > 0) {
    await store.append(gate.sessionScope, 'rlm/handoff', {
      action: 'decide-handover',
      sessionId: gate.sessionId,
      subjects: [...report.subjects],
    })
  }
  return report
}

/**
 * Render the mailbox view into the published/ projection. Titled active
 * beliefs become Markdown notes; per-file `use_count` / `last_accessed` are
 * usage counters, preserved from any existing file (they are not belief
 * content and a re-render must not erase them).
 * @param store - the unified store.
 * @param memoryDir - the memory root holding `published/`.
 * @returns the number of notes rendered (including removals of retracted ones).
 */
export async function syncMailboxProjection(store: RlmStore, memoryDir: string): Promise<number> {
  await store.loadOnce(MAILBOX_SCOPE)
  const dir = publishedDir(memoryDir)
  // The projection materializes its own directory — a fresh memory root with
  // no published/ yet must still render the mailbox view.
  mkdirSync(dir, { recursive: true })
  const titled = (b: RlmBeliefNode): b is RlmBeliefNode & { title: string; subject: string } =>
    b.title !== undefined && b.subject !== undefined
  const beliefs = store.beliefs(MAILBOX_SCOPE).filter(titled)
  const wantFiles = new Set<string>()
  for (const belief of beliefs) {
    const file = path.join(dir, `${slug(belief.subject)}.md`)
    wantFiles.add(path.basename(file))
    let preserved: { use_count?: number; last_accessed?: string } = {}
    if (existsSync(file)) {
      const existing = parseNote(file)
      if (existing) {
        preserved = {
          ...(existing.frontmatter.use_count !== undefined ? { use_count: existing.frontmatter.use_count } : {}),
          ...(existing.frontmatter.last_accessed !== undefined ? { last_accessed: existing.frontmatter.last_accessed } : {}),
        }
      }
    }
    const frontmatter = [
      '---',
      'kind: personal',
      'scope: global',
      `session_id: ${belief.scope}`,
      `title: ${JSON.stringify(belief.title ?? '')}`,
      `subject: ${JSON.stringify(belief.subject)}`,
      `source: ${belief.criterionRef}`,
      'source_conversation: mailbox-stream',
      `created_at: ${belief.time}`,
      `updated_at: ${new Date().toISOString()}`,
      `version: ${belief.updatedAt}`,
      `use_count: ${preserved.use_count ?? 0}`,
      `last_accessed: ${preserved.last_accessed ?? belief.time}`,
      `gate: { mode: mailbox, verdict: pass, reviewed_at: ${belief.time} }`,
      `grade: ${belief.grade}`,
      '---',
    ].join('\n')
    const body = belief.content.endsWith('\n') ? belief.content : `${belief.content}\n`
    writeFileSyncIfChanged(file, `${frontmatter}\n\n${body}`)
  }
  // Retracted beliefs must not leave stale files behind: a projected file
  // carries a `subject` field, so only projection-owned files are removed.
  let removed = 0
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.md') || wantFiles.has(name)) continue
    const full = path.join(dir, name)
    const existing = parseNote(full)
    if (typeof existing?.frontmatter.subject !== 'string' || existing.frontmatter.subject === '') continue
    if (!beliefs.some(b => `${slug(b.subject)}.md` === name)) {
      rmSync(full, { force: true })
      removed += 1
    }
  }
  return beliefs.length + removed
}

function writeFileSyncIfChanged(file: string, content: string): void {
  mkdirSync(path.dirname(file), { recursive: true })
  if (existsSync(file) && readFileSync(file, 'utf8') === content) return
  writeFileSync(file, content, 'utf8')
}

/**
 * Import pre-Phase-C published notes into the mailbox as human-revision
 * events. Idempotent: a note whose subject already has an ACTIVE mailbox
 * belief with identical content is skipped.
 * @param store - the unified store.
 * @param memoryDir - the memory root.
 * @returns the number of notes imported.
 */
export async function importLegacyNotes(store: RlmStore, memoryDir: string): Promise<number> {
  await store.loadOnce(MAILBOX_SCOPE)
  const dir = publishedDir(memoryDir)
  if (!existsSync(dir)) return 0
  let imported = 0
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.md')) continue
    const full = path.join(dir, name)
    if (!statSync(full).isFile()) continue
    const note = parseNote(full)
    if (!note) continue
    const titleText = note.frontmatter.title ?? name.replace(/\.md$/, '')
    const subject =
      typeof note.frontmatter.subject === 'string' && note.frontmatter.subject !== ''
        ? note.frontmatter.subject
        : `legacy:${slug(titleText)}`
    const active = store.beliefs(MAILBOX_SCOPE).find(b => b.subject === subject && b.status === 'active')
    if (active && active.content === note.body) continue
    await store.append(MAILBOX_SCOPE, 'rlm/human-revision', {
      action: 'upsert',
      subject,
      title: titleText,
      content: note.body,
      origin: 'legacy-import',
      sourceFile: name,
    })
    imported += 1
    // Absorb the legacy file into the canonical projection name: the
    // stream holds the content from here on, and the renamed file keeps its
    // usage counters for the next sync to re-render over.
    const canonical = path.join(dir, `${slug(subject)}.md`)
    if (path.resolve(canonical) !== path.resolve(full)) {
      if (existsSync(canonical)) rmSync(full, { force: true })
      else renameSync(full, canonical)
    }
  }
  return imported
}

/**
 * One reconciliation pass over `published/`: any file whose content differs
 * from the mailbox view's render (or that vanished) becomes an
 * `rlm/human-revision` event — the human semantic-exempt write, captured into
 * the stream instead of silently diverging.
 * @param store - the unified store.
 * @param memoryDir - the memory root.
 * @returns the number of revision events appended.
 */
export async function detectHumanRevisions(store: RlmStore, memoryDir: string): Promise<number> {
  await store.loadOnce(MAILBOX_SCOPE)
  const dir = publishedDir(memoryDir)
  if (!existsSync(dir)) return 0
  let revisions = 0
  const seen = new Set<string>()
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.md')) continue
    const full = path.join(dir, name)
    const note = parseNote(full)
    if (!note) continue
    const titleText = note.frontmatter.title ?? name.replace(/\.md$/, '')
    const subject =
      typeof note.frontmatter.subject === 'string' && note.frontmatter.subject !== ''
        ? note.frontmatter.subject
        : `legacy:${slug(titleText)}`
    seen.add(`${slug(subject)}.md`)
    const active = store.beliefs(MAILBOX_SCOPE).filter(b => b.subject === subject && b.status === 'active')
    const latest = active.at(-1)
    if (latest && latest.content === note.body) continue
    await store.append(MAILBOX_SCOPE, 'rlm/human-revision', {
      action: 'upsert',
      subject,
      title: titleText,
      content: note.body,
      origin: 'file-edit',
      sourceFile: name,
    })
    revisions += 1
  }
  // Vanished files: a human retraction.
  for (const belief of store.beliefs(MAILBOX_SCOPE)) {
    if (belief.title === undefined || belief.subject === undefined) continue
    const file = `${slug(belief.subject)}.md`
    if (seen.has(file)) continue
    if (!existsSync(path.join(dir, file))) {
      const stillActive = store.beliefs(MAILBOX_SCOPE).some(b => b.subject === belief.subject && b.status === 'active')
      if (stillActive) {
        await store.append(MAILBOX_SCOPE, 'rlm/human-revision', {
          action: 'retract',
          subject: belief.subject,
          origin: 'file-delete',
        })
        revisions += 1
      }
    }
  }
  return revisions
}

/**
 * Watch the published/ projection and reconcile human edits into the stream.
 * @param store - the unified store.
 * @param memoryDir - the memory root.
 * @returns the watcher (call `.close()` on dispose).
 */
export function watchMailboxProjection(store: RlmStore, memoryDir: string): FSWatcher | null {
  const dir = publishedDir(memoryDir)
  if (!existsSync(dir)) return null
  let timer: NodeJS.Timeout | null = null
  const watcher = fsWatch(dir, { recursive: true }, () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      // The reconciliation is async (every append is awaited); the watcher
      // chain it and let failures surface as warnings, never unhandled.
      detectHumanRevisions(store, memoryDir)
        .then(() => syncMailboxProjection(store, memoryDir))
        .catch((error) => {
          console.warn('[rlm-memory] mailbox projection reconciliation failed:', error)
        })
    }, 300)
  })
  return watcher
}

export interface MailboxPickupReport {
  picked: number
  conflicts: string[]
  byId: Map<string, string>
}

/**
 * Continuation pickup (r9 §9): mailbox beliefs join the session scope as
 * PROVISIONAL nominations — mailbox evidenced is a nomination, never a grade.
 * Same-subject conflict sets are all picked up and explicitly marked.
 * @param store - the unified store.
 * @param sessionScope - the continuing session's scope.
 * @returns the pickup report.
 */
export async function pickupMailboxSeeds(store: RlmStore, sessionScope: RlmScope): Promise<MailboxPickupReport> {
  await store.loadOnce(MAILBOX_SCOPE)
  const titled = (b: RlmBeliefNode): b is RlmBeliefNode & { title: string; subject: string } =>
    b.title !== undefined && b.subject !== undefined
  const mailboxBeliefs = store.beliefs(MAILBOX_SCOPE).filter(titled)
  const bySubject = new Map<string, typeof mailboxBeliefs>()
  for (const b of mailboxBeliefs) {
    const list = bySubject.get(b.subject) ?? []
    list.push(b)
    bySubject.set(b.subject, list)
  }
  const report: MailboxPickupReport = { picked: 0, conflicts: [], byId: new Map() }
  for (const [subject, group] of bySubject) {
    const conflict = group.length > 1
    if (conflict) report.conflicts.push(subject)
    for (const source of group) {
      // The pickup is itself a handoff event in the continuing session's
      // stream — the delivery notice gives the pickup judgment a locatable
      // provenance range and leaves the audit trail on the session side.
      const notice = await store.append(sessionScope, 'rlm/handoff', {
        action: 'pickup',
        sessionId: sessionScope.kind === 'session' ? sessionScope.id : 'mailbox',
        subject,
        from: source.id,
        ...(conflict ? { conflictSet: true } : {}),
      })
      await store.judge(sessionScope, {
        criterionRef: 'crit/refine-whitelist',
        verdict: 'conclusion',
        belief: {
          kind: source.kind,
          content: source.content,
          title: source.title,
          subject,
          basedOn: [],
          lastVerified: {
            channel: 'mailbox-pickup',
            eventPos: notice.seq,
            note: `mailbox:${source.id}${conflict ? ' conflict-set' : ''}`,
          },
        },
        dataSupport: {
          summary: conflict
            ? `conflict set pickup: ${String(group.length)} competing mailbox beliefs for '${subject}'`
            : `mailbox nomination from ${source.lastVerified?.note ?? 'mailbox'}`,
        },
        provenance: { eventRange: [notice.seq, notice.seq] },
      })
      report.picked += 1
      report.byId.set(source.id, store.beliefs(sessionScope).at(-1)?.id ?? '')
    }
  }
  return report
}

export interface CriterionProposal {
  id: string
  tier: 'deterministic' | 'structured' | 'open'
  title: string
  reason: string
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
export async function proposeCriterion(
  store: RlmStore,
  sessionScope: RlmScope,
  proposal: CriterionProposal,
): Promise<string> {
  await store.loadOnce(MAILBOX_SCOPE)
  const subject = `criterion:${proposal.id}`
  await store.append(MAILBOX_SCOPE, 'rlm/handoff', {
    action: 'criterion-proposal',
    sessionId: sessionScope.kind === 'session' ? sessionScope.id : 'mailbox',
    criterion: proposal.id,
    tier: proposal.tier,
    reason: proposal.reason,
  })
  await store.judge(MAILBOX_SCOPE, {
    criterionRef: 'crit/refine-whitelist',
    verdict: 'conclusion',
    belief: {
      kind: 'procedural',
      content: `Proposed ${proposal.tier} criterion revision for ${proposal.id}: ${proposal.reason}`,
      title: `[criterion-proposal] ${proposal.id}`,
      subject,
      basedOn: [],
      lastVerified: { channel: 'criterion-proposal', eventPos: store.view(MAILBOX_SCOPE).seq },
    },
    dataSupport: { summary: proposal.reason },
    provenance: { eventRange: [1, store.view(MAILBOX_SCOPE).seq] },
  })
  return store.beliefs(MAILBOX_SCOPE).at(-1)?.id ?? ''
}

/**
 * Human approval of a parked criterion proposal: registers the criterion on
 * the store (effective immediately) and records the approval event in the
 * mailbox stream. The registration is runtime-only for now — a persistent
 * approved-criteria store lands with the Phase D audit surface.
 * @param store - the unified store.
 * @param proposal - the approved proposal (id/tier/title as proposed).
 * @returns void
 */
export async function approveCriterion(store: RlmStore, proposal: CriterionProposal): Promise<void> {
  await store.append(MAILBOX_SCOPE, 'rlm/human-revision', {
    action: 'approve-criterion',
    subject: `criterion:${proposal.id}`,
    origin: 'human-approval',
  })
  store.registerCriterion({ id: proposal.id, tier: proposal.tier, title: proposal.title })
}
