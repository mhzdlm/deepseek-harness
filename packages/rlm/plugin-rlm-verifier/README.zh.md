# @deepseek-ai/dsh-plugin-rlm-verifier

[English](README.md) | 中文

LLM-as-a-Verifier 的 best-of-N 选择，完全承载于 harness 的 LLM seam 之上。打分契约是 `src/scoring.ts` 的 TypeScript 移植（20 档刻度、成对 judge 提示、在 verdict 位置的 token 分布上取期望，见公式 3.1），选择循环是 `src/tournament.ts` 中的概率支点锦标赛（Probabilistic Pivot Tournament）——O(Nk) 有向比较而非 O(N²)。挂载 `rlm.store` 时，锦标赛结局经判断通道落于 `crit/verify-eq31-tournament`（structured 层）；无 store 时退化为不落盘。

## 配置

| 配置 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `provider` | string | `deepseek-official` | 打分调用的默认 provider 路由。 |
| `model` | string | `deepseek-v4-flash` | 工具参数未点名时使用的 verifier 模型。 |
| `subagentProvider` | string | `spawn` | `auto_spawn` 候选生成所用的子代理 provider。 |
| `maxChildChars` | number | `20000` | 每个派生候选收集输出的字符上限。 |
| `privacyFilter` | `'' \| 'display' \| 'full'` | `''` | `display` 在输出中标注逐 judge 来源；`full` 对候选摘要与持久化详情档案做凭据/PII 掩码（经由 `@deepseek-ai/dsh-plugin-rlm-redact`）。 |
| `judgeProfiles` | record | — | 命名 judge 档案（`name → { model, provider? }`）；工具的 `judges[]` 参数从中选择做多 judge 融合。 |
| `dataDir` | string | `~/.dsh/rlm` | 运行产物根目录；每次 verify 运行把完整详情 JSON 写入 `<dataDir>/session-artifacts/<sid>/verify/`，结果携带路径。 |
| `maxCandidates` | number | `24` | 单次调用候选池硬上限；超限响亮报错。 |
| `maxEvaluations` | number | `8` | `n_evaluations`（每对比较的打分遍数）上限。 |
| `maxAutoSpawn` | number | `8` | `auto_spawn` 子代理数量上限。 |
| `verifyTimeoutMs` | number | `600000` | 整次 verify 的墙钟预算；judge 端点挂起不得永久钉住回合。 |
| `maxPivots` | number | `8` | `pivots` 参数的绝对上限（T9.2）。 |
| `maxInFlightPairCalls` | number | `4` | 并发成对打分调用的有界池。 |
| `maxTokens` | number | `4096` | 单次打分调用的输出 token 上限。 |

## 工具：`verify`

参数：`problem`（必填）、`candidates`（必填数组；建议至少 2 条）、`criteria`（可选 JSON 名称→描述映射，默认 specification/output/errors）、`n_evaluations`（每判据 K 遍，默认 4）、`pivots`（PPT 支点数 k，默认 2，钳制到 N）、`seed`（环形 pass 种子，默认 0）、`model`、`judges`（命名档案，各跑一次独立验证后融合排名）、`auto_spawn`（>0 且 `candidates` 为空时派生相应数量子代理解题，best-of-N）、`gate_score`。派生子代理按会话跟踪，`session/disposed` 时中止。

## 行为：自治质量门（T3.3）

可选的 `gate_score`（0-1 阈值）使结果按最佳候选得分报告 `passed`/`failed` 的 `gate`，并带模型可见的提示：门通过不代表任务成功——它是自治循环的下界过滤器，从不是裁决。省略 `gate_score` 则门保持 `unset`（无行为变化）。

## 模型体验

### 验证结果

#### 模型看到什么

候选文本原样进入由 `buildJudgePrompt` 构建的成对 judge 提示；工具除该提示外不添加自己的模型可见引导。

#### Token 影响

一次 `verify` 调用增加面板打分提示词与结构化结果文本（`N judge(s)`、各得分）；成本随候选与 judge 数量增长，与问题规模无关。

#### KV 缓存影响

请求路径上无状态：每条打分提示都是一次全新调用，verifier 从不修改更早的请求 token。

## 已知限制与待办工作

- v1 LLM 缝只暴露 chosen-token logprobs，因此每个 verdict 位置只有单一备选，公式 3.1 的期望退化为所选字母的刻度值；多备选机制保持完整，待暴露变体的缝出现。
- 详情档案写入（`artifactRoot`）是 best-effort：写失败只丢文件，不丢验证。

## 状态

Phase D（2026-09-01）：家族的带打分选择门——锦标赛结果作为 structured 层判断落进 store，使经过验证的选择成为可审计的流条目，而非工具侧便签。家族总览见 [packages/rlm/README.md](../README.md)；家族级状态见文档仓 BUILD.md。
