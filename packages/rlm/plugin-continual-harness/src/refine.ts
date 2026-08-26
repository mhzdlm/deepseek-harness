/**
 * `/refine` self-refinement: review the recent transcript, have a subagent
 * propose small evidence-backed harness updates, reverse-snapshot the entries
 * that will change, apply them, and record a RefinementEvent. Rollback restores
 * a snapshot by event id.
 *
 * Fixes (see docs/rlm-plugins-fixes.md):
 *  - FIX-1: provider name is now a parameter (`refineProvider`), not the
 *    hard-coded `'refine'` string that no provider is registered under.
 *  - FIX-2: the proposal prompt carries the current harness overview with
 *    authoritative entry ids, so update/delete proposals can name real ids.
 *  - FIX-4: proposals are runtime-validated after extraction; parse failures
 *    are surfaced instead of masquerading as "no updates proposed".
 *  - FIX-8: every proposal carries an `evidence` quote, persisted into the
 *    entry's metadata, and the transcript keeps tool call/result summaries
 *    instead of collapsing them into opaque `[tool_result]` tokens.
 * @module @deepseek-ai/dsh-plugin-continual-harness
 */

import path from 'node:path'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentRun, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import {
  HarnessConflictError,
  harnessStatePath,
  mergeHarnessStates,
  readHarnessState,
  readHarnessStatesDetailed,
  splitHarnessStateByScope,
  writeHarnessStates,
  type HarnessEntry,
  type HarnessKind,
  type HarnessScope,
  type HarnessStateFile,
  type RefinementEvent,
} from './harness-file.ts'
import { renderHarnessOverview } from './prompt.ts'

const TRANSCRIPT_TURNS = 12
/** Per-block content budget when rendering a transcript for the refine agent. */
const MAX_EVIDENCE_CHARS = 400
/** Validation limits for model-produced proposals (FIX-4). */
const TITLE_MAX = 200
const CONTENT_MAX = 100_000
const EVIDENCE_MAX = 2_000
/** item-10: how many `RefinementEvent`s (and their snapshots) are retained. */
export const DEFAULT_MAX_REFINEMENT_EVENTS = 100
const ID_RE = /^[0-9a-fA-F-]{8,64}$/
/**
 * Ids that are never acceptable proposal targets regardless of shape or
 * existence (FIX-4 prototype-pollution guard; also enforced when a permissive
 * `knownIds` set would otherwise admit them).
 */
const DANGEROUS_ID_SET: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype'])

export interface ValidateProposalsOptions {
  /**
   * `kind:id` keys of entries that exist in the current merged harness view
   * (see {@link collectKnownEntryIdSet}). When provided, an explicit proposal
   * id referencing a KNOWN entry is accepted regardless of its textual shape —
   * first-party tools mint slug-shaped ids (`loop_<run>/round_001`, skill
   * slugs like `loop-audit`) that the UUID-ish shape regex cannot express, and
   * refusing them made `/refine` update/delete and `/harness delete`
   * structurally unable to manage those entries. Unknown ids still fall back
   * to the strict shape check, preserving the FIX-4 guard against
   * model-invented ids. Absent → legacy shape-only behavior.
   */
  knownIds?: ReadonlySet<string>
}

/** Shape-or-existence acceptance rule for an explicit proposal id. */
function idAcceptable(kind: string, id: string, knownIds: ReadonlySet<string> | undefined): boolean {
  if (DANGEROUS_ID_SET.has(id)) return false
  if (ID_RE.test(id)) return true
  return knownIds?.has(`${kind}:${id}`) ?? false
}

/**
 * Build the `kind:id` existence set that {@link validateProposals}'s
 * `knownIds` option expects, from one or more harness state files (global +
 * local, or a single merged view).
 */
export function collectKnownEntryIdSet(states: readonly HarnessStateFile[]): Set<string> {
  const ids = new Set<string>()
  for (const state of states) {
    for (const [kind, entries] of Object.entries(state.entries ?? {})) {
      if (!entries) continue
      for (const id of Object.keys(entries)) ids.add(`${kind}:${id}`)
    }
  }
  return ids
}
const KIND_SET: ReadonlySet<string> = new Set(['prompt', 'memory', 'skill', 'subagent'])
const ACTION_SET: ReadonlySet<string> = new Set(['upsert', 'delete'])
const SCOPE_SET: ReadonlySet<string> = new Set(['local', 'global'])

