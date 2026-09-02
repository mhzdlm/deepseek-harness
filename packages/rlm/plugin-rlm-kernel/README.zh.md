# @deepseek-ai/dsh-plugin-rlm-kernel

[English](README.md) | 中文

持久 IPython 内核，作为模型的主工具，服务于 rlm 家族。它注册 `ipython` 工具（由按会话的 `KernelManager` 支撑，vendor 自 prime-agent，见 `src/vendor/UPSTREAM`）与 `create_python_skill` 工具，把内核的 `host.request` 桥接到 dsh 服务（`rlm.run` → `ctx.subagents.start`；`llm.query` → 宿主 LLM 缝），以 `rlm.kernels` Cordis 服务提供 `SessionKernelRegistry` 供兄弟插件共用同一持久内核，并在 `session/disposed` 时销毁内核。

## 配置

| 配置 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `dataDir` | string | `~/.dsh/rlm` | 内核产物根目录；必须与其他 rlm 插件的 `dataDir` 一致。 |
| `python` | string | — | 带 ipykernel + prime-agent-runtime 的 Python 解释器；缺省 → 自动引导 venv。 |
| `subagentProvider` | string | `spawn` | `rlm.run` 使用的子代理 provider。 |
| `idleTimeoutMs` | number | `600000` | 会话内核空闲多久后被回收（dill 快照保留状态）；`0` 关闭。 |
| `maxOutputChars` | number | `65536` | 返回给模型的 cell 输出文本上限。 |
| `snapshotDebounceMs` | number | `1500` | 成功 cell 后的自动快照去抖。 |
| `snapshotHistory` | number | `3` | 保留的 dill 快照数（`kernel-state.<n>.dill`）；`0` 关闭轮转。 |
| `warmupOnSessionCreate` | boolean | `false` | 在 `session/created` 时而非首次 ipython 调用时制备内核。 |
| `maxLiveKernels` | number | `4` | 并发存活内核上限（0 = 不限）；超限按 LRU 逐出最旧非忙内核（带租约的须先强制快照成功）。 |
| `reclaimSnapshotGraceMs` | number | `5000` | 带租约超限内核重试强制逐出快照前的宽限。 |
| `maxChildrenPerSession` | number | `8` | 每父会话允许的未完结 `rlm.run` 子代理数，超出响亮报错。 |
| `maxRunPromptChars` | number | `24000` | 单个 `rlm.run` 提示词字符上限。 |
| `subcallModel` | string | — | T7.10 `llm.query` 路由选择器：内核调用方未点名时使用的模型。缺省则用宿主代理自身模型（不降级）。 |
| `maxInFlightSubcalls` | number | `8` | 每宿主会话允许的在途 `llm.query` 子调用流数。 |
| `maxSubcallBatch` | number | `32` | 单批 `llm.query` 的最大提示词数。 |
| `maxSubcallAnswerChars` | number | `8000` | 单条子调用回答字符上限；超长截断并打标。 |
| `subcallTimeoutMs` | number | `120000` | 单次子调用生成的墙钟预算。 |
| `maxSubcallPromptChars` | number | `100000` | 单条 `llm.query` 提示词字符上限。 |
| `maxSessionSubcalls` | number | `200` | 每会话累计 `llm.query` 调用数，超出后新批次响亮报错。 |
| `maxSessionSubcallChars` | number | `1000000` | 每会话累计回答字符数。 |
| `maxRecursionDepth` | number | `2` | 代码强制的递归上限——`depth` 达到或超过此值的 `llm.query` 响亮报错；`0` 完全关闭子调用。 |

## 工具

- `ipython`（`code`）—— 在会话的持久 REPL 中执行 Python；变量与 import 跨调用存活；内核可经 `rlm` await 宿主服务（`await rlm("sub-task")`）。输出受 `maxOutputChars` 截断；溢出归档到会话产物目录。
- `create_python_skill`（`name`、`import_name`、`title`、`description`，`callable` 默认 `run`）—— 注册一个已写入 `<dataDir>/skills/<name>/` 的 python 技能（setuptools 的 `pyproject.toml` + 暴露 async `run(...)` 的模块），下次制备后可在内核中以 `await <import>(...)` 调用。磁盘文件不匹配时响亮报错。

## 服务：`rlm.kernels`

`apply` 提供 `SessionKernelRegistry`。兄弟插件（如 `plugin-rlm-verifier`）可经同一持久内核跑自己的 cell；无消费方注入时插件功能完整。

## venv

`python` 缺省时，注册表自动引导 venv（uv 安装解释器、ipykernel + prime-agent-runtime）；引导子进程使用消毒后的环境（`src/env.ts`），模型可达的内核进程永不继承宿主机密。每次制备时，harness 技能条目驱动 venv 的 python 技能安装（`collectPythonSkills` 每次制备重读 `<dataDir>/skills/`，改动免重启生效；非 slug 的 id 或缺 `pyproject.toml` 的跳过并告警）。

## 行为：`llm.query` 子调用桥

内核引导注入 `llm_query(prompt | prompts, **kwargs)`；宿主桥把每个子调用经 LLM 缝执行，带 `purpose: 'rlm-subcall'` 归属。数组即批处理。退化回答（空、过短、自我重复）重试一次，仍退化则带 `degenerate` 标记返回。超过 `maxSubcallAnswerChars` 的回答截断并打标。每批追加 log-only 的 `session/subcall-query` 事件。

## 行为：`rlm.run` 桥

`rlm.run` 映射到 `ctx.subagents.start`（走 `subagentProvider`），受 `maxChildrenPerSession` 与 `maxRunPromptChars` 约束；控制器按会话跟踪，`session/disposed` 时中止，子代理不会比父会话活得久。

## skills 目录

`skills/rlm_dag/` 以 python 技能包形态出厂 DAG 编排协议（LAYERS.md §4.1）：把子调用规划成层，每层作为一次 `llm_query` 批派发，每个回答在传播前用最便宜的确定性检查验证，被拒轮次换新种子重试，最终装配为普通 dict。部署方式：把包复制到 `<dataDir>/skills/rlm_dag/`，并注册一条 global harness 技能条目（`reference: { type: 'python', import: 'rlm_dag', callable: 'run' }`）。

## 行为：内核状态通知

会话从 dill 快照制备时，`appendRestoreNotice` 注入 `<ipython_state_restored>` 通知，列出复活的变量（丢失项另列）；快照落盘追加 log-only 的 `session/kernel-snapshot` 事件。压缩完成后，`compaction/end` 被转发给 `notifyCompactionEnd`，注入 `<ipython_state>` 通知列出存活的顶层变量名，让模型知道内核在压缩中持续运行。

## 已知限制与待办工作

- 内核的 `dataDir` 必须与 verifier/MOA/loop/continual-harness 的 `dataDir` 一致；不一致会把落地状态搁浅在另一个根目录下。
- 共享的参考文本脱敏器已不在本包——自 Phase 10 起它是零依赖的 `@deepseek-ai/dsh-plugin-rlm-redact` 包，moa/verifier 不再为打码而 import 本包（及其原生 zeromq 依赖链）。

## 状态

Phase D（2026-09-01）：家族的计算基座——持久内核、`rlm.run` / `llm.query` 宿主桥与 python 技能安装路径。家族总览见 [packages/rlm/README.md](../README.md)；家族级状态见文档仓 BUILD.md。
