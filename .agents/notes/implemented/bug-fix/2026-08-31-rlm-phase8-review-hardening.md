# Agent Note: RLM Phase 8 review-hardening batch (T8.1–T8.17)

Status: implemented

## Problem

The round-6 cross-review (five independent AI audit reports, cross-checked claim-by-claim before any fix) surfaced one critical wiring bug, two load-bearing contract gaps, and a spread of robustness defects no earlier round had caught:

- `DEFAULT_MAX_LIVE_KERNELS = 4` was defined but never consulted, so an unconfigured deployment had **no live-kernel cap at all** while INSTALL/LIFETIME documented "defaults to 4".
- The verify output schema set `additionalProperties: false` without declaring `failedJudges`, which degraded judge paths really do attach to the tool result — so any single judge degradation would be rejected by the host's output validator and blow up the whole verify call. Unit tests call `execute` directly and bypass the host validator, which is why 45/45 green hid it.
- The ReDoS guard checked only the FIRST quantified group and did not normalize character classes, so `(ab)+(a+)+` sailed through and `((a)+)+` (exponential: 8.6 s at 26 input characters) was not covered.
- The continual-harness build output imported the memory package's `src/search.ts` — a plain-Node-unloadable specifier — from the very file whose comments warn against that pattern.
- And a long tail: prompt-assembly callbacks with no error guard, a verify fan-out with neither wall-clock budget nor size caps, an `llm.query` bridge with no session-abort channel, CJK-collapse in memory slugs, cross-session published-path collisions, provision/disposeAll process leaks, an import_name that could overwrite the kernel's own `rlm` runtime binding, frontmatter quote round-trips that doubled backslashes on every recall, a `/memory unretire` command layer that rejected every input form, and more (full inventory: NEXT.md Phase 8).

## Decision

One worktree commit lands the previously uncommitted Phase 7 implementation (T7.3–T7.13: call-surface timeouts, preset-store error classification, memory lifecycle/audit honesty, kernel correctness, the `llm.query` bridge, the `rlm_dag` skill with quality gates, recall-inject observe, and the vitest migration) together with the Phase 8 fixes (T8.1–T8.17 in NEXT.md). Key durable decisions:

- **Defaults are wired, not decorative**: `enforceLiveCap` falls back to `DEFAULT_MAX_LIVE_KERNELS`; every governance knob added this round (`maxSubcallPromptChars`, `maxCandidates`, `maxEvaluations`, `maxAutoSpawn`, `verifyTimeoutMs`) is declared in the Config interface AND the schema AND INSTALL.md, with out-of-range values failing loud rather than silently degrading (the `gate_score` fix is the template: a misconfigured gate must never quietly stop gating).
- **The host validates tool output even when package tests do not**: `failedJudges` is declared in the schema, and the new verifier test runs a degraded result through `validateJsonSchemaValue` so the host-level contract is pinned, not just the engine.
- **The ReDoS guard is structural, not pattern-matching**: a balanced-paren walk attributes every quantifier to its enclosing group and rejects unbounded quantifiers over groups containing quantifiers, alternation, or nested groups; character classes collapse to one atom first. Bounded forms (`(1|2)?`, `(ab)+`, `(\w+)@…`, `.*error.*failed`) stay allowed.
- **Sibling plugins import through compiled package entries**: memory re-exports `search`/`hybridSearch`/`SearchHit` from its root (the kernel `redactReferenceText` precedent), harness imports the root and references the memory tsconfig project; cross-package `src/*.ts` specifiers are now confined to test files.
- **Memory identity is per-session**: published paths carry an 8-character session suffix (`turn-0-<sid8>.md`), so two sessions' first-turn notes never overwrite each other; content-level dedup (`dedupTarget`) remains the merge mechanism. Slugs preserve Unicode letters (CJK titles no longer collapse to `note`). Dialog persistence is cumulative (read-merge-rewrite) so `turn:N` evidence stays resolvable across `intervalTurns` windows, with the extractor consuming the same cumulative text the gate re-reads.
- **Consolidation locking is a queue, not a join**: callers each get their own outcome (the join used to report the second draft as promoted while its file work never ran), the dedup target is recomputed inside the lock, and the lock is process-global because every promotion scans the shared `published/` tree.
- **Rollback honesty**: `restoreSnapshot` carries the snapshot's mtime onto the restored file, so a second rollback no longer false-flags a user edit; dedup overwrites preserve `created_at`/`use_count`/`last_accessed` so a heavily-cited note is not silently rejuvenated into a retire candidate.

