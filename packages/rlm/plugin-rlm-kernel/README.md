# @deepseek-ai/dsh-plugin-rlm-kernel

English | [中文](README.zh.md)

RLM family shared substrate. It adapts the harness `SubagentRuntime` so the verifier and MOA plugins can borrow the subagent fleet for scoring and reference calls, and exposes the `redactReference` contract and the shared `dataDir` resolver the other rlm plugins depend on.

## Config

| Config | Type | Default | Description |
|---|---|---|---|
| `dataDir` | string | `~/.dsh/rlm` | Harness base dir the rlm plugins share for landing state and artifacts; must match the verifier/MOA/loop/continual-harness `dataDir`. |
| `python` | string | — | Python interpreter with ipykernel + prime-agent-runtime; omitted → auto-bootstrapped venv. |
| `subagentProvider` | string | `spawn` | Subagent provider name used by `rlm.run`. |
| `idleTimeoutMs` | number | `600000` | Idle timeout before a session's kernel is reclaimed (dill snapshot preserves state); `0` disables. |
| `maxOutputChars` | number | `65536` | Cap on cell output text returned to the model. |
| `snapshotDebounceMs` | number | `1500` | Auto-snapshot debounce after a successful cell. |
| `snapshotHistory` | number | `3` | Retained dill snapshots (`kernel-state.<n>.dill`); `0` disables rotation. |
| `warmupOnSessionCreate` | boolean | `false` | Provision the kernel at session/created instead of the first ipython call. |
| `maxLiveKernels` | number | `4` | Cap on concurrently live kernels (0 = unlimited); over-cap evicts oldest non-busy LRU-first. |
| `reclaimSnapshotGraceMs` | number | `5000` | Grace before a leased over-cap kernel retries its forced eviction snapshot. |
| `maxChildrenPerSession` | number | `8` | Live `rlm.run` children allowed per parent session (one-shot + retained, in-flight counted). |
| `maxRunPromptChars` | number | `24000` | Character cap on a single `rlm.run` prompt. |
| `subcallModel` | string | — | T7.10 `llm.query` route selector (LAYERS.md §2.3 R2): the model used when the kernel caller does not name one. Omit it to run subcalls on the owning agent's own model (no downgrade). |
| `maxInFlightSubcalls` | number | `8` | T7.10 (R1): in-flight `llm.query` subcall streams allowed per owning session; exceeding it fails loud naming the key. |
| `maxSubcallBatch` | number | `32` | T7.10 (R1): max prompts in one `llm.query` batch request. |
| `maxSubcallAnswerChars` | number | `8000` | T7.10: char cap per subcall answer; longer answers are truncated and flagged. |
| `subcallTimeoutMs` | number | `120000` | T7.10 (T7.3 semantics): wall-clock budget per subcall generation; expiry aborts the attempt. |

## Behavior: `llm.query` subcall bridge

The kernel bootstrap injects `llm_query(prompt | prompts, **kwargs)`; the host's 8th bridge handler executes each subcall through the LLM seam with `purpose: 'rlm-subcall'` attribution. Arrays are batches (the paper's `llm_batch` analog). Degenerate answers (empty, trivially short, or self-repeating — prime Appendix F.1's "sub-LM gives up" pattern) are retried once and, if still degenerate, returned with a `degenerate` flag so the kernel caller decides its own chunking. Every answer over `maxSubcallAnswerChars` is truncated and flagged; a bounced/failed generation throws. Each batch appends a log-only `session/subcall-query` event (batch size, resolved model, per-answer char counts, truncation flags, retries, duration, optional caller `use`/`depth` tags) — the LAYERS.md §5 evaluation data source.

## Behavior: `rlm_dag` orchestration skill (LAYERS.md §4.1)

`skills/rlm_dag/` ships the DAG orchestration protocol as a python-skill package: plan subcalls into layers, dispatch each layer as one `llm_query` batch, verify every answer with the cheapest deterministic check before it propagates, retry rejected rounds with fresh seeds, and assemble the plain result dict ("Root compute = dict lookup, string formatting, correctness checks"). Deploy by copying the package to `<dataDir>/skills/rlm_dag/` and registering a global harness skill entry (`reference: { type: 'python', import: 'rlm_dag', callable: 'run' }`), the same path as the loop-audit skill. The preset persona carries the "when not to recurse" discipline; automatic depth/use routing waits for the LAYERS.md §5 evaluation data.

## Behavior: kernel-state restore notice

When a session is provisioned from a dill snapshot, `appendRestoreNotice` injects a `user/message` (`source.form: 'notice'`, `surfaceOp: 'append'`) into the resolved session immediately after `restoreState()`. The body lists revived variables in an `<ipython_state_restored>` block and any lost entries separately, so the model sees the restored namespace before it issues the next cell. An empty restore result is a silent no-op. This complements the existing `consumeRestoreNotice` (surfaced as a prefix on the next `!python` result).

## Behavior: post-compaction kernel-state notice

After a compaction completes, the plugin's `session/event` subscription forwards `compaction/end` to `notifyCompactionEnd`. If a live kernel exists for that session, `appendPostCompactionNotice` lists the kernel's surviving top-level variable names (via the vendored `KernelManager.listNamespaceNames`) and injects them in an `<ipython_state>` block (`source.form: 'notice'`), mirroring prime-agent's `_syncKernelStateAfterCompaction`. The message tells the model the persistent kernel kept running through the compaction, so every variable, import, and helper defined before the checkpoint is still live. An absent kernel or empty namespace is a silent no-op. (Unlike prime, this build does not prune oversized variables before reporting, so the notice lists only surviving names, never discarded ones.)

## Model Experience

### Scoring delegation

#### What the model sees

The kernel emits no model-facing text itself; it hands the verifier and MOA plugins a `SubagentRuntime` so their scoring prompts reach the model through the ordinary subagent channel with `purpose` attribution.

#### Token effect

No tokens are produced by the kernel; it adds one borrowed subagent call per scoring request the consuming plugin chooses to make.

#### KV Cache effect

Stateless in the request path: it resolves the shared `dataDir` and redactor closure once at mount, so it never edits earlier request tokens.

## Known Limitations and Deferred Work

- The kernel's `dataDir` must match the verifier/MOA/loop/continual-harness `dataDir`; a mismatch strands landed state under a different root.
- Real-runtime mounting awaits the same dependency-closure fix as the other rlm plugins (`apps/cli` does not depend on rlm packages); until then the kernel reaches sessions via explicit `ctx.plugin()` mounting or vitest-toolchain compositions.
