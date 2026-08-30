# Agent Note: Memory session lifecycle and capture audit honesty (NEXT Phase 7 T7.5)

Status: implemented

[English](2026-08-30-rlm-memory-lifecycle-and-capture-audit.md) | 中文

## Problem

2026-08-30 复核揭出两个缺陷。

**Agent-per-session 注册表泄漏（T6.11 重开，实锤）。** `plugin-rlm-memory` 维护 `agentsBySession: Map<sessionId, Agent>`，以便 capture 把真实 `parent` 交给提取子代理（`Session` cast 没有 `.ctx`）。`session/disposed` handler 有三道早退——`captureMode === 'off'`、`!eligible(session)`（`rootAgentsOnly` 默认拒绝每个子代理会话）、"无缓冲条目"——全部位于 `agentsBySession.delete(id)` 之前。于是 off 模式下、每个子代理会话、以及每个无捕获回合的会话，`Agent` 强引用永驻 Map。`rootAgentsOnly` 默认 true 意味着每个子代理会话都泄漏其 `Agent`。

**Capture 审计谎报（P1#3）。** `extractDrafts` 用 `catch { return [] }` 包住 `subagents.start` + `run.result`，把 spawn 错误、子代理崩溃、超时一律折叠成空结果；`runCapture` 随后无条件置 `extractionRan = true`，还创建了一个从未 abort 的 `AbortController`。净效果：在 `session/memory/captured` 审计事件里，永久失败的提取与"无内容可记"不可区分，失败在日志里不可见。

## Decision

**生命周期：无条件释放。** `agentsBySession` 的 delete 移到 dispose handler 顶部、任何早退之前；`Agent` 先取出，capture 路径用它（`session as Agent` 回退 cast 现在只覆盖注册表从未见过的会话，如插件挂载前就存在的会话）。被处置的会话无论 capture 模式、资格、缓冲状态一律释放其 `Agent`。`buffers`/`counts` 无需等价改动：它们唯一的写入方（`bufferTurn`）已被同样的早退门控，跳过清理的路径上本就为空。

**审计诚实：失败传播，再作为失败记录。** `extractDrafts` 去掉吞错 catch：空 dialog 仍在 spawn 前返回 `[]`，干净运行但无所获仍返回 `[]`，但 spawn 错误或子代理运行 reject 现在会向外抛。`runCapture` 用 try/catch 包住调用：失败时经 `ctx.logger.warn` 记 `capture extraction failed for <id>` 并在审计事件保持 `extractionRan = false`，随后照常持久化 dialog 并落任何已产出的 proposals。死 `AbortController` 删除（调用改传普通 `new AbortController().signal` 作为无取消默认信号；墙钟预算在 `extractDrafts` 内部组合，T7.3）。

测试（`tests/capture.spec.ts`）：T7.3 的超时项改为断言预算内 reject（其旧断言"解析 []"描述的是旧吞错契约，随行为一并更新）；spawn 错误 reject；干净空结果仍返回 `[]`；空 dialog 短路不变。dispose 路径回归网（每会话释放 Agent）归 T7.7 要建的 `apply()` 级套件。

关联：[capture 管线](../feature/2026-08-30-rlm-memory-phase-a-write-path.zh.md)、[调用面超时](../bug-fix/2026-08-30-rlm-call-surface-timeouts.zh.md)。

## Alternatives considered

**继续吞错、只加日志。** 否决：日志修不了审计事件——那是模型可见的记录；失败的提取必须 `extractionRan = false`，否则下游仍会丢失这一区分。

**给提取子代理接 disposal-abort（verifier controller 模式）。** 暂缓：子代理已被墙钟预算（T7.3）兜底且 dispose 时 fire-and-forget；每会话 disposal-abort controller 是生命周期接线，属将来的子代理生命周期工作，不属于本次诚实性修复。

## Consequences

会话 `Agent` 不再活过其会话；失败的 capture 现在是可见的、被审计的失败而非静默空结果——耐久 dialog 两种情况下照常落盘。代价：`extractDrafts` 契约从"永不抛"变为"子代理失败即抛"，随之更新了 T7.3 时代的测试，并把吞错边界只留在真正需要宽容处（`parseExtractionProposal` 的解析宽容）。
