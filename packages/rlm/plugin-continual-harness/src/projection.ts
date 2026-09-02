/**
 * Store → harness-state projection (BUILD.md Phase A item 3).
 *
 * As of the Phase A authority flip, `harness_state.json` (local scope) is a
 * pure projection of the session's store view: every TS-side producer writes
 * the store, and the change listener registered here re-renders the file. The
 * file keeps its historical JSON shape so the synchronous prompt renderer and
 * the kernel-side reader work unchanged; it is cache-grade — `rebuild` on the
 * store plus one listener fire (or a fresh render) reproduces it.
 *
 * Rendering rules:
 * - `rlm/action-boundary` events with `action: 'loop-begin'` render the run's
 *   task contract as a `memory` entry (`${runId}/contract`);
 * - **titled** active beliefs render as `memory` entries keyed by belief id
 *   (the title is the producer's explicit "belongs in the overview" signal —
 *   untitled judgments like verify selections stay out of the prompt);
 * - everything else in the view is ignored here.
 *
 * The global-scope file is frozen in Phase A (BUILD.md R5 / Phase C migrates
 * it into the mailbox): the listener never writes it.
 *
 * @module @deepseek-ai/dsh-plugin-continual-harness/projection
 */

import type { RlmMaterializedView, RlmScope, RlmStore } from '@deepseek-ai/dsh-plugin-rlm-store'
import type { HarnessEntry, HarnessStateFile } from './harness-file.ts'
import { harnessStatePath, writeHarnessState } from './harness-file.ts'

const SOURCE = 'rlm-store'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function entry(partial: {
  id: string
  title: string
  content: string
  created: string
  updated: string
  version: number
  source: string
}): HarnessEntry {
  return {
    id: partial.id,
    kind: 'memory',
    title: partial.title,
    content: partial.content,
    path: '',
    scope: 'local',
    reference: {},
    arguments: {},
    metadata: { source: partial.source },
    source: partial.source,
    created_at: partial.created,
    updated_at: partial.updated,
    version: partial.version,
  }
}

/**
 * Render one session scope's store view into the harness-state file shape.
 * Pure function of the view — the property the rebuild check relies on.
 * @param view - the session scope's materialized view.
 * @returns the harness state file the projection persists.
 */
export function renderSessionProjection(view: RlmMaterializedView): HarnessStateFile {
  const memories: Record<string, HarnessEntry> = {}

  for (const action of view.actions) {
    if (!isRecord(action.payload) || action.payload['action'] !== 'loop-begin') continue
    const runId = typeof action.payload['runId'] === 'string' ? action.payload['runId'] : ''
    if (!runId) continue
    const task = typeof action.payload['task'] === 'string' ? action.payload['task'] : ''
    const contract = typeof action.payload['contract'] === 'string' ? action.payload['contract'] : ''
    memories[`${runId}/contract`] = entry({
      id: `${runId}/contract`,
      title: `[loop] Task contract (${runId})`,
      content: `[Task contract]\n${contract}\n\n[Original task]\n${task}`,
      created: action.time,
      updated: action.time,
      version: 1,
      source: SOURCE,
    })
  }

  for (const belief of view.beliefs) {
    if (belief.status !== 'active') continue
    // Titled beliefs only — see the module comment.
    if (!belief.title) continue
    memories[belief.id] = entry({
      id: belief.id,
      title: belief.title,
      content: belief.content,
      created: belief.time,
      updated: belief.time,
      version: belief.updatedAt,
      source: `${SOURCE}:${belief.criterionRef}`,
    })
  }

  return { schema: 1, entries: { memory: memories }, refinements: [] }
}

/**
 * Register the store change listener that keeps a session's projected
 * harness-state file fresh. Fire-and-forget writes, latest-wins: the store
 * stream is the authority, so a failed or racing projection write is repaired
 * by the next change (or a manual rebuild) rather than guarded with CAS.
 * @param store - the unified store service.
 * @param baseDir - the harness base directory (`dataDir`).
 * @returns an unsubscriber.
 */
export function registerStoreProjection(store: RlmStore, baseDir: string): () => void {
  return store.onChange((scope: RlmScope, view: RlmMaterializedView) => {
    // Phase A: only the local (session) file is a live projection; the global
    // file is frozen until the Phase C mailbox migration.
    if (scope.kind !== 'session') return
    const target = harnessStatePath(baseDir, scope.id)
    void writeHarnessState(target, renderSessionProjection(view)).catch((error: unknown) => {
      console.warn(`[continual-harness] projection write failed for ${target}:`, error)
    })
  })
}
