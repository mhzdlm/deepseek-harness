# Agent Note: T4.5 — Error escalation across three layers: status, slicing, and backlog

Status: implemented

English | [中文](2026-08-26-rlm-error-surfacing-layers.zh.md)

- **Date**: 2026-08-26
- **Area**: `plugin-rlm-kernel`（Layer ②，本轮落地）、`plugin-rlm-verifier`/`plugin-rlm-moa`（Layer ③，UI 依赖）、`plugin-rlm-loop` + shell/web（Layer ①，UI 依赖）
- **Status**: Layer ② 内核诊断上浮已落地；①/③ 的"渲染到 GUI"为 UI 依赖项，本轮只记录现状与设计

## Problem

`packages/llm/llm/src/error.ts` 定义稳定 code：`AUTH`(401/403)、`QUOTA`、`RATE_LIMIT`(429)、`CONTEXT_WINDOW_EXCEEDED`、`INVALID_REQUEST`、`SERVER`、`TRANSPORT`、`ABORTED`、`EMPTY_RESPONSE`、`MALFORMED_RESPONSE`、`STREAM_CLOSED`。`llm-deepseek`/`llm-pi-ai` 把提供方错误规范化为这些 code，并以 `finish {kind:'error', failure:{code}}` 形式上浮。所以**① 的"区分 QUOTA/auth/network 文案"分类器已存在**，缺口在渲染层而非分类层。

## 三层现状

### ① loop 收口 finish.kind=error → GUI 可见诊断
- 分类：LLM 层已产出 `finish.kind='error'` + code。
- 缺口：**GUI 是否把这些 code 渲染成"QUOTA/auth/network"友好文案**未核实（shell/web 渲染层）。这是 UI 依赖项，不在 rlm 包内。
- 建议：在渲染层把 `finish.failure.code` 映射为用户文案（如 `QUOTA`→"账户额度/余额耗尽"、`AUTH`→"鉴权失败（key 无效/过期）"、`CONTEXT_WINDOW_EXCEEDED`→"上下文超限，压缩器将介入"、`TRANSPORT`→"网络/网关不可达"）。

### ② 内核 sweep/快照失败 → 同一诊断通道（本轮落地）
- 修复前：`flushSnapshot` 失败事件写死 `error: 'snapshot failed'`（占位符，无诊断价值）；idle sweep 顶层失败 `console.warn`（丢进 stdout，不进会话/UI）。这正是 T4.4 的"静默失败"模式。
- 修复后（`packages/rlm/plugin-rlm-kernel/src/kernels.ts` `flushSnapshot` + `index.ts` sweep）：
  - 失败事件携带**真实错误文本**（`snapshotError instanceof Error ? message : String(...)`），不再是占位符；
  - idle sweep 顶层失败从 `console.warn` 改为 `ctx.logger.warn('[rlm-kernel] idle sweep failed; next sweep retries', { error })`（结构化、可被日志系统捕获）；
  - per-session reclaim 快照失败已通过 `session/kernel-snapshot {ok:false, reason:'reclaim', error:<真实文本>}` 进入**持久会话日志**（用户可见、可统计）。
- 统计侧（`~/.dsh/tools/session-stats.mjs --snapshots`）：摘要新增 `failure reasons`（去重样本）、时间线失败行行内显示 `error="..."`。

### ③ verify failedJudges / moa failedLabels → 渲染层亮出
- 数据已在：`verify-tool.ts` 在失败评委时写 `failedJudges: failedJudgeNames`（`verify-request`/result 事件）；`moa-tool.ts` 在 `degradedPolicy:'loud'` 时把 `failedLabels` 拼进结果文本，并写入事件 `failedLabels`。
- 缺口：这些字段**是否在某 UI 渲染层被高亮**（而非只在原始事件里）未核实——UI 依赖项。
- 建议：渲染层对 `failedJudges`/`failedLabels` 非空时亮出警示块，列出失败评委/引用标签。

## Decision

- `kernels.ts` `flushSnapshot`：捕获 `snapshotError` 并填入事件 `error` 字段。
- `index.ts`：idle sweep 顶层失败 `console.warn` → `ctx.logger.warn` 结构化。
- `session-stats.mjs --snapshots`：摘要 `failure reasons` + 时间线行内 `error`。
- 测试：`snapshot-rotation.spec.ts` 新增/修正断言——reclaim 失败事件携带真实错误文本（原断言 `'snapshot failed'` 占位符已改为具体 message）。
- 验证：合成会话（1 ok + 1 failing reclaim）`--snapshots` 正确显示 `error="dill pickle error: ..."`；kernel 单测 10/10 通过；typecheck 通过。

## Alternatives considered

- **不改 LLM 错误码体系**：已完备，重复造轮子。
- **①/③ 的 GUI 渲染**：属于 shell/web 渲染层，超出 rlm 包与本次"内核诊断上浮"范围；本轮只记录现状与设计，移交后续 UI 工作。
- **不新增独立"kernel diagnostic"事件类型**：复用既有的 `session/kernel-snapshot {ok:false, error}`（log-only、已入 persistence catalog），避免再扩事件目录与配对负担。

## Consequences

- 收益：Layer ② 内核诊断（snapshot flush / idle sweep 失败）现在携带真实错误文本进入持久会话日志，用户可见、可统计。
- 代价：①/③ 的 GUI 渲染（文案映射、failedJudges/failedLabels 高亮）移交后续 UI 工作，本轮只记录设计与现状；不新增独立 kernel diagnostic 事件类型（复用既有 log-only 事件）。

## Verification

- `tsc -p packages/rlm/plugin-rlm-kernel/tsconfig.json --noEmit` 通过。
- `snapshot-rotation.spec.ts` 10/10（含失败事件真实错误文本断言）。
- `session-stats.mjs --snapshots <合成失败会话>` 显示 failure reasons + 行内 error。
