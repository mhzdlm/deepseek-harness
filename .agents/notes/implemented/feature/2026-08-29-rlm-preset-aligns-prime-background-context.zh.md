# Agent Note: rlm preset 挂载 compaction、schedule、goal 以对齐 Prime 的非阻塞长任务面

Status: implemented

[English](2026-08-29-rlm-preset-aligns-prime-background-context.md) | 中文

## Problem

`rlm` preset（`docs/recipes/agent-presets/rlm/agent.cordis.yml`）原先只装配了
`rlm-stack` 组——`plugin-rlm-kernel`、`plugin-rlm-verifier`、`plugin-continual-harness`、
`plugin-rlm-moa`。它的 persona 已经声称有 "compactor runs at turn boundaries" 并要求
"non-blocking control loop"，但 preset **没有挂载任何 `compaction` 插件**，所以那句声称
毫无支撑：长会话或递归 rlm 会话从不自动压缩，会默默溢出上下文窗口。它也没挂载 `schedule`
或 `goal`，于是 agent 不能按定时器重新进入自己（Prime 的 `rlm_heartbeat` / 定时 prompt），
也不能用持久目标驱动工作（Prime 的 persistent goals + autonomous mode）。Prime 的非阻塞
长任务叙事正是建立在这三者上：自动压缩、daemon/heartbeat/定时重入、持久目标——而我们内核
原生就提供的 `rlm()` 异步子代理只是其中一条腿。

## Decision

把缺失的三个面挂进 `rlm` preset，参照 shipped `standard` preset 的接法：

- **compaction** —— 一个位于 `isolate: { compaction: true, toolResultPruner: true }` 之下的
  组，含 `compaction-basic`、`command-compact`、`tool-result-pruner`
  （`thresholdChars: 8192`、`headChars: 4096`、`tailChars: 1024`）。pruner 的截断对应
  Prime 的"总结前截断工具输出"；我们用 8192/4096/1024 预算——同种机制，更大窗口。
  `tokenMeter` 留在 host 平面（该组解析那唯一一个实例）。
- **goal** —— `command-goal` + `tool-goal` 作为松散行；`goals` 服务与会话驱动留在 host 平面，
  与 `standard` 完全一致。
- **schedule** —— `time-context` + `schedule` 作为松散行，参照
  `apps/cli/config/examples/schedule/cordis.yml`；schedule 服务在 host 平面。

挂载测试（`packages/rlm/plugin-rlm-verifier/tests/rlm-preset.spec.ts`）现在在其 harness 里
加载 `tokenMeter`、`sessionPersistence`、`goals` 三个 host provider，并断言挂载后
`compaction` 服务、`schedule_create` 工具、`goals` 服务均可用。

## Alternatives considered

- **只装 `compaction`（最小）。** 用户已选完整对齐，故否决：`schedule` 与 `goal` 是 Prime
  非阻塞长任务面的另外两条腿，一个能自我定时、能追求持久目标的研究会话，比只能 spawn 异步
  子代理的会话明显更接近 Prime。
- **用 Prime 自己的压缩替换 `compaction-basic`。** 否决：我们的 `compaction-basic` 已对齐
  Prime 的机制（上下文窗口阈值触发、turn 边界 cut、结构化 checkpoint 摘要、对上一轮摘要的
  迭代合并），且自带工具结果 pruner；采用 Prime 仅 prompt 层的逻辑反而是退步。
- **因 `standard` 未默认装配就省略 `schedule`/`goal`。** 作为本 preset 的非 sequitur 否决：
  `standard` 不装 `schedule`（它是 opt-in overlay），`goal` 在那里由 host 提供，但 `rlm`
  研究型 preset 明确面向长时自主工作，这些面恰恰该有位置。

## Consequences

- 买到的：`rlm` agent 现在自动压缩（长/递归会话不再默默溢出）、能按定时器重新进入自己、能
  追求持久目标。再叠加本就原生的异步 `rlm()` 子代理，就补齐了 persona 对齐 note 所描述的、
  与 Prime 非阻塞长任务模型之间的精神缺口。
- 代价：preset 的挂载闭包多引入了三个 host 服务（`tokenMeter`、`sessionPersistence`、
  `goals`）；挂载测试现在要供给它们。除这些服务在 `standard` 里本就花费的成本外，无额外
  运行时开销。
- 已在真实会话 headless e2e 中验证
  （`packages/rlm/plugin-rlm-verifier/tests/rlm-headless-real.e2e.ts`）：压缩保留 IPython
  kernel 状态——dill snapshot 独立于被压缩的 transcript，播种的 `x = 42` 在飞行中压力压缩
  后存活；schedule 到点重新进入会话；goal 驱动同会话自主 continuation。
- 交叉引用：扩展了
  [rlm persona 对齐 prime base prompt 精神](../feature/2026-08-29-rlm-persona-prime-base-spirit.zh.md)
  引入的对齐；compaction 接线遵循
  [standard preset](../presets/standard/agent.cordis.yml)。
