# @deepseek-ai/dsh-plugin-rlm-redact

English | [中文](README.zh.md)

Shared credential/PII reference-text redaction for the RLM plugin family. Not a Cordis plugin — no `apply`, no service, no config. It is a zero-dependency library exporting one redactor so `plugin-rlm-moa` and `plugin-rlm-verifier` can mask advisor/candidate text without importing the kernel package (and its native zeromq dependency chain).

## Exports

From `src/redact.ts` (the package root re-exports it):

- `redactReferenceText(text)` — masks credential-shaped material plus email/formatted-phone PII in one advisor text; non-string input passes through unchanged. Masked shapes: PEM private-key blocks, `sk-`/`pk-`/`rk-` prefixed keys, GitHub token families (`ghp_`/`gho_`/`ghs_`/`ghr_`/`gpu_`), JWT triples, `Authorization: bearer …` values (scheme preserved), and `password=`/`pwd=`/`api_key=`/`token=`/`secret=`-style URL/connection-string values.
- `MOA_EMAIL_RE` — the email pattern, exported for consumers that compose their own pass.
- `MOA_PHONE_RE` — the formatted-phone pattern; requires explicit delimiters (parenthesized area codes or `-`/`.` separators), so undelimited digit runs, dates, times, hex ids, and dotted quads never match.

Pattern safety: advisor text is frequently code-review-shaped (line numbers, SHAs, IPs, versions), so patterns require strong distinguishing markers and never match bare digit runs.

## Consumers

- `plugin-rlm-moa` (`src/index.ts`): wired as `redactReference` into the `moa` tool when `privacyFilter: 'full'` — masks reference advisor text before aggregation and tracing.
- `plugin-rlm-verifier` (`src/index.ts`): wired the same way for the `verify` tool — candidate digests and the durable detail archive under `<dataDir>/session-artifacts/` are masked under `privacyFilter: 'full'`.

`plugin-rlm-memory` does NOT consume this package; its capture-path `privacyFilter: 'full'` uses its own minimal masking pass.

## Status

Phase D (2026-09-01): the family's shared masking primitive, deliberately self-contained until the harness grows a central redactor (revisit when one lands). Family overview: [packages/rlm/README.md](../README.md); family-level status: see BUILD.md in the docs repo.
