/**
 * `/harness` management command (item-5): list / show / delete harness entries
 * without writing a proposal subagent. Deletes go through the same
 * reverse-snapshot + event pipeline as `/refine`, so they stay rollback-able
 * via `/refine-rollback <eventId>`.
 * @module @deepseek-ai/dsh-plugin-continual-harness
 */

import path from 'node:path'
import {
  globalHarnessStatePath,
  harnessStatePath,
  mergeHarnessStates,
  readHarnessStateSync,
  type HarnessEntry,
  type HarnessKind,
  type HarnessStateFile,
} from './harness-file.ts'
import { applyProposalsAndPersist, DEFAULT_MAX_REFINEMENT_EVENTS, validateProposals, type RefineProposal } from './refine.ts'

const KINDS: readonly HarnessKind[] = ['prompt', 'memory', 'skill', 'subagent']
const KIND_SET: ReadonlySet<string> = new Set(KINDS)

function readMergedSync(baseDir: string, sessionId: string): HarnessStateFile {
  return mergeHarnessStates(
    readHarnessStateSync(globalHarnessStatePath(baseDir)),
    readHarnessStateSync(harnessStatePath(baseDir, sessionId)),
  )
}

type ResolvedEntry = { kind: HarnessKind; entry: HarnessEntry }

/**
 * Resolve an id selector (exact id or a unique prefix) across every kind and
 * scope in the merged view. Ambiguous or unmatched selectors are errors.
 */
function resolveEntry(state: HarnessStateFile, selector: string): ResolvedEntry | string {
  const matches: ResolvedEntry[] = []
  for (const kind of KINDS) {
    for (const entry of Object.values(state.entries[kind] ?? {})) {
      if (entry.id === selector || entry.id.startsWith(selector)) matches.push({ kind, entry })
    }
  }
  if (matches.length === 0) return `No harness entry matches "${selector}"`
  if (matches.length > 1) {
    return `"${selector}" is ambiguous (${matches.length} matches); use a longer id prefix`
  }
  const match = matches[0]
  if (!match) return `No harness entry matches "${selector}"`
  return match
}

function byUpdatedDesc(a: HarnessEntry, b: HarnessEntry): number {
  return String(b.updated_at ?? b.created_at).localeCompare(String(a.updated_at ?? a.created_at))
}

/** `/harness list [kind]`: all entries, newest first, full ids, scope markers. */
export function listHarness(baseDir: string, sessionId: string, kind?: string): string {
  if (kind !== undefined && !KIND_SET.has(kind)) {
    return `Unknown harness kind "${kind}" (${KINDS.join('|')})`
  }
  const merged = readMergedSync(baseDir, sessionId)
  const lines: string[] = []
  for (const k of KINDS) {
    if (kind !== undefined && k !== kind) continue
    const entries = Object.values(merged.entries[k] ?? {})
    if (entries.length === 0) continue
    lines.push(`## ${k} (${entries.length})`)
    for (const entry of [...entries].sort(byUpdatedDesc)) {
      const content = entry.content.length > 120 ? entry.content.slice(0, 120) + '…' : entry.content
      const scope = entry.scope === 'global' ? ' [global]' : ''
      lines.push(`- ${entry.id}${scope} ${entry.title}: ${content}`)
    }
  }
  return lines.length > 0 ? lines.join('\n') : '(harness empty)'
}

/** `/harness show <id>`: full detail for one entry. */
export function showHarnessEntry(baseDir: string, sessionId: string, selector: string): string {
  const resolved = resolveEntry(readMergedSync(baseDir, sessionId), selector)
  if (typeof resolved === 'string') return resolved
  const entry = resolved.entry
  const meta = JSON.stringify(entry.metadata ?? {})
  return [
    `${resolved.kind} [${entry.scope}] #${entry.id} (v${entry.version})`,
    `title: ${entry.title}`,
    `source: ${entry.source}  created: ${entry.created_at}  updated: ${entry.updated_at}`,
    ...(meta && meta !== '{}' ? [`metadata: ${meta}`] : []),
    'content:',
    entry.content,
  ].join('\n')
}

/**
 * `/harness delete <id>`: remove one entry. Reuses the refine apply-and-persist
 * pipeline (reverse snapshot + event), so `/refine-rollback <eventId>` undoes it.
 */
export async function deleteHarnessEntry(
  baseDir: string,
  sessionId: string,
  selector: string,
  maxRefinementEvents = DEFAULT_MAX_REFINEMENT_EVENTS,
): Promise<string> {
  const resolved = resolveEntry(readMergedSync(baseDir, sessionId), selector)
  if (typeof resolved === 'string') return resolved

  const proposal: RefineProposal = {
    kind: resolved.kind,
    action: 'delete',
    id: resolved.entry.id,
    title: resolved.entry.title,
    content: '',
    evidence: 'manual delete via /harness',
  }
  const { valid, rejected } = validateProposals([proposal])
  if (valid.length === 0) return `Cannot delete: ${rejected.join('; ')}`

  const statePath = harnessStatePath(baseDir, sessionId)
  const snapshotDir = path.join(path.dirname(statePath), 'refinements')
  const { applied, changes, eventId } = await applyProposalsAndPersist(
    baseDir,
    sessionId,
    valid,
    snapshotDir,
    maxRefinementEvents,
    '/harness delete',
  )
  if (!applied) return 'No change: entry already absent.'

  return [
    `Deleted ${resolved.kind}:${resolved.entry.title} (${resolved.entry.id})`,
    ...changes.map(c => `- ${c}`),
    `Roll back with: /refine-rollback ${eventId}`,
  ].join('\n')
}
