/**
 * Platform-adaptation utilities for cross-platform kernel operation.
 *
 * Vendor kernel code from prime-agent assumes POSIX semantics that don't hold
 * on Windows.  These helpers centralise the signal/process/filesystem gaps
 * behind one import so that vendor kernel sources can call them instead of
 * using POSIX primitives directly.
 *
 * @module @deepseek-ai/dsh-plugin-rlm-kernel/util/platform
 */

import { spawnSync } from 'node:child_process'
import {
  lstatSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

/**
 * Terminate a process in a cross-platform manner.
 *
 * Platform behaviour:
 * - **POSIX** (Linux/macOS): sends the requested `signal` via `process.kill`.
 *   Use `'SIGTERM'` for graceful shutdown, `'SIGKILL'` for force-kill.
 * - **Windows**: POSIX signals are no-ops, so this always performs a forced
 *   tree-kill via `taskkill /F /PID <pid> /T` regardless of `signal`.  The
 *   `signal` parameter is **ignored** on Windows — callers should not rely on
 *   graceful/force semantics there.
 *
 * @param pid - Target process id.
 * @param signal - POSIX signal to send (ignored on Windows). Default `'SIGTERM'`.
 * @returns `true` if the termination command was issued without error, `false`
 *          if the process could not be signaled (already dead, permission error).
 */
export function killSignalSafe(pid: number, signal: NodeJS.Signals = 'SIGTERM'): boolean {
  try {
    if (process.platform === 'win32') {
      // `signal` parameter is meaningless on Windows — force-kill the tree.
      spawnSync('taskkill', ['/F', '/PID', String(pid), '/T'], {
        stdio: 'ignore',
        windowsHide: true,
      })
      return true
    }
    process.kill(pid, signal)
    return true
  } catch {
    return false
  }
}

/**
 * Check whether a process with the given pid is alive.
 *
 * On POSIX, `process.kill(pid, 0)` is a zero-signal probe: success = alive,
 * ESRCH = not alive, EPERM = alive but we can't signal it.
 *
 * On Windows, `process.kill(pid, 0)` works via `OpenProcess` for most cases,
 * but can return ambiguous results for processes with restricted access or
 * zombie handles.  When the result is ambiguous (EPERM/EINVAL), we fall back
 * to `tasklist` for a definitive answer.
 *
 * @returns `true` if the process appears to be alive, `false` otherwise.
 */
export function isPidAlive(pid: number): boolean {
  if (process.platform === 'win32') {
    return isPidAliveWindows(pid)
  }
  // POSIX path
  try {
    process.kill(pid, 0)
    return true // Process exists and we have permission to signal it.
  } catch (error) {
    // POSIX: EPERM = process exists but we can't signal it (still alive).
    return error instanceof Error && (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Windows-specific process liveness check.
 *
 * `process.kill(pid, 0)` on Windows uses `OpenProcess` with limited access
 * rights.  It works for most processes but can throw EPERM/EINVAL for:
 * - System-protected processes (PID 0, PID 4, CSRSS, etc.)
 * - Processes whose primary token denies QUERY_INFORMATION
 * - Zombie handles awaiting final closure
 *
 * When the result is ambiguous, we fall back to `tasklist /FI "PID eq <pid>"`
 * which uses a different access path and gives a definitive answer.
 */
function isPidAliveWindows(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true // OpenProcess succeeded → process exists.
  } catch (error) {
    const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined
    if (code === 'ESRCH') {
      return false // Definitely doesn't exist.
    }
    // EPERM / EINVAL / unknown → ambiguous; fall back to tasklist.
    return isPidAliveTasklist(pid)
  }
}

/**
 * Definitive Windows process liveness check via `tasklist`.
 *
 * `tasklist /FI "PID eq <pid>" /NH /FO CSV` outputs a CSV line for the
 * process if it exists, or "INFO: No tasks are running which match the
 * specified criteria." if not.  We check for the absence of the "No tasks"
 * marker to determine liveness.
 */
function isPidAliveTasklist(pid: number): boolean {
  try {
    const result = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'], {
      encoding: 'utf8',
      windowsHide: true,
    })
    const output = result.stdout?.trim() || ''
    // tasklist outputs "INFO: No tasks are running which match the specified criteria."
    // when no process matches the filter.
    if (!output || output.startsWith('INFO:')) {
      return false
    }
    // A matching process produces a CSV line like: "python.exe","1234","Console","1","12,345 K"
    return output.includes(String(pid))
  } catch {
    return false // tasklist unavailable; assume not alive.
  }
}

/**
 * Recursively remove a directory without following junctions/symlinks.
 *
 * On Windows, `rmSync(path, { recursive: true })` will follow directory
 * junctions and delete the target contents, which can cause data loss if the
 * junction points outside the intended tree (e.g., pnpm's node_modules links).
 * This function checks each entry with `lstat` and unlinks symlinks/junctions
 * instead of recursing into them.
 */
export function safeRmDirSync(dirPath: string): void {
  let entries
  try {
    entries = readdirSync(dirPath, { withFileTypes: true })
  } catch {
    return // Already gone or unreadable; nothing to do.
  }

  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name)
    let stats
    try {
      stats = lstatSync(fullPath)
    } catch {
      continue // Entry vanished; skip.
    }

    if (stats.isDirectory()) {
      safeRmDirSync(fullPath)
    } else {
      // Symlinks and regular files are both unlinked directly; we never follow
      // a junction into its target (that is the whole point of safeRmDirSync).
      try {
        unlinkSync(fullPath)
      } catch {
        // Best-effort.
      }
    }
  }

  try {
    // rmdirSync, not rmSync: with recursive:false rmSync rejects directories
    // outright (ERR_FS_EISDIR on every platform), so the tree skeleton would
    // survive. The directory is empty at this point by construction.
    rmdirSync(dirPath)
  } catch {
    // Already gone.
  }
}

/**
 * Write a file synchronously with a given POSIX mode.  On Windows the `mode`
 * parameter is ignored by the Node.js runtime, so we create the file with
 * default permissions and rely on the containing directory's ACL for access
 * control.
 */
export function writeFileSecureSync(
  filePath: string,
  data: string | NodeJS.ArrayBufferView,
  mode?: number,
): void {
  if (process.platform === 'win32') {
    writeFileSync(filePath, data)
  } else {
    writeFileSync(filePath, data, { mode: mode ?? 0o600 })
  }
}
