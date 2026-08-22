/**
 * `/refine` self-refinement: review the recent transcript, have a subagent
 * propose small evidence-backed harness updates, reverse-snapshot the entries
 * that will change, apply them, and record a RefinementEvent. Rollback restores
 * a snapshot by event id.
 * @module @deepseek-ai/dsh-plugin-continual-harness
 */

import path from 'node:path'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentRun, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import {
  harnessStatePath,
  readHarnessState,
  writeHarnessState,
  type HarnessEntry,
  type HarnessKind,
  type HarnessStateFile,
} from './harness-file.ts'

const TRANSCRIPT_TURNS = 12

interface RefineProposal {
  kind: HarnessKind
  action: 'upsert' | 'delete'
  id?: string
  title: string
  content: string
}

function buildRefinePrompt(transcriptText: string): string {
  return [
    'You are reviewing an agent trajectory to propose small, evidence-backed updates',
    'to a persistent harness (persistent instructions / memories / skills / subagents).',
    'Rules:',
    '- Each update must be traceable to concrete evidence in the transcript.',
    '- Prefer a handful of small, high-value updates over broad rewrites.',
    '- If nothing is worth changing, return an empty proposals list.',
    '',
    'Respond with ONLY a JSON object of the form:',
    '{"proposals":[{"kind":"memory|prompt|skill|subagent","action":"upsert|delete","id":"<existing id if delete/update>","title":"...","content":"..."}]}',
    '',
    '--- TRANSCRIPT (recent turns) ---',
    transcriptText,
  ].join('\n')
}

function transcriptToText(sessionId: SessionId, ctx: Context): string {
  const session = ctx.sessions.get(sessionId)
  if (!session) return '(no session available)'
  const messages = session.deriveMessages().slice(-TRANSCRIPT_TURNS)
  const parts = messages.map((message) => {
    const content = message.content
      .map(block => (block.type === 'text' ? block.text : `[${block.type}]`))
      .join(' ')
    return `[${message.role}] ${content}`
  })
  return parts.join('\n')
}

function extractProposals(result: unknown): RefineProposal[] {
  if (typeof result === 'string') {
    const start = result.indexOf('{')
    const end = result.lastIndexOf('}')
    if (start >= 0 && end > start) {
      try {
        const parsed: unknown = JSON.parse(result.slice(start, end + 1))
        return isRecord(parsed) && Array.isArray(parsed.proposals) ? parsed.proposals : []
      } catch {
        return []
      }
    }
    return []
  }
  if (isRecord(result)) {
    if (Array.isArray(result.proposals)) return result.proposals
    const structured = result.structured
    if (isRecord(structured) && Array.isArray(structured.proposals)) return structured.proposals
  }
  return []
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nowIso(): string {
  return new Date().toISOString()
}

/**
 * Apply proposals to the harness state, reverse-snapshotting affected entries
 * first. Returns a list of human-readable change lines.
 */
export async function applyProposals(
  state: HarnessStateFile,
  proposals: RefineProposal[],
  snapshotDir: string,
): Promise<{ changes: string[]; snapshotPath: string | null }> {
  const snapshot: Record<string, HarnessEntry | null> = {}
  const changes: string[] = []
  const touched = new Set<string>()

  for (const proposal of proposals) {
    const entries = (state.entries[proposal.kind] ??= {})
    const existing = proposal.id ? entries[proposal.id] : undefined

    if (proposal.action === 'delete') {
      if (!existing) continue // deleting a missing entry is a no-op
      const entryKey = `${proposal.kind}:${existing.id}`
      if (!touched.has(entryKey)) {
        touched.add(entryKey)
        snapshot[entryKey] = { ...existing }
      }
      Reflect.deleteProperty(entries, existing.id)
      changes.push(`delete ${proposal.kind}:${proposal.title}`)
      continue
    }

    // upsert: resolve the target id first so the reverse snapshot keys on the
    // id that will actually exist on disk — a freshly created entry must be
    // removable by rollback (it keys a null tombstone on its real id).
    const id = existing?.id ?? crypto.randomUUID()
    const entryKey = `${proposal.kind}:${id}`
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
      scope: existing?.scope ?? 'local',
      reference: existing?.reference ?? {},
      arguments: existing?.arguments ?? {},
      metadata: existing?.metadata ?? {},
      source: 'refine',
      created_at: existing?.created_at ?? now,
      updated_at: now,
      version: (existing?.version ?? 0) + 1,
    }
    changes.push(`upsert ${proposal.kind}:${proposal.title}`)
  }

  let snapshotPath: string | null = null
  if (Object.keys(snapshot).length > 0) {
    snapshotPath = path.join(snapshotDir, `refine-${nowIso().replace(/[:.]/g, '-')}.snapshot.json`)
    await mkdir(path.dirname(snapshotPath), { recursive: true })
    const tmp = `${snapshotPath}.tmp`
    await writeFile(tmp, JSON.stringify(snapshot, null, 2), 'utf8')
    await rename(tmp, snapshotPath)
  }

  return { changes, snapshotPath }
}

