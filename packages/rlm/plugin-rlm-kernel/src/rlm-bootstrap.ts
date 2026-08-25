/**
 * RLM bootstrap code that is executed in every fresh kernel, plus the
 * callable-skill wrapper. Vendored from `prime-agent` `tools/ipython.ts`
 * (UPSTREAM_COMMIT af0b8e0), MIT License.
 * @module @deepseek-ai/dsh-plugin-rlm-kernel
 */

import type { PythonSkillRuntimeInfo } from './vendor/kernel/bootstrap.ts'

const RLM_BOOTSTRAP_BASE_CODE = `
import asyncio
import os as _prime_agent_os

_prime_agent_os.environ["NO_COLOR"] = "1"
get_ipython().colors = "nocolor"

try:
    import nest_asyncio as _prime_agent_nest_asyncio
    _prime_agent_nest_asyncio.apply()
except Exception:
    pass

try:
    import rlm as _prime_agent_rlm_module
    rlm = _prime_agent_rlm_module.rlm
except Exception as _prime_agent_rlm_error:
    _PRIME_AGENT_RLM_IMPORT_ERROR = str(_prime_agent_rlm_error)

    class _PrimeAgentMissingRlm:
        def _raise_missing(self):
            raise RuntimeError(
                "prime-agent-runtime is not installed in this IPython kernel. "
                "Remove ~/.prime/agent/kernel-venv so the runtime can rebuild it, or set "
                "DSH_RLM_KERNEL_PYTHON (legacy PRIME_AGENT_KERNEL_PYTHON) to a kernel environment with prime-agent-runtime installed. "
                f"Import error: {_PRIME_AGENT_RLM_IMPORT_ERROR}"
            )

        async def run(self, prompt, **kwargs):
            self._raise_missing()

        async def find_models(self, query="", limit=8):
            self._raise_missing()

        async def list_subagents(self):
            self._raise_missing()

        async def delete_subagent(self, target):
            self._raise_missing()

        async def __call__(self, prompt, **kwargs):
            return await self.run(prompt, **kwargs)

    rlm = _PrimeAgentMissingRlm()

    class _PrimeAgentTranscript:
        """Programmatic read access to this session's own transcript.

        Backed by the host read-only session.query bridge: the model can
        inspect and search its own history as data (prompt-as-a-variable)
        instead of relying on memory alone. Output is capped host-side.
        """

        async def _query(self, payload):
            return await rlm.host_request("session.query", payload)

        async def tail(self, n=20, max_chars=2000):
            result = await self._query({"op": "tail", "n": n, "maxChars": max_chars})
            return result.get("messages", [])

        async def grep(self, pattern, limit=50, max_chars=2000):
            result = await self._query({"op": "grep", "pattern": pattern, "limit": limit, "maxChars": max_chars})
            return result.get("messages", [])

    transcript = _PrimeAgentTranscript()
`.trim()

/**
 * Build the Python bootstrap for a fresh kernel: base RLM runtime injection,
 * then optional callable-skill wrappers keyed by import name.
 */
export function buildRlmBootstrapCode(pythonSkills: readonly PythonSkillRuntimeInfo[] = []): string {
  const importNames = [...new Set(pythonSkills.map(skill => skill.importName))]
  if (importNames.length === 0) {
    return RLM_BOOTSTRAP_BASE_CODE
  }

  return `
${RLM_BOOTSTRAP_BASE_CODE}

import importlib as _prime_agent_importlib
import inspect as _prime_agent_inspect
import sys as _prime_agent_sys
import types as _prime_agent_types

class _PrimeAgentCallableSkillModule(_prime_agent_types.ModuleType):
    async def __call__(self, *args, **kwargs):
        result = self.run(*args, **kwargs)
        if _prime_agent_inspect.isawaitable(result):
            return await result
        return result

class _PrimeAgentUnavailableSkill:
    def __init__(self, name, error):
        self.__name__ = name
        self._prime_agent_import_error = error
        self.__doc__ = f"Python skill {name} is unavailable: {error}"

    async def run(self, *args, **kwargs):
        raise RuntimeError(
            f"Python skill {self.__name__} is unavailable in this IPython kernel. "
            f"Import error: {self._prime_agent_import_error}"
        )

    async def __call__(self, *args, **kwargs):
        return await self.run(*args, **kwargs)

    def __repr__(self):
        return f"<unavailable Python skill {self.__name__!r}: {self._prime_agent_import_error}>"

def _prime_agent_wrap_skill_module(module):
    run = getattr(module, "run", None)
    if not callable(run):
        return module
    if isinstance(module, _PrimeAgentCallableSkillModule):
        return module
    wrapped = _PrimeAgentCallableSkillModule(module.__name__)
    wrapped.__dict__.update(module.__dict__)
    try:
        wrapped.__signature__ = _prime_agent_inspect.signature(run)
    except Exception:
        pass
    doc = getattr(run, "__doc__", None)
    if doc:
        wrapped.__doc__ = doc
    _prime_agent_sys.modules[module.__name__] = wrapped
    return wrapped

_PRIME_AGENT_SKILL_IMPORT_ERRORS = {}

for _prime_agent_skill_name in ${JSON.stringify(importNames)}:
    try:
        globals()[_prime_agent_skill_name] = _prime_agent_wrap_skill_module(
            _prime_agent_importlib.import_module(_prime_agent_skill_name)
        )
    except Exception as _prime_agent_skill_error:
        _PRIME_AGENT_SKILL_IMPORT_ERRORS[_prime_agent_skill_name] = str(_prime_agent_skill_error)
        globals()[_prime_agent_skill_name] = _PrimeAgentUnavailableSkill(
            _prime_agent_skill_name,
            str(_prime_agent_skill_error),
        )
`.trim()
}
