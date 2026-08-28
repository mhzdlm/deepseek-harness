import { closeSync, fsyncSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
// [local patch #11] dsh env naming (new first, legacy fallback via rlmEnv()).
import { ENV_ORPHAN_PROCESS_JOURNAL, rlmEnv } from "../../env.ts";

// [local patch #17] Vendored without prime's session-lease dependency tree:
// getProcessStartId (Windows PowerShell / /proc / ps probing) is pruned, so
// processStartId is always undefined here. The journal keeps its pid/owner/active
// shape, which is all the dsh host consumes for orphan-kernel bookkeeping.
const getProcessStartId = (_pid: number): string | undefined => undefined;

// Resolve at call time would be ideal; a constant snapshot is fine for this
// process-lifetime journal path. rlmEnv picks DSH_RLM_* first, legacy fallback.



interface OrphanProcessRecord {
	version: 1;
	pid: number;
	ownerPid: number;
	processStartId?: string;
	active: boolean;
	recordedAt: string;
}

export interface ActiveOrphanProcess {
	pid: number;
	processStartId: string;
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

export function readActiveOrphanProcesses(path: string, ownerPid: number): ActiveOrphanProcess[] {
	let contents: string;
	try {
		contents = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return [];
		}
		throw error;
	}
	const latest = new Map<number, OrphanProcessRecord>();
	for (const line of contents.split("\n")) {
		if (!line) {
			continue;
		}
		try {
			const record = JSON.parse(line) as Partial<OrphanProcessRecord>;
			if (
				record.version === 1 &&
				Number.isInteger(record.pid) &&
				(record.pid ?? 0) > 0 &&
				record.ownerPid === ownerPid &&
				typeof record.active === "boolean" &&
				typeof record.recordedAt === "string"
			) {
				latest.set(record.pid!, record as OrphanProcessRecord);
			}
		} catch {
			// A crash can truncate only the final append.
		}
	}
	return [...latest.values()]
		.filter(
			(record): record is OrphanProcessRecord & { processStartId: string } =>
				record.active && typeof record.processStartId === "string",
		)
		.map((record) => ({ pid: record.pid, processStartId: record.processStartId }));
}

export function isOrphanProcessIdentityCurrent(orphan: ActiveOrphanProcess): boolean {
	return getProcessStartId(orphan.pid) === orphan.processStartId;
}

export function clearOrphanProcessJournal(path: string): void {
	rmSync(path, { force: true });
}
