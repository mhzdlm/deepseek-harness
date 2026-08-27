# Agent Note: LLM 缝可提供选中 token 的 logprobs

Status: implemented

[English](2026-08-24-llm-seam-token-logprobs.md) | 中文

## Problem

需要 token 级分布的评分引擎（LLM-as-a-Verifier 细粒度奖励）只能在缝旁运行——当前经由子进程里的 vendored Python 包——因为 `ctx.llm.stream()` 不携带概率数据。这迫使引擎各自做凭据转发、单后端评审，且恰恰最值得审计的调用完全没有用途归因。

## Decision

`GenerateOptions` 增加选择开关 `logprobs: { topLogprobs }`。开启后，支持的 adapter 在线上请求选中 token 概率，并发射新的流块：

```ts
type LogprobsChunk = { type: 'logprobs'; index: number; tokens: ReadonlyArray<{ token: string; logprob: number }> }
```

（`TokenLogprob = { token, logprob }`；top 变体列表 v1 不出缝。）`BlockAssembler` 按流序在 `logprobs` 访问器后累积条目。持久 `ContentBlock` 刻意不携带评分元数据——回放历史无需为单一消费方承载概率载荷。

DeepSeek adapter 将该开关映射到线上 `logprobs: true` + `top_logprobs`，并把每个 delta 的 `logprobs.content[]` 翻译为块条目；无法服务的路由保持流不变，因此消费方须把"缺席"理解为"不支持"，而非"为空"。

## Alternatives considered

**把 logprobs 挂到 TextBlock。** 否决：块是持久、回放、渲染的对象；概率载荷会随每份存储转录流转，而流式访问器已覆盖真实用例。

**adapter 侧带外旁路通道。** 否决：把同一逻辑响应拆到两个传输面，破坏回放顺序保证。

## Consequences

缝上的任何消费方都能以 adapter 托管凭据、多路由支持与用途归因读取 token 分布——verify 评分的收敛触发条件在能力层面已满足。代价：流块联合按设计随每个概率型功能增长一次；不支持的服务商与"从未开启"在流上不可区分，除非消费方查询路由能力。

## Testing

- `packages/llm/llm/tests/assembler.spec.ts`：累积顺序、空默认、以及装配文本块不带 logprob 字段的不变量。
- `packages/llm/llm-deepseek/tests/translate.spec.ts`：线上 `delta.logprobs.content[]` 翻译为绑定打开文本块的条目；无打开文本块时不发射。
- `packages/llm/llm-deepseek/tests/serialize.spec.ts`：开启即置 `logprobs: true` + `top_logprobs`；省略则两字段均不存在。
- 经 `gen-cordis-catalog` / `gen-cordis-inspect-catalog` 刷新生成目录。
