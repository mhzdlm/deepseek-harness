# Agent Note: MoA 面板作为第四个 RLM 插件落在宿主 LLM 缝上

Status: implemented

[English](2026-08-24-rlm-moa-plugin.md) | 中文

## Problem

RLM 插件家族此前只有选择面（`verify`，对候选做 best-of-N），没有综合面：难题需要多个独立模型意见时，模型只能派全功能子代理（昂贵、带工具、易跑偏）或者相信单一答案。Hermes 的 Mixture-of-Agents 恰好解决这个问题——回合级编排：并行纯 LLM 参考调用加一次聚合——但该编排长在 Hermes 主循环里，没有可移植形态。

## Decision

`packages/rlm/plugin-rlm-moa/` 以与兄弟插件相同的 Cordis 形态注册 `moa` 工具。面板完全跑在本上下文的 LLM 缝上：每个参考槽与聚合器都是 `ctx.llm.stream()` 调用（compaction summarizer 的调用形状——`createUserMessage`、`BlockAssembler`、finish 规整），凭据由各 adapter 自己解析，不存在子进程桥或转发密钥清单。

- Config 持有命名 presets（`referenceModels[]` + `aggregator`，preset 级 `referenceMaxTokens`、`referenceTimeoutMs`、`degradedPolicy`）。未配置时使用内置 preset：扇出两个 DeepSeek 参考、更强的聚合器。`dataDir` 默认共享的 `~/.dsh/rlm`；trace 以 JSONL 追加在 `<dataDir>/moa-traces/<sessionId>.jsonl`。
- 失败语义对齐 Hermes 的 `aggregate_moa_context`：失败或超时的参考变成 `failedLabels` 里的标签（`loud` 时向聚合器播报，`quiet` 时静默丢弃）；只有全部参考失败才抛错并完全跳过聚合器调用。
- 聚合器永不接收 `referenceMaxTokens`——给综合设上限会截断长输出；上限只属于参考。
- 每个参考运行在 `AbortSignal.any([exec.signal, AbortSignal.timeout(referenceTimeoutMs)])` 下；工具调用的 abort 始终是权威信号。
- `privacyFilter: 'display'` 在渲染结果中标注每条参考的来源。完整 redaction 等 harness 出现中央 redactor 再接。

相对 Hermes 的有意偏离如实记录：guidance 注入的缓存论证在此不成立——综合结果作为一条工具结果落地而非注入对话；参考槽默认保持纯 LLM 调用（`subagent` 槽位模式留作可能的扩展，不是默认）。

## Alternatives considered

**并入 plugin-rlm-verifier。** 否决：选择排名与综合是不同的认知动作、不同的依赖面；合并会把 verifier 的 Python 桥关注点拖进纯编排工具。

**llm_verifier 式 Python 桥。** 否决：MoA 不依赖任何算法包，子进程只会带来凭据转发与生命周期复杂度而零能力增益——还会重新引入"活内核内无法鉴权"一类问题。

**参考槽用 rlm.run 子代理。** 暂缓：每个参考升级为全工具代理——更贵更不可控；Hermes 让参考不带工具有充分理由。未来可用 `slotMode` 以可选方式暴露。

## Consequences

RLM 组合获得可与 `verify` 组合的综合原语（moa 起草 → verify 选优；或 verify.auto_spawn 出候选 → moa 综合），两个工具之间暂无硬接线。代价：每次 `moa` 调用是 N+1 次提供方往返，只受工具描述的使用引导和 `referenceMaxTokens` 约束；preset 点名未配置路由的 provider 时按槽失败，由降级路径吸收。这类旁路调用的 `purpose` 归因待 dsh-llm 封闭的 `GenerateOptions.purpose` 联合类型扩展。

## Testing

- `tests/moa.spec.ts`: 13 项——扇出完整性、聚合器提示装配（task/context/reference 块）、loud 与 quiet 降级通知、全败短路不聚合、墙钟超时单槽失败兄弟成功、candidates 模式评审提示、未知 preset 报错列可用名、参考封顶与聚合器不封顶的 token 边界、JSONL trace 内容、display 过滤来源渲染、preset 规范化（内置回退、禁用与非法槽丢弃、`model@provider` 标注）。
- verifier 的 `rlm-preset.spec.ts` 现断言四插件组合注册 `ipython`、`verify` 与 `moa`。
- `pnpm exec tsc --noEmit -p packages/rlm/plugin-rlm-moa/tsconfig.json` 全净；包内 vitest 13/13 全绿。
