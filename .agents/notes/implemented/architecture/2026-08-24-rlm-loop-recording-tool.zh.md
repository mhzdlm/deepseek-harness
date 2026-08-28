# Agent Note: 2026-08-24 — rlm-loop：一个录制工具，而非自主监督器

Status: implemented

[English](2026-08-24-rlm-loop-recording-tool.md) | 中文

## Problem

LongHorizon-Harness 的分析（见 operator 的 `docs/LOOP.md`）建议将其 Manage→Execute→Audit 循环移植进 dsh。诱人的形态是一个监督器插件：`loop.start(task)` 自主驱动多轮，host 端派生 manager/executor/auditor 子进程。我们做的恰恰相反：`plugin-rlm-loop` 是一个录制工具，而加入的会话仍然担任 Manager。

## Decision

- 主会话自行规划每一轮；executor/auditor 环节复用组合级别的具名 `dsh-tool-subagent` 实例（`toolName: executor` / `auditor`，一次性）。该插件绝不派生子进程。
- `loop` 工具只持有那些不能依赖模型合规性的部分：严格的三行审计头解析、clean/complete/aligned 信任门、`session/loop-start|round-done` 仅记录日志的事件，以及将契约 + 已验证进度以 CAS 落盘到 continual-harness 状态。
- 已验证进度复用 `loop_<runId>/...` 条目 id 下的既有 `memory` 种类。不引入新的 `HarnessKind` 值。

## Why

在这里，一个带有 harness 注入状态的持久 Manager 优于每轮冷启动的 manager：已验证的事实存在于 harness 条目中，原始轨迹留在子会话里，因此父会话上下文只按蒸馏后的报告增长——LongHorizon 的账本重建机制变得不再必要，而对话连续性（后续回合继续一个已结束的运行）则自然免费获得。

新的种类会触及 continual-harness 的种类联合、渲染管线以及 `/refine` 白名单——其精化逻辑是上游派生的 IP，我们刻意不为便利而重塑。id 约定以零跨包改动买到了注入与回滚能力。

## Alternatives considered

- 不支持从一个 `begin` 调用发起的隔夜自主运行；编排成本为每轮一个模型回合。可接受：在纯 CLI 阶段，每轮耗时以分钟计，而非小时。
- 运行注册表位于内存中；进程重启后，`status` 为空，尽管事件与状态文件仍具有权威性。

## Consequences

- 收益：loop 作为"录制工具"交付，加入会话即 Manager；严格的三行审计头解析、clean/complete/aligned 信任门、log-only 事件与契约+已验证进度的 CAS 落盘全部集中在 `loop` 工具内，绝不自主派生子进程。
- 代价：不支持一次 `begin` 的隔夜自主运行（每轮耗一个模型回合）；运行注册表在内存（重启后 `status` 为空，但事件与状态文件仍权威）；CLI-only 阶段接受该编排成本。

## Verification

- `parseAuditHeader` 拒绝乱序行、越界枚举值、表头前的散文，以及非规范化的大小写（小写规范化这一 bug 是被测试而非评审捕获的）。
- 工具测试覆盖：契约落盘、clean 审计的进度落盘、dirty 判定拒绝、不可解析表头拒绝、无 clean 审计时拒绝 `done`、缺失 note 的告警、针对真实临时目录的 CAS 文件断言。

## Phase A evidence carried into this design

- Auditor 子进程隔离必须使用 `toolFilter.allow`（[read, glob, grep]）：拒绝列表会跨平台失效，因为 shell 工具名是平台受限的（win32 没有 `bash` 行），而 `tools.restrict()` 在遇到未知名称时会 loudly 失败——在 Phase A headless 运行中，修复前曾连续出现四次 auditor 派生失败。
