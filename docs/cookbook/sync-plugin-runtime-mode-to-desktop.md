# Sync the plugin runtime mode into a running DeepSeek Harness Desktop

English | [中文](sync-plugin-runtime-mode-to-desktop.zh.md)

How to push the dynamic Cordis plugin system — `dsh-cordis-host-runner`, `dsh-cordis-client-runner`, `dsh-host-plugin-inventory`, `dsh-client-ui-cordis`, `dsh-client-ui-rlm`, `dsh-tool-cordis` — and its supporting packages (`dsh-client-runtime`, `dsh-session`, `dsh-llm`, `dsh-llm-pi-ai`, `dsh-web-app`) plus the RLM family from the source working tree into a running DeepSeek Harness Desktop install.

The desktop loads code from a built install package. On Windows the install lives at `%APPDATA%\io.github.hairyf.deepseek-harness-desktop\dependencies\dsh`; its `node_modules\@deepseek-ai\*` are compiled `lib/` outputs. The sync copies freshly built `lib/` into that tree as an update to a previous install.

## Prerequisites

- The source working tree compiles: run `pnpm run build:lib` and confirm exit 0.
- Identify the desktop install root (the directory that contains `node_modules\@deepseek-ai`). Refer to it as `<desktop-install>` below.
- A timestamped backup of the packages you will overwrite is recoverable.

## Steps

1. Build the workspace.
   `pnpm run build:lib`
   This compiles the host and client faces into each package's `lib/`, `lib/types/`, and `lib/client.js`.

2. Back up the install packages you will touch.
   Copy each target `@deepseek-ai/<pkg>` directory out of `<desktop-install>/node_modules/@deepseek-ai` into a timestamped sibling so any mistake is restorable.

3. Sync the RLM family.
   `pnpm exec tsx scripts/sync-rlm-deployment.mts --deploy-root <desktop-install> --skip-build`
   The script copies the five packages, ensures runtime deps, and verifies each deployed package has its entry and no extensionless relative import. See `scripts/sync-rlm-deployment.mts` (documented in the RLM sync architecture note).

4. Sync the remaining packages.
   For each remaining package, copy the built package directory — excluding `node_modules` — into `<desktop-install>/node_modules/@deepseek-ai/<dsh-pkg-name>`. Use Node `fs.cpSync` (not PowerShell `Copy-Item`, which descends into nested `node_modules` symlinks and overflows the path):
   ```js
   import { basename } from 'node:path'
   import { cpSync, rmSync } from 'node:fs'
   rmSync(to, { recursive: true, force: true })
   cpSync(fromPkgDir, to, { recursive: true, filter: (s) => basename(s) !== 'node_modules' })
   ```
   The target directory name is the full `@deepseek-ai/dsh-<name>` (for example `dsh-cordis-host-runner`), never the source path basename (which omits the `dsh-` prefix).

5. Re-apply the `DSH_PKG_ALLOW_LAN` guard.
   The guard in `dsh-web-app/lib/startup.js` is a local patch on the install and is absent from source, so step 4 overwrites it. After copying, restore the host check:
   ```js
   const allowLan = process.env.DSH_PKG_ALLOW_LAN === "1";
   if (options.host === "0.0.0.0" && !allowLan) program.error("error: --host 0.0.0.0 is blocked for safety: it would expose remote code execution to the network; set DSH_PKG_ALLOW_LAN=1 to opt in");
   ```
   The install root keeps the original patch file (`dsh-web-app@<version>.patch`) as the source of truth.

6. Verify the deployed output.
   For every synced package, confirm its `package.json#main` file exists under `lib/`, and that no literal extensionless `.js`/`.ts` relative import remains. The `sync-rlm-deployment` script covers the RLM packages; replicate the check for the rest.

7. Restart the desktop.
   Node caches required modules, so the running process keeps old code until it restarts. A briefly blank page on restart is expected.

## Verification

- `pnpm exec tsx scripts/sync-rlm-deployment.mts --deploy-root <desktop-install> --skip-build` prints `ok` for each RLM package and exits 0.
- Each non-RLM package's `lib/<main>` file exists and loads under plain Node.
- `dsh-web-app/lib/startup.js` contains the `DSH_PKG_ALLOW_LAN` guard.

## Pitfalls

- **PowerShell recursion into `node_modules`.** `Copy-Item -Recurse` with `-Exclude node_modules` still descends; source packages carry nested pnpm symlinks that form an unbounded path. Use Node `fs.cpSync` with `filter: (s) => basename(s) !== 'node_modules'`.
- **Wrong target directory name.** The install expects `@deepseek-ai/dsh-<name>`; the source path basename lacks the `dsh-` prefix. Copying to the basename creates dead directories and leaves the real package stale. Map to the full `dsh-*` name.
- **`DSH_PKG_ALLOW_LAN` is install-local.** It lives only in the installed `dsh-web-app/lib/startup.js` as a patch; source `lib/startup.js` does not carry it. Re-apply after every `dsh-web-app` copy.
- **`.css` imports are a false positive.** `lib/types/client/*.js` files import `./X.module.css`; the extensionless-import check flags them, but these are the unbundled client modules. The runtime loads the bundled `lib/client.js` (produced by rolldown), which has resolved the css — confirm the bundle contains no literal `from './X.module.css'`. A successful `pnpm run build:lib` already proves rolldown resolved them.
- **Restart required.** The running process serves old code until restarted; a transient blank page on restart is the expected reload, not a crash.
