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

/**
 * Shared: passing the full host environment to a child reintroduces the
 * credential leak that [local patch #14] closed — every child env must go
 * through kernel-env.ts's builders.
 */
const noFullEnvPassthrough: RegExp = /\.\.\.process\.env|env:\s*process\.env\s*[,}]/;

/**
 * Shared: an extensionless relative import survives tsc emit verbatim, and
 * plain Node over node_modules cannot resolve it — the deployed preset mount
 * fails with "Cannot find module .../lib/types/util/platform". Every relative
 * import must carry its explicit .ts extension (rewritten to .js on emit).
 * Anchored to physical import lines so commented examples never match.
 */
const noExtensionlessRelativeImports: RegExp = /^[ \t]*import[^;\n]*from\s*["']\.[^"']*(?<!\.ts)["']/m;

const COMMON_FORBIDDEN: RegExp[] = [noDotJsImports, noDirectPrimeEnv, noFullEnvPassthrough, noExtensionlessRelativeImports];

const AUDITS: FileAudit[] = [
	{
		file: "index.ts",
		checks: [
			{
				// 2026-08-28 (prime v0.8.1): killSignalSafe moved out of index.ts — upstream
				// routes forked-kernel kill through the forkserver protocol; index.ts keeps
				// the junction-safe dir removal + secure file write helpers.
				label: "#13 platform helpers imported (safeRmDirSync/writeFileSecureSync)",
				mustContain: [/import\s*\{[^}]*safeRmDirSync[^}]*writeFileSecureSync[^}]*\}\s*from\s*["']\.\.\/\.\.\/util\/platform\.ts["']/],
			},
			{
				label: "#1/#4 disposeKernelsForSession exported (pi-ai cleanup replacement)",
				mustContain: [/export function disposeKernelsForSession/],
			},
			{
				label: "#7 port/ready timeouts bumped to 30s (Windows cold start; upstream absorbed this as 30_000)",
				mustContain: [/PORTS_RESOLVE_TIMEOUT_MS = 30(?:000|_000)/, /READY_TIMEOUT_MS = 30(?:000|_000)/],
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
			{
				// 2026-08-28 (prime v0.8.1): forked-kernel liveness moved onto the
				// forkserver kill/alive protocol (forkedKernelDead / checkForkedKernelDeath);
				// the pid-poll probe (#13f isPidAlive) is retired with it. Windows never
				// runs the forkserver, so the Windows EPERM concern is structurally gone.
				label: "#13f forked-liveness via the forkserver protocol (supersedes isPidAlive poll)",
				mustContain: [/checkForkedKernelDeath/, /forkedKernelDead/],
				mustNotContain: [/process\.kill\([^)]*,\s*0\s*\)/],
			},
			{
				label: "#14 kernel env built by the shared kernel-env module",
				mustContain: [/import\s*\{[^}]*buildKernelEnv[^}]*\}\s*from\s*["']\.\.\/\.\.\/kernel-env\.ts["']/],
			},
			{
				label: "#18 kernelStderr buffer bounded (T7.9)",
				mustContain: [/MAX_KERNEL_STDERR/, /appendKernelStderr/],
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
				label: "#12 retired: llm-verifier must NOT be in default extra packages",
				mustNotContain: [/uvArg:\s*"llm-verifier"/],
			},
			{
				label: "#13d processIsRunning delegates to isPidAlive",
				mustContain: [/\[local patch #13d\]/, /return isPidAlive\(pid\)/, /import\s*\{[^}]*isPidAlive[^}]*\}\s*from\s*["']\.\.\/\.\.\/util\/platform\.ts["']/],
			},
			{
				label: "#13e PATHEXT-aware executable lookup",
				mustContain: [/\[local patch #13e\]/, /PATHEXT/],
			},
			{
				label: "#14 boot helper children get a credential-scrubbed env",
				mustContain: [/\[local patch #14\]/, /env: buildScrubbedEnv\(\)/],
			},
			{
				label: "#15 per-platform uv installer (no sh on Windows)",
				mustContain: [/\[local patch #15\]/, /install\.ps1/, /uvInstallSpec\(\)/],
				mustNotContain: [/run\(\s*"sh"/],
			},
			{
				label: "#16 batch-file spawn routing (PATHEXT .bat/.cmd shims)",
				mustContain: [/\[local patch #16\]/, /windowsBatchSpawnSpec\(/, /windowsVerbatimArguments/],
			},
			{
				label: "#18 hung installer child bounded (run() timeout, T7.9)",
				mustContain: [/DEFAULT_RUN_TIMEOUT_MS/, /timed out after/, /child\.kill\(\)/],
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
				// 2026-08-28 (prime v0.8.1): forked-child kill goes through the forkserver
				// kill protocol (fork-id keyed); killSignalSafe now covers the warm
				// template proc's SIGTERM on the teardown path.
				label: "#13a killSignalSafe imported and used for the template-proc kill",
				mustContain: [/import\s*\{[^}]*killSignalSafe[^}]*\}\s*from\s*["']\.\.\/\.\.\/util\/platform\.ts["']/, /killSignalSafe\(proc\.pid/],
			},
			{
				label: "#13a no direct POSIX signal kill",
				mustNotContain: [/process\.kill\([^)]*,\s*"(?:SIGTERM|SIGKILL|SIGINT)"\)/],
			},
			{
				label: "#13b junction-safe dir removal",
				mustNotContain: [/rmSync\([^)]*recursive:\s*true/],
			},
			{
				label: "#14 forkserver template launched with a scrubbed env",
				mustContain: [/\[local patch #14\]/, /launchEnv = buildKernelEnv\(\)/],
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
