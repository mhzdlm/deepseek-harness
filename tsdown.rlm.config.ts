import { defineConfig } from 'tsdown'

function isBuildFaceClient(value: unknown): boolean {
  if (value === undefined || value === 'host') return false
  if (value === 'client') return true
  throw new Error(`tsdown: --env.DSH_BUILD_FACE must be host or client, received ${String(value)}`)
}

// The rlm-scoped face of tsdown.config.ts (docs 仓 BUILD.md Phase 0): identical
// settings, workspace narrowed to the rlm family plus the three llm packages
// carrying the logprobs seam, WITHOUT the typert plugin — the plugin's face
// analysis currently dies on an official pre-existing failure
// (packages/api/session-controller — WorkspaceId, untouched by rlm) whenever
// the session-controller closure is in scope. No rlm package declares
// Typert/Remote exports or uses decorators, so the plugin is a no-op for
// them; llm's `lib/typert.host.js` is intentionally NOT regenerated here
// (`clean: false` keeps the previous artifact) — regenerate it via the
// full-root run once the official typert failure is fixed upstream.
const RLM_WORKSPACE = [
  'packages/rlm/plugin-rlm-store',
  'packages/rlm/plugin-continual-harness',
  'packages/rlm/plugin-rlm-memory',
  'packages/rlm/plugin-rlm-loop',
  'packages/rlm/plugin-rlm-compaction',
  'packages/rlm/plugin-rlm-moa',
  'packages/rlm/plugin-rlm-verifier',
  'packages/rlm/plugin-rlm-redact',
  'packages/rlm/plugin-rlm-kernel',
  'packages/llm/llm',
  'packages/llm/llm-deepseek',
  'packages/llm/deepseek-llm-api-extensions',
]

export default defineConfig(({ env }) => {
  const client = isBuildFaceClient(env?.DSH_BUILD_FACE)
  return {
    workspace: client ? [] : RLM_WORKSPACE,
    entry: client ? '' : ['lib/types/{index,invariant,startup}.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    plugins: [],
  }
})
