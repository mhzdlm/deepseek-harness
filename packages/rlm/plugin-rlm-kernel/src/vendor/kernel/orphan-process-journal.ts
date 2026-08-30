import { closeSync, fsyncSync, openSync, writeSync } from "node:fs";
// [local patch #11] dsh env naming (new first, legacy fallback via rlmEnv()).
import { ENV_ORPHAN_PROCESS_JOURNAL, rlmEnv } from "../../env.ts";

// [local patch #17] Vendored without prime's session-lease dependency tree:
// getProcessStartId (Windows PowerShell / /proc / ps probing) is pruned, so
// processStartId is always undefined here. The journal keeps its pid/owner/active
// shape, which is all the dsh host consumes for orphan-kernel bookkeeping.
const getProcessStartId = (_pid: number): string | undefined => undefined;

// [local patch #18] T7.9: the read/identity/clear side (readActiveOrphanProcesses /
// isOrphanProcessIdentityCurrent / clearOrphanProcessJournal + ActiveOrphanProcess)
// is deleted — zero callers in the dsh host, and its active filter was vacuously
// false because processStartId is always undefined under #17. The journal remains
// an append-only process-tracking log for the write side, which the dsh host has
// real callers for (kernel/fork-server spawn and exit bookkeeping).
// rlmEnv picks DSH_RLM_* first, legacy fallback.

interface OrphanProcessRecord {
	version: 1;
	pid: number;
	ownerPid: number;
	processStartId?: string;
	active: boolean;
	recordedAt: string;
}

export function recordOrphanProcessState(pid: number, active: boolean): void {
	// [local patch #11] dsh env naming via rlmEnv (DSH_RLM_* first, legacy fallback).
	const path = rlmEnv(...ENV_ORPHAN_PROCESS_JOURNAL);
	if (!path || !Number.isInteger(pid) || pid <= 0) {
		return;
	}
	const processStartId = active ? getProcessStartId(pid) : undefined;
	const record: OrphanProcessRecord = {
		version: 1,
		pid,
		ownerPid: process.pid,
		...(processStartId ? { processStartId } : {}),
		active,
		recordedAt: new Date().toISOString(),
	};
	try {
		const descriptor = openSync(path, "a", 0o600);
		try {
			writeSync(descriptor, `${JSON.stringify(record)}\n`);
			fsyncSync(descriptor);
		} finally {
			closeSync(descriptor);
		}
	} catch {
		// Process tracking must not make a successfully spawned command fail.
	}
}
