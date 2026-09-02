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
import type { RlmMaterializedView, RlmStore } from '@deepseek-ai/dsh-plugin-rlm-store';
import type { HarnessStateFile } from './harness-file.ts';
/**
 * Render one session scope's store view into the harness-state file shape.
 * Pure function of the view — the property the rebuild check relies on.
 * @param view - the session scope's materialized view.
 * @returns the harness state file the projection persists.
 */
export declare function renderSessionProjection(view: RlmMaterializedView): HarnessStateFile;
/**
 * Register the store change listener that keeps a session's projected
 * harness-state file fresh. Fire-and-forget writes, latest-wins: the store
 * stream is the authority, so a failed or racing projection write is repaired
 * by the next change (or a manual rebuild) rather than guarded with CAS.
 * @param store - the unified store service.
 * @param baseDir - the harness base directory (`dataDir`).
 * @returns an unsubscriber.
 */
export declare function registerStoreProjection(store: RlmStore, baseDir: string): () => void;
//# sourceMappingURL=projection.d.ts.map