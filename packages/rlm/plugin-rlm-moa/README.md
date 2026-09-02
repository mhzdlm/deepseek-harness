# @deepseek-ai/dsh-plugin-rlm-moa

English | [中文](README.zh.md)

Mixture-of-Agents (MOA) synthesis for the rlm family. It fans a problem (plus optional context and candidate answers) out to several reference model slots, aggregates their advice with a synthesizer slot, and returns the fused answer with per-reference provenance. Phase D adds the reverse-filtering audit surface: the `rlm_audit` tool and the `/moa audit run|pending|release` subcommands, wired onto the same model seam and the `rlm.store` audit pipeline.

> Phase D (2026-09-01): mirrors `src/index.ts` / `src/moa-tool.ts` / `src/audit-tool.ts` exactly, including the `audit` config block and the `/moa` command surface.

## Config

| Config | Type | Default | Description |
|---|---|---|---|
| `dataDir` | string | `~/.dsh/rlm` | Root for traces and the managed preset store; must match the other rlm plugins' `dataDir`. |
| `presets` | record | built-in `default` | Named panels: `referenceModels[]` + `aggregator`. Preset-level knobs: `referenceMaxTokens` (4096), `referenceTimeoutMs` (120000), `aggregatorTimeoutMs` (300000, T7.3), `degradedPolicy` (`loud`), per-slot `mode`. |
| `defaultPreset` | string | first / `default` | Preset id used when a call does not name one. |
| `privacyFilter` | string | `''` | `''` off; `'display'` annotates provenance in the rendered result; `'full'` masks credential/PII material in advisor text (via `@deepseek-ai/dsh-plugin-rlm-redact`) before it reaches the aggregator and the trace. |
| `trace` | boolean | `true` | Write JSONL traces under `<dataDir>/moa-traces/`. |
| `subagentProvider` | string | `'spawn'` | Subagent provider for `mode:'subagent'` reference slots without their own `provider`. |
| `maxChildChars` | number | `20000` | Char cap on text captured from `subagent`-slot children. |
| `audit` | object | absent | Phase D audit wiring: `critic` (`provider`, `model`), `producerModel`, `timeoutMs` (120000). Absent or critic without a `model` disables `rlm_audit` with guidance. |

## Tool: `moa`

Arguments: `problem` (required), `context` (optional shared background), `candidates` (optional draft answers placed before the references as extra input), `preset` (optional named panel). Reference slots that answer via a plain completion run through the host LLM seam (`ctx.llm.stream` — not the kernel's SubagentRuntime); only `mode:'subagent'` slots spawn tool-capable children. Per-reference failures fold into a `failed` status so the panel can continue; a caller cancellation (session disposal) propagates instead of masquerading as reference failures. When every reference fails, the tool fails loud without calling the aggregator. With `rlm.store` mounted the synthesis lands through the judgment channel under `crit/moa-aggregator` (open tier — never promotes to evidenced); absent store degrades to no landing.

## Tool: `rlm_audit`

Phase D reverse-filtering audit. Parameters: `beliefId` (required), `scope` (`'session'` default / `'mailbox'`), `producerModel` (defaults to configured `audit.producerModel`). Hard constraint: the critic MUST be a different model than the producer — a same-model critic is a re-judgment, not an independent audit, and the store-side pipeline re-checks the constraint before any model call. Outcomes: `pass` (lands a check-pass), `objection-accepted` (lands a demotion/voiding), `objection-rejected-frozen` (the belief's trust-gate eligibility freezes pending human review), `skipped`. No `rlm.store` or no configured critic/producerModel fails loud with guidance. Each call costs one critic completion (4096-token cap, `audit.timeoutMs` budget).

## Command: `/moa`

`/moa list`, `/moa show <name>`, `/moa use <name>`, `/moa remove <name>` manage the preset store (`<dataDir>/moa-presets.json`; `/moa use` takes effect for subsequent calls immediately). Phase D audit subcommands: `/moa audit run <beliefId> [--mailbox]` (single human-triggered audit), `/moa audit pending [--mailbox]` (batch review queue of frozen beliefs), `/moa audit release <beliefId> <note>` (human release landing the `unfreeze` judgment). All three need the `rlm.store` service.

## Model Experience

### Synthesis result

#### What the model sees

The problem/context/candidates reach the reference and synthesizer slots as assembled prompts on the host LLM seam; the tool adds no model-facing guidance beyond the MOA prompt the plugin assembles. Each reference's advice is delivered to the aggregator as a labelled block with provenance.

#### Token effect

One `moa` call adds the reference fan-out prompts plus the synthesizer prompt and the fused result text to the turn; cost scales with reference count (N+1 round trips), each reference bounded by `referenceMaxTokens` and `referenceTimeoutMs`, the aggregator by `aggregatorTimeoutMs`.

#### KV Cache effect

Stateless in the request path: each reference and synthesizer call is a fresh host-side LLM request, so the plugin never edits earlier request tokens.

## Known Limitations and Deferred Work

- Reference aggregation trusts the synthesizer to report provenance; a reference that fails is named in the result text but does not block synthesis.
- Reference slots never see the harness or tools (except `mode:'subagent'` children, which do run with tools).
- Preset-level `aggregatorTimeoutMs` is honored at runtime and declared in the Config schema (Phase 8), but is not yet exposed through the managed `/moa` store commands.
- The critic slot is configured, never inferred — naming the wrong model in `audit.critic` fails loud at use time rather than silently breaking the independence constraint.

## Status

Phase D (2026-09-01): the family's model-fanout seam — MOA synthesis for aggregation, and the host of the reverse-filtering audit transport (the pipeline itself lives in `plugin-rlm-store/audit`). Family overview: [packages/rlm/README.md](../README.md); family-level status: see BUILD.md in the docs repo.
