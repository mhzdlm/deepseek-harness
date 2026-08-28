/**
 * Unit tests for the Python bootstrap injected into every fresh kernel
 * (`buildRlmBootstrapCode`): the base runtime import with its loud missing-
 * runtime fallback, and the deduplicated callable-skill wrapper section.
 */
import { describe, expect, it } from 'vitest'
import { buildRlmBootstrapCode, buildSkillImportProbe, parseSkillImportErrors } from '../src/rlm-bootstrap.ts'

describe('rlm bootstrap code', () => {
  it('base code wires the RLM runtime and fails loud when it is missing', () => {
    const code = buildRlmBootstrapCode()
    expect(code).toContain('rlm = _prime_agent_rlm_module.rlm')
    expect(code).toContain('_PrimeAgentMissingRlm')
    expect(code).toContain('DSH_RLM_KERNEL_PYTHON')
    // The fallback must also answer transcript/agent_message's host_request
    // route with the install guidance instead of an AttributeError.
    expect(code).toContain('async def host_request(self, request_type, payload=None):')
    // No skills → the wrapper section must be absent entirely.
    expect(code).not.toContain('_prime_agent_skill_name')
  })

  it('appends one import loop per unique skill import name', () => {
    const code = buildRlmBootstrapCode([
      { importName: 'weather' },
      { importName: 'calc' },
    ] as never)
    expect(code).toContain('for _prime_agent_skill_name in ["weather","calc"]:')
    expect(code).toContain('_prime_agent_wrap_skill_module')
  })

  it('deduplicates repeated skill import names', () => {
    const code = buildRlmBootstrapCode([
      { importName: 'weather' },
      { importName: 'weather' },
    ] as never)
    expect(code.match(/"weather"/g)).toHaveLength(1)
  })

  it('injects the transcript object backed by the session.query bridge', () => {
    const code = buildRlmBootstrapCode()
    expect(code).toContain('class _PrimeAgentTranscript')
    expect(code).toContain('transcript = _PrimeAgentTranscript()')
    expect(code).toContain('host_request("session.query", payload)')
    expect(code).toContain('async def tail(self, n=20, max_chars=2000):')
    expect(code).toContain('async def grep(self, pattern, limit=50, max_chars=2000):')
    expect(code).toContain('async def search(self, pattern, limit=20, max_chars=2000):')
  })

  it('injects the agent_message object for retained-child follow-ups', () => {
    const code = buildRlmBootstrapCode()
    expect(code).toContain('class _PrimeAgentMessage')
    expect(code).toContain('agent_message = _PrimeAgentMessage()')
    expect(code).toContain('host_request("rlm.message", payload)')
  })

  it('parses the skill import probe output for the T2.2 verification gate', () => {
    // Clean venv: empty object parses to no errors.
    expect(parseSkillImportErrors('{}\n')).toEqual({})
    // Failures recorded by the bootstrap loop surface verbatim.
    const stdout = 'some earlier print\n{"weather": "ModuleNotFoundError: no module named weather"}\n'
    expect(parseSkillImportErrors(stdout)).toMatchObject({ weather: /ModuleNotFoundError/ })
    // A broken probe (no JSON line) reports null so the gate can warn instead.
    expect(parseSkillImportErrors('Traceback: something else')).toBeNull()
    // The probe cell is emitted with the shared global name.
    expect(buildSkillImportProbe()).toContain('_PRIME_AGENT_SKILL_IMPORT_ERRORS')
  })
})

/**
 * Exec-based regression (binding fix): `transcript`/`agent_message` used to be
 * bound ONLY inside the missing-runtime branch, so every healthy kernel lacked
 * them entirely (T1.1/T1.2 broke silently). String-containment assertions above
 * cannot catch that shape of bug, so these cases EXECUTE the generated Python
 * in the real venv interpreter and assert bindings plus host-request routing
 * on both paths. Self-skips when the venv is missing.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { getKernelVenvDir, venvPythonPath } from '../src/vendor/kernel/bootstrap.ts'
import { isKernelVenvReady } from './venv-gate.ts'

const execFileAsync = promisify(execFile)
const venvReadyBootstrapSpec = isKernelVenvReady()
const dIt = venvReadyBootstrapSpec ? it : it.skip

/**
 * Retry wrapper for child `python -c` spawns: during the full suite, worker
 * threads booting REAL kernels create a short resource-storm window in which
 * CreateProcess can fail transiently (observed as an instant nonzero exit long
 * before our harness logic could matter). Assertion semantics stay strict —
 * only transport-level failures are retried; assertion mismatches throw.
 */
