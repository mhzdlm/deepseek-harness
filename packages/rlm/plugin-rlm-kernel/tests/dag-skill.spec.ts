/**
 * Unit coverage for the rlm_dag kernel skill (LAYERS.md §4.1, T7.12): the
 * deterministic pieces (task validation, topological layering, placeholder
 * substitution) and the full async protocol against an injected fake
 * llm_query bridge — layer-batched dispatch, cheapest deterministic
 * verification, fresh-seed retry, and plain dict assembly. Executed in the
 * real venv interpreter (self-skips without one); no kernel is started.
 */
import { describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { getKernelVenvDir, venvPythonPath } from '../src/vendor/kernel/bootstrap.ts'
import { isKernelVenvReady } from './venv-gate.ts'

const execFileAsync = promisify(execFile)
const venvReady = isKernelVenvReady()
const dIt = venvReady ? it : it.skip

const SKILL_PATH = new URL('../skills/rlm_dag/rlm_dag.py', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

/**
 * Python harness: load rlm_dag from the skill source path, wrap `body` (the
 * body of an `async def _probe()` function) and print one JSON value.
 */
function pythonProbe(body: string): string {
  const indent = (text: string): string => text.split('\n').map(line => `    ${line}`).join('\n')
  return [
    'import asyncio, importlib.util, json',
    `spec = importlib.util.spec_from_file_location("rlm_dag", ${JSON.stringify(SKILL_PATH)})`,
    'mod = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(mod)',
    'async def _probe():',
    indent(body),
    'print(json.dumps(asyncio.run(_probe())))',
  ].join('\n')
}

async function runProbe(body: string): Promise<unknown> {
  const { stdout } = await execFileAsync(venvPythonPath(getKernelVenvDir()), ['-c', pythonProbe(body)], { timeout: 120_000 })
  const line = stdout.trim().split('\n').filter(Boolean).pop()
  return JSON.parse(line ?? 'null') as unknown
}

describe('rlm_dag skill (LAYERS.md §4.1)', () => {
  dIt('rejects malformed task shapes: duplicate ids, unknown deps, empty prompts', async () => {
    await expect(runProbe('mod.validate_tasks([{"id": "a", "prompt": "x"}, {"id": "a", "prompt": "y"}])')).rejects.toThrow()
    await expect(runProbe('mod.validate_tasks([{"id": "a", "prompt": "x"}, {"id": "b", "prompt": "y", "depends_on": ["nope"]}])')).rejects.toThrow()
    await expect(runProbe('mod.validate_tasks([{"id": "a", "prompt": "  "}])')).rejects.toThrow()
    // A self-dependency is tolerated and filtered (no back-edge).
    await expect(runProbe('mod.validate_tasks([{"id": "a", "prompt": "x", "depends_on": ["a"]}])')).resolves.toBeNull()
  })

  dIt('layers a linear chain and a diamond into parallel layers; cycles raise', async () => {
    const chain = await runProbe('return mod.layers([{"id": "a", "prompt": "1"}, {"id": "b", "prompt": "2", "depends_on": ["a"]}, {"id": "c", "prompt": "3", "depends_on": ["b"]}])')
    expect(chain).toEqual([['a'], ['b'], ['c']])

    const diamond = await runProbe('return mod.layers([{"id": "root", "prompt": "r"}, {"id": "x", "prompt": "x", "depends_on": ["root"]}, {"id": "y", "prompt": "y", "depends_on": ["root"]}, {"id": "z", "prompt": "z", "depends_on": ["x", "y"]}])')
    expect(diamond).toEqual([['root'], ['x', 'y'], ['z']])

    const cyclic = await runProbe(`
try:
    mod.layers([{"id": "a", "prompt": "1", "depends_on": ["b"]}, {"id": "b", "prompt": "2", "depends_on": ["a"]}])
    return "no-error"
except ValueError as exc:
    return str(exc)
`)
    expect(String(cyclic)).toContain('cyclic')
  })

  dIt('substitutes computed answers into downstream prompts', async () => {
    const out = await runProbe('return mod.substitute("wrap {{parse}} now", {"parse": "the parsed value"})')
    expect(out).toBe('wrap the parsed value now')
  })

  dIt('executes a two-layer DAG: one batched call per layer, answers propagate', async () => {
    const out = await runProbe(`
calls = []
async def fake(prompt=None, prompts=None, **kw):
    calls.append(prompts if prompts is not None else prompt)
    if prompts is not None:
        return {"answers": ["parsed:" + p for p in prompts], "degenerate": False}
    return {"answers": ["final:" + prompt], "degenerate": False}
tasks = [
    {"id": "parse", "prompt": "extract"},
    {"id": "format", "prompt": "format {{parse}}", "depends_on": ["parse"]},
]
result = await mod.run(tasks, llm_query=fake)
return [result, calls]
`)
    expect(out as unknown[]).toEqual([
      { parse: 'parsed:extract', format: 'parsed:format parsed:extract' },
      [['extract'], ['format parsed:extract']],
    ])
  })

  dIt('a rejected answer is retried with a fresh seed; the retry landing wins', async () => {
    const out = await runProbe(`
async def fake(prompt=None, prompts=None, **kw):
    if prompts is not None:
        return {"answers": ["bad-a", "ok-b"], "degenerate": False}
    if prompt == "pa":
        return {"answers": ["good-a"], "degenerate": False}
    return {"answers": ["final:" + prompt], "degenerate": False}
tasks = [
    {"id": "a", "prompt": "pa"},
    {"id": "b", "prompt": "pb {{a}}", "depends_on": ["a"]},
]
def validator(text):
    return text not in ("bad-a",) and len(text.strip()) > 0
result = await mod.run(tasks, llm_query=fake, validator=validator, max_retries=1)
return result
`)
    // The batch round rejects only "bad-a"; the single retry lands "good-a",
    // then layer 2 dispatches b with the substituted answer.
    expect(out).toEqual({ a: 'good-a', b: 'final:pb good-a' })
  }, 60_000)

  dIt('a fully rejected DAG assembles an empty dict (bridge degenerate flagged)', async () => {
    const out = await runProbe(`
async def fake(prompt=None, prompts=None, **kw):
    if prompts is not None:
        return {"answers": ["x", "y"], "degenerate": True}
    return {"answers": ["retry"], "degenerate": True}
tasks = [
    {"id": "a", "prompt": "pa"},
    {"id": "b", "prompt": "pb {{a}}", "depends_on": ["a"]},
]
result = await mod.run(tasks, llm_query=fake, max_retries=1)
return result
`)
    expect(out).toEqual({})
  }, 60_000)
})
