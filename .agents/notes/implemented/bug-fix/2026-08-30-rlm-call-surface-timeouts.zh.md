# Agent Note: RLM call-surface wall-clock timeouts (NEXT Phase 7 T7.3)

Status: implemented

[English](2026-08-30-rlm-call-surface-timeouts.md) | 中文

## Problem

2026-08-30 复核的 P1#1/P1#7：RLM 家族的每一次旁路模型调用都可能永久挂起。`moa` 聚合器只受调用方 abort 信号约束且无 token 上限——一个永不返回的 provider 烧光全部 reference 扇出后把工具调用无限挂死。memory 插件的 embedding fetch 无 signal、无超时、无重试，而它在 `memory_search` 的同步路径上，一个卡死的网络端点会冻结整个 agent 回合；capture 提取子代理同样无界。`moa` 的 references 本就有逐槽 `AbortSignal.timeout`——缺口在聚合器、embeddings 请求和 capture 子代理。

## Decision

三个墙钟预算，均经 `AbortSignal.any` 与既有调用方信号组合，均为带显式默认值的校验 Config/preset 字段（无隐藏 `??`）：

- **`moa` 聚合器**——新增 preset 级 `aggregatorTimeoutMs`（默认 `DEFAULT_AGGREGATOR_TIMEOUT_MS = 300_000`，下限 1s，在 `presets.ts` 中与 `referenceTimeoutMs` 同款归一化）。综合调用在 `moa-tool.ts` 组合 `AbortSignal.any([signal, AbortSignal.timeout(...)])`；预算到期在 `session/moa-reference` 事件已经落日志**之后**响亮地使工具失败，烧掉的 reference 工作在日志中可见。聚合器"不设 token 上限"的既定选择不变——预算是墙钟，不是截断。
- **Embeddings 请求**——`createExternalEmbeddingProvider` 新增 `timeoutMs`（默认 30s），在 `embedding.ts` 中作为每个 HTTP 请求的 `AbortSignal.timeout` 传入。经 memory Config `embeddingsTimeoutMs` 接线。消费方本就降级：`hybridSearch` 把 embed 失败接进词法路径（T6.7），`promoteDraft` 将 embedding 缓存视为 best-effort——预算到期只降召回质量，从不使回合失败。
- **Capture 提取子代理**——`extractDrafts` 新增 `timeoutMs` 实参（默认 120s，memory Config `captureTimeoutMs`），把预算组合进传给 `subagents.start` 的 signal。到期的子代理抛错；失败被记录并审计为 `extractionRan: false`（失败语义由 memory-lifecycle-and-capture-audit note 细化，T7.5），`persistCapture` 仍写入耐久 dialog。

测试钉住每个预算：挂起的聚合器在预算内使工具失败（`moa.spec.ts`）、挂起的 embeddings fetch 在预算内拒绝（`embedding.spec.ts`）、挂起的提取子代理在预算内抛错（失败语义由 T7.5 细化）外加两条静态 `parseExtractionProposal` 项（新 `capture.spec.ts`，已入 memory 包测试白名单）。

关联：[moa 插件](../bug-fix/2026-08-24-rlm-moa-plugin.zh.md)（拥有本预算所约束的面板决策）、[memory Phase E embedding 缝](../feature/2026-08-30-rlm-memory-phase-e-embedding-seam.zh.md)（拥有本超时包裹的 provider）。

## Alternatives considered

**Embeddings 超时后重试。** 现阶段否决：重试会在同步路径上倍增最坏延迟并掩盖端点健康问题；词法回退已覆盖失败，有界的重试应等真实的延迟数据（由将来的 `purpose:'rlm-subcall'` 遥测记录，而非今天猜测）。

**全插件共享一个超时常量。** 否决：三个表面的成本形态不同（综合是长文生成、embeddings 批次是亚秒级、提取子代理是完整 agent 运行），同一个数要么大到无用、要么小到无用。逐表面 Config 字段把可调项留在语义所在处。

**经会话处置 controller 中止 capture 子代理（verifier 模式）。** 暂缓：真实需求，但归 `agentsBySession` 生命周期修复（NEXT T7.5）所有——它拥有 dispose 路径接线；此处的墙钟预算与之独立。

## Consequences

家族内再无任何旁路调用能挂死回合；每个表面的失败在该响亮处响亮（moa 在 references 落日志后抛出）、在已有降级处降级（embeddings → 词法，capture → 仅 dialog）。代价：三个新 Config 字段需要保持文档同步，且 moa preset 的 resolved 形状多了一个必填字段——编译器从此强制未来的 preset 形状变更同步更新（`llm-stream.spec.ts` 的字面量已被迫更新一次）。
