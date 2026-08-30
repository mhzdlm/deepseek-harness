# @deepseek-ai/dsh-plugin-rlm-verifier

[English](README.md) | 中文

LLM-as-a-Verifier 的 best-of-N 选择，完全承载于 harness 的 LLM seam 之上。打分契约是 `scoring.ts` 的 TypeScript 移植（20 档刻度、成对 judge 提示、在 verdict 位置的 token 分布上取期望，见公式 3.1），选择循环是 `tournament.ts` 中的概率支点锦标赛（Probabilistic Pivot Tournament）——O(Nk) 有向比较而非 O(N²)。

## 配置

| 配置 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `dataDir` | string | `~/.dsh/rlm` | 落地运行产物的 harness 基础目录；必须与其余 rlm 插件的 `dataDir` 一致。 |
| `model` | string | `deepseek-v4-flash` | 工具参数与调用装配都未指名时使用的 verifier 模型。 |
| `provider` | string | `deepseek-official` | 打分模型的默认 provider 路由。 |
| `subagentProvider` | string | `spawn` | `verify.auto_spawn` 候选生成使用的 subagent provider。 |
| `maxChildChars` | number | `20000` | auto_spawn 路径下每个生成候选收集输出的字符上限。 |
| `privacyFilter` | `'' \| 'display' \| 'full'` | `''` | `display` 在输出上标注每位 judge 的来源；`full` 在打分提示前遮蔽候选文本。 |
| `judgeProfiles` | record | — | 命名 judge 配置（`name → { model, provider? }`）；工具参数 `judges[]` 从中选取，做多评委 Borda 融合。 |

## 工具：`verify`

`verify` 接收 `problem`、一个或多个 `candidates` 以及可选的 `judges`，运行评委面板，返回最优候选及其平均偏好分数与验证轨迹。

## 行为：自主质量门（T3.3）

可选 `gate_score`（0-1 阈值）让结果按最优候选分数报告 `gate` 为 `passed`/`failed`，并带模型可见说明：gate 通过不代表任务成功——它是自主循环的下界过滤器，不是裁决。省略 `gate_score` 时 gate 为 `unset`（行为不变）。

## 模型体验

### 验证结果

#### 模型看到什么

候选文本在 `buildJudgePrompt` 构建的成对 judge 提示中原样到达 judge 模型；工具本身不额外添加任何面向模型的引导，仅该提示除外。

#### Token 影响

一次 `verify` 调用向当轮增加评委面板的打分提示以及结构化结果文本（`N judge(s)`、所选分数）；开销随候选数与 judge 数增长，与问题规模无关。

#### KV 缓存影响

在请求路径上无状态：每次打分提示都是一次全新调用，因此 verifier 从不修改更早的请求 token。

## 已知限制与待办工作

- v1 的 LLM seam 只暴露 chosen-token 的 logprobs，因此每个 verdict 位置只有单一候选，公式 3.1 的期望退化为所选字母的刻度值；多候选机制保留给暴露变体的 seam 使用。
- 真实运行时挂载需等待与其它 rlm 插件相同的依赖闭包修复（`apps/cli` 未依赖 rlm 包）；在此之前工具通过显式 `ctx.plugin()` 挂载或 vitest 工具链组合抵达会话。
- 详情归档写入（`artifactRoot`）尽力而为：写入失败会丢弃文件，但绝不丢弃验证本身。
