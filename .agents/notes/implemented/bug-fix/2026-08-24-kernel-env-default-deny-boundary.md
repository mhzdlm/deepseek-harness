# Agent Note: Kernel processes get one default-deny environment boundary

Status: implemented

English | [中文](2026-08-24-kernel-env-default-deny-boundary.zh.md)

## Problem

The RLM kernel spawns helper children from three places — the direct `spawn()` in `vendor/kernel/index.ts`, the forkserver template process in `fork-server.ts`, and the bootstrap helpers in `bootstrap.ts`. Only the first place filtered its environment; the forkserver template passed the host environment through unchanged, so the kernel child inherited every credential-bearing variable (the fork child merges via `os.environ.update`, which only adds entries), and bootstrap children that must run installers received credentials they never needed. On Windows this also silently dropped variables the whitelist was meant to keep: real key names are mixed-case (`Path`, `SystemRoot`, `windir`), and case-sensitive matching discarded them all — a missing `SystemRoot` is the classic Windows child-process failure.

## Decision

A single module, `packages/rlm/plugin-rlm-kernel/src/kernel-env.ts`, owns both environment constructions:

- `buildKernelEnv(overrides?, platform?, source?)` — default-deny allowlist for kernel processes. Used by the direct spawn and the forkserver template. Credential-shaped prefixes (`DSH_`, `DEEPSEEK_`, `OPENAI_`, `ANTHROPIC_`, `GOOGLE_`, `AZURE_`, `AWS_`, `PRIME_`, `PI_`, `CODEBUDDY_`, `CLAUDE_`) are blocked before any allowlist check; runtime-required names (`RLM_*`, `PATH`, `HOME`, `USERPROFILE`, `SYSTEMROOT`, `SYSTEMDRIVE`, `TMP`, `TEMP`, locale, `PYTHON*`, `UV_*`, `npm_config_*`) pass. On `win32`, matching folds name casing while the output keeps each source key's original casing; on POSIX, matching is exact-case and byte-identical to the pre-existing inline implementation.
- `buildScrubbedEnv(platform?, source?)` — deny-only credential strip for helper children that legitimately need a broad environment (uv installer, bootstrap shell steps). Proxy, XDG, and locale settings survive; only secret-bearing namespaces are removed.

`overrides` are merged without re-screening; callers pass internal `RLM_*` wiring only. The blocklist is exported as the canonical `CREDENTIAL_BLOCKLIST_PREFIXES`; `plugin-rlm-verifier`'s subprocess scrub imports it instead of keeping its own copy. The `platform` and `source` parameters make both case regimes testable deterministically on any host (`tests/kernel-env.spec.ts`, 10 items, injected source, no live `process.env` mutation). `scripts/audit-vendor.mts` gained the #14 checks plus a full-environment passthrough ban (`...process.env` / `env: process.env` are forbidden in every vendored kernel file; 39 total).

## Alternatives considered

**Patch each call site with its own filter.** Rejected: three independent filters drift apart exactly the way this bug formed — two of the three sites had already drifted. One module gives one boundary to audit.

**Filter inside the forked kernel child.** Rejected: `os.environ.update` only adds entries, so a child-side filter cannot remove what the template already carried; the template process is the only choke point.

**Deny-list scrub everywhere instead of an allowlist.** Rejected for kernel processes: a deny-list requires enumerating every provider prefix forever, and an unknown credential namespace passes by default. The allowlist inverts that default; the deny-list remains only where breadth is required (installers).

**Empty or near-empty environment for all children.** Rejected: `PATH` lookup, locale, and Windows `SystemRoot`-dependent subprocesses break; the failure mode moves from credential exposure to non-functional kernels.

## Consequences

Kernel children no longer see provider credentials through any of the three spawn paths, and Windows keeps the runtime variables it previously lost. The cost is a maintained allowlist: a kernel feature needing a new variable requires a deliberate edit here rather than inheriting whatever the host has. The fork-server path runs only on Linux and this repository's development host is Windows, so that path is verified by tsc, unit tests, and the audit gate but not by a live Linux fork run. Env filtering narrows the credential surface only — the model can still write arbitrary Python with network access; this is not a sandbox.

## Testing

- `tests/kernel-env.spec.ts`: 10 items covering both platforms' blocking, allowlisting, casing, overrides, and scrubbing semantics via injected sources.
- `tests/kernel-env-runtime.spec.ts`: one end-to-end item — a credential planted on the host never appears inside a live kernel child (self-skips without the kernel venv).
- `scripts/audit-vendor.mts` #14 checks (shared-module import in `index.ts`, scrubbed launch env in `fork-server.ts`, scrubbed bootstrap env in `bootstrap.ts`) plus the full-environment passthrough ban across all vendored files — 39 checks total.
- `pnpm exec tsc --noEmit -p packages/rlm/plugin-rlm-kernel/tsconfig.json` and the package vitest run stay green.
