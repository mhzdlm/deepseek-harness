/**
 * item-8: dsh-native environment variable naming for the kernel plugin.
 *
 * All prime-named environment variables (`PRIME_AGENT_KERNEL_PYTHON`,
 * `PRIME_AGENT_CODING_AGENT_DIR`, …) gain a `DSH_RLM_*` alias. Reads go through
 * {@link rlmEnv}, which prefers the new name and falls back to the legacy one
 * for one compatibility release. The vendored kernel/harness files call this
 * helper (patches recorded in `vendor/UPSTREAM`).
 * @module @deepseek-ai/dsh-plugin-rlm-kernel
 */

/** Read the first set environment variable among `names` (new name first). */
export function rlmEnv(...names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]
    if (value !== undefined) return value
  }
  return undefined
}

/** Python interpreter override for the kernel venv. */
export const ENV_KERNEL_PYTHON = ['DSH_RLM_KERNEL_PYTHON', 'PRIME_AGENT_KERNEL_PYTHON'] as const
/** Explicit kernel venv directory override. */
export const ENV_KERNEL_VENV = ['DSH_RLM_KERNEL_VENV', 'PRIME_AGENT_KERNEL_VENV'] as const
/** Allow prime-agent to run the uv installer without prompting. */
export const ENV_INSTALL_UV = ['DSH_RLM_INSTALL_UV', 'PRIME_AGENT_INSTALL_UV'] as const
/** Cap on concurrent kernel bootstraps. */
export const ENV_MAX_CONCURRENT_BOOTS = ['DSH_RLM_MAX_CONCURRENT_BOOTS', 'PRIME_AGENT_MAX_CONCURRENT_KERNEL_BOOTS'] as const
/** Disable the kernel forkserver fast path. */
export const ENV_FORKSERVER = ['DSH_RLM_KERNEL_FORKSERVER', 'PRIME_AGENT_KERNEL_FORKSERVER'] as const
/** Coding-agent root dir read by the vendored `harness.py` fallback path. */
export const ENV_CODING_AGENT_DIR = ['DSH_RLM_CODING_AGENT_DIR', 'PRIME_AGENT_CODING_AGENT_DIR', 'PI_CODING_AGENT_DIR'] as const