export interface RefineProposal {
  kind: HarnessKind
  action: 'upsert' | 'delete'
  id?: string
  /**
   * Target store: `global` for cross-session entries (rendered `[global]` in
   * the overview), `local` (default) for the current session's store.
   */
  scope?: HarnessScope
  title: string
  content: string
  /** Transcript quote or turn reference backing this proposal (FIX-8). */
  evidence: string
}

/** Extraction result: proposals plus a distinguishable parse failure (FIX-4). */
export interface ExtractResult {
  proposals: RefineProposal[]
  /** Set only when the model output could not be parsed as our JSON shape. */
  parseError?: string
}

export interface ValidatedProposals {
  valid: RefineProposal[]
  /** Human-readable rejection reasons, one per dropped proposal. */
  rejected: string[]
}

function buildRefinePrompt(transcriptText: string, harnessOverview: string): string {
  return [
    'You are reviewing an agent trajectory to propose small, evidence-backed updates',
    'to a persistent harness (persistent instructions / memories / skills / subagents).',
    'Rules:',
    '- Every proposal requires an "evidence" string quoting the transcript fragment',
    '  (or a turn reference like [turn 7]) that justifies it; unsupported proposals are rejected.',
    '- Prefer a handful of small, high-value updates over broad rewrites.',
    '- If nothing is worth changing, return an empty proposals list.',
    '- To update or delete an existing entry, use the exact "id" shown in the',
    '  CURRENT HARNESS overview below. An entry with no id in that overview is new:',
    '  upserting it must omit "id".',
    '- A line marked [global] lives in the cross-session global store: to update',
    '  or delete it, include "scope":"global" with its exact id. Everything else',
    '  is session-local and defaults to "scope":"local".',
    '',
    'Respond with ONLY a JSON object of the form:',
    '{"proposals":[{"kind":"memory|prompt|skill|subagent","action":"upsert|delete",' +
      '"scope":"local|global (optional, default local)","id":"<existing id from overview, ' +
      'required for update/delete>","title":"...","content":"...","evidence":"<transcript ' +
      'quote or turn reference>"}]}',
    '',
    '--- CURRENT HARNESS (ids are authoritative for update/delete) ---',
    harnessOverview || '(empty)',
    '',
    '--- TRANSCRIPT (recent turns) ---',
    transcriptText,
  ].join('\n')
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max) + '…'
}

/** Render a content block with enough detail to serve as evidence (FIX-8). */
function contentBlockToText(block: { type: string; [key: string]: unknown }): string {
  switch (block.type) {
    case 'text':
      return String(block.text ?? '')
    case 'reasoning':
      return `[reasoning: ${truncate(String(block.text ?? ''), MAX_EVIDENCE_CHARS)}]`
    case 'tool-call': {
      const name = String(block.name ?? '?')
      const args = typeof block.arguments === 'string'
        ? block.arguments
        : JSON.stringify(block.arguments ?? '')
      return `[tool-call: ${name}(${truncate(args, MAX_EVIDENCE_CHARS)})]`
    }
    case 'tool-result': {
      const content = Array.isArray(block.content) ? (block.content as unknown[]) : []
      const body = content
        .map(c => contentBlockToText(c as unknown as { type: string; [key: string]: unknown }))
        .join(' ')
      return `[tool-result${block.isError ? ' (error)' : ''}: ${truncate(body, MAX_EVIDENCE_CHARS)}]`
    }
    case 'image':
      return '[image]'
    default:
      return `[${block.type}]`
  }
}

