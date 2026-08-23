/**
 * Python-side bridge for the `verify` tool.
 *
 * The heavy lifting (Eq 3.1 fine-grained reward, Eq 3.2 Bradley-Terry, PPT
 * best-of-N) lives in the `llm_verifier` Python package. This module builds
 * the small Python program that drives it and runs it either through the
 * session's persistent IPython kernel (when one is already provisioned) or
 * through a spawned venv python subprocess.
 * @module @deepseek-ai/dsh-plugin-rlm-verifier
 */

import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import path from 'node:path'
// P1-fix: 统一走 rlmEnv()（新名优先、旧名回退、Windows 大小写不敏感），
// 替代此前直接用 process.env.DSH_RLM_KERNEL_* 的双轨读取。
import { rlmEnv, ENV_KERNEL_PYTHON, ENV_KERNEL_VENV } from '@deepseek-ai/dsh-plugin-rlm-kernel/src/env.ts'
// Canonical credential blocklist shared with the kernel's env boundary — one
// source of truth, no drift between the two subprocess scrubs.
import { CREDENTIAL_BLOCKLIST_PREFIXES } from '@deepseek-ai/dsh-plugin-rlm-kernel/src/kernel-env.ts'

/** A minimal view of the kernel registry the verify tool can execute cells through. */
export interface KernelExecutor {
  hasSession(sessionId: string): boolean
  execute(sessionId: string, code: string, opts?: { signal?: AbortSignal; maxOutputChars?: number }): Promise<{
    stdout: string
    stderr: string
    result?: string
    status: string
    error?: { ename: string; evalue: string; traceback: string[] }
  }>
}

/** A single candidate trajectory + optional per-candidate score hint. */
export interface VerifyCandidate {
  /** The trajectory / solution text. */
  text: string
}

/** What the verify tool asks for. */
export interface VerifyRequest {
  problem: string
  candidates: VerifyCandidate[]
  /** Criteria as {name, description} pairs; defaults to the bundled tri-criteria. */
  criteria?: Record<string, string>
  /** Repeated evaluations K (Eq 3.1 outer sum). Default 4. */
  nEvaluations?: number
  /** PPT pivots k. Default 2. */
  pivots?: number
  /** Random seed for the ring pass. Default 0. */
  seed?: number
  /** Verifier model name. Default deepseek-v4-flash (DeepSeek). */
  model?: string
  /** Optional JSON score-cache path for incremental re-runs. */
  cache?: string
}

export interface VerifyResult {
  /** Index of the selected best candidate. */
  index: number
  /** Per-candidate normalized tournament scores (w_i / c_i). */
  scores: number[]
  /** Candidate indices ordered best-first. */
  ranking: number[]
  /** Number of directed pairwise comparisons performed. */
  nComparisons: number
  /** Criteria ids used. */
  criteria: string[]
  /** Raw verifier text (the model's analysis), when captured. */
  analysis?: string
}

/** Parse a JSON object out of a cell's stdout, tolerating surrounding text. */
export function parseResultJson(stdout: string): VerifyResult {
  const text = stdout.trim()
  // The Python program prints a single line: {"index":...,"scores":...,...}
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) {
    throw new Error(`verify: no JSON result in python output: ${text.slice(0, 500)}`)
  }
  const raw = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
  // The Python side emits snake_case; the TS surface uses camelCase.
  const out: VerifyResult = {
    index: Number(raw.index ?? -1),
    scores: Array.isArray(raw.scores) ? (raw.scores as number[]) : [],
    ranking: Array.isArray(raw.ranking) ? (raw.ranking as number[]) : [],
    nComparisons: Number(raw.n_comparisons ?? raw.nComparisons ?? 0),
    criteria: Array.isArray(raw.criteria) ? (raw.criteria as string[]) : [],
  }
  if (typeof raw.analysis === 'string') out.analysis = raw.analysis
  return out
}

/**
 * Hard ceiling on the base64-encoded payload size (in bytes) when embedded in
 * the Python program source.  Beyond this, the generated source line risks
 * hitting Jupyter shell message limits, Python parser constraints on string
 * literal length, or excessive memory use in the kernel.  Callers hitting this
 * limit should reduce candidate count or truncate candidate text.
 */
