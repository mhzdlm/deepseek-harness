# Compaction Files Touched cross-round carry (P1-A, RLM-only)

- **Decision**: Add a `## Files Touched` section to the compaction summary and carry
  the cumulative read/modified file set across compaction rounds, closing the
  "avoid re-reading files" omission vs prime-agent's `formatFileOperations`
  (`readFiles`/`modifiedFiles`). Per the user's instruction to keep the shared
  `compaction-basic` package untouched ("不要和官方混在一起"), this lives entirely
  in the RLM-specific provider `packages/rlm/plugin-rlm-compaction`, alongside the
  split-turn prefix (P1-B) — it is NOT in the shared core. No new session event
  type is introduced; the file set is model-maintained text in the summary and
  echoed back as a prompt hint.
- **What shipped** (`packages/rlm/plugin-rlm-compaction`):
  - `src/split-turn-summarizer.ts`:
    - `buildRlmInstruction` always includes a `## Files Touched` section with an
      explicit "keep across rounds" rule and an "inherit PREVIOUS FILES TOUCHED
      hint" rule.
    - `parseFilesTouched(text)` extracts the section into read/modified buckets
      (understands the `read:`/`modified:` hint prefixes) and stops at the next
      heading.
    - `priorFilesTouched(session)` scans the durable log newest-first for the most
      recent `compaction/summary` whose text has a `## Files Touched` section and
      returns its parsed set; undefined when none exists.
    - `parseRlmSummary` decodes `filesTouched` from the model output.
  - `src/index.ts`: the `summarize` override calls `priorFilesTouched(agent.session)`
    and injects the result as `priorFilesTouched` on the input before `summarizeRlm`,
    so each round inherits the cumulative file context from the session's own
    compaction log.
  - `tests/rlm-compaction.spec.ts`: `priorFilesTouched` scan checks (recent summary
    parse, no-section → undefined) and a `PREVIOUS FILES TOUCHED` injection assertion.
- **Why this shape**: prime carries file operations as text in the summary and the
  next compaction reads the prior summary's list. We mirror that with a text section
  + a best-effort parse-back, reusing the existing `compaction/summary` event as the
  authoritative store — no new durable format, no `SESSION_FORMAT_VERSION` bump.
  Keeping it in the RLM provider means the shared `compaction-basic` package stays
  byte-for-byte unmodified.
- **P1-B (split-turn prefix)** is implemented in the same provider; see
  `2026-08-29-rlm-compaction-split-turn.md`.
- **Known limitation**: the read/modified set is currently model-maintained text —
  no file-tool event hook feeds it automatically. Wiring an automatic source (e.g.
  read/modified events) is a separate enhancement.
