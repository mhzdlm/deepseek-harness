# Agent Note: RLM active recall injection, observe-first (LAYERS.md §3, NEXT Phase 7 T7.13)

Status: implemented

[English](2026-08-30-rlm-recall-inject-observe.md) | 中文

## Problem

LAYERS.md §3 记录的中间层缺口：harness overview 是纯时间索引通道（最近条目），"此刻什么相关"没有逐轮相关度通道。ReMe 集成分析（research/ReMe与dsh集成分析.md §12.1）画了草图——在 `continual-harness` section 渲染时用最近一条 user message 做一次轻量检索、以硬预算注入 top-N 相关记忆。三分支纪律（off | observe | enforce，默认不动现状）适用：默认不得改变 prompt。

## Decision

主动召回注入在 `@deepseek-ai/dsh-plugin-continual-harness` 以 observe-first 落地：

- **`src/recall-inject.ts`**（新）：`latestUserQuery(session)` 从派生 transcript 取最近 user message（截断至查询预算）；`renderRecallSection(query, hits, budgetChars)` 在硬字符预算内按排序渲染 `## Relevant Memories` 段——头部放不下的命中被丢弃、被采纳的正文超预算以省略号截断，slice 长度有下限防护（极小预算不会产生负切片）。
- **section 接线**：harness section 渲染只在 `enforce` 下追加召回后缀。`observe`（默认）执行同样的召回并记录"将会注入什么"；`off` 全部跳过。默认行为不变（验收标准）。
- **Config**：`recallInject`（`off|observe|enforce`，默认 `observe`）、`recallInjectTopN`（3）、`recallInjectBudgetChars`（2000）。
- **检索源**：memory 包的同步词法 `search` 对 `<dataDir>/memory` 的 `published/`（插件现经 `./src/*` 缝依赖 `@deepseek-ai/dsh-plugin-rlm-memory`）。按设计廉价：无嵌入、无网络、一次 `deriveMessages` 遍历。
- **事件**：每次有命中的渲染（observe 或 enforce）追加 log-only `session/memory-recall-inject` 事件（mode、query、命中 relPath、将注入/已注入字符数）——LAYERS.md §5 的中间层评估数据源。persistence catalog 已重生成。
- **不更新 use 信号**：注入是机器动作而非检索使用，`use_count`/`last_accessed` 不动（`memory_search` 工具仍是唯一的 use 信号写入者）。

## Testing

`tests/recall-inject.spec.ts`（6 项）：helper 覆盖（最近 user message 提取/尾部截断/空白跳过；渲染排序、预算拒掉命中、预算截断正文、空命中→''）与 apply 级 off/observe/enforce/no-hits 三分支，经捕获的 `systemPrompt.section` 回调驱动真实 `apply()`，fake session 的 `append` 收集事件。harness 包 40/40；typecheck RLM 零错误。

## Alternatives considered

**observe 模式带标记注入。** 否决：observe 意味着 prompt 不被触碰——记录活在事件里，模型可见差异保持为零，直到部署显式选择 `enforce`（与 memory Phase D `exitMode: observe` 的保守语义一致）。

**以嵌入/hybrid 检索做相关度。** 否决：设计约束是"逐轮廉价"——同步词法检索每次渲染 O(index) 且无网络；hybrid 缝仍保留给 memory 工具路径，注入质量可先由事件测量再决定升级。

**注入更新 memory use 信号。** 否决：每次渲染都会触碰模型从未读过的笔记，污染老化/退役信号；`memory_search` 工具调用保持唯一 use 信号写入者。

## Consequences

中间层现在有了相关度通道，三分支门控且默认只观察：部署可以先从 `session/memory-recall-inject` 测量每轮"将召回什么"，再带数据决定是否翻 `enforce`。代价：非 `off` 时每次 section 渲染一次同步索引扫描（受 published 存储规模约束）；`enforce` 下注入段占用部分 prompt（硬预算 2000 字符 → 3 条命中）；memory 目录按 `<dataDir>/memory` 推导——自定义了 memory 包 `memoryDir` 的部署需让 harness `dataDir` 对齐（此处记录；两个默认值本就一致）。