async function execPythonHarness(args: string[], attempts = 3): Promise<string> {
  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const { stdout } = await execFileAsync(venvPythonPath(getKernelVenvDir()), args, { timeout: 120_000 })
      return stdout
    } catch (err) {
      lastError = err
      await new Promise(resolve => setTimeout(resolve, 1_000 * (attempt + 1)))
    }
  }
  const detail = lastError instanceof Error ? `${lastError.message}\n${String((lastError as { stderr?: string }).stderr ?? '')}` : String(lastError)
  throw new Error(`python harness failed after ${attempts} attempts:\n${detail}`)
}

/**
 * Python harness: installs get_ipython (+ an rlm module stub on the healthy
 * path; None-in-sys.modules forces ImportError on the fallback path), execs
 * the generated bootstrap, then reports namespace bindings and how the two
 * bridges route. Every async probe is failure-captured so the fallback path
 * surfaces its install-guidance RuntimeError as data instead of crashing.
 */
function buildExecHarness(opts: { healthyStub: boolean }): string {
  const lines = [
    'import sys, types, json, asyncio, builtins',
    'class _FakeIPython:',
    '    colors = None',
    'builtins.get_ipython = lambda: _FakeIPython()',
  ]
  if (opts.healthyStub) {
    lines.push(
      'fake = types.ModuleType("rlm")',
      'class _FakeRlm: pass',
      'fake.rlm = _FakeRlm()',
      'async def _hr(request_type, payload=None):',
      '    return {"messages": [{"role": "stub", "text": request_type}]}',
      'fake.host_request = _hr',
      'sys.modules["rlm"] = fake',
    )
  } else {
    lines.push('sys.modules["rlm"] = None')
  }
  lines.push(
    'ns = {"__name__": "__bootstrap__"}',
    'BOOTSTRAP = json.loads(sys.argv[1])',
    'exec(compile(BOOTSTRAP, "bootstrap.py", "exec"), ns)',
    'def _probe(coro):',
    '    try:',
    '        return {"ok": asyncio.run(coro)}',
    '    except Exception as exc:',
    '        return {"error": str(exc)}',
    'names = sorted(n for n in ns if not n.startswith("_prime_agent") and n not in ("__builtins__", "asyncio", "os"))',
    'print(json.dumps({"names": names, "rlmClass": type(ns["rlm"]).__name__}))',
    'print(json.dumps(_probe(ns["transcript"].tail(5))))',
    'print(json.dumps(_probe(ns["agent_message"].send("hi"))))',
  )
  return lines.join('\n')
}

describe('generated bootstrap execution (binding regression)', () => {
  dIt('healthy path binds rlm/transcript/agent_message and routes both bridges', async () => {
    const code = buildRlmBootstrapCode()
    const stdout = await execPythonHarness(['-c', buildExecHarness({ healthyStub: true }), JSON.stringify(code)])
    const [info, tail, send] = stdout.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    if (!info || !tail || !send) throw new Error('incomplete probe output from exec harness')
    expect(info).toMatchObject({ rlmClass: '_FakeRlm' })
    expect(info.names).toEqual(expect.arrayContaining(['rlm', 'transcript', 'agent_message']))
    expect(tail).toEqual({ ok: [{ role: 'stub', text: 'session.query' }] })
    expect(send).toEqual({ ok: { messages: [{ role: 'stub', text: 'rlm.message' }] } })
  }, 180_000)

  dIt('missing-runtime path still binds the objects and fails with install guidance', async () => {
    const code = buildRlmBootstrapCode()
    const stdout = await execPythonHarness(['-c', buildExecHarness({ healthyStub: false }), JSON.stringify(code)])
    const [info, tail] = stdout.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    if (!info || !tail) throw new Error('incomplete probe output from exec harness')
    expect(info).toMatchObject({ rlmClass: '_PrimeAgentMissingRlm' })
    expect(info.names).toEqual(expect.arrayContaining(['transcript', 'agent_message']))
    expect(tail).toMatchObject({ error: expect.stringContaining('prime-agent-runtime is not installed') })
  }, 180_000)
})
