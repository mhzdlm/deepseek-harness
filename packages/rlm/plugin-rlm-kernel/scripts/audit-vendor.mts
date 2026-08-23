#!/usr/bin/env node
/**
 * audit-vendor.mts — Verify that src/vendor/kernel/*.ts carries every dsh
 * local patch and none of the forbidden POSIX-only patterns.
 *
 * The vendor workflow is AUDIT-DRIVEN, not transform-driven: strict-mode
 * patches (#6) and env indirection require human judgment, so kernel/*.ts is
 * hand-maintained (each patch marked with a `[local patch ...]` comment).
 * This script replaces the old write-mode normalize pipeline, which could
 * silently destroy the manual patches (see FIXES-ARCHIVE.md, incident 2026-08).
 *
 * Usage:
 *   node --import tsx scripts/audit-vendor.mts   # audit kernel/ against ORIGINAL/ + patch contract
 *
 * Exit 0 = all checks pass; exit 1 = drift detected.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(SCRIPT_DIR, "..");
const VENDOR_DIR = join(PLUGIN_ROOT, "src", "vendor");
const KERNEL_DIR = join(VENDOR_DIR, "kernel");

// ---------------------------------------------------------------------------
// Check model
// ---------------------------------------------------------------------------

interface Check {
	/** Short label printed on failure. */
	label: string;
	/** Must match the file content (required patch present). */
	mustContain?: RegExp[];
	/** Must NOT match the file content (forbidden pristine/POSIX pattern). */
	mustNotContain?: RegExp[];
}

interface FileAudit {
	file: string;
	checks: Check[];
}

/** Shared: dsh uses .ts import extensions (allowImportingTsExtensions). */
const noDotJsImports: RegExp = /^[ \t]*import[^;\n]*from\s+["'][^"']+\.js["'];?[ \t]*$/m;

/** Shared: direct PRIME_AGENT_* env reads bypass the rlmEnv() legacy fallback. */
const noDirectPrimeEnv: RegExp = /process\.env\.PRIME_AGENT_/;

const COMMON_FORBIDDEN: RegExp[] = [noDotJsImports, noDirectPrimeEnv];

const AUDITS: FileAudit[] = [
	{
		file: "index.ts",
		checks: [
			{
				label: "#13 platform helpers imported (killSignalSafe/safeRmDirSync/writeFileSecureSync)",
				mustContain: [/import\s*\{[^}]*killSignalSafe[^}]*safeRmDirSync[^}]*writeFileSecureSync[^}]*\}\s*from\s*["']\.\.\/\.\.\/util\/platform["']/],
			},
			{
				label: "#1/#4 disposeKernelsForSession exported (pi-ai cleanup replacement)",
				mustContain: [/export function disposeKernelsForSession/],
			},
			{
				label: "#7 port/ready timeouts bumped to 30s (Windows cold start)",
				mustContain: [/PORTS_RESOLVE_TIMEOUT_MS = 30000/, /READY_TIMEOUT_MS = 30000/],
			},
			{
				label: "#13b junction-safe dir removal",
				mustNotContain: [/rmSync\([^)]*recursive:\s*true/],
			},
			{
				label: "#13c secure file write (mode 0o600 is a Windows no-op)",
				mustNotContain: [/writeFileSync\([^)]*mode:\s*0o600/],
			},
			{
				label: "#13a variable-signal kill routed through killSignalSafe",
				mustNotContain: [/process\.kill\([^)]*,\s*killSignal\)/],
			},
		],
	},
	{
		file: "bootstrap.ts",
		checks: [
			{
				label: "#11 env access via rlmEnv() indirection",
				mustContain: [/rlmEnv\(\.\.\.ENV_KERNEL_PYTHON\)/, /rlmEnv\(\.\.\.ENV_KERNEL_VENV\)/, /rlmEnv\(\.\.\.ENV_INSTALL_UV\)/],
			},
			{
				label: "Windows venv layout (venvPythonPath)",
				mustContain: [/export function venvPythonPath/],
			},
			{
				label: "#10 bootstrap lock wait deadline (60s cap)",
				mustContain: [/BOOTSTRAP_LOCK_WAIT_TIMEOUT_MS = 60_000/, /Date\.now\(\) [<>]=? deadline/],
			},
			{
				label: "#12 llm-verifier in default extra packages",
				mustContain: [/uvArg:\s*"llm-verifier"/],
			},
			{
				label: "#13d processIsRunning delegates to isPidAlive",
				mustContain: [/\[local patch #13d\]/, /return isPidAlive\(pid\)/, /import\s*\{[^}]*isPidAlive[^}]*\}\s*from\s*["']\.\.\/\.\.\/util\/platform["']/],
			},
			{
				label: "#13e PATHEXT-aware executable lookup",
				mustContain: [/\[local patch #13e\]/, /PATHEXT/],
			},
		],
	},
	{
		file: "fork-server.ts",
		checks: [
			{
				label: "#11 env access via rlmEnv() indirection",
				mustContain: [/rlmEnv\(\.\.\.ENV_FORKSERVER\)/],
			},
			{
				label: "#13a killSignalSafe imported and used for orphan kill",
				mustContain: [/import\s*\{[^}]*killSignalSafe[^}]*\}\s*from\s*["']\.\.\/\.\.\/util\/platform["']/, /killSignalSafe\(msg\.pid/],
			},
			{
				label: "#13a no direct POSIX signal kill",
				mustNotContain: [/process\.kill\([^)]*,\s*"(?:SIGTERM|SIGKILL|SIGINT)"\)/],
			},
		],
	},
	{
		file: "boot-gate.ts",
		checks: [
			{
				label: "#3 inline Semaphore (prime-internal util replaced)",
				mustContain: [/class Semaphore/],
			},
			{
				label: "#11 env access via rlmEnv() indirection",
				mustContain: [/rlmEnv\(\.\.\.ENV_MAX_CONCURRENT_BOOTS\)/],
			},
		],
	},
	{
		file: "state-snapshot.ts",
		checks: [],
	},
	{
		file: "fork-server-script.ts",
		checks: [
			{
				label: "#1/#4 no pi-ai registerSessionResourceCleanup import",
				mustNotContain: [/registerSessionResourceCleanup/],
			},
		],
	},
];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
	let failed = 0;
	let passed = 0;

	for (const audit of AUDITS) {
		const dstPath = join(KERNEL_DIR, audit.file);
		if (!existsSync(dstPath)) {
			process.stderr.write(`FAIL  kernel/${audit.file}: file does not exist\n`);
			failed++;
			continue;
		}
		const content = readFileSync(dstPath, "utf8");

		for (const pattern of COMMON_FORBIDDEN) {
			if (pattern.test(content)) {
				process.stderr.write(`FAIL  kernel/${audit.file}: forbidden pattern ${pattern} — dsh uses .ts imports + rlmEnv() indirection\n`);
				failed++;
			} else {
				passed++;
			}
		}

		for (const check of audit.checks) {
			let ok = true;
			for (const re of check.mustContain ?? []) {
				if (!re.test(content)) ok = false;
			}
			for (const re of check.mustNotContain ?? []) {
				if (re.test(content)) ok = false;
			}
			if (ok) {
				passed++;
			} else {
				process.stderr.write(`FAIL  kernel/${audit.file}: ${check.label}\n`);
				failed++;
			}
		}
		process.stdout.write(`PASS  kernel/${audit.file}\n`);
	}

	if (failed > 0) {
		process.stderr.write(`\n${failed} check(s) failed — vendor drift detected.\n`);
		process.exit(1);
	}
	process.stdout.write(`\nAll ${passed} checks passed.\n`);
}

main();
