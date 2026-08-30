# @deepseek-ai/dsh-plugin-continual-harness

[English](README.md) | 中文

面向 RLM 家族的持续学习基座。它持有基于 CAS 的 harness 状态存储、`/refine` 自我精炼流程，以及把已验证的 loop 进度落为持久 `memory` 条目的管道。

## 配置

| 配置 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `dataDir` | string | `~/.dsh/rlm` | CAS 状态存储与落地条目的 harness 基础目录；必须与其余 rlm 插件的 `dataDir` 一致。 |
| `autoRefine` | boolean | `false` | 可选开关：按根代理轮次间隔门触发 `/refine`。 |
| `autoRefineTurnInterval` | number | `12` | 两次自动审视之间的根代理空闲轮数。 |
| `autoRefineCooldownMs` | number | `600000` | 两次自动审视之间的最小间隔（成功与拒否均盖戳）。 |
| `maxEntriesPerKind` | number | `6` | 渲染 harness overview 时每类条目的上限，镜像 prime 的 hints-only 注入：呈现路由提示而非全量 harness，模型按需读取底层条目。 |
| `maxCharsPerEntry` | number | `180` | 渲染 harness overview 时每条目内容上限；截断为提示，保留 id/tag/title 供引用。 |
| `maxTotalChars` | number | `6000` | 整个 harness overview 段的字符总上限——四类路由索引的有界天花板。 |
| `refineProvider` | string | `spawn` | `/refine` 使用的 subagent provider 名。 |
| `maxRefinementEvents` | number | `100` | 每会话保留的 `RefinementEvent`（及其快照文件）上限，超出修剪最旧。 |
| `recallInject` | `off\|observe\|enforce` | `observe` | T7.13 主动召回注入（LAYERS.md §3）：`off` 不做任何事；`observe`（默认）执行检索并记录 `session/memory-recall-inject` 事件而不触碰 prompt；`enforce` 实际注入 top-N 召回段。 |
| `recallInjectTopN` | number | `3` | 注入召回段最多携带的排序命中数。 |
| `recallInjectBudgetChars` | number | `2000` | 整个注入召回段的硬字符预算；超限截断并标记。 |

## 行为：主动召回注入（默认 observe）

每次 harness section 渲染时，插件取最近一条 user message，对 `<dataDir>/memory` 的 `published/` 存储（memory 包检索）做一次轻量检索。默认 `observe` 模式下命中只记录进 log-only `session/memory-recall-inject` 事件（mode、query、命中 relPath、将注入字符数）——prompt 不变，默认行为保持原样。`enforce` 模式下 top-N 命中以 `## Relevant Memories` 段注入，带硬字符预算。召回是相关度通道；harness overview 保持时间索引通道。

## 工具：`/refine`

`/refine` 审视最近的对话轨迹，让一个 subagent 提出小而带证据支撑的 harness 更新，对将要变更的条目做逆向快照，应用之，并记录一条 RefinementEvent；回滚按事件 id 恢复快照。提案与审视 subagent 均运行于 `reasoningEffort: 'none'`，使 JSON 预算不被思考链占用。

## 行为：自动精炼（可选）

启用 `autoRefine` 时，`registerAutoRefine` 监听 `agent/status` 并统计根代理轮次完成（`currentInitiator()` 为 undefined）。当达到轮次间隔且冷却门通过，运行一个作用域受限的审视 subagent（`reviewAutoRefine`）；仅当 `shouldRefine` 为真才复用 `runRefine` 流程。子代理被排除，冷却持久化以保证一次失败审视不会立即重触发。默认值保持既有部署仅手动触发，直到显式开启。

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