/**
 * Run /refine: evidence → proposal subagent → reverse snapshot → apply →
 * record event. Returns a summary string for the command result.
 */
export async function runRefine(
  ctx: Context,
  sessionId: SessionId,
  baseDir: string,
  parent: Agent,
): Promise<string> {
  const transcriptText = transcriptToText(sessionId, ctx)
  const controller = new AbortController()

  const request: SubagentStartRequest = {
    label: 'refine harness',
    prompt: [{ type: 'text', text: buildRefinePrompt(transcriptText) }],
    parent,
    signal: controller.signal,
    outputSchema: {
      type: 'object',
      properties: {
        proposals: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              kind: { enum: ['memory', 'prompt', 'skill', 'subagent'] },
              action: { enum: ['upsert', 'delete'] },
              id: { type: 'string' },
              title: { type: 'string' },
              content: { type: 'string' },
            },
          },
        },
      },
    },
  }
  const run: SubagentRun = await ctx.subagents.start('refine', request)

  const result = await run.result
  await run.dispose().catch(() => undefined)
  const proposals = extractProposals(result)

  const state = await readHarnessState(harnessStatePath(baseDir, sessionId))
  const artifactDir = path.dirname(harnessStatePath(baseDir, sessionId))
  const { changes, snapshotPath } = await applyProposals(state, proposals, path.join(artifactDir, 'refinements'))

  if (changes.length > 0) {
    state.refinements ??= []
    state.refinements.push({
      id: crypto.randomUUID(),
      trigger: '/refine',
      changes,
      evidence: `transcript-hash:${hashString(transcriptText)}`,
      outcome: 'applied',
      snapshot: snapshotPath ? { path: snapshotPath } : null,
    })
    await writeHarnessState(harnessStatePath(baseDir, sessionId), state)
  }

  return changes.length > 0
    ? `Applied ${changes.length} harness update(s):\n${changes.map(c => `- ${c}`).join('\n')}`
    : 'No evidence-backed harness updates proposed.'
}

/**
 * Roll back a refinement by event id using its reverse snapshot.
 */
export async function rollbackRefine(
  baseDir: string,
  sessionId: string,
  eventId: string,
): Promise<string> {
  const statePath = harnessStatePath(baseDir, sessionId)
  const state = await readHarnessState(statePath)
  const event = (state.refinements ?? []).find(e => e.id === eventId)
  if (!event || !event.snapshot?.path) return `No reversible refinement event found: ${eventId}`

  let snapshot: Record<string, HarnessEntry | null>
  try {
    const raw = await readFile(event.snapshot.path, 'utf8')
    snapshot = JSON.parse(raw)
  } catch {
    return `Cannot read snapshot for event ${eventId}`
  }

  for (const [key, entry] of Object.entries(snapshot)) {
    const [kind, id] = key.split(':') as [HarnessKind, string]
    const entries = (state.entries[kind] ??= {})
    if (entry === null) {
      Reflect.deleteProperty(entries, id)
    } else {
      entries[id] = entry
    }
  }

  state.refinements.push({
    id: crypto.randomUUID(),
    trigger: 'rollback',
    changes: [`rollback of ${eventId}`],
    evidence: '',
    outcome: 'rolled-back',
    snapshot: null,
  })
  await writeHarnessState(statePath, state)
  return `Rolled back ${eventId}`
}

function hashString(value: string): string {
  let hash = 0
  for (let index = 0; index < value.length; index++) {
    hash = (hash << 5) - hash + value.charCodeAt(index)
    hash |= 0
  }
  return hash.toString(36)
}
