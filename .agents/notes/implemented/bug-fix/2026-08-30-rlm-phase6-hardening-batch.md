# Agent Note: RLM Phase 6 hardening batch (T6.1–T6.22, commit 3ac8e63ae2)

Status: implemented

## Problem

The 2026-08-30 review's Phase 6 audit found a spread of small but real defects across the RLM packages: `/memory` argument handling accepted traversal forms; recall's `use_count` touch moved file mtimes and made `/memory rollback` flag spurious "user edits"; capture failures were swallowed; hybrid search had an unguarded zero-token path and unhandled embed failure; config zeros were accepted where `min(1)` was intended; and several failure paths logged nothing.

## Decision

Commit `3ac8e63ae2` (message header "harden memory/kernel/verifier/loop/harness against traversal, mtime false-positive, silent failures, config traps") shipped the T6.1–T6.22 fixes as recorded in NEXT.md:

- **Traversal hardening**: `/memory` args resolved through a published-bounded sanitizer rejecting `..` / absolute / out-of-tree paths (T6.4); `archiveNote` rejects non-`published/` relPaths (T6.18).
- **mtime false-positive**: `updateUsage` freezes the pre-write mtime so a recall no longer moves the file and `/memory rollback` stops false-flagging every recall as a user edit (T6.5).
- **Silent failures surfaced**: `runCapture` logs errors and clears the buffer on failure (T6.6); hybridSearch gains a zero-term guard and embed failure degrades to lexical with an `embedding.data`-missing fallback (T6.7); continual-harness auto-refine uses a cancellable AbortController and review/ run errors are no longer swallowed (T6.10); verifier in-flight abort short-circuits the tournament instead of a neutral tie (T6.13); verifier detail archive masks `rawText` and logprob tokens (T6.14); kernel dispose errors surface (T6.15); `landEntry` logs landing failures (T6.17).
- **Bounds**: capture buffer capped at `MAX_CAPTURE_TURNS` (T6.19).
- **Config traps**: `min(1)` validation on moa/kernel/verifier config keys (T6.9).
- **Kernel lifecycle**: `rlm.delete_subagent` clears its controller from the session set (T6.16).
- **Test infra**: both orphan specs (`restore-notice.spec.ts`, `loop-preset.spec.ts`) whitelisted into their package scripts (T6.8); compaction test script gains `--root` (T6.1); `finishError` aligns with the official `max-tokens`/`code` values (T6.3).
- **Correction (T7.9)**: T6.22's "drop dead void turnPrefix" only removed the explicit `void` marker — `parseRlmSummary` still computed `turnPrefix` and no caller consumed it. The dead field/parser were truly removed in T7.9; the mid-turn context still flows forward inside the `<compacted-summary>` text. See `2026-08-30-rlm-hygiene-batch.md`.

Docs rode the same commit: STATUS/INSTALL/README/NEXT, recipe headers, and the memory/compaction bilingual READMEs (EN/zh + i18n pairing), plus an update to the Phase E embedding-seam note.

## Verification

Per-package typecheck + keyless tests were green at the commit; the fixes are still pinned by the package suites (memory `consolidate.spec.ts`, `memory-cmd.spec.ts` gained traversal/rejection cases; kernel `restore-notice.spec.ts` and verifier `loop-preset.spec.ts` entered their package whitelists).

## Alternatives considered

**A per-field runtime validator for `/memory` arguments.** Rejected in favor of a single published-bounded resolver: one sanitizer covers every subcommand that touches a path, so a new subcommand cannot forget its own check.

**Making restore/rollback compare content instead of mtime.** Rejected: content comparison is O(n) per recall and still ambiguous (identical content could be a user rewrite); freezing the pre-write mtime is O(1) and preserves the existing snapshot-mtime discipline.

**Failing capture on extraction errors.** Rejected in this batch: capture is best-effort by design — the error is logged and the buffer cleared (T6.6), and the audit-honesty upgrade (failure propagated as `extractionRan:false` instead of silence) landed later in T7.5.

## Consequences

Every P0/P2 item of Phase 6 shipped in one commit with tests; the traversal sanitizer, mtime freeze, and failure logging are the enduring mechanisms, and the config `min(1)` traps are gone. Cost: hybrid recall can silently degrade to lexical on embed failure (by design, logged at warn), and the traversal sanitizer rejects any out-of-tree path form even when a future subcommand might legitimately want one (it would extend the resolver, not bypass it).