# Agent Note: Compaction Files Touched cross-round carry (P1-A, RLM-only)

Status: implemented

## Problem

Prime-agent's compaction carries the cumulative read/modified file set across rounds (`formatFileOperations`/`readFiles`/`modifiedFiles`) so a later summary does not re-read files. The RLM provider shipped without that carry. The user's standing instruction is to keep the shared `compaction-basic` package untouched ("不要和官方混在一起"), so the gap must close inside the RLM-specific provider.

## Decision

The `## Files Touched` section lives in the RLM compaction summary and the cumulative read/modified set is carried across compaction rounds, entirely in `packages/rlm/plugin-rlm-compaction` (never the shared core):

- `buildRlmInstruction` always includes a `## Files Touched` section with an explicit "keep across rounds" rule and an "inherit PREVIOUS FILES TOUCHED hint" rule.
- `parseFilesTouched(text)` extracts the section into read/modified buckets (understands the `read:`/`modified:` hint prefixes) and stops at the next heading.
- `priorFilesTouched(session)` scans the durable log newest-first for the most recent `compaction/summary` whose text has a `## Files Touched` section and returns its parsed set; undefined when none exists.
- `parseRlmSummary` decodes `filesTouched` from the model output.
- The `summarize` override in `src/index.ts` calls `priorFilesTouched(agent.session)` and injects the result as `priorFilesTouched` on the input before `summarizeRlm`, so each round inherits the cumulative file context from the session's own compaction log.

No new session event type is introduced; the authoritative store is the existing `compaction/summary` event. The split-turn prefix (P1-B) ships in the same provider; see `2026-08-29-rlm-compaction-split-turn.md`.

## Testing

`tests/rlm-compaction.spec.ts`: `priorFilesTouched` scan checks (recent summary parse, no-section → undefined) and a `PREVIOUS FILES TOUCHED` injection assertion.

## Alternatives considered

**Changing the shared `compaction-basic` package.** Rejected on the user's standing instruction: the official package stays byte-for-byte unmodified, so the carry is implemented in the RLM provider only.

**Introducing a durable file-set format or a new session event.** Rejected: prime carries file operations as summary text and the next compaction re-reads the prior summary's list; mirroring that with a text section + a best-effort parse-back reuses the existing `compaction/summary` event as the store — no new durable format, no `SESSION_FORMAT_VERSION` bump.

## Consequences

The shared `compaction-basic` package remains untouched, and the cross-round file context rides the session's own compaction log (auditable, replayable). Known limitation: the read/modified set is model-maintained text — no file-tool event hook feeds it automatically; wiring an automatic source (e.g. read/modified events) is a separate enhancement.