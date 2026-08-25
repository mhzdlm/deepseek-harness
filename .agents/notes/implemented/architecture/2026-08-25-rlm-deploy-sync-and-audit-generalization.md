# 2026-08-25 — rlm deployment sync tooling and generalized vendor import audit

## Context

Installing the rlm family into the desktop deployment was a multi-hour manual walk: build, copy five packages by hand (robocopy with node_modules exclusions), pull runtime dependencies from wherever they happened to exist, then discover — only through the deployed preset mount failing — that three vendored files carried extensionless relative imports (`../../util/platform`) which tsx resolves but plain Node over node_modules does not.

## Decision

- `scripts/sync-rlm-deployment.mts` (+ root `pnpm run sync:rlm -- --deploy-root <dir>`): build (skippable), copy the five packages via `cpSync` with a node_modules filter, ensure runtime deps (`zeromq`/`uuid`/`cmake-ts`/`node-addon-api`) from an optional flat `--deps-from`, and fail the run when any deployed package lacks its entry or contains an extensionless relative import.
- audit-vendor gains a fourth COMMON_FORBIDDEN rule (`noExtensionlessRelativeImports`): any physical import line whose relative specifier does not end in `.ts`. Anchored to line-start imports so commented migration examples cannot false-positive. Audit count is now 49 = 4 rules × 6 files + 25 file-level checks; the three platform-helper regexes were tightened to require the `.ts` suffix as well.

## Why

The sync script exists because the five packages intentionally declare no dsh.bundle: bundle patches are host/profile-plane layers, while these rows belong to agent presets (and `rlm.kernels` must stay behind an isolate realm). Plain dependency + junction view + user preset is the supported shape, so it deserves one-command upkeep. The audit generalization converts today's one-off fix into a structural guarantee — the next vendored helper import cannot silently reintroduce the same deployment-only failure.

## Given up

- dsh.bundle declarations for these five packages (investigated and rejected: wrong plane; see NEXT.md T0.2).
- A shared cross-platform spawn helper for pnpm: the script spawns `pnpm` with `shell: true` on win32 only (.cmd shim / EINVAL constraint, same family as vendor patch #16), fixed argv, no composed strings.

## Required verification

- `pnpm exec tsx scripts/sync-rlm-deployment.mts --deploy-root <desktop> --skip-build` → five ok lines, exit 0 on the real desktop deployment.
- `pnpm run vendor:check` → 49/49 with the new generic rule present.
