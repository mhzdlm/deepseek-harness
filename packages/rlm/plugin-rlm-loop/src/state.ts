/**
 * Harness-state landing for loop verdicts. Entries ride the existing
 * `memory` kind under a `loop_<runId>/...` id convention (e.g.
 * `loop_ab12cd34/round_002`) instead of new `HarnessKind` values, so the
 * continual-harness overview injection, `/refine` whitelist, and rollback
 * machinery apply unchanged. Writes go through the shared CAS pipeline (read
 * with mtime, upsert, rename) and stay session-local: verified progress
 * belongs to the run that audited it.
 *
 * @module @deepseek-ai/dsh-plugin-rlm-loop/state
 */

import {
  HarnessConflictError,
  type HarnessEntry,
  readHarnessStatesDetailed,
  writeHarnessStates,
} from '@deepseek-ai/dsh-plugin-continual-harness'

const SOURCE = 'plugin-rlm-loop'

export interface UpsertInput {
  /** Entry id inside the memory kind, e.g. `loop_ab12cd34/round_002`. */
  id: string
  title: string
  content: string
}

function nowIso(): string {
  return new Date().toISOString()
}

/**
 * Upsert one local-scope memory entry into the session's harness state via the
 * CAS pipeline. One conflict retry re-reads and re-applies; the second failure
 * surfaces so the caller can report the landing as failed without losing the
 * verdict itself (the session-log event is already durable by then).
 * @param baseDir - harness base dir shared with plugin-continual-harness.
 * @param sessionId - owning session id; entries stay session-local.
 * @param input - entry id (e.g. `loop_ab12cd34/round_002`), title, and content.
 * @returns once the entry is durable under CAS.
 */
export async function upsertMemoryEntry(
  baseDir: string,
  sessionId: string,
  input: UpsertInput,
): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { global, local } = await readHarnessStatesDetailed(baseDir, sessionId)
    const memories = { ...local.state.entries.memory }
    const previous = memories[input.id]
    const timestamp = nowIso()
    const entry: HarnessEntry = {
      id: input.id,
      kind: 'memory',
      title: input.title,
      content: input.content,
      path: '',
      scope: 'local',
      reference: {},
      arguments: {},
      metadata: { source: SOURCE },
      source: SOURCE,
      created_at: previous?.created_at ?? timestamp,
      updated_at: timestamp,
      version: (previous?.version ?? 0) + 1,
    }
    memories[input.id] = entry
    try {
      await writeHarnessStates(
        baseDir,
        sessionId,
        global.state,
        { ...local.state, entries: { ...local.state.entries, memory: memories } },
        { global: global.mtimeMs, local: local.mtimeMs },
      )
      return
    } catch (error) {
      if (attempt === 1 || !(error instanceof HarnessConflictError)) throw error
    }
  }
}
