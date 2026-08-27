# Bring an Agent Note into compliance

English | [中文](fix-agent-note-format.zh.md)

`verify-agent-note-format` (part of `doc-sync`) rejects any active Agent Note that breaks the uniform in-file format. This guide repairs a note written in the old style into compliance while keeping all its body text.

## Prerequisites

- The repository and a Node/pnpm toolchain.
- The path of the note to fix, for example `.agents/notes/implemented/feature/2026-08-25-recording-completeness.md`.

## Steps

1. See the violations.
   `pnpm exec tsx scripts/verify-agent-note-format.ts`
   The output lists each offending file and the exact rule it breaks (missing `Status:`, wrong first section, missing `## Consequences`, …).

2. Apply the mechanical fixes.
   `node scripts/fix-agent-note-format.mjs --write .agents/notes/implemented/feature/2026-08-25-recording-completeness.md`
   The fixer prefixes the title with `Agent Note: `, inserts `Status: implemented` on line 3, renames the first section to `## Problem`, renames `## Given up` to `## Alternatives considered`, renames `## Required verification` to `## Verification`, and inserts a `## Consequences` placeholder before `## Verification`. Pass `--check` first to preview.

3. Write the `## Consequences` body.
   Open the file and replace the `## Consequences` TODO line with one or two bullets on what the trade-off bought and cost. The gate passes on the header alone, but the note is incomplete until this is filled.

4. Re-run the gate.
   `pnpm exec tsx scripts/verify-agent-note-format.ts`
   It must report `all conform`.

5. Fix by hand if the gate still complains.
   Implemented notes must not carry `## Proposal`, `## Plan`, `## Migration plan`, or `## Acceptance criteria`. The fixer only warns about these; rename or remove them manually, folding their content into `## Decision` or `## Consequences`.

6. Commit.
   Stage the note and commit. lefthook's pre-commit whitespace check gates trailing whitespace, so ensure the edited lines end cleanly.

## Verification

- `pnpm exec tsx scripts/verify-agent-note-format.ts` prints `all conform` (or names zero files).
- `git show --stat HEAD` on the fix commit lists only the repaired note(s).

## Pitfalls

- **The `Status:` line must be unique.** If the note has a `- **Status**:` bullet, the fixer drops it; the gate fails when more than one `Status:` line exists, so never leave a duplicate.
- **`.zh.md` counterparts are not auto-fixed.** The format gate skips `.zh.md`; translate the same header tokens (`# Agent Note:` and `Status: implemented`) verbatim and re-run the translation pairing check after editing either side.
- **Banned headers fail silently until commit.** `## Proposal`/`## Plan`/… are spec-speak the `implemented/` skeleton rejects; the fixer warns but does not rewrite them.
- **Whitespace pre-commit.** `git diff --cached --check` (run by lefthook) fails on trailing whitespace added by the edit; keep added lines clean.
