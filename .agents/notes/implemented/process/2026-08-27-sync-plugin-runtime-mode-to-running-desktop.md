# Agent Note: Sync the plugin runtime mode into the running DeepSeek Harness Desktop

Status: implemented

## Problem

The "plugin runtime mode" — the dynamic Cordis plugin system (`@deepseek-ai/dsh-cordis-host-runner`, `dsh-cordis-client-runner`, `dsh-host-plugin-inventory`, `dsh-client-ui-cordis`, `dsh-client-ui-rlm`, `dsh-tool-cordis`) plus its supporting packages (`dsh-client-runtime`, `dsh-session`, `dsh-llm`, `dsh-llm-pi-ai`, `dsh-web-app`) and the RLM family — lives as uncommitted source in the repo working tree. The running DeepSeek Harness Desktop loads its code from a built install package at `%APPDATA%\io.github.hairyf.deepseek-harness-desktop\dependencies\dsh`, whose `node_modules\@deepseek-ai\*` are compiled `lib/` outputs. After changing the source, the new code must be pushed into that install as an update to a previous install, without breaking the live deployment.

## Decision

The install copy is an incremental, per-package sync of compiled output — not a full redeploy.

1. **Build first.** `pnpm run build:lib` compiles the host and client faces into each package's `lib/` (and `lib/types/`, `lib/client.js`). Uncommitted source must compile before it can be installed; a failed build gates the whole step.
2. **Back up what you will touch.** Copy the target `@deepseek-ai/<pkg>` directories out of the install into a timestamped sibling (e.g. `dsh-backup-<YYYYMMDD-HHmmss>`) so any mistake is restorable.
3. **Sync the RLM family** with the established script: `pnpm exec tsx scripts/sync-rlm-deployment.mts --deploy-root <desktop-install> --skip-build`. It copies the five packages via `cpSync` with a node_modules filter, ensures runtime deps, and verifies each deployed package has its entry and no extensionless relative import. (See [the RLM sync architecture note](../architecture/2026-08-25-rlm-deploy-sync-and-audit-generalization.md) for why this script exists and the vendor audit rule it pairs with.)
4. **Sync the remaining packages** (cordis/platform + `dsh-client-runtime`, `dsh-session`, `dsh-llm`, `dsh-llm-pi-ai`, `dsh-web-app`) by copying each built package directory — excluding `node_modules` — into `<deploy>/node_modules/@deepseek-ai/<dsh-pkg-name>`. Use **Node `fs.cpSync`**, not PowerShell:
   ```js
   import { cpSync, rmSync } from 'node:fs'
   rmSync(to, { recursive: true, force: true })
   cpSync(fromPkgDir, to, { recursive: true, filter: (s) => basename(s) !== 'node_modules' })
   ```
   The target directory name is the **full `@deepseek-ai/dsh-<name>`** (e.g. `dsh-cordis-host-runner`), never the source path basename (which lacks the `dsh-` prefix).
5. **Re-apply the `DSH_PKG_ALLOW_LAN` guard** to `dsh-web-app/lib/startup.js`. The guard is a local patch on the install, not in source, so step 4 overwrites it with the unguarded source build. After copying, edit the host-check block back in:
   ```js
   const allowLan = process.env.DSH_PKG_ALLOW_LAN === "1";
   if (options.host === "0.0.0.0" && !allowLan) program.error("error: --host 0.0.0.0 is blocked for safety: it would expose remote code execution to the network; set DSH_PKG_ALLOW_LAN=1 to opt in");
   ```
6. **Verify** each synced package: its `package.json#main` file exists under `lib/`, and no literal extensionless `.js`/`.ts` relative import is present (the `sync-rlm-deployment` check covers the RLM packages; replicate it for the rest).
7. **Restart the desktop.** Node caches `require`d modules; the running process keeps old code until it restarts. A briefly blank page on restart is expected and normal.

## Alternatives considered

- **PowerShell `Copy-Item -Recurse` (with `-Exclude node_modules`).** Rejected: `-Exclude` does not stop recursion from descending into `node_modules`, and source packages carry nested pnpm symlinks (`cordis/node_modules/cordis-plugin-include/node_modules/cordis/...`) that form an effectively infinite path. The copy dies with "系统无法辨识文件名" / a `MAX_PATH` overflow. Node `cpSync` with a `basename !== 'node_modules'` filter is the only reliable copy.
- **`robocopy /XD node_modules`.** Rejected for the same symlink exposure and because it is less reproducible than a one-command script.
- **Full `pnpm deploy` rebuild of the whole install.** Rejected: it regenerates the entire deployment, discards local install-only patches (the `DSH_PKG_ALLOW_LAN` guard), and is far heavier than an incremental package copy for a routine update.

## Consequences

- **Benefit:** a fast, incremental update of a live install without a full redeploy, and local install-only patches survive (when re-applied) rather than being wiped.
- **Cost:** the sync is manual per package; the `DSH_PKG_ALLOW_LAN` guard must be remembered and re-applied after every `dsh-web-app` copy; the desktop must be restarted for changes to take effect.
- **Pitfalls (observed, each reproduced):** see below. The wrong-directory-name trap shipped dead `@deepseek-ai/cordis-host-runner` directories into the install while leaving the real `dsh-cordis-host-runner` stale — it was caught by an integrity re-check and rolled back from backup before any restart.

## Pitfalls

- **PowerShell recursion into `node_modules`.** `Copy-Item -Recurse` with `-Exclude node_modules` still descends; source packages have nested pnpm symlinks producing unbounded paths. Use Node `fs.cpSync` with `filter: (s) => basename(s) !== 'node_modules'`.
- **Wrong target directory name.** The install expects `@deepseek-ai/dsh-<name>`; the source path basename (`cordis-host-runner`, `client-runtime`, `web-app`, …) is missing the `dsh-` prefix. Copying to the basename creates dead wrong-named directories and leaves the real package untouched. Always map to the full `dsh-*` name.
- **`DSH_PKG_ALLOW_LAN` is install-local.** It lives only in the installed `dsh-web-app/lib/startup.js` as a patch (`dsh-web-app@*.patch` in the install root); source `lib/startup.js` does not carry it. Re-apply after every `dsh-web-app` copy.
- **`.css` imports are a false positive.** `lib/types/client/*.js` files import `./X.module.css`; the extensionless-import check flags them, but these are the *unbundled* client modules. The runtime loads the bundled `lib/client.js` (produced by rolldown), which has resolved/handled the css — confirm the bundle contains no literal `from './X.module.css'`. A successful `pnpm run build:lib` already proves rolldown resolved them.
- **Restart required.** The running process serves old code until restarted; a transient blank page on restart is the expected reload, not a crash.

## Related

- [rlm deployment sync tooling and generalized vendor import audit](../architecture/2026-08-25-rlm-deploy-sync-and-audit-generalization.md) — the `sync-rlm-deployment.mts` design and the `noExtensionlessRelativeImports` vendor audit rule that pairs with step 3 above.
- The install's `DSH_PKG_ALLOW_LAN` guard is recorded as a patch file at the install root (`dsh-web-app@*.patch`); treat it as the source of truth for the startup.js edit in step 5.
