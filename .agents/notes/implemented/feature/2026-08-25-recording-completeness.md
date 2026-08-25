# 2026-08-25 — Recording completeness: verify detail files and ipython output archive (NEXT T2.6)

## Context

Post-implementation audit of the recording pipeline surfaced an asymmetry with the established principle that trimming is a context-layer policy while durability belongs to the artifacts layer. moa already persisted advisor answers verbatim (privacy-piped) into `session/moa-reference` events; verify did not — its events carried only 120-char candidate digests, fused scores, and no fusion inputs. Worse, `auto_spawn` child session ids were never recorded, so the linkage to full candidate logs was severed. Separately, over-long ipython outputs were truncated destructively inside the vendored kernel protocol layer: the model-facing view was capped, and everything beyond it vanished.

## Decision

- **verify detail file**: when `artifactRoot` is configured (verifier gains optional `dataDir`, default `~/.dsh/rlm`), every run writes `<artifactRoot>/<sessionId>/verify/<ts>.json` containing masked full candidates, per-call raw judge outputs with chosen-token logprobs (teed off the injected `callModel`), fusion inputs (per-judge preference vectors), and child session ids. The result event gains `judges[]`, `childSessionIds[]`, and `detailPath`. Write is best-effort; failure drops the pointer, never the verification.
- **ipython archive-then-truncate**: the tool now requests the vendor's hard backstop window (`DEFAULT_FULL_OUTPUT_CAP`, 10MB) instead of forwarding the model-facing cap; on overflow it writes the verbatim assembly to `<sessionArtifactDir>/tool-results/<ts>.log` and appends a pointer line to the truncated transcript view (`full N chars archived at <path>`). The model can read the archive in slices — turning what was an audit gap into a self-service capability. Beyond 10MB even the archive is capped (pathological runnaway guard).
- Placement rule recorded for future cases: context gets the trimmed view, session.jsonl carries pointers and light events, `session-artifacts/<sid>/` holds originals — keeping each session directory a self-contained replay unit (the reason a global `verify-traces/` dir was rejected).

## Given up

- Storing judge raw outputs or logprobs inside `session.jsonl` events themselves (size would tax every event consumer); they live only in the per-run detail file.
- Unfiltered raw persistence under privacy `'full'`: archived candidates are masked first — masking and truncation are treated as orthogonal axes from here on.
- Modifying vendored truncation behavior: the vendor keeps a hard 10MB backstop cap untouched; everything above happens in plugin-owned code.

## Required verification

- verify.spec: new case asserts detailPath existence, masked-candidate storage (no `sk-…` material), non-empty calls array, and childSessionIds linkage.
- ipython-tool.spec: overflow case asserts verbatim archive plus capped-with-pointer render; small-output case asserts no archive directory appears.
