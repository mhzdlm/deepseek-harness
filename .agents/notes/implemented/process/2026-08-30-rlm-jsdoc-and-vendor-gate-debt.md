# Agent Note: RLM JSDoc and vendor-gate debt cleanup (2026-08-30)

Status: implemented

[English](2026-08-30-rlm-jsdoc-and-vendor-gate-debt.md) | 中文

## Problem

Three repository-level gate debts sat outside the RLM feature batches: the RLM packages' own exported names lacked JSDoc (`verify-export-jsdoc` reported 147 violations under `packages/rlm`); the same gate scanned vendored sources whose upstream never had JSDoc (the kernel `src/vendor/kernel/**` and its `ORIGINAL/**` pristine mirrors — ~128 of the 147, each file double-counted); and the `rlm` package group had no group README declaring subsystem ownership (`verify-subsystem-pages`), because the plugin family's design lives in `docs/REME.md` and `docs/LAYERS.md`, not a core-catalog subsystem page.

## Decision

**RLM-owned JSDoc completed (13 violations)** — every remaining one was a real documentation gap, fixed in place:

- `harness-file.ts` `HARNESS_KINDS` — added its purpose JSDoc.
- `storage.ts` `embeddingCacheDir` — added `@param memoryDir` + `@returns`; `unarchiveNote` — the stale `@param relPath` renamed to the actual `archivedRelPath`; `writePublished` — documented the optional `targetRel`.
- `split-turn-summarizer.ts` `parseRlmSummary` — `@param text` + `@returns`.
- `refine.ts` `reviewAutoRefine` — the five missing `@param`s.

**Vendored sources excluded from the gate** — `collectExportJsdocViolations` now filters `**/vendor/**` and `**/ORIGINAL/**` from its scan: the vendored prime kernel has no upstream JSDoc, and forcing comments into code we re-vendor would churn every sync. The gate's own 41-case fixture suite stays green. Result: 166 → 19 violations, all of which are official/other-package pre-existing debt (api/client/fs/preset), zero under `packages/rlm`.

**`rlm` group README + subsystem-page exemption** — new `packages/rlm/README.md` declares the family's subsystem ownership (per-package contracts, group design in REME/LAYERS/LOOP, assembled preset), and `verify-subsystem-pages`'s exemption registry gains `rlm` with the recorded reason (plugin family whose design lives in docs, not a core-catalog page). Both gates now pass; `verify-md-links` reports no new dead links (the remaining failures are pre-existing official-package ones).

## Alternatives considered

**Adding JSDoc to the vendored sources.** Rejected: the upstream prime kernel carries no JSDoc; comments would be lost or fought on every re-vendor, and the ORIGINAL mirrors must stay pristine. Excluding vendored paths from an API-doc gate is the honest reading of the gate's own "non-vendored" contract.

**Creating a `docs/subsystems/rlm.md` page to link from the group README.** Rejected: the catalog's subsystem pages are generated for core packages; the RLM family's design homes (REME.md, LAYERS.md) already exist and are linked from the new group README — a page that only restates them would be a slop violation. The exemption registry exists precisely for this case and records the reason.

## Consequences

`verify-export-jsdoc`: RLM owned-zero, 19 pre-existing official violations remain (documented, not this batch's scope). `verify-subsystem-pages` passes with the new group README giving readers a family-level entry point. Cost: the vendored-exclusion filter broadens the gate's scan definition (new vendored dirs must join the filter); the exemption makes `rlm` explicitly non-catalog — a future core subsystems page would remove it and link the group README.