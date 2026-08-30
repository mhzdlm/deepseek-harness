# @deepseek-ai/dsh-plugin-rlm-kernel

[English](README.md) | 中文

RLM 家族的共享基座。它适配 harness 的 `SubagentRuntime`，让 verifier 与 MOA 插件可以借用 subagent 集群进行打分与参考调用，并对外暴露 `redactReference` 契约以及其它 rlm 插件依赖的共享 `dataDir` 解析器。

## 配置

| 配置 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `dataDir` | string | `~/.dsh/rlm` | rlm 插件共享的 harness 基础目录，用于落地状态与产物；必须与 verifier/MOA/loop/continual-harness 的 `dataDir` 一致。 |
| `python` | string | — | 带 ipykernel + prime-agent-runtime 的 Python 解释器；省略 → 自动引导 venv。 |
| `subagentProvider` | string | `spawn` | `rlm.run` 使用的 subagent provider 名。 |
| `idleTimeoutMs` | number | `600000` | 会话内核被回收前的空闲超时（dill 快照保状态）；`0` 禁用回收。 |
| `maxOutputChars` | number | `65536` | 返回给模型的 cell 输出文本上限。 |
| `snapshotDebounceMs` | number | `1500` | 成功 cell 后的自动快照防抖。 |
| `snapshotHistory` | number | `3` | 保留的 dill 快照数（`kernel-state.<n>.dill`）；`0` 禁用轮转。 |
| `warmupOnSessionCreate` | boolean | `false` | 在 session/created 即供应内核，而非首次 ipython 调用。 |
| `maxLiveKernels` | number | `4` | 并发存活内核上限（0 = 不限）；超限按 LRU 优先驱逐最旧非忙内核。 |
| `reclaimSnapshotGraceMs` | number | `5000` | 被租用的超限内核重试强制驱逐快照前的宽限。 |
| `maxChildrenPerSession` | number | `8` | 每父会话允许的存活 `rlm.run` 子代理数（one-shot + retained，in-flight 计入）。 |
| `maxRunPromptChars` | number | `24000` | 单条 `rlm.run` prompt 的字符上限。 |
| `subcallModel` | string | — | T7.10 `llm.query` 路由选择器（LAYERS.md §2.3 R2）：内核调用方未指名模型时使用的子调用模型。省略则以所属 agent 自身的模型运行（不降档）。 |
| `maxInFlightSubcalls` | number | `8` | T7.10（R1）：每个所属会话允许的在途 `llm.query` 子调用流上限；超限响亮报错并点名键名。 |
| `maxSubcallBatch` | number | `32` | T7.10（R1）：单次 `llm.query` 批请求的 prompt 数上限。 |
| `maxSubcallAnswerChars` | number | `8000` | T7.10：每答案字符上限；超限答案被截断并标记。 |
| `subcallTimeoutMs` | number | `120000` | T7.10（T7.3 语义）：单次子调用生成的墙钟预算；到期中止该次尝试。 |

## 行为：`llm.query` 子调用桥

内核 bootstrap 注入 `llm_query(prompt | prompts, **kwargs)`；宿主第 8 个 handler 经 LLM 缝以 `purpose: 'rlm-subcall'` 归因执行每个子调用。数组载荷即批量（论文 `llm_batch` 对应物）。退化答案（空 / 极短 / 自我重复——prime Appendix F.1 的「子 LM 放弃」模式）自动重试一次，仍退化则带 `degenerate` 标记返回，由内核调用方自行决定分块。超过 `maxSubcallAnswerChars` 的答案被截断并标记；生成失败/中止则抛出。每个批次追加 log-only `session/subcall-query` 事件（批量大小、解析到的模型、各答案字符数、截断标记、重试次数、耗时、可选的调用方 `use`/`depth` 标签）——LAYERS.md §5 评估层的数据源；`rlm_dag` 技能的层批量与重试分别带 `use: "dag-layer" / "dag-retry"`。

## 行为：内核状态恢复告知

当会话从 dill 快照恢复时，`appendRestoreNotice` 在 `restoreState()` 之后立即向解析出的会话注入一条 `user/message`（`source.form: 'notice'`、`surfaceOp: 'append'`）。正文在 `<ipython_state_restored>` 块中列出已恢复的变量、并单独列出丢失项，使模型在发出下一个 cell 之前就看到恢复后的命名空间。空恢复结果为静默 no-op。它与既有的 `consumeRestoreNotice`（在下一次 `!python` 结果前缀提示）互补。

## 行为：压缩后内核状态告知

压缩完成后，插件的 `session/event` 订阅把 `compaction/end` 转发给 `notifyCompactionEnd`。若该会话存在存活内核，`appendPostCompactionNotice` 通过 vendored `KernelManager.listNamespaceNames` 列出内核存活的顶层变量名，并以 `<ipython_state>` 块（`source.form: 'notice'`）注入（镜像 prime 的 `_syncKernelStateAfterCompaction`）。消息告诉模型持久内核穿过压缩仍在运行——检查点前定义的每个变量、导入与助手都还活着。无内核或空命名空间为静默 no-op。（与 prime 不同，本构建不预先修剪超大变量，因此告知只列存活名、不列被丢弃名。）

## 行为：`rlm_dag` 编排技能（LAYERS.md §4.1）

`skills/rlm_dag/` 以 python-skill 包形态交付 DAG 编排协议：把子调用规划成分层、每层一次 `llm_query` 批量派发、每个答案传播前做最便宜确定性验证、被拒轮以新种子重试、装配纯结果 dict（"Root compute = dict lookup, string formatting, correctness checks"）。部署：把包复制到 `<dataDir>/skills/rlm_dag/` 并注册全局 harness skill entry（`reference: { type: 'python', import: 'rlm_dag', callable: 'run' }`），与 loop-audit 技能同路径。preset persona 携带"何时不递归"纪律；自动 depth/用途路由等待 LAYERS.md §5 评估数据。

## 模型体验

### 打分委派

#### 模型看到什么

内核本身不产出任何面向模型的文本；它把 `SubagentRuntime` 交给 verifier 与 MOA 插件，使它们的打分提示通过普通 subagent 通道到达模型，并带有 `purpose` 归属。

#### Token 影响

内核不产生 token；它只为消费插件选择的每一次打分请求增加一次借用的 subagent 调用。

#### KV 缓存影响

在请求路径上无状态：它在挂载时解析一次共享 `dataDir` 与 redactor 闭包，因此从不修改更早的请求 token。

## 已知限制与待办工作

- 内核的 `dataDir` 必须与 verifier/MOA/loop/continual-harness 的 `dataDir` 一致；不一致会导致落地状态落到不同根目录。
- 真实运行时挂载需等待与其它 rlm 插件相同的依赖闭包修复（`apps/cli` 未依赖 rlm 包）；在此之前内核通过显式 `ctx.plugin()` 挂载或 vitest 工具链组合抵达会话。
