# Agent Note: Preset store read-error classification (NEXT Phase 7 T7.4)

Status: implemented

[English](2026-08-30-rlm-preset-store-read-error-classification.md) | 中文

## Problem

The 2026-08-30 review's P1#2: `loadPresetStoreSync` wrapped the file read and the JSON parse in one `catch` that quarantines the path as `<name>.corrupt-<ts>` and returns an empty store. Content corruption deserves that policy, but a read *error* (EPERM/EACCES/EISDIR — an antivirus scan, a momentary lock, a permission problem) leaves the file healthy; quarantining it can rename a good store aside, and the next `/moa use` save then writes an empty store over the original path — silent loss of every managed preset. The save path compounded the fragility: its tmp file name was only pid-scoped, so any future concurrent-save shape would share one tmp file.

## Decision

`loadPresetStoreSync` (`plugin-rlm-moa/src/preset-store.ts`) classifies read failures from content failures:

- `ENOENT` → empty store (replaces the `existsSync` pre-check, removing the exists-then-read race);
- any other read error (EPERM/EACCES/EISDIR/…) → **fails loud**, touching nothing — the path and its bytes stay exactly where they were;
- JSON parse or shape failure → quarantined as `<name>.corrupt-<ts>` + empty store (unchanged policy for genuine corruption).

`savePresetStoreSync` writes each save to a unique tmp path (`pid` + monotonic per-process sequence) and unlinks the tmp on failure before rethrowing, so a failed save can neither promote half-written bytes nor litter the directory.

Tests (`tests/preset-store.spec.ts`): a directory at the store path (EISDIR everywhere) now throws while everything under it stays intact and nothing is quarantined; repeated saves win last-write and leave no `.tmp-` residue; the existing corruption-quarantine and layering tests are unchanged and green.

Related: [moa managed presets](../bug-fix/2026-08-24-rlm-moa-managed-presets-and-redaction.md) (owns the store and its corruption policy — unchanged for content corruption).

## Alternatives considered

**Fail loud on every read error including corruption.** Rejected: a genuinely corrupt file would wedge `/moa` until a human deletes it; the harness state-file quarantine policy is the better shape for real corruption, and the review only faults its application to read errors.

**Retry the read on EPERM with backoff.** Rejected: a synchronous store read cannot block the command path on a timer, and retry logic would paper over a deploy-specific permission problem that should surface as an error naming the path.

## Consequences

A transient unreadable store now produces a loud error naming the path instead of silently destroying managed presets on the next save; corruption handling is unchanged. Cost: `loadPresetStoreSync` can now throw where it previously always returned, so callers (the preset view accessors behind `/moa` and the `moa` tool) surface that error to the model or user — the intended fail-loud behavior. Save-path tmp files gained a per-save sequence suffix; stale tmp files from crashed runs are overwritten rather than reused blindly.