export const MAX_PAYLOAD_B64_BYTES = 1_000_000 // ~750 KB of JSON pre-encoding.

/**
 * The Python program that runs llm_verifier.select().
 *
 * Reads its request from (in order): a base64 payload embedded in the program
 * source (kernel path — the kernel process was spawned with its own env
 * snapshot, so a `PY_VERIFY_PAYLOAD` env var set now would never reach it),
 * the `PY_VERIFY_PAYLOAD` env var (subprocess path), or argv[1] (JSON file).
 * Prints one JSON line with the result, or `VERIFY_ERROR {...}` on failure.
 * A standalone `llm_verifier` install is required in the target python env.
 *
 * @throws {Error} If the base64-encoded payload exceeds {@link MAX_PAYLOAD_B64_BYTES}.
 */
export function buildPythonProgram(payload?: VerifyRequest | null): string {
  // The payload is embedded base64-encoded so kernel-cell transport carries it
  // in-band; JSON with arbitrary candidate text would need escaping inside a
  // Python string literal, base64 needs none.
  const payloadJson = payload ? JSON.stringify(payload) : ''
  const payloadB64 = payloadJson ? Buffer.from(payloadJson, 'utf8').toString('base64') : ''
  if (Buffer.byteLength(payloadB64, 'utf8') > MAX_PAYLOAD_B64_BYTES) {
    const candidateCount = payload?.candidates.length ?? 0
    const totalChars = payload?.candidates.reduce((sum, c) => sum + c.text.length, 0) ?? 0
    throw new Error(
      `verify payload too large for in-band transport: base64 size ${Buffer.byteLength(payloadB64, 'utf8')} bytes ` +
        `exceeds limit ${MAX_PAYLOAD_B64_BYTES} bytes. ` +
        `You have ${candidateCount} candidates totaling ${totalChars} chars. ` +
        'Reduce candidate count or truncate candidate text.',
    )
  }
  return [
    'import base64, json, os, sys, traceback',
    `_PAYLOAD_B64 = ${JSON.stringify(payloadB64)}`,
    'def _main():',
    '    if _PAYLOAD_B64:',
    '        payload = json.loads(base64.b64decode(_PAYLOAD_B64))',
    '    elif os.environ.get("PY_VERIFY_PAYLOAD"):',
    '        payload = json.loads(os.environ["PY_VERIFY_PAYLOAD"])',
    '    else:',
    '        payload = json.load(open(sys.argv[1]))',
    '    import llm_verifier',
    '    criteria = payload.get("criteria") or {}',
    '    result = llm_verifier.select(',
    '        problem=payload["problem"],',
    '        candidates=[c["text"] for c in payload["candidates"]],',
    '        criteria=criteria,',
    '        n_evaluations=payload.get("nEvaluations", 4),',
    '        pivots=payload.get("pivots", 2),',
    '        seed=payload.get("seed", 0),',
    '        model=payload.get("model", "deepseek-v4-flash"),',
    '        cache=payload.get("cache") or None,',
    '        progress=False,',
    '    )',
    '    out = {"index": result.index, "scores": result.scores,',
    '           "ranking": result.ranking, "n_comparisons": result.n_comparisons,',
    '           "criteria": result.criteria}',
    '    print("VERIFY_RESULT " + json.dumps(out))',
    'try:',
    '    _main()',
    'except SystemExit:',
    '    raise',
    'except Exception as e:',
    '    print("VERIFY_ERROR " + json.dumps({"error": str(e), "tb": traceback.format_exc()}))',
    '    sys.exit(1)',
  ].join('\n')
}

/** Default venv python path for the RLM kernel (Windows vs POSIX layout). */
export function defaultVenvPython(): string {
  // P1-fix: 统一走 rlmEnv()，支持新名/旧名回退 + Windows 大小写不敏感。
  const override = rlmEnv(...ENV_KERNEL_PYTHON)
  if (override) return override
  const venv = rlmEnv(...ENV_KERNEL_VENV) ?? path.join(homedir(), '.prime', 'agent', 'kernel-venv')
  return process.platform === 'win32'
    ? path.join(venv, 'Scripts', 'python.exe')
    : path.join(venv, 'bin', 'python')
}

