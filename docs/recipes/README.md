# rlm preset assembly

English | [中文](README.zh.md)

<!-- This document explains the purpose of the `agent-presets/rlm/` composition, why it is not in the shipped roster, and the available assembly paths. -->

`agent-presets/rlm/` is the Cordis composition for the RLM fusion mode (`preset.yml` + `agent.cordis.yml`). It stays out of `apps/cli/config/agent-presets/`: a real `dsh` runtime cannot resolve the four `@deepseek-ai/dsh-plugin-rlm-*` packages from a profile directory — the CLI dependency closure does not contain them and tsconfig-paths aliases work only in the vitest toolchain, so a shipped-config entry would be selectable in the roster but fail to assemble when picked.

## Assembly paths

1. Explicit mount: mount the four plugins with `ctx.plugin()` in one host, keeping their `dataDir` config aligned.
2. Reference this composition: build a preset from the plugin rows in `agent.cordis.yml`; resolution requires the four packages to be visible to the loader (a workspace source tree or an installed profile).

The four plugin npm packages list `src/**/*` and a vendored Python runtime in `files`, so the published form resolves like the source tree. `packages/rlm/plugin-rlm-verifier/tests/rlm-preset.spec.ts` uses this directory as the AgentPresets root and verifies roster discovery and tool registration in the vitest toolchain.

Beyond the four rlm plugins, `agent.cordis.yml` mounts the host-plane `compaction` (automatic summarization, isolate realm), `goal` (persistent goals), and `schedule` (timed re-entry) capabilities. These support automatic context compression and non-blocking long tasks across long sessions, aligning with Prime Agent's non-blocking long-task surface (compaction + schedule + persistent goals).