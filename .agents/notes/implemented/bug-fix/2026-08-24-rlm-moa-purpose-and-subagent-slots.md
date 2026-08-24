# Agent Note: MoA slots gain purpose attribution and a subagent execution mode

Status: implemented

English | [中文](2026-08-24-rlm-moa-purpose-and-subagent-slots.zh.md)

## Problem

Panel calls flowed through `ctx.llm.stream()` indistinguishable from ordinary conversation traffic — token-meter folding and observability could not separate MoA fan-out from loop steps. Separately, every reference was a plain completion; tasks needing real environment interaction (run the code, read the repo) had no panel representation, forcing users to hand-roll `verify.auto_spawn` for tool-capable opinions.

## Decision

Two additive extensions:

- **`purpose: 'moa'`** joins the closed `GenerateOptions.purpose` union in dsh-llm (`'compaction' | 'session-title' | 'moa'`). The moa transport stamps it on every panel call together with the branded session id, so metering and interceptors can classify the traffic; adapters without moa-specific policy ignore it exactly like unknown purposes today.
- **Subagent reference slots** — a preset slot may declare `mode:'subagent'`, running as a spawned child of the owning agent instead of a completion. `provider` names the subagent provider (falling back to Config `subagentProvider`, default `'spawn'`); `model` becomes the child label hint. Controllers register before start and abort on session disposal (the verifier pattern), the composed signal still honors the reference timeout, and captured child text truncates at Config `maxChildChars`. This is an opt-in deviation from Hermes, whose references are always tool-free completions.

Supporting fixes landed en route: `scripts/gen-cordis-catalog.ts` gained a `SERVICE_WALK_EXEMPTIONS` entry for `'rlm.kernels'` — a pre-existing unrendered Context merge that made the generator fail before any regeneration could pick up the widened union. Composition guidance for pairing moa with verify ships in the workspace audit docs (`MOA.md`), outside this repository's generated surfaces.

## Alternatives considered

**Open-ended purpose strings.** Rejected: the closed union is what lets each adapter own purpose-specific policy exhaustively; free-form tags would decay into unmaintained metadata.

**Subagent slots as the default references.** Rejected: tool-capable children cost more, run longer, and drift; Hermes keeps references tool-free by design. Opt-in per-slot keeps the default cheap and predictable.

**Hand-editing api-catalog.ts for the widened declaration.** Rejected by policy: generated sources change only through their generator, which required fixing the walk-exemption gap first.

## Consequences

MoA traffic is classifiable end-to-end (purpose → session → route), and hard tasks can put one tool-capable advisor on the panel while keeping the rest cheap. Costs: the purpose union grows once per auxiliary consumer by design; subagent slots inherit delegation economics (spawn latency, child variance) and are bounded only by the reference timeout plus `maxChildChars`; fork-server-style Linux-only caveats do not apply since subagents spawn normally on Windows.

## Testing

- `tests/llm-stream.spec.ts`: one integration item through real `LlmRuntime` with a capture adapter — asserts `purpose:'moa'`, branded session id forwarding, per-slot provider/model routing, live `AbortSignal`, and reference-cap-vs-uncapped-aggregator bounds across all three calls.
- `tests/moa.spec.ts`: three items — subagent routing with folded persona/task prompt, unwired-callSubagent degradation into `failedLabels`, and owner-less executions failing the slot before any spawn.
- Package suite 30/30 green across four files; `tsc --noEmit` clean; `pnpm run gen-cordis-catalog` passes (95 artifacts) including the new union in the generated API catalog.
