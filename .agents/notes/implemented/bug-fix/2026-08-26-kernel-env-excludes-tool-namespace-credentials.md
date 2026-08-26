# Agent Note: The kernel allowlist excludes credential-bearing tool namespaces

Status: implemented

English | [中文](2026-08-26-kernel-env-excludes-tool-namespace-credentials.zh.md)

## Problem

`buildKernelEnv`'s default-deny allowlist admitted the `UV_*` and `npm_config_*` prefixes wholesale. Both namespaces carry secret variants — `UV_PUBLISH_TOKEN` (PyPI publish token), npm auth/proxy configuration (`npm_config__auth`, per-registry authtokens) — and the kernel process runs model-written arbitrary Python, so any of those variables present on the host reached a process where the model could read and exfiltrate them. The blocklist-first ordering did not help: these names match no blocked prefix, so the allowlist alone decided, and it said yes. This contradicted the family contract's "the kernel process receives no external credentials".

## Decision

The kernel-process allowlist (`ALLOWLIST_PREFIXES` in `packages/rlm/plugin-rlm-kernel/src/kernel-env.ts`) no longer contains `UV_` or `npm_config_`. Nothing in the vendored kernel runtime reads those variables: uv invocation happens host-side in bootstrap through `buildScrubbedEnv`, which keeps its deny-only semantics and still passes tool configuration to installer children. Windows case-insensitive folding applies to the exclusion as to every allowlist decision. Negative cases pin `UV_PUBLISH_TOKEN`, `UV_CACHE_DIR`, `npm_config__auth`, and `NPM_CONFIG_REGISTRY` as absent from kernel children in both platform regimes.

## Alternatives considered

**Enumerate the safe UV_/npm_config_ variables individually.** Rejected for now: the kernel runtime needs none of them, so each enumerated entry would be surface without a consumer; entries can be added deliberately if a kernel-side consumer appears.

**Add the two prefixes to the credential blocklist.** Rejected: semantically they are not always credentials (`UV_CACHE_DIR` is plain configuration), and blocking them in `buildScrubbedEnv` would break uv/npm helper children that legitimately need their configuration. Exclusion lives where the trust boundary is — the kernel allowlist.

## Consequences

A host that exports `UV_PUBLISH_TOKEN` no longer leaks it into model-reachable process environments. The cost is the same one the allowlist already charges: a future kernel feature genuinely needing a tool variable requires a deliberate, reviewed entry rather than namespace-wide inheritance. Helper-child behavior is unchanged because the scrubbed builder never consulted the kernel allowlist.

## Testing

- `tests/kernel-env.spec.ts`: two new buildKernelEnv negatives (POSIX exact names, Windows folded casing) plus extended buildScrubbedEnv positives proving tool config survives for helper children.
