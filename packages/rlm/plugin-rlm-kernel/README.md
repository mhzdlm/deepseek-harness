# @deepseek-ai/dsh-plugin-rlm-kernel

English | [中文](README.zh.md)

Persistent IPython kernel as the model's primary tool, for the rlm family. It registers the `ipython` tool (backed by a per-session `KernelManager` vendored from prime-agent, see `src/vendor/UPSTREAM`), the `create_python_skill` tool, wires the kernel's `host.request` bridge to dsh services (`rlm.run` → `ctx.subagents.start`; `llm.query` → the host LLM seam), provides the `rlm.kernels` Cordis service (the `SessionKernelRegistry`) so sibling plugins can run cells through the same persistent kernel, and disposes kernels on `session/disposed`.

## Config

| Config | Type | Default | Description |
|---|---|---|---|
| `dataDir` | string | `~/.dsh/rlm` | Root for kernel artifacts; must match the other rlm plugins' `dataDir`. |
| `python` | string | — | Python interpreter with ipykernel + prime-agent-runtime; omitted → auto-bootstrapped venv. |
| `subagentProvider` | string | `spawn` | Subagent provider used by `rlm.run`. |
| `idleTimeoutMs` | number | `600000` | Idle timeout before a session's kernel is reclaimed (dill snapshot preserves state); `0` disables. |
| `maxOutputChars` | number | `65536` | Cap on cell output text returned to the model. |
| `snapshotDebounceMs` | number | `1500` | Auto-snapshot debounce after a successful cell. |
| `snapshotHistory` | number | `3` | Retained dill snapshots (`kernel-state.<n>.dill`); `0` disables rotation. |
| `warmupOnSessionCreate` | boolean | `false` | Provision the kernel at `session/created` instead of the first ipython call. |
| `maxLiveKernels` | number | `4` | Cap on concurrently live kernels (0 = unlimited); over-cap evicts oldest non-busy LRU-first (leased ones only after a forced snapshot succeeds). |
| `reclaimSnapshotGraceMs` | number | `5000` | Grace before a leased over-cap kernel retries its forced eviction snapshot. |
| `maxChildrenPerSession` | number | `8` | Outstanding `rlm.run` children per parent session before further spawns fail loud. |
| `maxRunPromptChars` | number | `24000` | Character cap on a single `rlm.run` prompt. |
| `subcallModel` | string | — | T7.10 `llm.query` route selector: the model used when the kernel caller does not name one. Omit to run subcalls on the owning agent's own model (no downgrade). |
| `maxInFlightSubcalls` | number | `8` | In-flight `llm.query` subcall streams per owning session. |
| `maxSubcallBatch` | number | `32` | Max prompts in one `llm.query` batch. |
| `maxSubcallAnswerChars` | number | `8000` | Char cap per subcall answer; longer answers are truncated and flagged. |
| `subcallTimeoutMs` | number | `120000` | Wall-clock budget per subcall generation. |
| `maxSubcallPromptChars` | number | `100000` | Char cap per `llm.query` prompt. |
| `maxSessionSubcalls` | number | `200` | Cumulative `llm.query` calls per session before further batches fail loud. |
| `maxSessionSubcallChars` | number | `1000000` | Cumulative answer characters per session. |
| `maxRecursionDepth` | number | `2` | Code-enforced recursion ceiling — `llm.query` calls at or above this `depth` fail loud; `0` disables subcalls entirely. |

## Tools

- `ipython` (`code`) — execute Python in the session's persistent REPL; variables and imports survive across calls; the kernel can await host services via `rlm` (`await rlm("sub-task")`). Output is capped at `maxOutputChars`; overflow is archived under the session's artifacts.
- `create_python_skill` (`name`, `import_name`, `title`, `description`, `callable` default `run`) — register a python-backed skill already written to `<dataDir>/skills/<name>/` (setuptools `pyproject.toml` + module exposing an async `run(...)`), making it callable in the kernel as `await <import>(...)` after the next provision. Fails loud when the files on disk do not match.

## Service: `rlm.kernels`

`apply` provides the `SessionKernelRegistry`. Sibling plugins (e.g. `plugin-rlm-verifier`) may run their own cells through the same persistent kernel; the plugin stays fully functional when nothing injects it.

## Venv

With `python` omitted, the registry auto-bootstraps a venv (uv-installed interpreter, ipykernel + prime-agent-runtime); the bootstrap child rides a scrubbed environment (`src/env.ts`) so model-reachable kernel processes never inherit host secrets. At each provision, harness skill entries drive the venv's python-skill installs (`collectPythonSkills` re-reads `<dataDir>/skills/` per provision, so edits flow without a restart; non-slug ids or missing `pyproject.toml` are skipped with a warning).

## Behavior: `llm.query` subcall bridge

The kernel bootstrap injects `llm_query(prompt | prompts, **kwargs)`; the host bridge executes each subcall through the LLM seam with `purpose: 'rlm-subcall'` attribution. Arrays are batches. Degenerate answers (empty, trivially short, or self-repeating) are retried once and, if still degenerate, returned with a `degenerate` flag. Every answer over `maxSubcallAnswerChars` is truncated and flagged. Each batch appends a log-only `session/subcall-query` event.

## Behavior: `rlm.run` bridge

`rlm.run` maps to `ctx.subagents.start` under `subagentProvider`, bounded by `maxChildrenPerSession` and `maxRunPromptChars`; controllers are tracked per session and aborted on `session/disposed` so children cannot outlive their parent session.

## Skills directory

`skills/rlm_dag/` ships the DAG orchestration protocol as a python-skill package (LAYERS.md §4.1): plan subcalls into layers, dispatch each layer as one `llm_query` batch, verify every answer with the cheapest deterministic check before it propagates, retry rejected rounds with fresh seeds, and assemble a plain result dict. Deploy by copying the package to `<dataDir>/skills/rlm_dag/` and registering a global harness skill entry (`reference: { type: 'python', import: 'rlm_dag', callable: 'run' }`).

## Behavior: kernel-state notices

When a session is provisioned from a dill snapshot, `appendRestoreNotice` injects an `<ipython_state_restored>` notice listing revived variables (and lost entries separately); snapshot flushes append the log-only `session/kernel-snapshot` event. After a compaction, `compaction/end` is forwarded to `notifyCompactionEnd`, which injects an `<ipython_state>` notice listing surviving top-level names so the model knows the kernel kept running through the compaction.

## Known Limitations and Deferred Work

- The kernel's `dataDir` must match the verifier/MOA/loop/continual-harness `dataDir`; a mismatch strands landed state under a different root.
- The shared reference-text redactor no longer lives here — since Phase 10 it is the zero-dependency `@deepseek-ai/dsh-plugin-rlm-redact` package, so moa/verifier no longer import this package (and its native zeromq dependency chain) just to mask reference text.

## Status

Phase D (2026-09-01): the family's compute substrate — the persistent kernel, the `rlm.run` / `llm.query` host bridges, and the python-skill install path. Family overview: [packages/rlm/README.md](../README.md); family-level status: see BUILD.md in the docs repo.
