# Agent Note: MoA presets gain runtime management and a full redaction tier

Status: implemented

English | [中文](2026-08-24-rlm-moa-managed-presets-and-redaction.zh.md)

## Problem

The first `plugin-rlm-moa` cut read its panel definitions exclusively from static plugin Config: changing the reference lineup or the default panel required editing `cordis.yml` and reloading, and advisor answers reached the aggregator prompt unfiltered — credential material an advisor echoed from the conversation would flow straight into another model call and into the rendered transcript's neighborhood.

## Decision

Two additions, both layered without touching the tool's orchestration contract:

- **Managed-preset store** — `<dataDir>/moa-presets.json` holds runtime-managed presets plus the active default pointer (`/moa use <name>` writes it). The view layers store over Config presets (store wins on name collisions) and re-reads per call, so management takes effect immediately for subsequent tool executions. A corrupted store is quarantined as `<file>.corrupt-<ts>` and treated as empty, mirroring harness state-file policy.
- **`/moa` command** — `list | show <name> | use <name> | remove <name>`. `remove` deletes only store-managed presets; Config-sourced ones are reported as immutable rather than silently skipped.
- **Privacy `full`** — advisor text is masked through `redactReferenceText` before entering the aggregator prompt: PEM private-key blocks, provider-style keys (`sk-…`, `gh[posr]_…`), JWTs, Bearer header values, `password=/api_key=/token=` pairs, emails, and delimiter-required phone numbers. Pattern safety mirrors upstream advisory-panel reasoning: versions, IPs, dates, SHAs, and undelimited digit runs never match. Trace lines carry lengths only, so nothing else persists advisor text.

The tool consumes these through injected seams — `resolvePreset`/`availablePresets` (the layered view) and `redactReference` — keeping orchestration unit-testable without an LLM runtime or filesystem fixture beyond tmp dirs.

## Alternatives considered

**Persist managed presets into cordis.yml.** Rejected: plugin Config is deployment-owned; a dataDir JSON file keeps user mutation out of composition files while staying inside the shared artifact root.

**Redact inside the reference system prompt instead ("do not echo secrets").** Rejected as sole defense: prompt-level requests are advisory; masking is deterministic and auditable. Both together are fine, but only the mask is enforced.

**Reuse the harness state-file module for the store.** Rejected: that module is harness-entry-shaped (kinds, scopes, CAS); the store needs two fields with last-writer-wins semantics, and copying its corruption-quarantine behavior was the only shared part worth taking.

## Consequences

Panel lineups and the default become session-runtime adjustable via `/moa`, and `full` mode gives deployments a deterministic confidentiality tier for cross-model flows. Costs: the store file is a new mutable artifact under `dataDir` (last-writer-wins, single-host assumption like the rest of the RLM family), and the redaction pattern list must be extended deliberately when new secret families matter. Config-declared presets stay authoritative for anything not overridden.

## Testing

- `tests/redact.spec.ts`: 6 items — key/JWT/PEM/KV-pair/Bearer masking, email and delimited-phone detection, and non-matching guarantees for versions, IPs, dates, SHAs, and bare digit runs.
- `tests/preset-store.spec.ts`: 6 items — layering precedence (store over Config, same-name override), default resolution order (store → Config → first), corrupted-store quarantine, `use` persistence visible to the view immediately, remove-only-managed rule, list/show rendering with default marker.
- `tests/moa.spec.ts`: gains one item asserting `full` mode masks advisor email/key material before the aggregator prompt; existing 13 items updated to the injected-view shape. Package suite: 26 items green across three files; tsc clean.
