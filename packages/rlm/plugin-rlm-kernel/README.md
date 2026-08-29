# @deepseek-ai/dsh-plugin-rlm-kernel

English | [中文](README.zh.md)

RLM family shared substrate. It adapts the harness `SubagentRuntime` so the verifier and MOA plugins can borrow the subagent fleet for scoring and reference calls, and exposes the `redactReference` contract and the shared `dataDir` resolver the other rlm plugins depend on.

## Config

| Config | Type | Default | Description |
|---|---|---|---|
| `dataDir` | string | `~/.dsh/rlm` | Harness base dir the rlm plugins share for landing state and artifacts; must match the verifier/MOA/loop/continual-harness `dataDir`. |

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
