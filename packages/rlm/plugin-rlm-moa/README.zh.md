# @deepseek-ai/dsh-plugin-rlm-moa

[English](README.md) | 中文

面向 RLM 家族的 Mixture-of-Agents（MOA）合成。它把一个问题（附可选上下文与候选答案）扇出到多个参考模型槽位，用合成器槽位聚合它们的建议，返回融合后的答案以及各参考贡献的来源说明。Phase D 新增反向筛选审计面：`rlm_audit` 工具与 `/moa audit run|pending|release` 子命令，复用同一模型缝与 `rlm.store` 的审计管线。

> Phase D（2026-09-01）：与 `src/index.ts` / `src/moa-tool.ts` / `src/audit-tool.ts` 逐条对齐，含 `audit` 配置块与 `/moa` 命令面。

## 配置

| 配置 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `dataDir` | string | `~/.dsh/rlm` | trace 与托管 preset 根目录；必须与其余 rlm 插件的 `dataDir` 一致。 |
| `presets` | record | 内置 `default` | 命名面板：`referenceModels[]` + `aggregator`。preset 级旋钮：`referenceMaxTokens`（4096）、`referenceTimeoutMs`（120000）、`aggregatorTimeoutMs`（300000，T7.3）、`degradedPolicy`（`loud`）、逐槽 `mode`。 |
| `defaultPreset` | string | 首个 / `default` | 调用未点名 preset 时使用。 |
| `privacyFilter` | string | `''` | `''` 关闭；`'display'` 在渲染结果中标注参考来源；`'full'` 在 advisor 文本进入聚合器与 trace 前做凭据/PII 掩码（经由 `@deepseek-ai/dsh-plugin-rlm-redact`）。 |
| `trace` | boolean | `true` | 写 JSONL trace 至 `<dataDir>/moa-traces/`。 |
| `subagentProvider` | string | `'spawn'` | `mode:'subagent'` 参考槽未自带 `provider` 时使用的子代理 provider。 |
| `maxChildChars` | number | `20000` | `subagent` 槽子代理结果截断的字符上限。 |
| `audit` | object | 缺省 | Phase D 审计接线：`critic`（`provider`、`model`）、`producerModel`、`timeoutMs`（120000）。缺省或 critic 无 `model` 时 `rlm_audit` 以指引报错停用。 |

## 工具：`moa`

参数：`problem`（必填）、`context`（可选共享背景）、`candidates`（可选草稿答案，作为参考模型的额外输入）、`preset`（可选命名面板）。普通补全型参考槽走宿主 LLM 缝（`ctx.llm.stream`——**不是**内核的 SubagentRuntime）；仅 `mode:'subagent'` 槽会派生带工具的子代理。单个参考失败折算为 `failed` 状态让面板继续；调用方中止（会话销毁）会原样传播，不再伪装成参考失败。全部参考失败时响亮报错、不调用聚合器。挂载 `rlm.store` 时合成结果经判断通道落于 `crit/moa-aggregator`（open 层——永远不能晋升 evidenced）；无 store 时退化为不落盘。

## 工具：`rlm_audit`

Phase D 反向筛选审计。参数：`beliefId`（必填）、`scope`（`'session'` 默认 / `'mailbox'`）、`producerModel`（缺省取配置的 `audit.producerModel`）。硬约束：批评者必须是与生产方不同的模型——同模型批评是复读而非独立审计，store 侧管线在任何模型调用前会复查该约束。结局：`pass`（落 check-pass）、`objection-accepted`（落 demotion/voiding）、`objection-rejected-frozen`（信念信任门资格冻结、待人工复核）、`skipped`。无 `rlm.store` 或未配置 critic/producerModel 时响亮报错并给出指引。

## 命令：`/moa`

`/moa list`、`/moa show <name>`、`/moa use <name>`、`/moa remove <name>` 管理 preset 库（`<dataDir>/moa-presets.json`；`/moa use` 对后续调用立即生效）。Phase D 审计子命令：`/moa audit run <beliefId> [--mailbox]`（人工触发单次审计）、`/moa audit pending [--mailbox]`（冻结信念的批量复核队列）、`/moa audit release <beliefId> <note>`（人工放行，落 `unfreeze` 判断）。三者都需要 `rlm.store` 服务。

## 模型体验

### 合成结果

#### 模型看到什么

problem/context/candidates 以组装好的提示词经宿主 LLM 缝到达参考与合成器槽位；工具不额外添加模型可见的指引，只有插件装配的 MOA 提示词。每个参考的建议以带来源标注的块交给聚合器。

#### Token 影响

一次 `moa` 调用增加参考扇出提示词、合成器提示词与融合结果文本；成本随参考数量增长（N+1 次往返），每个参考受 `referenceMaxTokens` 与 `referenceTimeoutMs` 约束，聚合器受 `aggregatorTimeoutMs` 约束。一次 `rlm_audit` 调用增加一次批评者补全（4096 token 上限、`audit.timeoutMs` 预算）与渲染后的结局。

#### KV 缓存影响

在请求路径上无状态：每次参考与合成器调用都是宿主侧的全新 LLM 请求，因此插件从不修改更早的请求 token。

## 已知限制与待办工作

- 参考聚合信任合成器报告来源；某个参考失败会在结果文本中具名，但不会阻断合成。
- 参考槽看不到 harness 与工具（`mode:'subagent'` 子代理除外——它们带工具运行）。
- preset 级 `aggregatorTimeoutMs` 运行时生效且已声明进 Config schema（Phase 8），但尚未通过托管 `/moa` store 命令暴露。
- 批评者槽位只来自配置、绝不推断——`audit.critic` 配错模型会在使用时响亮报错，而不是悄悄破坏独立性约束。

## 状态

Phase D（2026-09-01）：家族的模型扇出缝——MOA 合成负责聚合，同时是反向筛选审计传输层的宿主（管线本体在 `plugin-rlm-store/audit`）。家族总览见 [packages/rlm/README.md](../README.md)；家族级状态见文档仓 BUILD.md。
