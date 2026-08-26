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

export interface HarnessOverviewCache {
  /** Render (or replay from cache) the merged overview for one session. */
  render(baseDir: string, sessionId: string): string
}

export interface HarnessOverviewCacheOptions {
  globalStatePath: (baseDir: string) => string
  localStatePath: (baseDir: string, sessionId: string) => string
  /** Read the merged global+local state for a session (sync). */
  readMerged: (baseDir: string, sessionId: string) => HarnessStateFile
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
