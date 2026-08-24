# Agent Note: RLM 判断类工具收敛到统一的调用与持久契约

Status: implemented

[English](2026-08-24-rlm-unified-judgment-contract.md) | 中文

## Problem

rlm 家族的两个判断工具在调用方关心的同一批语义上契约分裂：`verify` 单模型、单一硬编码凭据对，无隐私档位、无会话关联，判定做出后没有任何"为什么"的持久记录；`moa` 这些都有，但过程信息只落在会话日志之外的旁路文件。调用方无法跨家族统一依赖归因、多模型面板、保密档位或可回放的决策历史。

## Decision

家族契约（记录在工作区 REPLICATE 笔记）钉死统一语义——同一工具 schema 形态、会话关联、用途归因、三档隐私、多模型许可，以及两层持久模型：会话日志是权威过程记录，dataDir 文件降级为缓存/导出/状态仓库。本次变更把两个工具都拉上契约：

- **多评委验证**——Config `judgeProfiles` 命名评委条目（`model`、可选 OpenAI 兼容 `baseUrl`、`keyEnv`、`extraEnv[]`）；工具 `judges` 参数点名。每个评委独立子进程、仅以点名变量认证（spawn 时从 `process.env` 解析、叠在清洗基线之上），结果经 Borda 积分 + 归一均分 tiebreak 融合（`src/fusion.ts`）。多评委强制子进程路径——内核 env 白名单携带不了任意厂商凭据。
- **隐私对齐**——`privacyFilter` 落到 verifier，语义与 moa 一致；`full` 在评分提示前经 `redactReferenceText` 掩码 candidates 文本；该函数上移至 `plugin-rlm-kernel/src/redact.ts` 作为家族共享掩码（moa 改从此处导入）。
- **过程事件**——`session/verify-request|result` 与 `session/moa-reference|synthesis` 加入 `SessionEventMap`，沿用 `session/title-llm-request` 的 log-only 先例：经执行 agent 自己的 Session 在派发前后追加、best-effort、位于派生模型历史之外。MoA 参考事件按活动隐私管线携带 advisor 回答；verify 结果事件携带逐次 scores/ranking 及评委模式的融合输出。
- **目录门禁解锁**——`scripts/gen-cordis-catalog.ts` 补上缺失的 `'rlm.kernels'` SERVICE_WALK_EXEMPTIONS 条目（既有的未渲染 Context 合并键，此前任何再生之前生成器即失败），生成的 API 目录得以纳入放宽的 `GenerateOptions.purpose` 联合。

## Alternatives considered

**现在就把 verify 评分迁到 ctx.llm。** 附触发条件暂缓：seam 尚未暴露 scoring-token logprobs；在此之前迁移意味着换算法而非换传输。

**给两个工具建通用判断框架抽象。** 否决：两个消费方撑不起 ABC，只会对未来需求瞎猜；共享部分（redact 归属、事件命名约定）直接统一。

**单子进程内多评委凭据。** 否决：llm_verifier 每次调用从环境构建一个 client；N 个子进程把每个评委的凭据暴露半径干净隔离。

## Consequences

调用方获得跨家族的单一契约：每次辅助判断都带会话关联、经 request/result 事件可归因、有隐私档位、可选多模型。代价：judge profiles 把额外环境变量名放进 Config（适用部署方密钥策略）；融合排名引入确定性但顺序敏感的 tiebreak 语义；事件族使每次判断运行日志增长数 KB。内核路径保持单模型，直至 logprobs 收敛触发条件成立。

## Testing

- `tests/fusion.spec.ts`: 5 项——一致融合、多数位置 Borda 裁决、第三评委归一均分 tiebreak、失败评委剔除、全败 `-1` 哨兵。
- `tests/moa.spec.ts`: 新增断言 reference/synthesis 事件序列与字段（经录制 session）。
- 包级回归：verifier 21/21（含带 key e2e）、moa 31/31；redact 迁移后重建 kernel 声明，verifier/moa/kernel 三包 tsc 全净。
