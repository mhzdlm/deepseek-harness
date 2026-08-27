# Agent Note: RLM plugin deployment to other DeepSeek Harness instances

Status: implemented

## Problem

The RLM (recursive language model) plugin family — `plugin-rlm-kernel`, `plugin-rlm-verifier`, `plugin-rlm-moa`, `plugin-rlm-loop`, `plugin-continual-harness` (host) and `ui-rlm` (client) — is developed under `packages/rlm/` and `packages/client/ui-rlm/` of the `deepseek-harness` repo, but reaches a running DeepSeek Harness Desktop through a separate install path. Two recurring failure modes obscured whether it was actually installed:

- Checking from the wrong scope returns "not installed" even when the `rlm 融合模式` preset is mounted: `rlm.kernels` and the rlm tools are agent-plane scoped (the rlm preset declares `isolate: { rlm.kernels: true }`), so a host-wide `Service`/`Event` catalog and the current session's `Tool.listTools` miss them unless the querying session uses the rlm preset.
- Installing by copying built `lib/` into the desktop `node_modules` (the procedure in `docs/cookbook/sync-plugin-runtime-mode-to-desktop.md`) causes a transient blank page on restart and does not survive a desktop update; for the client package `ui-rlm` it never takes effect, because the browser loads the bundled `lib/client.js`, not per-package `lib/`.

## Decision

Deploy RLM through the desktop's pnpm **profile** mechanism, splitting host and client packages by where the runtime resolves them:

- **Host packages** (`plugin-rlm-{kernel,verifier,moa,loop}` and `plugin-continual-harness`) install into a dedicated profile, for example `<dsh-home>/profiles/rlm/`, listed as `file:` tarballs in `profiles/rlm/package.json` and resolved into `profiles/rlm/node_modules/`. Host code reloads from `node_modules` on process restart, so no web rebuild is needed.
- **Client package `ui-rlm`** installs into the **web profile** (`profiles/web`): add `@deepseek-ai/dsh-client-rlm` to `profiles/web/package.json` and a `dsh.client` row to `profiles/web/cordis.patch.yml`, then **rebuild the `dsh-web-app` bundle** (rolldown) and refresh. Copying `ui-rlm/lib/` into `node_modules` alone never reaches the browser.
- The agent preset [`docs/recipes/agent-presets/rlm/agent.cordis.yml`](../../../../docs/recipes/agent-presets/rlm/agent.cordis.yml) groups the host plugins under one agent-plane realm with `isolate: { rlm.kernels: true }`; that realm isolation is required, or the preset mount audit rejects it.
- The package inventory, host/client split, and step-by-step procedure are captured in [`docs/cookbook/rlm-plugin-install.md`](../../../../docs/cookbook/rlm-plugin-install.md); the lib-copy variant stays documented in [`docs/cookbook/sync-plugin-runtime-mode-to-desktop.md`](../../../../docs/cookbook/sync-plugin-runtime-mode-to-desktop.md) as a non-durable, host-only path. The lib-copy deploy script's design is recorded in [2026-08-25-rlm-deploy-sync-and-audit-generalization.md](2026-08-25-rlm-deploy-sync-and-audit-generalization.md) and the general profile mechanism in [2026-08-05-profile-plugin-bundles.md](2026-08-05-profile-plugin-bundles.md); both stay active as the transient-path and mechanism backings respectively.

## Consequences

- A session selects RLM by mounting the `rlm 融合模式` preset; only that session's scope exposes `ipython`/`verify`/`moa`/`loop` and the `rlm.kernels` service.
- Verify a live mount from a session that uses the rlm preset via `cordis_inspect_query` (`Tool.listTools`, `Service.listService`, `Event.listEvents`) — host-wide queries miss agent-plane plugins.
- The `ui-rlm` degradation-warning cards appear only after the web bundle is rebuilt and the page refreshed.
- lib-copy installs are not durable: a desktop update refreshes `dependencies/dsh` and removes manually copied `node_modules` entries, so profile installs are the only persistent route.

## Alternatives considered

- **lib-copy sync into `node_modules`** (the `sync-plugin-runtime-mode-to-desktop` method): retained only as a documented transient, host-only path. Rejected as the default because it is non-durable (wiped by desktop updates) and ineffective for client packages (the browser uses the bundle, not per-package `lib/`).
- **Installing `ui-rlm` into the rlm profile**: rejected because client plugins compile into the web-app bundle; the rlm profile never participates in the browser build, so `ui-rlm` there would load nothing.
