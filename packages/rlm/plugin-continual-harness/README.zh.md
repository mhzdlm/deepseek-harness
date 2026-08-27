# @deepseek-ai/dsh-plugin-continual-harness

[English](README.md) | 中文

面向 RLM 家族的持续学习基座。它持有基于 CAS 的 harness 状态存储、`/refine` 自我精炼流程，以及把已验证的 loop 进度落为持久 `memory` 条目的管道。

## 配置

| 配置 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `dataDir` | string | `~/.dsh/rlm` | CAS 状态存储与落地条目的 harness 基础目录；必须与其余 rlm 插件的 `dataDir` 一致。 |

## 工具：`/refine`

`/refine` 审视最近的对话轨迹，让一个 subagent 提出小而带证据支撑的 harness 更新，对将要变更的条目做逆向快照，应用之，并记录一条 RefinementEvent；回滚按事件 id 恢复快照。

## 模型体验

### 精炼流程

#### 模型看到什么

提案 subagent 收到带有权威条目 id 的当前 harness 概览，因此更新/删除提案可以指名真实 id；工具除该概览外不添加任何面向模型的引导。

#### Token 影响

一次 `/refine` 调用向当轮增加审视提示与提案提示，并记录一条 RefinementEvent；每次调用开销为一次审视加一次提案。

#### KV 缓存影响

落地条目通过 harness 概览注入重新进入上下文，因此后续轮次从提示中读取可信状态，而非从历史重新推导；插件从不修改更早的请求 token。

## 已知限制与待办工作

- `/refine` 提案在抽取后做运行时校验；解析失败会丢弃该提案，而不是应用部分更新。
- 真实运行时挂载需等待与其它 rlm 插件相同的依赖闭包修复（`apps/cli` 未依赖 rlm 包）；在此之前工具通过显式 `ctx.plugin()` 挂载或 vitest 工具链组合抵达会话。
