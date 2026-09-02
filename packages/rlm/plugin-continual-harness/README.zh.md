# @deepseek-ai/dsh-plugin-continual-harness

[English](README.md) | 中文

面向 RLM 家族的持续学习基座。它把 harness 概览（持久 instructions / memories / skills / subagents）以 `continual-harness` 节（order -100）注入每次装配的系统提示词，并持有各读取面。自 Phase A 权威翻转起，本地 `harness_state.json` 是会话统一 store 视图的投影：生产方写 store，此处的变更监听器重渲染文件，提示词渲染器照旧同步读取。global 作用域文件在 Phase C 信箱迁移前冻结为只读。

## 配置

| 配置 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `dataDir` | string | `~/.dsh/rlm` | harness 基目录；必须与其他 rlm 插件的 `dataDir` 一致。 |
| `maxEntriesPerKind` | number | `6` | 概览注入时每类条目上限（hints-only：只给路由提示，不给全量）。 |
| `maxCharsPerEntry` | number | `180` | 每条内容上限；截为提示，保留 id/tag/title 可见。 |
| `maxTotalChars` | number | `6000` | 整个概览节的总字符上限。 |
| `refineProvider` | string | `spawn` | `/refine` 使用的子代理 provider。 |
| `maxRefinementEvents` | number | `100` | 为 preset 兼容而保留；通道化 `/refine` 不再持有快照库。 |
| `autoRefine` | boolean | `false` | 接受但惰性：自动精炼调度器随 `/refine` 旧的直写路径消亡，通道化重写前无任何调度。 |
| `autoRefineTurnInterval` | number | `12` | 为 preset 兼容而保留（见 `autoRefine`）。 |
| `autoRefineCooldownMs` | number | `600000` | 为 preset 兼容而保留（见 `autoRefine`）。 |
| `recallInject` | `off\|observe\|enforce` | `observe` | T7.13 主动召回注入：`off` 不动；`observe` 跑召回并记录 log-only 的 `session/memory-recall-inject` 事件、不动提示词；`enforce` 实际注入 top-N 召回节。 |
| `recallInjectTopN` | number | `3` | 注入召回节可携带的排名命中数。 |
| `recallInjectBudgetChars` | number | `2000` | 整个注入召回节的硬字符预算。 |

## 行为：store 投影

挂载 `rlm.store` 时，`registerStoreProjection` 订阅 `store.onChange`，从会话 scope 视图重渲染每会话的 `harness_state.json`；概览渲染按文件（mtime、size）缓存。无 store 时文件保持最后内容——一个诚实的陈旧缓存，激活时告警一次。

## 行为：主动召回注入（默认 observe）

每次 harness 节渲染时，插件取最近一条用户消息，对 `<dataDir>/memory` 的 `published/` 库跑一次轻量词法召回（来自 `@deepseek-ai/dsh-plugin-rlm-memory` 的 `search`）。默认 `observe` 模式下命中只记入 `session/memory-recall-inject` 事件（mode、query、命中 relPath、本将注入的字符数）——提示词不动。`enforce` 下 top-N 命中以硬字符预算注入为召回节。召回失败降级为基础提示词（召回是建议性的）。召回是相关性通道；harness 概览仍是时间索引通道。

## 命令

- `/refine` —— 通道化（Phase B）：评审结论经判断通道落地，绝不直写投影文件。管线：近期转写（24 turn 窗口）→ 抽取子代理 → JSON 提案（≤6 条、每条 ≤1200 字符）→ 确定性白名单判据 `crit/refine-whitelist`（每条提案的 evidence 必须能在其引用的转写中逐字定位）→ 每条准入提案落一个 `conclusion` 判断（procedural 信念，subject `harness:memory:<slug>`；同 subject 的既有信念被 supersede）。需要 `rlm.store`；无反向快照——被撤回的内容在 store 中 void，下次渲染即消失。
- `/harness list [kind]` / `/harness show <id>` —— 查看当前会话的 harness 条目。`/harness delete <id>` 已冻结：文件是 store 投影，返回错误并指向判断通道。

## 模型体验

### harness 概览

#### 模型看到什么

由 global + 会话投影合并渲染的有界概览节（每类上限、逐条截断），外加 `recallInject: enforce` 下的预算化召回节。`/refine` 的提案子代理收到转写节选；插件除概览本身外不添加模型可见引导。

#### Token 影响

概览受 `maxEntriesPerKind`/`maxCharsPerEntry`/`maxTotalChars` 约束；召回节受 `recallInjectTopN`/`recallInjectBudgetChars` 约束。一次 `/refine` 的成本是一个抽取子代理加每条准入提案一个判断。

#### KV 缓存影响

概览节以 identity order（-100）渲染在基础提示词后续节之前；落地信念经它重新进入上下文，后续 turn 从提示中读取可信状态而非从历史重推。

## 已知限制与待办工作

- `/refine` 提案在抽取后校验；解析失败丢弃该提案而非部分应用。
- `autoRefine*` 配置键被接受但惰性，直到通道化的自动精炼调度器重建。

## 状态

Phase D（2026-09-01）：家族的提示词注入与读取面——store 是写权威，本插件把投影渲染进系统提示词，并暴露 `/refine`（通道化）与 `/harness`（只读）。家族总览见 [packages/rlm/README.md](../README.md)；家族级状态见文档仓 BUILD.md。
