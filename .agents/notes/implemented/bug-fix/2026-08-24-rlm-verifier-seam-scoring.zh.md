# Agent Note: verify 评分迁到宿主缝上，Python 桥退役

Status: implemented

[English](2026-08-24-rlm-verifier-seam-scoring.md) | 中文

## Problem

`verify` 曾通过 vendored Python 包（`llm_verifier`）在子进程或活动内核里为候选打分。该传输迫使出现凭据转发面（`forwardProviderCredentials`）、每次调用只能单后端评判、没有用途归因，以及一类已知局限（内核路径永远无法鉴权；载荷传输需要 base64 技巧）。编写家族契约时记录的收敛触发条件——dsh-llm 暴露选中 token 的 logprobs——如今已经触发。

## Decision

verify 工具的执行层就是宿主缝本身：

- `src/scoring.ts` 逐字移植评判契约：20 字母量表、成对提示布局、在流式 logprob 条目上定位标签（累计文本匹配、融合 `>` 处理、末次匹配规则），以及带字面文本回退的 Eq 3.1 期望分提取。
- `src/tournament.ts` 移植概率枢纽锦标赛（带种子的环循环、Bradley-Terry 软胜负、枢纽选择/轮次）。mulberry32 取代 Python 的 Mersenne Twister：同种子运行的确定性限定在 TypeScript 内部；跨语言环一致性明确不属于契约。
- 单模型与多评判（`judges[]`）运行共享同一代码路径——每个评判一次完整 PPT，跨评判用 Borda 融合排名。多评判不再需要逐 profile 的凭据变量；每个评判可任取 adapter 路由。
- `src/python-bridge.ts`、它的 spec 与 `forwardProviderCredentials` 被删除。`cacheFile` 从 Config 移除（它缓存的是已不存在的 llm_verifier 结果）；评分调用携带 `logprobs: { topLogprobs: 20 }`、默认温度，以及同参考 DeepSeek 路径一致的 `maxTokens` 4096。

校准证据：对 deepseek-v4-flash 与 v4-pro 的在线探针（`scripts/calibrate-judge.mts`）显示两个模型都会自行发射 `<score_A>/<score_B>` 标签，且移植后的提取在已知答案 fixture 上精确返回 1.0 / 0.0。

## Alternatives considered

**保留 Python 桥并增加逐评判凭据转发。** 否决：每增加一个厂商就扩大一遍敏感信息波及半径，并为一个能力保留三种传输。

**只移植锦标赛，用注入客户端保留 llm_verifier 做逐对评分。** 否决：客户端仍从子进程内读取进程环境来鉴权，转发顽疾仍在；而逐对调用形态（单一用户提示、logprobs 标志）本来就是最容易移植的那一半。

## Consequences

整个 rlm 家族一个执行模型：每次模型调用都经由缝，带 adapter 托管的凭据、会话关联与事件记录。代价：评分提示现在成了必须手动跟随论文修订的 TypeScript 字符串常量（由钉住提示布局与提取数学的契约测试对 fixture 缓解）；不支持 logprobs 的提供商降级到字面文本回退而不是报错；移除 `cacheFile` 意味着重复的相同运行会重新支付评分调用，除非未来针对新引擎设计缓存。

## Testing

- `tests/scoring.spec.ts`：8 项——标签定位（后随位置备选、分裂标签累计匹配、末次匹配优先、null 情况）与 Eq 3.1 提取（大小写合并后的最大概率期望、融合 `>` 剥离、带字母取值映射的字面回退、非法字母 0.5）。
- `tests/tournament.spec.ts`：4 项——环覆盖、比较数公式 N + k(N−k) + C(k,2)、平局取较小下标、Bradley-Terry 单调性。
- `tests/events.spec.ts`：即使每次评分调用都失败也写入请求事件；on-error 平局下结果事件随之写出；尽力发射被钉住。
- 完整包套件 26/26 绿；四插件预设装载不变；tsc 干净。