Docs rode the same tree: NEXT.md Phase 8 (T8.1–T8.17 + deferred rulings), STATUS test statistics (414 keyless/venv + 15 real-key e2e) and known-limitations updates, INSTALL config tables (11 previously missing keys, retained-counting wording), DEPLOY package table (+memory/+compaction), MOA cost formula (N + k(N−k) + C(k,2)), LOOP rollback wording, audit-count 49→45 syncs, README index repairs, and the bilingual moa README rewrite.

## Verification

Full keyless/venv suites: 414 green (kernel 158, verifier 48, moa 39, memory 100, loop 19, compaction 10, harness 40), including 17 new Phase 8 tests (ReDoS group/class cases, llm.query abort + prompt cap, failedJudges host-schema validation, gate fail-loud, candidate cap, moa caller-cancel propagation, and a dedicated memory `phase8-fixes.spec.ts` pinning CJK slugs, session-disambiguated paths, cumulative dialog, quote round-trips, snapshot uniqueness, second-rollback mtime, unretire resolution, and zero-`use_count` aging). Typecheck is RLM-clean; vendor audit 45/45. The ReDoS rewrite was additionally measured (not just asserted): catastrophic shapes rejected at the guard, common grep shapes ≤52 ms at 10k characters.

## Alternatives considered

**Splitting Phase 7 and Phase 8 into two commits.** Rejected: the two batches interleave inside the same files (the llm.query bridge and its Phase 8 abort channel live in one hunk neighborhood), so a file-level split would create untested intermediate trees. One commit keeps every committed state a verified state.

**Batch-level budget for `llm.query` (batch deadline = N × per-call timeout).** Deferred: per-call timeouts plus the new session-abort channel close the unbounded-billing hole; whether a whole-batch deadline is wanted is an R1 semantics ruling (LAYERS.md §2.2) that should follow real usage data, the same ruling as batch-internal parallelism.

**Content-hash draft filenames (instead of Unicode-preserving slugs).** Rejected: draft identity is deliberately content-prefix based so re-extraction is stable (T6.19); preserving CJK in the prefix fixes the actual defect (Chinese titles collapsing to `note`) without changing the identity scheme.

**Verifying harness `evidence` strings against the transcript at validate time.** Deferred (NEXT.md 8C): the full closure needs transcript back-references plus injection fencing; the observe gate's "proves existence, not truth" stance is a documented property, not an accident this batch could silently change.

## Consequences

The documented safety envelope now holds by construction: live-kernel caps default to 4, verify cannot bill unbounded, disposed sessions stop subcall billing, and misconfigured gates fail loud. Memory is trustworthy for CJK and multi-session deployments (no silent overwrites), and degraded verify runs survive host validation with named failures. Costs and residuals, recorded on purpose: two Phase 7 ✅ summaries remain partially aspirational (loop T6.17 landed 1/6 — the round-dedup half fixed here; `deleteEmbedding` wiring landed here via `archiveNote`); single-CJK-character queries still return empty in hybrid search (T7.8 deferred item — zero-term behavior is the T6.7 acceptance, not a regression); the Borda-vs-mean-score gate mismatch in multi-judge verify is a recorded semantics ruling awaiting dogfood data rather than a bug fix; and the harness build must be re-run after source changes or `lib/types` goes stale relative to `src/` (the stale-bundle failure mode this batch fixed is now documented in NEXT.md 8A/T8.4).
