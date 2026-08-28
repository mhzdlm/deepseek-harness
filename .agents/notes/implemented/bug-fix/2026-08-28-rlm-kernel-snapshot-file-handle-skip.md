# Agent Note: Kernel snapshots skip live file handles

Status: implemented

English | [中文](2026-08-28-rlm-kernel-snapshot-file-handle-skip.zh.md)

## Problem

dill serializes an open file object as reopen-instructions (`dill._dill._create_filehandle(path, mode)`), not as dead data. A live write-mode handle stored in the rlm kernel namespace was therefore snapshotted successfully, and every later `dill.loads` of the payload — session restore after kernel recreation, or off-session analysis of the artifact — reopened the target file with its stored mode; write modes truncate. The snapshot design relied on `dill.dump` raising for open files (the header comment listed them among unpicklables), which never happens for handles, so the guard never fired. Observed concretely: analyzing the `kernel-state.dill` of a prior session deserialized a `BufferedWriter` blob pointing at `packages/rlm/plugin-rlm-loop/README.zh.md` and truncated the working-tree file to zero bytes at load time ([snapshot history note](../feature/2026-08-26-rlm-kernel-snapshot-history.md) owns the surrounding mechanism).

## Decision

`buildSnapshotCode` checks `isinstance(value, io.IOBase)` before dumping each top-level name and records the name in `skipped` with the reason `live io.IOBase handle: dill reopens the file on load (write modes truncate)`. In-memory `BytesIO`/`StringIO` values are skipped too: a lost in-memory buffer is reported and re-creatable, while a truncated file is silent loss. The failure surfaces through the existing skip channels — manifest `skipped`, the `session/kernel-snapshot` event `skipped[]` — and never aborts the snapshot.

## Alternatives considered

**Restore-side pre-scan (pickletools) to neutralize handle blobs.** Rejected: it adds a permanent per-restore scan cost for a payload class the fixed snapshot no longer produces, and detection cannot prevent the truncation anyway — the reopen happens during deserialization itself, before any post-load check runs.

**Preserve handles by value (serialize the bytes, restore into `BytesIO`).** Rejected: it changes the restored type and silently redirects subsequent writes away from the original file, which is a different data-loss mode wearing a fix's clothes.

## Consequences

Names holding open handles no longer enter the payload; they are reported as skipped where every other skip is reported, and the model-visible `[lost: …]` restore notice is unaffected because such names were never restorable members. Payloads written by earlier builds still carry handle blobs and replay the truncation on restore; there is no migration, so artifacts produced before this change should be treated as hazardous to load outside their session. Cost: one `isinstance` check per top-level namespace name.

## Testing

- `snapshot-file-handle-skip.spec.ts`: runs the generated snapshot code against a seeded `wb` handle with bytes already on disk, then replays the consumer pattern (`dill.load` + `dill.loads` of every blob) and asserts the handle lands in `skipped` while the target file keeps its bytes. Negative control against the pre-fix build: same fixture ends at zero bytes with the handle saved.
