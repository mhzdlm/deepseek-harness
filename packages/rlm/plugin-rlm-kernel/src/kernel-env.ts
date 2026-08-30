/**
 * Kernel-process environment construction for the RLM kernel plugin.
 *
 * The model writes arbitrary Python inside the kernel process, so that process
 * must not inherit host credentials. Two builders cover the three spawn sites:
 *
 * - {@link buildKernelEnv} — default-deny allowlist, for the kernel process
 *   itself (direct spawn and the forkserver template). Anything not on the
 *   allowlist is dropped; credential-shaped names are blocked first so an
 *   allowlist edit can never leak them back in.
 * - {@link buildScrubbedEnv} — deny-only credential strip, for helper children
 *   that need a broad environment to function (the uv/bootstrap child: its
 *   installer shell wants PATH/HOME/proxy/XDG vars we do not enumerate).
 *
 * On Windows, environment variable names are case-insensitive at the OS level
 * while `process.env` preserves original casing (`Path`, `SystemRoot`,
 * `windir` are mixed case), so both builders match names case-insensitively
 * there. POSIX keeps exact-case semantics. This mirrors the `rlmEnv` fallback
 * in `env.ts`. The original key casing is preserved in the returned env.
 *
 * `[local patch #14]`: extracted from the vendored kernel copy so
 * `vendor/kernel/index.ts`, `vendor/kernel/fork-server.ts`, and
 * `vendor/kernel/bootstrap.ts` share one boundary; see `vendor/UPSTREAM`.
 */

// Runtime-required variables. Prefix matches are checked with startsWith;
// exact entries must name the variable in full. Names here are written in
// canonical case and folded per platform at match time.
//
// Tool namespaces (`UV_*`, `npm_config_*`) are deliberately NOT allowlisted
// even though they look like innocuous configuration: both carry credential
// variants (`UV_PUBLISH_TOKEN`, npm auth/proxy config) that would otherwise
// reach the model-writable kernel process. The uv/bootstrap helper children
// that genuinely need them run through {@link buildScrubbedEnv} instead.
const ALLOWLIST_PREFIXES = [
  'RLM_', 'PATH', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'SYSTEMDRIVE',
  'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE', 'PYTHONPATH',
  'PYTHONIOENCODING',
] as const
const ALLOWLIST_EXACT = new Set([
  'ComSpec', 'OS', 'PATHEXT', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE',
  'PROCESSOR_IDENTIFIER', 'COMMONPROGRAMFILES', 'PROGRAMFILES', 'PUBLIC',
  'WINDIR', 'DRIVERDATA', 'TMPDIR',
])
/**
 * Credential-adjacent variable-name prefixes blocked before any allowlist
 * check. Includes harness/agent runtime namespaces whose values may carry keys
 * or endpoints. This is the canonical list for the RLM packages:
 * `plugin-rlm-verifier`'s subprocess scrub mirrors it and a consistency test
 * pins the two together.
 */
export const CREDENTIAL_BLOCKLIST_PREFIXES = [
  'DSH_', 'DEEPSEEK_', 'OPENAI_', 'ANTHROPIC_', 'GOOGLE_', 'AZURE_', 'AWS_',
  'PRIME_', 'PI_', 'CODEBUDDY_', 'CLAUDE_',
] as const
/**
 * Phase 8 (review round 6): credential variables with no shared prefix. The
 * prefix list alone let `GITHUB_TOKEN`/`NPM_TOKEN`/`HF_TOKEN`/`SSH_AUTH_SOCK`
 * ride through {@link buildScrubbedEnv} into the uv/bootstrap helper children.
 * These are exact-name (not prefix) blocks: `GITHUB_TOKEN` must never match a
 * hypothetical benign `GITHUB_TOKEN_SETTINGS`-style name either way.
 */
export const CREDENTIAL_BLOCKLIST_EXACT = [
  'GITHUB_TOKEN', 'GH_TOKEN', 'GITLAB_TOKEN', 'NPM_TOKEN', 'NODE_AUTH_TOKEN',
  'HF_TOKEN', 'HUGGING_FACE_TOKEN', 'SSH_AUTH_SOCK',
] as const
const BLOCKLIST_PREFIXES = CREDENTIAL_BLOCKLIST_PREFIXES
const BLOCKLIST_EXACT = CREDENTIAL_BLOCKLIST_EXACT

function nameFolder(platform: NodeJS.Platform): (key: string) => string {
  return platform === 'win32' ? key => key.toLowerCase() : key => key
}

/**
 * Build a default-deny environment for a kernel process.
 *
 * @param overrides - Merged into the result after filtering, without
 *   re-screening. Callers pass internal `RLM_*` wiring only (e.g.
 *   `RLM_SESSION_DIR`); do not route user-controlled values through here.
 * @param platform - Target platform semantics; defaults to the current one.
 *   Parameterized so both case regimes are testable on any host.
 * @param source - Environment to filter; defaults to `process.env`. Injectable
 *   so tests exercise either case regime deterministically (a worker thread's
 *   `process.env` may uppercase names, which would otherwise pin the observable
 *   casing to the host).
 * @returns A fresh env object safe to hand to `spawn` for a kernel.
 */
export function buildKernelEnv(
  overrides?: Record<string, string>,
  platform: NodeJS.Platform = process.platform,
  source: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const fold = nameFolder(platform)
  const allowPrefixes = ALLOWLIST_PREFIXES.map(fold)
  const allowExact = new Set([...ALLOWLIST_EXACT].map(fold))
  const blockPrefixes = BLOCKLIST_PREFIXES.map(fold)
  const blockExact = new Set(BLOCKLIST_EXACT.map(fold))

  const filtered: Record<string, string> = {}
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue
    const probe = fold(key)
    if (blockPrefixes.some(prefix => probe.startsWith(prefix))) continue
    if (blockExact.has(probe)) continue
    if (allowPrefixes.some(prefix => probe.startsWith(prefix)) || allowExact.has(probe)) {
      filtered[key] = value
    }
  }
  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      if (value !== undefined) filtered[key] = value
    }
  }
  return filtered
}

/**
 * Build a credential-scrubbed environment for helper children that need a
 * broad environment (uv installer, bootstrap shell steps). Everything except
 * {@link BLOCKLIST_PREFIXES}-matching names passes through unchanged, so
 * proxy/XDG/locale configuration survives; only secret-bearing namespaces
 * are stripped.
 *
 * @param platform - Case-folding regime; see {@link buildKernelEnv}.
 * @param source - Environment to scrub; defaults to `process.env`.
 * @returns A fresh env object with {@link BLOCKLIST_PREFIXES}-matching
 *   names removed, safe to hand to `spawn` for a helper child.
 */
export function buildScrubbedEnv(
  platform: NodeJS.Platform = process.platform,
  source: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const fold = nameFolder(platform)
  const blockPrefixes = BLOCKLIST_PREFIXES.map(fold)
  const blockExact = new Set(BLOCKLIST_EXACT.map(fold))
  const scrubbed: Record<string, string> = {}
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue
    const probe = fold(key)
    if (blockPrefixes.some(prefix => probe.startsWith(prefix))) continue
    if (blockExact.has(probe)) continue
    scrubbed[key] = value
  }
  return scrubbed
}
