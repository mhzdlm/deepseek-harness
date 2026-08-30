# @deepseek-ai/dsh-plugin-rlm-moa

English | [中文](README.zh.md)

Mixture-of-Agents (MOA) synthesis for the rlm family. It fans a problem (plus optional context and candidate answers) out to several reference model slots, aggregates their advice with a synthesizer slot, and returns the fused answer with per-reference provenance.

> Phase 8 (2026-08-31): this README previously documented a single `dataDir`
> config key, a `problem`+`draft` tool signature, and a `SubagentRuntime` call
> path — all stale. It now mirrors `src/index.ts` / `src/moa-tool.ts` exactly.

## Config

| Config | Type | Default | Description |
|---|---|---|---|
| `dataDir` | string | `~/.dsh/rlm` | Root for traces and the managed preset store; must match the other rlm plugins' `dataDir`. |
| `presets` | record | built-in `default` | Named panels: `referenceModels[]` + `aggregator`. Preset-level knobs: `referenceMaxTokens` (4096), `referenceTimeoutMs` (120000), `aggregatorTimeoutMs` (300000, T7.3), `degradedPolicy` (`loud`), per-slot `mode`. |
| `defaultPreset` | string | first / `default` | Preset id used when a call does not name one. |
| `privacyFilter` | string | `''` | `''` off; `'display'` annotates provenance in the rendered result; `'full'` masks credential/PII material in advisor text before it reaches the aggregator and the trace. |
| `trace` | boolean | `true` | Write JSONL traces under `<dataDir>/moa-traces/`. |
| `subagentProvider` | string | `'spawn'` | Subagent provider for `mode:'subagent'` reference slots without their own `provider`. |
| `maxChildChars` | number | `20000` | Char cap on text captured from `subagent`-slot children. |

## Tool: `moa`

Arguments: `problem` (required), `context` (optional shared background),
`candidates` (optional draft answers placed before the references as extra
input), `preset` (optional named panel). Reference slots that answer via a
plain completion run through the host LLM seam (`ctx.llm.stream` — not the
kernel's SubagentRuntime); only `mode:'subagent'` slots spawn tool-capable
children. Per-reference failures fold into a `failed` status so the panel can
continue; a caller cancellation (session disposal) propagates instead of
masquerading as reference failures. When every reference fails, the tool
fails loud without calling the aggregator.

## Model Experience

### Synthesis result

#### What the model sees

The problem/context/candidates reach the reference and synthesizer slots as
assembled prompts on the host LLM seam; the tool adds no model-facing guidance
beyond the MOA prompt the plugin assembles. Each reference's advice is
delivered to the aggregator as a labelled block with provenance.

#### Token effect

One `moa` call adds the reference fan-out prompts plus the synthesizer prompt
and the fused result text to the turn; cost scales with reference count
(N+1 round trips), each reference bounded by `referenceMaxTokens` and
`referenceTimeoutMs`, the aggregator by `aggregatorTimeoutMs`.

#### KV Cache effect

Stateless in the request path: each reference and synthesizer call is a fresh
host-side LLM request, so the plugin never edits earlier request tokens.

## Known Limitations and Deferred Work

- Reference aggregation trusts the synthesizer to report provenance; a
  reference that fails is named in the result text but does not block
  synthesis.
- Reference slots never see the harness or tools (except `mode:'subagent'`
  children, which do run with tools).
- Preset-level `aggregatorTimeoutMs` is honored at runtime and declared in the
  Config schema (Phase 8), but is not yet exposed through the managed
  `/moa` store commands.
