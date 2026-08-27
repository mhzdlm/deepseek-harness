# Install the RLM plugin family into another DeepSeek Harness

English | [中文](rlm-plugin-install.zh.md)

The RLM (recursive language model) family is a set of Cordis plugins that give an agent a persistent IPython kernel plus LLM-as-a-Verifier judging, Mixture-of-Agents fusion, audited loop recording, and durable self-editing. This guide lists the packages, explains how they cooperate, and shows how to install them into a different DeepSeek Harness Desktop or runtime.

## Package inventory

All host packages live under `packages/rlm/`; the client package lives under `packages/client/`.

| Package | Kind | Provides | Key events / services |
|---|---|---|---|
| `plugin-rlm-kernel` | host | `ipython` tool (persistent kernel), `rlm.run` recursive subagents, `create_python_skill`; service `rlm.kernels` (per-session kernel registry) | `session/kernel-snapshot` |
| `plugin-rlm-verifier` | host | `verify` tool (probabilistic pivot tournament over candidate trajectories) | `session/verify-result` (carries `failedJudges`) |
| `plugin-rlm-moa` | host | `moa` tool (reference-slot fusion) + `/moa` command | `session/moa-reference` |
| `plugin-rlm-loop` | host | `loop` tool (Manage→Execute→Audit recording; audit-header parse + trust gate) | `session/loop-start`, `session/loop-round-done` |
| `plugin-continual-harness` | host | harness overview injection; `/refine` + `/refine-rollback`; `/harness`; CAS write path | harness state file |
| `ui-rlm` (`packages/client/ui-rlm`) | client | `tool.call.toolview` rows for `verify`/`moa` showing degradation warnings | — |

`plugin-rlm-verifier` consumes `rlm.kernels` to run candidate code in the same persistent kernel; `plugin-rlm-loop` and `plugin-rlm-kernel` land durable state through `plugin-continual-harness`'s CAS pipeline.

## How they cooperate

The agent preset [`docs/recipes/agent-presets/rlm/agent.cordis.yml`](../recipes/agent-presets/rlm/agent.cordis.yml) assembles `plugin-rlm-kernel`, `plugin-rlm-verifier`, `plugin-continual-harness`, and `plugin-rlm-moa` into one agent-plane group with `isolate: { rlm.kernels: true }`, so the kernel registry lives in a realm-private symbol rather than the process-global root.

- `plugin-rlm-kernel` is the compute and state base.
- `plugin-rlm-verifier` and `plugin-rlm-moa` judge and fuse candidate solutions (through the LLM seam and subagents; verifier also through `rlm.kernels`).
- `plugin-rlm-loop` records audited rounds and lands verified progress into `plugin-continual-harness`.
- `plugin-continual-harness` injects durable memory/skills into the system prompt and supports reversible self-edits via `/refine`.
- `ui-rlm` visualizes verifier/moa degradation in the browser.

The persistent spine is `plugin-continual-harness` state (re-injected into the prompt) plus `session-artifacts/<sessionId>/` files plus log-only session events.

## Install into another environment

There are two install mechanisms. The **host/client split decides where each package goes**.

### Host packages: durable install via a pnpm profile

A DeepSeek Harness Desktop stores installed packages per **profile**. Create or extend a profile that lists the host rlm packages:

- Profile directory: `<dsh-home>/profiles/rlm/`
- `profiles/rlm/package.json` lists `@deepseek-ai/dsh-plugin-rlm-{kernel,loop,moa,verifier}` (plus `plugin-continual-harness` if the mode needs `/refine`) as `file:` tarballs, e.g. `file:<dsh-home>/rlm-pkgs/deepseek-ai-dsh-plugin-rlm-kernel-0.1.1-rc.2.tgz`.
- Run the profile install so `profiles/rlm/node_modules/@deepseek-ai/dsh-plugin-rlm-*/lib/` is populated.

The desktop then exposes the mode (for example "rlm 融合模式") in its agent-preset selector. Host packages reload from `node_modules` on process restart, so no web rebuild is needed for them.

### Client package `ui-rlm`: must go in the web profile + rebuild the bundle

`ui-rlm` is a **client** plugin. The browser does not load per-package `lib/`; it loads the single bundled `lib/client.js` that `dsh-web-app` produces with rolldown. Therefore `ui-rlm` must be installed into the **web profile**, not the rlm profile:

1. Add `@deepseek-ai/dsh-client-rlm` to `profiles/web/package.json` (as a versioned dependency or a `link:` to a local build).
2. Register it in `profiles/web/cordis.patch.yml` with a `dsh.client` row (the existing file already mounts `win-terminal-inspector`; add `ui-rlm` the same way).
3. **Rebuild the `dsh-web-app` bundle** so rolldown folds `ui-rlm` into `lib/client.js`.
4. Refresh the page.

Skipping the rebuild leaves the degradation-warning rows absent even though the package is "installed."

### Lib-copy sync (transient; not durable)

The [`sync-plugin-runtime-mode-to-desktop`](sync-plugin-runtime-mode-to-desktop.md) cookbook describes copying freshly built `lib/` into `<desktop-install>/node_modules/@deepseek-ai/<dsh-pkg>` (via `scripts/sync-rlm-deployment.mts` and `fs.cpSync`). This works for **host** packages but not for **client** packages, because the browser loads the web-app bundle, not per-package `lib/`. Overwriting `node_modules` while the desktop runs also causes a **transient blank page on restart** — the old process served cached modules until it restarted and reloaded the updated code. That blank page is the expected reload, not a crash.

A desktop **update** refreshes `dependencies/dsh` and removes manually copied `node_modules` entries; only profile installs survive an update. Use the profile mechanism above for anything that must persist.

## Verification

- Host packages: query the running host with `cordis_inspect_query` for `Tool.listTools` (expect `ipython`, `verify`, `moa`, `loop`), `Service.listService` (expect `rlm.kernels`), and `Event.listEvents` (expect `session/verify-result`, `session/loop-start`, …). These are agent-plane scoped, so query from a session that uses the rlm preset, not a different mode.
- Client package: after the web rebuild and refresh, open a `verify` or `moa` tool card; it should show a degradation-warning row when a judge/reference fails.

## Pitfalls

- **Host vs client destination.** Host rlm packages → rlm profile; `ui-rlm` → web profile. Putting `ui-rlm` in the rlm profile does nothing.
- **Client packages need a web rebuild.** Copying `ui-rlm/lib/` into `node_modules` never reaches the browser bundle.
- **`rlm.kernels` is realm-isolated.** The rlm preset must declare `isolate: { rlm.kernels: true }`; mounting the plugins without that realm fails the preset audit.
- **Lib-copy is not durable.** A desktop update wipes manual `node_modules` copies; prefer profile installs.
- **Blank page on restart is expected** for the lib-copy method; it is the reload, not a crash.
