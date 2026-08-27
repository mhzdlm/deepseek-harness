/**
 * item-11: mtime-keyed cache for the harness-overview prompt section.
 *
 * The section is re-assembled for every LLM turn; reading + sorting both harness
 * state files each time is wasted work when nothing changed. This cache keys on
 * each file's (mtimeMs, size) pair, re-rendering only when either file actually
 * changed. Bounded to `maxEntries` sessions (evicts oldest on overflow).
 * @module @deepseek-ai/dsh-plugin-continual-harness
 */

import { statSync } from 'node:fs'
import type { HarnessStateFile } from './harness-file.ts'

/**
 * Cache that renders (or replays from cache) the merged harness-overview
 * prompt section for one session, re-rendering only when a state file changes.
 */
export interface HarnessOverviewCache {
  /**
   * Render (or replay from cache) the merged overview for one session.
   * @param baseDir - Absolute path to the harness data root directory.
   * @param sessionId - Identifier of the session whose overview is requested.
   * @returns The rendered overview string, served from cache when neither state file changed.
   */
  render(baseDir: string, sessionId: string): string
}

/**
 * Configuration and callbacks used to construct a {@link HarnessOverviewCache}.
 */
export interface HarnessOverviewCacheOptions {
  globalStatePath: (baseDir: string) => string
  localStatePath: (baseDir: string, sessionId: string) => string
  /** Read the merged global+local state for a session (sync). */
  readMerged: (baseDir: string, sessionId: string) => HarnessStateFile
  /** Render the merged state into the overview string. */
  render: (state: HarnessStateFile) => string
  /** Max cached sessions; oldest evicted first. Defaults to 64. */
  maxEntries?: number
}

interface CacheEntry {
  gMtime: number
  gSize: number
  lMtime: number
  lSize: number
  rendered: string
}

function fileStamp(filePath: string): { mtime: number; size: number } {
  try {
    const stat = statSync(filePath)
    return { mtime: stat.mtimeMs, size: stat.size }
  } catch {
    // Missing file renders as empty state; treat any absent file as stale = -1.
    return { mtime: -1, size: -1 }
  }
}

/**
 * Create an mtime-keyed cache for the harness-overview prompt section.
 * @param options - Configuration and callbacks used to read and render session state.
 * @returns A {@link HarnessOverviewCache} that re-renders only when a state file changes.
 */
export function createHarnessOverviewCache(options: HarnessOverviewCacheOptions): HarnessOverviewCache {
  const { globalStatePath, localStatePath, readMerged, render, maxEntries = 64 } = options
  const cache = new Map<string, CacheEntry>()

  return {
    render(baseDir, sessionId) {
      const gPath = globalStatePath(baseDir)
      const lPath = localStatePath(baseDir, sessionId)
      const g = fileStamp(gPath)
      const l = fileStamp(lPath)
      const key = `${baseDir}\0${sessionId}`

      const hit = cache.get(key)
      if (
        hit &&
        hit.gMtime === g.mtime &&
        hit.gSize === g.size &&
        hit.lMtime === l.mtime &&
        hit.lSize === l.size
      ) {
        // Refresh insertion order on hit so eviction is truly least-recently-used.
        cache.delete(key)
        cache.set(key, hit)
        return hit.rendered
      }

      const rendered = render(readMerged(baseDir, sessionId))
      cache.set(key, { gMtime: g.mtime, gSize: g.size, lMtime: l.mtime, lSize: l.size, rendered })
      if (cache.size > maxEntries) {
        const oldest = cache.keys().next().value
        if (oldest !== undefined) cache.delete(oldest)
      }
      return rendered
    },
  }
}
