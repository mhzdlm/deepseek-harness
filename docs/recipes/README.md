# rlm preset assembly

English | [中文](README.zh.md)

<!-- This document explains the purpose of the `agent-presets/rlm/` and `agent-presets/loop/` compositions, the two RLM run modes they provide, and how they now assemble under the shipped CLI. -->

There are two RLM run modes, both shipped as agent presets under this directory:

- `agent-presets/rlm/` — **MODE A (plain RLM)**: the persistent IPython kernel is the whole loop; the model drives `rlm()` recursion, `verify`, `moa`, and `/refine` directly. No Loop Engineering orchestration.
- `agent-presets/loop/` — **MODE B (Loop Engineering)**: the joining session is the Manager and runs the Manage→Execute→Audit loop under the `loop` tool's bookkeeping. The executor is the Manager calling `rlm()` inside its own persistent kernel (so state still accumulates in `user_ns`/dill exactly like MODE A); a separate read-only `auditor` child verifies real workspace evidence. See `docs/LOOP.md` for the dual-mode contract.

## Closure status (updated 2026-08-29)

The RLM plugin packages are now part of the CLI dependency closure: `@deepseek-ai/dsh-plugin-rlm-kernel`, `@deepseek-ai/dsh-plugin-rlm-verifier`, `@deepseek-ai/dsh-plugin-rlm-moa`, `@deepseek-ai/dsh-plugin-rlm-loop`, `@deepseek-ai/dsh-plugin-rlm-compaction`, and `@deepseek-ai/dsh-plugin-continual-harness` were added to `apps/cli/package.json` `dependencies`, and `pnpm install` relinks them into `apps/cli/node_modules/@deepseek-ai/`. A real `dsh` runtime can therefore resolve these presets; a roster entry for them assembles when picked. (Previously they were kept out of `apps/cli/config/agent-presets/` because the closure did not contain them and tsconfig-paths aliases only worked in the vitest toolchain.)

## Assembly paths

1. Explicit mount: mount the relevant plugins with `ctx.plugin()` in one host, keeping their `dataDir` config aligned.
2. Reference this composition: build a preset from the plugin rows in `agent.cordis.yml`; resolution requires the packages to be visible to the loader (they now are, via the CLI closure or a workspace source tree).

The plugin npm packages list `src/**/*` and a vendored Python runtime in `files`, so the published form resolves like the source tree. `packages/rlm/plugin-rlm-verifier/tests/rlm-preset.spec.ts` and `loop-preset.spec.ts` use this directory as the AgentPresets root and verify roster discovery and tool registration in the vitest toolchain.

Beyond the rlm plugins, each `agent.cordis.yml` mounts the host-plane `compaction` (automatic summarization, isolate realm), `goal` (persistent goals), and `schedule` (timed re-entry) capabilities. These support automatic context compression and non-blocking long tasks across long sessions, aligning with Prime Agent's non-blocking long-task surface (compaction + schedule + persistent goals).