/** Spawn a python subprocess running the verify program, returning its stdout. */
export function runVerifySubprocess(
  python: string,
  program: string,
  payload: VerifyRequest & { criteria?: Record<string, string> },
  options?: { signal?: AbortSignal },
): Promise<string> {
  return new Promise((resolve, reject) => {
    // P1-fix: env 白名单化，排除凭据类变量（与 plugin-rlm-kernel/src/kernel-env.ts
    // 的 CREDENTIAL_BLOCKLIST_PREFIXES 同步，一致性由 python-bridge.spec.ts 钉住）。
    const { PY_VERIFY_PAYLOAD: _, ...safeEnv } = buildScrubbedSubprocessEnv()
    const child = spawn(python, ['-c', program], {
      env: {
        ...safeEnv,
        ...forwardProviderCredentials(),
        PY_VERIFY_PAYLOAD: JSON.stringify(payload),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    const onAbort = () => {
      child.kill('SIGTERM')
    }
    options?.signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', (d: Buffer) => { out += d.toString() })
    child.stderr.on('data', (d: Buffer) => { err += d.toString() })
    child.on('error', reject)
    child.on('close', (code) => {
      options?.signal?.removeEventListener('abort', onAbort)
      // The program prints `VERIFY_ERROR {...}` to stdout before exiting 1;
      // surface that message instead of a bare exit code.
      if (code === 0) {
        resolve(out)
      } else if (out.includes('VERIFY_ERROR')) {
        reject(new Error(`verify python failed: ${out.slice(0, 1000)}`))
      } else {
        reject(new Error(`verify python subprocess exited ${code}: ${err.slice(0, 1000)}`))
      }
    })
  })
}

/**
 * Provider variables `llm_verifier` authenticates with. The subprocess runs a
 * fixed generated program (never model-authored code), so these are required
 * inputs rather than leaks — forwarded explicitly on top of the scrubbed env,
 * everything else credential-shaped stays stripped.
 */
const PROVIDER_CREDENTIAL_VARS = ['DEEPSEEK_API_KEY', 'OPENAI_BASE_URL'] as const

/**
 * Pick {@link PROVIDER_CREDENTIAL_VARS} out of an environment.
 *
 * @param source - Environment to read; defaults to `process.env`.
 * @returns Only the provider variables that are present, ready to merge over a
 *   scrubbed child env.
 */
export function forwardProviderCredentials(source: Record<string, string | undefined> = process.env): Record<string, string> {
  const forwarded: Record<string, string> = {}
  for (const name of PROVIDER_CREDENTIAL_VARS) {
    const value = source[name]
    if (value !== undefined) forwarded[name] = value
  }
  return forwarded
}

/**
 * Build a credential-scrubbed environment for spawned python subprocesses.
 *
 * Mirrors the deny-list half of `plugin-rlm-kernel/src/kernel-env.ts` — same
 * prefix families, matched case-insensitively on every platform (a Windows
 * `deepseek_api_key` lookalike must not slip through exact-case matching).
 * The verifier needs the broad environment (proxy/locale), so unlike the
 * kernel's default-deny allowlist everything non-credential passes through;
 * callers re-add the provider credentials via {@link forwardProviderCredentials}.
 *
 * @param source - Environment to scrub; defaults to `process.env`. Injectable
 *   so tests exercise scrubbing deterministically without mutating the host.
 */
export function buildScrubbedSubprocessEnv(source: Record<string, string | undefined> = process.env): Record<string, string> {
  const blockPrefixes = CREDENTIAL_BLOCKLIST_PREFIXES.map(prefix => prefix.toUpperCase())
  const safe: Record<string, string> = {}
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue
    if (blockPrefixes.some(prefix => key.toUpperCase().startsWith(prefix))) continue
    safe[key] = value
  }
  return safe
}
