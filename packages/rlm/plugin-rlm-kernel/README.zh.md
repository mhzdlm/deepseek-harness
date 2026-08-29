# @deepseek-ai/dsh-plugin-rlm-kernel

[English](README.md) | 中文

RLM 家族的共享基座。它适配 harness 的 `SubagentRuntime`，让 verifier 与 MOA 插件可以借用 subagent 集群进行打分与参考调用，并对外暴露 `redactReference` 契约以及其它 rlm 插件依赖的共享 `dataDir` 解析器。

## 配置

| 配置 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `dataDir` | string | `~/.dsh/rlm` | rlm 插件共享的 harness 基础目录，用于落地状态与产物；必须与 verifier/MOA/loop/continual-harness 的 `dataDir` 一致。 |

## 行为：内核状态恢复告知

当会话从 dill 快照恢复时，`appendRestoreNotice` 在 `restoreState()` 之后立即向解析出的会话注入一条 `user/message`（`source.form: 'notice'`、`surfaceOp: 'append'`）。正文在 `<ipython_state_restored>` 块中列出已恢复的变量、并单独列出丢失项，使模型在发出下一个 cell 之前就看到恢复后的命名空间。空恢复结果为静默 no-op。它与既有的 `consumeRestoreNotice`（在下一次 `!python` 结果前缀提示）互补。

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
