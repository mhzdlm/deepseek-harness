# Agent Note: MoA 槽位获得 purpose 归因与 subagent 执行模式

Status: implemented

[English](2026-08-24-rlm-moa-purpose-and-subagent-slots.md) | 中文

## Problem

面板调用经 `ctx.llm.stream()` 发出时与普通对话流量无法区分——token 计量折叠与可观测性不能把 MoA 扇出从循环步骤中分离。另外参考槽一律是纯补全：需要真实环境交互（跑代码、读仓库）的任务在面板中没有代表，用户只能手工绕道 `verify.auto_spawn` 获取带工具的意见。

## Decision

两项加法扩展：

- **`purpose: 'moa'`** 加入 dsh-llm 中封闭的 `GenerateOptions.purpose` 联合类型（`'compaction' | 'session-title' | 'moa'`）。moa 传输层在每次面板调用上打该标记并携带品牌化 session id，计量与拦截器得以分类流量；无 moa 专属策略的 adapter 与今天对待未知 purpose 一样忽略它。
- **Subagent 参考槽**——preset 槽位可声明 `mode:'subagent'`，以所属 agent 的子代理身份运行而非补全。`provider` 命名子代理 provider（回退到 Config `subagentProvider`，默认 `'spawn'`）；`model` 变为子代理标签提示。controller 先注册后 start、session 销毁即 abort（verifier 模式），组合信号仍遵守参考超时，捕获的子代理文本按 Config `maxChildChars` 截断。这是相对 Hermes 的 opt-in 偏离——其参考永远是无工具补全。

顺带落地的配套修复：`scripts/gen-cordis-catalog.ts` 为 `'rlm.kernels'` 增加 `SERVICE_WALK_EXEMPTIONS` 条目——这是一个既有的未渲染 Context 合并键，此前导致生成器在任何再生之前就失败。moa 与 verify 的组合引导随工作区审计文档（`MOA.md`）交付，位于本仓库生成面之外。

## Alternatives considered

**开放式 purpose 字符串。** 否决：封闭联合正是各 adapter 能穷尽式拥有 purpose 专属策略的前提；自由标签会退化为无人维护的元数据。

**subagent 槽作为默认参考。** 否决：带工具的子代理更贵、更久、易漂移；Hermes 让参考无工具有充分理由。逐槽 opt-in 保住默认路径的廉价与可预测。

**手改 api-catalog.ts 以纳入放宽的声明。** 政策否决：生成源只能经生成器变更——这要求先修复 walk-exemption 缺口。

## Consequences

MoA 流量端到端可分类（purpose → session → route），困难任务可以在面板上放一个带工具的 advisor 同时保持其余廉价。代价：purpose 联合按设计随每个旁路消费方增长一次；subagent 槽继承委托经济学（spawn 延迟、子代方差），仅受参考超时与 `maxChildChars` 约束；fork-server 式 Linux-only 注意事项不适用——子代理在 Windows 上正常 spawn。

## Testing

- `tests/llm-stream.spec.ts`: 一项经真实 `LlmRuntime` 加捕获 adapter 的集成——断言三次调用的 `purpose:'moa'`、品牌化 session id 转发、逐槽 provider/model 路由、活 `AbortSignal`，以及参考封顶对聚合器不封顶的边界。
- `tests/moa.spec.ts`: 三项——subagent 路由含折叠 persona/任务提示、未接线 callSubagent 降级进 `failedLabels`、无 owner 的执行在任何 spawn 之前使槽失败。
- 包套件四文件 30/30 全绿；`tsc --noEmit` 全净；`pnpm run gen-cordis-catalog` 通过（95 个产物），生成 API 目录包含新联合。
