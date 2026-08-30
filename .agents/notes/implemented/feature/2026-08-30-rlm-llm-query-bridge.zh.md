# Agent Note: RLM `llm.query` subcall bridge (LAYERS.md §2, NEXT Phase 7 T7.10)

Status: implemented

[English](2026-08-30-rlm-llm-query-bridge.md) | 中文

## Problem

论文的核心定量技巧——根模型把超长输入切片、在循环内同步扇出廉价子调用并编程化聚合（arXiv:2512.24601v3）——在 dsh 当前不可表达：`rlm()` 是完整子会话（`maxChildrenPerSession=8`、fire-and-forget），host bridge 也没有"直接查 LLM"的 handler。论文主表全部结果的子调用都用弱一档模型（GPT-5 根 + GPT-5-mini 子调用），证明默认子调用降档是质量无损的免费成本规则。

## Decision

`llm.query` 桥（LAYERS.md §2）端到端落地：

- **内核侧**：注入的 bootstrap 绑定 `llm_query(prompt | prompts, **kwargs)`（`_PrimeAgentLlmQuery.query`，`_prime_agent_host_request` 的薄包装的绑定方法）。数组载荷即批量——论文 `llm_batch` 的对应物。两种运行时路径（健康 import、缺 runtime 的安装引导 stub）都绑定它；exec 回归探针在两条路径上断言路由。
- **宿主侧**：第 8 个 handler（`'llm.query'`）经宿主 LLM 缝（`ctx.llm.stream` + `BlockAssembler`，verify/compaction 同路径）执行每个子调用，`purpose: 'rlm-subcall'` 归因——共享 llm 包的 purpose union 增补该成员。
- **路由（R2）**：`subcallModel` 是 kernel Config 选择器（经 preset 配置面管理）；解析顺序为请求 model → 路由选择器 → 所属 agent 的 model。省略选择器 = 不降档（默认不改现状）。
- **配额（R1）**：每会话在途流上限 `maxInFlightSubcalls`（默认 8）+ 批组长上限 `maxSubcallBatch`（默认 32）；超限响亮报错点名键名（`maxChildrenPerSession` 风格）。`abortSession` 清空计数。
- **质量门（§2.4）**：退化答案（空 / 极短 / 同一词元重复 3 次以上——prime Appendix F.1 的「子 LM 放弃」模式）自动重试一次；仍退化则把文本带 `degenerate: true` 标记返回，精确的分块策略留给内核调用方。
- **边界**：每答案按 `maxSubcallAnswerChars`（默认 8000）截断并标记；每次生成自带墙钟预算 `subcallTimeoutMs`（默认 120000，T7.3 同层超时语义）。
- **事件**：每个批次追加 log-only `session/subcall-query` 事件（批量大小、解析到的模型、各答案字符数、截断标记、重试次数、耗时）——LAYERS.md §5 评估层的数据源。persistence catalog 已重生成。

**总量+成本台账**（按会话聚合 purpose 账）仍是 LAYERS.md §2.2 记录的更准确配额方向，待真实 `session/subcall-query` 分布出现后作为可替换方向实施。

## Testing

`host-handlers.spec.ts` 新增 10 项桥单测：单 prompt、批量、空载荷拒绝、批组长拒绝、在途配额拒绝+释放、退化→重试→恢复、仍退化标记、截断、模型解析顺序（请求→选择器→agent）、无 llm 服务响亮失败。`rlm-bootstrap.spec.ts` 断言注入并把 exec 回归探针扩展到两条路径上的两种调用形态。`snapshot-rotation.spec.ts` 的事件集合断言现期望两个内核事件类型。kernel 套件 147/147；typecheck RLM/llm 零错误。

## Alternatives considered

**以总量+成本台账做配额。** 暂缓并记录（LAYERS.md §2.2）：台账是最准确方向（论文成本结论是中位数便宜、长尾贵，要防的是挣扎轨迹），但当前实现成本高于在途并发上限，而后者已阻止无界并行扇出。事件流将为未来的替换提供真实分布。

**ML 路由。** 否决（LAYERS.md §2.3 R2）：路由表是经 preset 配置面管理的校验 Config 字段；只做规则路由。

**宿主侧猜测分块策略。** 否决（LAYERS.md §2.4）：宿主只检测退化信号（空/短/重复）并标记；精确策略（块大小、续接）归内核调用方，与论文"根模型自行决定"的行为一致。

## Consequences

内层原语现在可表达：内核可以在循环内扇出廉价子调用并编程化聚合，带每会话并发与批量边界、每答案截断、墙钟预算与退化答案——一切都在 `session/subcall-query` 中审计。代价：退化时多一次生成（重试），总和已被并发配额约束；想用论文廉价档规则的部署需设 `subcallModel`；总量成本记账作为未来工作在 LAYERS.md 记录。