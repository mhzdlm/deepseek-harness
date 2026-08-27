# Agent Note: T4.5 ③ — verify judge degradation observability (kill silent failure)

Status: implemented

- **Date**: 2026-08-26
- **Status**: 已实现（方案 A）
- **Area**: `packages/rlm/plugin-rlm-verifier/src/verify-tool.ts`、`src/events.ts`
- **Symptom**: verify 的评委/评分失败**全链路静默**——`failedJudges` 从不产生（死代码），失败评分被悄悄按平局（0.5/0.5）处理，模型和用户都看不到任何降级信号。

## Problem

T4.5 ③ 原以为"failedJudges/failedLabels 已在事件，只缺 GUI 渲染"。实现前追引擎层发现**verify 侧不成立**：

- `scorePairOnSeam`（verify-tool.ts）`try { await callModel() } catch { ra=rb=0.5 }`——评分调用抛错**永远转 neutral tie**，从不向上抛。
- `runTournament` 只调 `scorePairOnSeam`（不抛）→ 多 judge 的 `status:'failed'` 分支（catch runTournament 抛错）在**正常路径不可达**（仅 n≤0 触发，而 candidates≥2 已检查）。
- 单 judge 路径 judges **恒硬编码 `status:'ok'`**。
- 结果：`failedJudges`（事件、返回、文本）**从不产生**——`session/verify-result` 里 `failedJudges` 与渲染逻辑都是死代码。

这是比 compaction/kernel 更隐蔽的静默失败：数据层就不存在降级信号，GUI 渲染无从谈起。

## Decision

### 1. `scorePairOnSeam` 加失败计数（verify-tool.ts）
新增可选 `failures?: { count: number }` out 参数；catch 转 tie 时 `failures.count++`。tie 语义不变（run 继续），但失败不再无痕。

### 2. judge 状态三态（events.ts）
`VerifyJudgeOutcomeData.status`: `'ok' | 'degraded' | 'failed'`。
- `ok`：全部评分调用成功。
- `degraded`：部分评分失败被按平局处理，但锦标赛跑完、有偏好向量。
- `failed`：锦标赛本身抛错（无向量）。

### 3. 多 judge 路径
- 每个 judge 维护独立 `failures`；跑完无失败→`ok`，有失败→`degraded`。
- `fusable = outcomes.filter(o => o.status !== 'failed')`（degraded 有向量，参与融合——原 `okOutcomes` 语义放宽）。
- `failedJudges = status !== 'ok'` 的 judge 名（degraded + failed 都算，都是"非健康评委"）。
- 结果 text 追加：`verify: N judge(s) degraded or failed (names)`。
- 返回对象 + `session/verify-result` 事件带 `failedJudges`（现在真实产生）。

### 4. 单 judge 路径
- 维护 `failures` → `judgeStatus = failures.count > 0 ? 'degraded' : 'ok'`。
- text 追加：`verify: scoring degraded — N call(s) failed and were scored as ties`。
- 返回对象 + 事件带 `failedJudges: [model]`。

### 5. 测试（verify.spec.ts）
- **新增**「surfaces a partially failing judge as degraded...」：judge-a 全 ok、judge-b 评分抛错 → judge-b `degraded`，`failedJudges=['judge-b']`，text 含 `1 judge(s) degraded or failed (judge-b)`，事件 judges 状态与 failedJudges 同步。
- **更新**单 judge「scores failed calls as neutral ties while surfacing the degraded judge」：全失败 → `failedJudges=[model]`、text 含 `scoring degraded`（原只断 tie，补降级断言）。
- 验证：verify + moa 全包 73/73、typecheck 过。

## Consequences

- 收益：verify 评分失败不再静默——`failedJudges` 真实产生，模型（结果文本）、用户（GUI 文本）、事件（持久可查）均可见降级。
- 代价：`scorePairOnSeam` 的 tie 语义本身不变（平局让 run 继续是既有设计）；结构化 GUI 警示块为后续 UI 工程。

## Verification

verify 评分失败不再静默：**模型**（工具结果 text 含降级提示）与**用户**（GUI generic 渲染结果文本可见）都能看到"评委降级/失败"，`session/verify-result` 事件带 `failedJudges` 持久可查。完全符合 T4.4/T4.5"静默失败→可见诊断"。

## Alternatives considered

- **moa 侧**：`failedLabels` 本就真实产生（返回对象 + loud 文本提示），无静默问题；GUI 警示块（keyed `tool.call.toolview` 高亮）仍为可选后续，需新建 client 插件包（三面注册），本轮未做。
- **verify 的 GUI 警示块**：同理，结果文本已可见，样式化警示块是后续 UI 工程。
- 不改 `scorePairOnSeam` 的 tie 语义本身（平局让 run 继续是既有设计决定）；只让失败可计数、可暴露。
