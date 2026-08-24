# Agent Note: RLM plugin publish surface closes and Windows platform residues land

Status: implemented

English | [中文](2026-08-24-rlm-publish-surface-and-platform-residues.zh.md)

## Problem

The three `packages/rlm/*` plugins declared npm `files` limited to `lib/**`, while their runtime needs more: `exports["./src/*"]` promises source paths that were never shipped, `plugin-rlm-verifier` imports `@deepseek-ai/dsh-plugin-rlm-kernel/src/env.ts` and `/src/kernel-env.ts` across packages, and kernel bootstrap resolves its vendored Python runtime from `vendor/prime-agent-runtime/` at the package root. A published tarball therefore could not boot a kernel even before the separate assembly-chain gap. The rlm preset composition also sat in `apps/cli/config/agent-presets/`, where the shipped roster offered a mode that cannot mount outside the vitest toolchain.

Four smaller defects shared the batch: `forkedKernelDied()` probed liveness with a bare zero-signal kill whose EPERM result is ambiguous on Windows; `fork-server.ts` removed its socket directory with recursive `rmSync`, the exact pattern patch #13b bans elsewhere; `ensureUv()` invoked `sh -c`, which does not exist on a fresh Windows host; and `safeRmDirSync()` finished with `rmSync(path, { recursive: false })`, which rejects directories outright (`ERR_FS_EISDIR`) on every platform — the helper unlinked files but silently left empty directory skeletons behind.

## Decision

The publish surface matches what the code actually loads:

- All three packages ship `"src/**/*"` in `files`; the kernel package additionally ships `"vendor/prime-agent-runtime/**"`.
- `runtimeCandidateDirs()` covers both layouts — tsc output (`lib/types/vendor/kernel`) and source tree (`src/vendor/kernel`) — so every candidate chain terminates at `<packageRoot>/vendor/prime-agent-runtime`.
- The rlm preset composition lives in `docs/recipes/agent-presets/rlm/`; the shipped roster no longer offers it. `rlm-preset.spec.ts` mounts from that location and stays the vitest-only tier.

Windows residues close through the existing platform layer:

- `forkedKernelDied()` returns `!isPidAlive(pid)` ([local patch #13f]); the auditor forbids bare zero-signal kills in `index.ts`.
- The forkserver socket directory goes through `safeRmDirSync` ([local patch #13b] extended to `fork-server.ts`, enforced by the auditor).
- `ensureUv()` picks its installer via `uvInstallSpec()`: PowerShell `irm … install.ps1 | iex` on win32, the POSIX pipeline elsewhere ([local patch #15]; auditor bans a literal `run("sh", …)`).
- `safeRmDirSync` removes each emptied directory with `rmdirSync`, which accepts directories where `rmSync(recursive:false)` throws.

Test hygiene: `kernel-env-runtime.spec.ts` plants a `DSH_RLM_TEST_CREDENTIAL` canary instead of touching real provider key names; `cancel/warmup/idle-reclaim` gained the same venv-missing self-skip guard as the runtime spec; the kernel package `test` script runs all nine keyless specs; new `tests/platform.spec.ts` covers the four helpers (13 items) with mocked `spawnSync`/`writeFileSync` delegates and stubbed `process.platform`. `scripts/audit-vendor.mts` now enforces 42 checks.

## Alternatives considered

**Fix assembly by adding the three packages to the CLI dependency closure.** Deferred: publishing broken tarballs meanwhile widens the blast radius, and the profile-install flow is still undesigned; relocating the preset is reversible once that lands.

**Re-export `env`/`kernel-env` through the kernel package entry instead of shipping `src`.** Rejected for now: verifier's imports resolve through tsconfig paths in the source plane today, and shipping `src` keeps one resolution story for vitest, tsx, and a future installed layout.

**Ban zero-signal kills outright in the auditor.** Rejected: legitimate probes exist on POSIX paths; the check targets the Windows-ambiguous site specifically.

## Consequences

A published tarball of any of the three plugins contains everything its own code resolves at runtime, and the roster no longer advertises an unmountable mode. Windows cleanup, liveness probing, and first-run uv installation behave through one audited platform layer. Costs: `files` ships TypeScript sources (acceptable while the packages are rc-stage internal), the auditor grows to 42 checks that must track future spawn sites, and the fork-server path remains verified by tests and the audit gate only — no live Linux fork run exists in this repository.

## Testing

- `tests/platform.spec.ts`: 13 items — taskkill shape and POSIX signal passthrough (`killSignalSafe`), ESRCH/EPERM/tasklist semantics (`isPidAlive`), nested-tree removal, junction cut-with-target-intact, missing-dir no-op (`safeRmDirSync`), mode applied on POSIX and omitted on win32 (`writeFileSecureSync`). The nested-tree case exposed the `ERR_FS_EISDIR` defect.
- Kernel package suite: 9 files / 44 items green, including live-kernel `cancel`, `idle-reclaim`, `warmup`, and the canary-based runtime env item.
- Verifier suite: 16 items green, including preset discovery and tool registration from `docs/recipes/agent-presets/rlm/`. Harness: 73 checks green.
- `pnpm exec tsc --noEmit` clean for kernel and verifier; `pnpm --filter @deepseek-ai/dsh-plugin-rlm-kernel run vendor:check` reports 42/42.
