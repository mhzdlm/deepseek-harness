# Agent Note: RLM judgment tools converge on one call and persistence contract

Status: implemented

English | [中文](2026-08-24-rlm-unified-judgment-contract.zh.md)

## Problem

The rlm family's two judgment tools exposed divergent contracts for the same caller-facing concerns. `verify` scored with a single model and single hard-coded credential pair, had no privacy tier, no session correlation, and no durable record of why a verdict was reached; `moa` had all of these but recorded process information only in sidecar files outside the session log. A caller could not rely on attribution, multi-model panels, confidentiality tiers, or replayable decision history uniformly across the family.

## Decision

A family contract (documented in the workspace REPLICATE notes) fixes the unified semantics — same tool schema shape, session correlation, purpose attribution, three-tier privacy, multi-model allowance, and a two-layer persistence model where the session log is the authoritative process record while dataDir files are demoted to caches/exports/state stores. This change brings both tools onto it:

- **Multi-judge verification** — Config `judgeProfiles` names judge entries (`model`, optional OpenAI-compatible `baseUrl`, `keyEnv`, `extraEnv[]`); the tool's `judges` argument selects profiles. Each judge runs in its own subprocess authenticated only by its named variables (resolved from `process.env` at spawn time over the scrubbed base), and outcomes fuse through Borda points with mean min-max normalized score as tiebreak (`src/fusion.ts`). Multi-judge runs force the subprocess path — the kernel's env whitelist cannot carry arbitrary vendor credentials.
- **Privacy parity** — `privacyFilter` lands on verifier with moa semantics; `full` masks candidate text before scoring prompts via `redactReferenceText`, now relocated to `plugin-rlm-kernel/src/redact.ts` as the family-shared mask (moa imports it from there).
- **Process events** — `session/verify-request|result` and `session/moa-reference|synthesis` join `SessionEventMap` following the `session/title-llm-request` log-only precedent: appended through the executing agent's own Session around dispatch/settlement, best-effort, outside derived model history. MoA reference events carry each advisor answer under the active privacy pipeline; verify result events carry per-run scores/ranking plus fusion output when judged.
- **Catalog gate unblocked** — `scripts/gen-cordis-catalog.ts` gained the missing `'rlm.kernels'` SERVICE_WALK_EXEMPTIONS entry (a pre-existing unrendered Context merge that failed the generator before any regeneration), so the generated API catalog picked up the widened `GenerateOptions.purpose` union.

## Alternatives considered

**Migrate verify scoring onto ctx.llm now.** Deferred with an explicit trigger: the seam does not expose scoring-token logprobs yet; migrating before that means changing algorithms, not transports.

**Generic "judgment framework" abstraction over both tools.** Rejected: two consumers cannot support an ABC without guessing future requirements; the shared parts (redaction helper home, event naming convention) are unified directly instead.

**Per-judge credentials inside one subprocess.** Rejected: llm_verifier builds one client from the environment per invocation; N subprocesses isolate each judge's credential blast radius cleanly.

## Consequences

Callers get one contract across the family: every auxiliary judgment is session-correlated, attributable through request/result events, privacy-tiered, and optionally multi-model. Costs: judge profiles put additional environment variable names in Config (deployment-owned secrets policy applies), fused rankings add deterministic-but-order-sensitive tiebreak semantics worth knowing when comparing across runs, and the event families grow the session log by a few KB per judgment run. The kernel path remains single-model until the logprobs convergence trigger fires.

## Testing

- `tests/fusion.spec.ts`: 5 items — agreement fusion, majority-position Borda resolution, normalized-mean tiebreak with a third judge, failed-judge exclusion, and the all-failed `-1` sentinel.
- `tests/moa.spec.ts`: new item asserting the exact reference/synthesis event sequence and payload fields through a recording session.
- Full package regressions: verifier 21/21 (including the keyed e2e), moa 31/31; tsc clean for verifier, moa, and kernel after rebuilding kernel declarations for the relocated redact module.
