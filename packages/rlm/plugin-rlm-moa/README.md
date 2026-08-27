# @deepseek-ai/dsh-plugin-rlm-moa

English | [中文](README.zh.md)

Mixture-of-Agents (MOA) synthesis for the rlm family. It fans a problem and a draft answer out to several reference models, aggregates their proposals with a synthesizer model, and returns the fused answer with provenance over which references contributed.

## Config

| Config | Type | Default | Description |
|---|---|---|---|
| `dataDir` | string | `~/.dsh/rlm` | Harness base dir for landing run artifacts; must match the other rlm plugins' `dataDir`. |

## Tool: `moa`

`moa` takes a `problem` and a `draft`, calls the configured reference models in parallel, and asks the synthesizer to fuse their answers into the final result with a per-reference contribution summary.

## Model Experience

### Synthesis result

#### What the model sees

The draft and problem reach the reference and synthesizer models through the kernel's `SubagentRuntime`; the tool adds no model-facing guidance beyond the MOA prompt assembled by the plugin.

#### Token effect

One `moa` call adds the reference fan-out prompts plus the synthesizer prompt and the fused result text to the turn; cost scales with reference-model count.

#### KV Cache effect

Stateless in the request path: each reference and synthesizer call is a fresh subagent invocation, so the plugin never edits earlier request tokens.

## Known Limitations and Deferred Work

- Reference aggregation trusts the synthesizer to report provenance; a reference that fails is named in the result text but does not block synthesis.
- Real-runtime mounting awaits the same dependency-closure fix as the other rlm plugins (`apps/cli` does not depend on rlm packages); until then the tool reaches sessions via explicit `ctx.plugin()` mounting or vitest-toolchain compositions.
