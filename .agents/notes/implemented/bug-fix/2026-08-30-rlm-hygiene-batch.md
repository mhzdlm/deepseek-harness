# Agent Note: RLM hygiene batch (NEXT Phase 7 T7.9)

Status: implemented

[English](2026-08-30-rlm-hygiene-batch.md) | 中文

## Problem

The 2026-08-30 review's P3/hygiene pass left a backlog: three commits shipped with "Agent Note: to be added by committer." placeholders; two file headers were stale; `packages/rlm/temp/` was an untracked empty directory; T6.20's "turnPrefix fix" had been misattributed (only the explicit `void` marker was dropped, the dead parse remained); P3 code items (use_count NaN, embedding dimension mismatch, same-millisecond filename collisions, four vendor-layer issues) were open; and eight pre-format Agent Notes failed the note-format gate (enforced at `doc-sync`).

## Decision

**Dead-code/defect batch (product code):**
- `storage.ts` `updateUsage`: `use_count: (note.frontmatter.use_count ?? 0) + 1` — a missing field no longer produces `NaN` (which would keep the note from ever retiring).
- `embedding.ts`: the provider now throws on a dimension mismatch between the configured/inferred `dim` and a response vector, instead of silently pairing vectors of different lengths for cosine (fail loud on provider misconfiguration).
- Same-millisecond filename collisions fixed with a `randomUUID` suffix in `verify-tool.ts` (`${Date.now()}-${…}.json`) and `ipython-tool.ts` (`${Date.now()}-${…}.log`), matching the `harness-file.ts` corrupt-backup naming precedent.
- `split-turn-summarizer.ts`: the dead `turnPrefix` field/parser removed (T6.20 corrected for real this time); `parseRlmSummary` returns `filesTouched` only. The mid-turn context continues to flow forward inside the `<compacted-summary>` text, so no behavior is lost. Test updated.
- Vendor layer `[local patch #18]` (logged in `vendor/UPSTREAM`): `boot-gate.ts` deleted (zero callers repo-wide; audit-vendor entry removed); the orphan-process-journal read/identity/clear side deleted (zero callers; the active filter was vacuously false because `processStartId` is always undefined under patch #17); `kernelStderr` bounded at 1 MiB (`MAX_KERNEL_STDERR` + `appendKernelStderr`); `bootstrap.ts` `run()` gained a 120s per-run timeout that kills a hung installer child and surfaces a timed out run instead of stranding bootstrap.

**Housekeeping:** the two stale headers (memory `index.ts` "await Phase C" self-contradiction; `memory-cmd.ts` missing `retire`/`unretire`) are corrected; `packages/rlm/temp/` deleted; compaction's `test` script gained the explicit spec whitelist its sibling packages have (UPSTREAM-SYNC:126 alignment closed).

**Commit-placeholder notes:** `3ac8e63ae2` (the T6.1–T6.22 hardening batch) gets a real Agent Note now — `2026-08-30-rlm-phase6-hardening-batch.md` (EN/zh). `e1bf5b486d` (drop dead recallMode tool param; remove temp cruft) and `a9e77bc157` (drop two dead-code smells) are mechanical cleanup, which AGENTS.md's "only mechanical/local edits are exempt" clause covers; the exemption is recorded here and in FIXES-ARCHIVE rather than by writing notes for commits that have no decisions to record.

**Agent Note format debt (8 files) repaid:** the six 2026-08-29 `implemented/architecture/` notes and the two 2026-08-30 `implemented/feature/` notes were restructured to the enforced skeleton (header block + `## Problem` / `## Decision` / `## Alternatives considered` / `## Consequences`, with Testing and bespoke sections preserved as present-tense facts). No facts were changed or dropped; the pre-format list style (Decision/What shipped/Why this shape) mapped onto the skeleton, and "Why this shape"/"Deviations" material became the genuine Alternatives records. None of the eight had a Chinese counterpart, so the EN files are the complete triplet here.

## Alternatives considered

**Keeping the read side of the orphan-process journal and fixing its filter.** Rejected: zero callers exist in the dsh host, and under patch #17 `processStartId` is always undefined, so any "active" filter would remain vacuously false; deleting the read/identity/clear side is the honest trim (write side keeps its real callers).

**Keeping `boot-gate.ts` "for upstream sync".** Rejected: zero callers repo-wide and its local patches had no consumer; ORIGINAL/ keeps the pristine snapshot, so re-vendoring can re-evaluate. audit-vendor.mts dropped the entry with the file.

**Unit-testing the bootstrap timeout by injecting a fake child.** Rejected: the vendored `run()` has no seam, and adding one to a vendored file for a 120s-bound path is not worth the drift; the timeout is mechanical and covered by the audit gate's `#18` mustContain checks.

**Writing Agent Notes for `e1bf5b486d`/`a9e77bc157`.** Rejected: both commits are mechanical cleanup with no decision to record; AGENTS.md's mechanical-exempt clause applies and the exemption is documented here instead.

## Consequences

The format gate is green for all 692 notes (the 8-file debt is gone, so `doc-sync` no longer carries pre-existing violations). Product code: NaN `use_count`, silent dimension mismatches, same-millisecond collisions, an unbounded stderr buffer, a strandable bootstrap child, and a dead `turnPrefix`/`boot-gate`/journal-read surplus are all gone; compaction joins the whitelist regime. Costs: the embeddings provider now fails loud on a dimension mismatch (a deployer with a wrong `embeddingsDim` sees an error instead of wrong cosine comparisons); a 1 MiB stderr bound means only the tail is ever available (already the model-visible semantics); bootstrap installer runs are capped at 120s each. Honest boundary: the EPERM/EBUSY rename-sharing path in `harness-file.ts` remains untested cross-platform, as recorded in T7.7.