function transcriptToText(sessionId: SessionId, ctx: Context): string {
  const session = ctx.sessions.get(sessionId)
  if (!session) return '(no session available)'
  const messages = session.deriveMessages().slice(-TRANSCRIPT_TURNS)
  const parts = messages.map((message) => {
    const blocks = Array.isArray(message.content) ? message.content : []
    const text = blocks
      .map(block => contentBlockToText(block as unknown as { type: string; [key: string]: unknown }))
      .join(' ')
    return `[${message.role}] ${text}`
  })
  return parts.join('\n')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Extract proposals from a subagent result. Distinguishes "valid JSON, empty
 * list" from "could not parse" so a malformed model reply cannot masquerade
 * as a successful no-op (FIX-4).
 */
export function extractProposals(result: unknown): ExtractResult {
  let candidate: unknown

  if (typeof result === 'string') {
    // Strip markdown code fences the model may wrap around the JSON.
    const fenced = result.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')
    const start = fenced.indexOf('{')
    const end = fenced.lastIndexOf('}')
    if (start < 0 || end <= start) {
      return { proposals: [], parseError: 'no JSON object found in model output' }
    }
    try {
      candidate = JSON.parse(fenced.slice(start, end + 1))
    } catch (cause) {
      return {
        proposals: [],
        parseError: `JSON parse failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      }
    }
  } else {
    candidate = result
  }

  if (isRecord(candidate)) {
    if (Array.isArray(candidate.proposals)) return { proposals: candidate.proposals as RefineProposal[] }
    const structured = candidate.structured
    if (isRecord(structured) && Array.isArray(structured.proposals)) {
      return { proposals: structured.proposals as RefineProposal[] }
    }
    return { proposals: [], parseError: 'model returned an object without a proposals array' }
  }

  return { proposals: [], parseError: `unexpected result type: ${typeof result}` }
}

/**
 * Validate model-produced proposals against the output schema before they can
 * touch harness state (FIX-4). Invalid entries are rejected with reasons rather
 * than silently dropped; duplicate targets collapse to the first occurrence.
 */
export function validateProposals(proposals: unknown[], options?: ValidateProposalsOptions): ValidatedProposals {
  const knownIds = options?.knownIds
  const valid: RefineProposal[] = []
  const rejected: string[] = []
  const seen = new Set<string>()

  for (const [index, raw] of proposals.entries()) {
    const tag = `proposal[${index}]`
    if (!isRecord(raw)) {
      rejected.push(`${tag}: not an object`)
      continue
    }
    const problems: string[] = []

    const kind = raw.kind
    if (typeof kind !== 'string' || !KIND_SET.has(kind)) problems.push(`invalid kind "${String(kind)}"`)

    const action = raw.action
    if (typeof action !== 'string' || !ACTION_SET.has(action)) problems.push(`invalid action "${String(action)}"`)

    const id = raw.id
    if (id !== undefined && typeof id !== 'string') {
      problems.push(`invalid id "${String(id)}"`)
    } else if (typeof id === 'string' && !idAcceptable(typeof kind === 'string' ? kind : '', id, knownIds)) {
      problems.push(`unknown or malformed id "${id}"`)
    }
    if (action === 'delete' && typeof id !== 'string') problems.push('delete requires an existing id')

    const scope = raw.scope
    if (scope !== undefined && (typeof scope !== 'string' || !SCOPE_SET.has(scope))) {
      problems.push(`invalid scope "${String(scope)}"`)
    }

    const title = raw.title
    if (typeof title !== 'string' || title.length === 0 || title.length > TITLE_MAX) {
      problems.push(`title must be a 1..${TITLE_MAX} char string`)
    }

    const content = raw.content
    if (action === 'upsert' && (typeof content !== 'string' || content.length > CONTENT_MAX)) {
      problems.push(`content must be a string ≤ ${CONTENT_MAX} chars`)
    }

    const evidence = raw.evidence
    if (typeof evidence !== 'string' || evidence.length === 0 || evidence.length > EVIDENCE_MAX) {
      problems.push(`evidence is required (≤ ${EVIDENCE_MAX} chars)`)
    }

    if (problems.length > 0) {
      rejected.push(`${tag}: ${problems.join('; ')}`)
      continue
    }

    const dedupeKey = `${kind}:${action}:${typeof id === 'string' ? id : title}`
    if (seen.has(dedupeKey)) {
      rejected.push(`${tag}: duplicate target ${dedupeKey}`)
      continue
    }
    seen.add(dedupeKey)

    valid.push({
      kind: kind as HarnessKind,
      action: action as 'upsert' | 'delete',
      ...(typeof id === 'string' ? { id } : {}),
      ...(typeof scope === 'string' ? { scope: scope as HarnessScope } : {}),
      title: title as string,
      content: (typeof content === 'string' ? content : '') as string,
      evidence: evidence as string,
    })
  }

  return { valid, rejected }
}

function nowIso(): string {
  return new Date().toISOString()
}

/**
 * Apply proposals to the harness state, reverse-snapshotting affected entries
 * first. Returns human-readable change lines, the reverse snapshot path, and
 * the after-image of every touched key (FIX-5: used by rollback to detect
 * concurrent edits before overwriting).
 */
export async function applyProposals(
  state: HarnessStateFile,
  proposals: RefineProposal[],
  snapshotDir: string,
): Promise<{ changes: string[]; snapshotPath: string | null; after: Record<string, HarnessEntry | null> }> {
  const snapshot: Record<string, HarnessEntry | null> = {}
  const after: Record<string, HarnessEntry | null> = {}
  const changes: string[] = []
  const touched = new Set<string>()

  for (const proposal of proposals) {
    const entries = (state.entries[proposal.kind] ??= {})
    let existing = proposal.id ? entries[proposal.id] : undefined
    // item-9: a no-id upsert whose title matches an existing entry updates it
    // instead of silently accumulating a duplicate — repeated /refine of the
    // same preference bumps version rather than creating a twin.
    if (!existing && !proposal.id && proposal.action === 'upsert') {
      const match = Object.values(entries).find(entry => entry.title === proposal.title)
      if (match) existing = match
    }
    // Scope routing (P0-fix): an explicit proposal.scope wins; otherwise the
    // existing entry's own scope decides, so updating a `[global]` entry works
    // even when the model omits the scope field.
    const scope: HarnessScope = proposal.scope ?? existing?.scope ?? 'local'

    if (proposal.action === 'delete') {
      if (!existing) continue // deleting a missing entry is a no-op
      const entryKey = `${scope}:${proposal.kind}:${existing.id}`
      if (!touched.has(entryKey)) {
        touched.add(entryKey)
        snapshot[entryKey] = { ...existing }
      }
      Reflect.deleteProperty(entries, existing.id)
      after[entryKey] = null
      changes.push(`delete ${scope === 'global' ? 'global:' : ''}${proposal.kind}:${proposal.title}`)
      continue
    }

    // upsert: resolve the target id first so the reverse snapshot keys on the
    // id that will actually exist on disk — a freshly created entry must be
    // removable by rollback (it keys a null tombstone on its real id).
    const id = existing?.id ?? crypto.randomUUID()
    const entryKey = `${scope}:${proposal.kind}:${id}`
    if (!touched.has(entryKey)) {
      touched.add(entryKey)
      snapshot[entryKey] = existing ? { ...existing } : null
    }
    const now = nowIso()
    entries[id] = {
      id,
      kind: proposal.kind,
      title: proposal.title,
      content: proposal.content,
      path: existing?.path ?? 'general',
      scope,
      reference: existing?.reference ?? {},
      arguments: existing?.arguments ?? {},
      metadata: {
        ...(existing?.metadata ?? {}),
        // FIX-8: persist the supporting evidence on the entry itself.
        ...(proposal.evidence ? { evidence: proposal.evidence } : {}),
      },
      source: 'refine',
      created_at: existing?.created_at ?? now,
      updated_at: now,
      version: (existing?.version ?? 0) + 1,
    }
    after[entryKey] = entries[id]
    changes.push(`upsert ${scope === 'global' ? 'global:' : ''}${proposal.kind}:${proposal.title}`)
  }

  let snapshotPath: string | null = null
  if (Object.keys(snapshot).length > 0) {
    snapshotPath = path.join(snapshotDir, `refine-${nowIso().replace(/[:.]/g, '-')}.snapshot.json`)
    await mkdir(path.dirname(snapshotPath), { recursive: true })
    const tmp = `${snapshotPath}.tmp`
    await writeFile(tmp, JSON.stringify(snapshot, null, 2), 'utf8')
    await rename(tmp, snapshotPath)
  }

  return { changes, snapshotPath, after }
}

/**
 * Run /refine: evidence → proposal subagent → reverse snapshot → apply →
 * record event. Returns a summary string for the command result.
 *
 * `provider` is the subagent provider name (FIX-1) — the same registry used by
 * `rlm.run`; the refine agent's display name rides on `request.label`.
 */
export async function runRefine(
  ctx: Context,
  sessionId: SessionId,
  baseDir: string,
  parent: Agent,
  provider: string,
  signal: AbortSignal,
  maxRefinementEvents = DEFAULT_MAX_REFINEMENT_EVENTS,
): Promise<string> {
  // Read both harness stores before spawning so the proposal prompt can list the
  // current entries (local + global) with authoritative ids (FIX-2, P0-fix).
  const statesForPrompt = await readHarnessStatesDetailed(baseDir, sessionId)
  const overview = renderHarnessOverview(
    mergeHarnessStates(statesForPrompt.global.state, statesForPrompt.local.state),
  )
  const transcriptText = transcriptToText(sessionId, ctx)

  const request: SubagentStartRequest = {
    label: 'refine harness',
    prompt: [{ type: 'text', text: buildRefinePrompt(transcriptText, overview) }],
    parent,
    // FIX-6: wire the command's own cancellation signal through instead of a
    // throwaway AbortController — aborting the command aborts the refine agent.
    signal,
    outputSchema: {
      type: 'object',
      properties: {
        proposals: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['memory', 'prompt', 'skill', 'subagent'] },
              action: { type: 'string', enum: ['upsert', 'delete'] },
              scope: { type: 'string', enum: ['local', 'global'] },
              id: { type: 'string' },
              title: { type: 'string' },
              content: { type: 'string' },
              evidence: { type: 'string' },
            },
            required: ['kind', 'action', 'title', 'content', 'evidence'],
          },
        },
      },
    },
  }
  const run: SubagentRun = await ctx.subagents.start(provider, request)

  const result = await run.result
  await run.dispose().catch(() => undefined)

  // FIX-4: parse failures and rejected proposals must be visible, not silently
  // reported as a successful "nothing to update".
  const { proposals, parseError } = extractProposals(result)
  if (parseError) return `Failed to parse refine proposals: ${parseError}`

  // Existence-aware id validation (slug-tolerant): first-party tools land
  // entries under non-UUID ids; the current merged view is the authority on
  // what exists. The CAS write below still guards against concurrent moves.
  const statesForIds = await readHarnessStatesDetailed(baseDir, sessionId)
  const { valid, rejected } = validateProposals(proposals, {
    knownIds: collectKnownEntryIdSet([statesForIds.global.state, statesForIds.local.state]),
  })
  if (valid.length === 0) {
    return rejected.length > 0
      ? `No valid harness updates proposed.\nRejected ${rejected.length} proposal(s):\n- ${rejected.join('\n- ')}`
      : 'No evidence-backed harness updates proposed.'
  }

  // Re-read for apply: the prompt-time snapshot may be stale by the time the
  // subagent settles. FIX-7: the write is CAS-guarded against a kernel-side
  // write landing between our read and our write; on conflict we retry once
  // with a fresh read (proposals are idempotent inputs to a re-apply).
  const statePath = harnessStatePath(baseDir, sessionId)
  const snapshotDir = path.join(path.dirname(statePath), 'refinements')

  const { applied, changes } = await applyProposalsAndPersist(
    baseDir,
    sessionId,
    valid,
    snapshotDir,
    maxRefinementEvents,
    '/refine',
  )
  if (!applied) {
    return rejected.length > 0
      ? `No evidence-backed harness updates proposed.\nRejected ${rejected.length} proposal(s):\n- ${rejected.join('\n- ')}`
      : 'No evidence-backed harness updates proposed.'
  }

  const summary = `Applied ${changes.length} harness update(s):\n${changes.map(c => `- ${c}`).join('\n')}`
  return rejected.length > 0
    ? `${summary}\nRejected ${rejected.length} proposal(s):\n- ${rejected.join('\n- ')}`
    : summary
}

export interface PersistedRefine {
  applied: boolean
  changes: string[]
  eventId: string
  snapshotPath: string | null
}

/**
 * Shared apply-and-persist pipeline used by `/refine` and the manual
 * `/harness delete` command: read merged global+local → apply proposals (with
 * reverse snapshots) → record an event → prune the event log → CAS-write both
 * files, retrying once on conflict.
 *
 * A2: a CAS-conflict retry re-runs applyProposals (which writes a fresh
 * timestamped snapshot); the superseded file is removed so it is never left
 * orphaned and unreferenced by any event.
 */
export async function applyProposalsAndPersist(
  baseDir: string,
  sessionId: string,
  proposals: RefineProposal[],
  snapshotDir: string,
  maxRefinementEvents: number,
  trigger: string,
): Promise<PersistedRefine> {
  let writtenSnapshotPath: string | null = null

  for (let attempt = 0; ; attempt++) {
    // P0-fix: work on the merged global+local view; applyProposals routes each
    // proposal by scope; splitHarnessStateByScope sends entries home before the
    // CAS write of both files.
    const { global, local } = await readHarnessStatesDetailed(baseDir, sessionId)
    const merged = mergeHarnessStates(global.state, local.state)
    const { changes, snapshotPath, after } = await applyProposals(merged, proposals, snapshotDir)

    if (changes.length === 0) {
      // A2: a superseded attempt's snapshot has no referencing event — remove it.
      if (writtenSnapshotPath) {
        await rm(writtenSnapshotPath, { force: true }).catch(() => undefined)
      }
      return { applied: false, changes, eventId: '', snapshotPath: null }
    }

    // A2: drop the previous attempt's snapshot before this attempt's is
    // referenced by an event.
    if (writtenSnapshotPath && snapshotPath !== writtenSnapshotPath) {
      await rm(writtenSnapshotPath, { force: true }).catch(() => undefined)
    }
    writtenSnapshotPath = snapshotPath

    const eventId = crypto.randomUUID()
    merged.refinements ??= []
    merged.refinements.push({
      id: eventId,
      trigger,
      changes,
      // FIX-8: per-proposal evidence lives in each entry's `metadata.evidence`;
      // the old transcript-hash here was a redundant weak hash and is gone.
      evidence: '',
      outcome: 'applied',
      snapshot: snapshotPath ? { path: snapshotPath } : null,
      // FIX-5: record the after-image so rollback can detect concurrent edits.
      after,
    })
    // item-10: cap the event log (pruning the oldest events and their snapshots)
    // before the write, so the file lands already bounded.
    await pruneRefinements(merged.refinements, maxRefinementEvents)

    const split = splitHarnessStateByScope(merged, global.state.refinements)

    try {
      await writeHarnessStates(baseDir, sessionId, split.global, split.local, {
        global: global.mtimeMs,
        local: local.mtimeMs,
      })
    } catch (error) {
      if (!(error instanceof HarnessConflictError) || attempt >= 1) throw error
      continue // FIX-7: one retry with a fresh read
    }

    return { applied: true, changes, eventId, snapshotPath }
  }
}

/**
 * Parse a reverse-snapshot key. Current format is `scope:kind:id` (global/local
 * routing, P0-fix); snapshots written before the global-scope change used
 * `kind:id` — those are legacy local entries.
 */
function parseSnapshotKey(key: string): { scope: HarnessScope; kind: HarnessKind; id: string } {
  const parts = key.split(':')
  if (parts.length >= 3 && (parts[0] === 'local' || parts[0] === 'global')) {
    return { scope: parts[0], kind: parts[1] as HarnessKind, id: parts.slice(2).join(':') }
  }
  return { scope: 'local', kind: (parts[0] ?? '') as HarnessKind, id: parts.slice(1).join(':') }
}

/**
 * Roll back a refinement by event id using its reverse snapshot.
 *
 * FIX-5: before overwriting, the live state of every affected key is itself
 * snapshotted and recorded on the rollback event (so a rollback is reversible),
 * and any key that moved on since the refine applied is called out instead of
 * being silently clobbered.
 */
export async function rollbackRefine(
  baseDir: string,
  sessionId: string,
  eventId: string,
  maxRefinementEvents = DEFAULT_MAX_REFINEMENT_EVENTS,
): Promise<string> {
  const statePath = harnessStatePath(baseDir, sessionId)

  const readSnapshot = async (): Promise<
    Record<string, HarnessEntry | null> | typeof SNAPSHOT_NOT_FOUND | typeof SNAPSHOT_READ_ERROR
  > => {
    const state = await readHarnessState(statePath)
    const event = (state.refinements ?? []).find(e => e.id === eventId)
    if (!event || !event.snapshot?.path) return SNAPSHOT_NOT_FOUND
    try {
      return JSON.parse(await readFile(event.snapshot.path, 'utf8'))
    } catch {
      return SNAPSHOT_READ_ERROR
    }
  }
  const snapshot = await readSnapshot()
  if (snapshot === SNAPSHOT_NOT_FOUND) return `No reversible refinement event found: ${eventId}`
  if (snapshot === SNAPSHOT_READ_ERROR) return `Cannot read snapshot for event ${eventId}`

  const refinementsDir = path.join(path.dirname(statePath), 'refinements')
  await mkdir(refinementsDir, { recursive: true })

  for (let attempt = 0; ; attempt++) {
    const { global, local } = await readHarnessStatesDetailed(baseDir, sessionId)
    const globalState = global.state
    const localState = local.state

    // FIX-5: capture the live values we are about to overwrite so this rollback
    // itself can be undone; flag keys that changed since the refine applied.
    const forwardSnapshot: Record<string, HarnessEntry | null> = {}
    const warnings: string[] = []
    const afterImage = eventAfter(localState, eventId) ?? {}
    for (const key of Object.keys(snapshot)) {
      const { scope, kind, id } = parseSnapshotKey(key)
      const target = scope === 'global' ? globalState : localState
      const current = target.entries[kind]?.[id]
      forwardSnapshot[key] = current ? { ...current } : null

      const afterEntry = afterImage[key]
      if (afterEntry && current && afterEntry.version !== undefined && current.version !== afterEntry.version) {
        warnings.push(
          `${key} was modified after refine (version ${afterEntry.version} → ${current.version}); rollback will overwrite the newer value`,
        )
      }
    }

    for (const [key, entry] of Object.entries(snapshot)) {
      const { scope, kind, id } = parseSnapshotKey(key)
      const target = scope === 'global' ? globalState : localState
      const entries = (target.entries[kind] ??= {})
      if (entry === null) {
        Reflect.deleteProperty(entries, id)
      } else {
        entries[id] = entry
      }
    }

    // Persist the forward snapshot so `/refine-rollback <rollbackEventId>` undoes
    // this rollback.
    let forwardPath: string | null = null
    if (Object.keys(forwardSnapshot).length > 0) {
      forwardPath = path.join(refinementsDir, `rollback-${nowIso().replace(/[:.]/g, '-')}.snapshot.json`)
      const tmp = `${forwardPath}.tmp`
      await writeFile(tmp, JSON.stringify(forwardSnapshot, null, 2), 'utf8')
      await rename(tmp, forwardPath)
    }

    localState.refinements.push({
      id: crypto.randomUUID(),
      trigger: 'rollback',
      changes: [`rollback of ${eventId}`],
      evidence: '',
      outcome: 'rolled-back',
      snapshot: forwardPath ? { path: forwardPath } : null,
      after: forwardSnapshot,
    })
    // item-10: same event-log cap as /refine, applied before the write.
    await pruneRefinements(localState.refinements, maxRefinementEvents)

    try {
      await writeHarnessStates(baseDir, sessionId, globalState, localState, {
        global: global.mtimeMs,
        local: local.mtimeMs,
      })
    } catch (error) {
      if (!(error instanceof HarnessConflictError) || attempt >= 1) throw error
      continue // FIX-7: one retry with a fresh read
    }

    const warningText = warnings.length > 0 ? `\nWarnings:\n- ${warnings.join('\n- ')}` : ''
    return `Rolled back ${eventId}${warningText}`
  }
}

/** Sentinel values for the snapshot-loading outcome. */
const SNAPSHOT_NOT_FOUND: unique symbol = Symbol('snapshot-not-found')
const SNAPSHOT_READ_ERROR: unique symbol = Symbol('snapshot-read-error')

/** The `after` image of the targeted refine event, if it has one. */
function eventAfter(state: HarnessStateFile, eventId: string): Record<string, HarnessEntry | null> | null {
  const event = (state.refinements ?? []).find(e => e.id === eventId)
  return event?.after ?? null
}

/**
 * item-10: cap the event log to the newest `maxEvents` entries. Pruned events'
 * snapshot files are deleted — they can no longer be rollback targets, and
 * leaving them would be unbounded disk growth. Called before the state write so
 * the file lands already pruned.
 */
export async function pruneRefinements(refinements: RefinementEvent[], maxEvents: number): Promise<void> {
  const excess = refinements.length - maxEvents
  if (excess <= 0) return
  const removed = refinements.splice(0, excess)
  for (const event of removed) {
    if (event.snapshot?.path) {
      await rm(event.snapshot.path, { force: true }).catch(() => undefined)
    }
  }
}
