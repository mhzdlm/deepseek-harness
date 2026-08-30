# @deepseek-ai/dsh-plugin-rlm-compaction

[English](README.md) | 中文

RLM 专属压缩 Provider。`BasicCompactionEngine` 子类：官方 replay-aware、工具配对对齐的压缩事务原样继承，仅替换为 **split-turn 感知摘要器**（P1-B）并叠加 **Files Touched 跨轮携带**（P1-A）——两者全部实现在本包内，共享的 `@deepseek-ai/dsh-compaction-basic` 包保持逐字节不动。

## 为什么单独一个 provider

`compaction-basic` 是所有 preset 共用的压缩后端。split-turn 前缀摘要与 Files Touched 跨轮携带只改*摘要提示词*，不改切割点算法与持久化事务，因此归入独立 provider 而非共享包。本包以消费者（子类）身份依赖 `compaction-basic`，只覆盖其唯一文档化钩子 `summarize()`。

## 行为

- **继承且不变**：触发策略（`auto`/`thresholdRatio`/`retainTokens`）、保留策略、持久化 `compaction/start`–`compaction/end` 事务，以及 `toolPairingBalancedBefore`/`After` 切割对齐。
- **Split-turn 前缀（P1-B）**：当被压缩区域的起始处于 assistant 轮中段（重放首条消息是 `assistant` 续写）时，摘要指令追加 `## Turn Prefix` 一节，让模型记录被切割前正在进行的轮次内容——即 prime 的 `TURN_PREFIX_SUMMARIZATION_PROMPT` 行为。
- **Files Touched 跨轮携带（P1-A）**：摘要指令始终携带 `## Files Touched` 一节；`priorFilesTouched(session)` 扫描会话自身的持久化 `compaction/summary` 日志，取最近一节作为 `PREVIOUS FILES TOUCHED` 提示回填，后续摘要由此继承累计的读/改文件上下文（prime 的 `readFiles`/`modifiedFiles`）。文件上下文连续性不以触碰共享包为代价。

## Model Experience

摘要器复用会话自身的 system prompt、工具 schema 与消息作为请求前缀（KV-cache 对齐），再追加 RLM 指令。该指令独立于 `compaction-basic` 的内部常量维护，不从该包导入任何私有符号。

## Known Limitations and Deferred Work

- split-turn 判定是启发式：区域首条消息为 `assistant` 角色即触发。精确的"切割在轮内"信号需要扩展 `compaction-basic` 的 `SummarizationInput`，本包刻意不做。
- 本 provider 是 `compaction-basic` 的替代项，仅 RLM 挂载；不替换其他 preset 的选择。
