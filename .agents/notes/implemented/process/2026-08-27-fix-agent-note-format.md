# Agent Note: Mechanical fix for non-conforming Agent Notes

Status: implemented

- **Date**: 2026-08-27
- **Area**: `.agents/notes/**`, `scripts/verify-agent-note-format.ts`, `scripts/fix-agent-note-format.mjs`
- **Status**: implemented (the fixer is a process tool; this note records the procedure)

## Problem

`verify-agent-note-format` (part of `doc-sync`) rejects any active Agent Note that does not follow the uniform in-file format: the first line must be `# Agent Note: <title>`, line 3 `Status: implemented`, the first body section `## Problem`, and the `implemented/` skeleton must carry `## Decision`, `## Consequences`, and `## Alternatives considered`. Older notes written in the pre-format style (`# 2026-08-xx — <title>`, `## Context`, `## Given up`, `## Required verification`) fail the gate, and a batch of them accumulated in the tree.

## Decision

Repair each note mechanically, preserving all Chinese body text and only changing structure and header tokens:

1. Prefix the title line with `Agent Note: ` (turn `# 2026-08-25 — x` into `# Agent Note: 2026-08-25 — x`).
2. Insert `Status: implemented` as line 3, with blank lines around it; drop any pre-existing `Status:` bullet so the line-3 status is the only one in the file.
3. Rename the first body section to `## Problem` (old notes use `## Context`).
4. Rename `## Given up` to `## Alternatives considered`.
5. Rename `## Required verification` to `## Verification`.
6. Insert a `## Consequences` section (with a one-line TODO placeholder) immediately before `## Verification`; the author fills in what the trade-off bought and cost.
7. Remove any banned `implemented/` headers (`## Proposal`, `## Plan`, `## Migration plan`, `## Acceptance criteria`) by hand — the fixer only warns about them.

`scripts/fix-agent-note-format.mjs` applies steps 1–6 for one or many files (`--check` to report, `--write` to apply). Step 7 is manual because the rewrite is semantic.

## Alternatives considered

- Hand-editing each file in the editor: correct but slow and error-prone across a batch; the fixer script encodes the mechanical steps so they are repeatable and reviewable as a diff.
- Generating `## Consequences` automatically: rejected — the content is a judgment (what the trade-off bought and cost) that the author must state; a placeholder plus the gate's failure is the forcing function.
- A one-shot `pre-commit` auto-fixer: rejected because reformatting committed history notes silently hides the real change in review; the fixer is opt-in per file.

## Consequences

- Bought: a repeatable, diff-reviewable repair; the tree's active notes now pass `verify-agent-note-format` (0 violations across all notes).
- Cost: the `## Consequences` body for each repaired note is a placeholder until the author writes one or two bullets; the gate passes on the header alone, so the TODO must be closed by hand.

## Verification

- `pnpm exec tsx scripts/verify-agent-note-format.ts` reports `all conform` after the repair.
- `git diff` on each repaired note shows only header/section renames plus an added `## Consequences` placeholder — no body text changed.

## Related

- Format rules: `.agents/notes/README.md#the-file-format`.
- Gate source: `scripts/verify-agent-note-format.ts`.
- Fixer: `scripts/fix-agent-note-format.mjs`.
