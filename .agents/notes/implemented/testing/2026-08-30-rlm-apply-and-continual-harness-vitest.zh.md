# Agent Note: memory apply()-level tests and continual-harness vitest migration (NEXT Phase 7 T7.7)

Status: implemented

[English](2026-08-30-rlm-apply-and-continual-harness-vitest.md) | 中文

## Problem

2026-08-30 审查 §5「补测试」要求补三处覆盖缺口：

- **memory 没有 apply() 级测试。** T7.5 泄漏修复（dispose handler 在三道早退前无条件 `delete agentsBySession`）在挂载路径上没有任何回归网；既有 14 个 spec 全是纯函数套件。
- **plugin-continual-harness 没有 vitest spec。** 它唯一的测试是 768 行手写脚本（`refine-test.mts`），用自造的 `check()`/console.log 机制——不是 vitest 套件，进不了 vitest 报告/过滤，也不符合其他 RLM 包都遵守的包级白名单协议。审查点名的三处（`writeHarnessStates` 的 ENOENT/EPERM 分支、local 回滚补偿、`rollbackRefine` 并发版本告警）其实*已被*那个脚本覆盖，只是没有 vitest 形态。
- **T7.2④ 的孤儿 spec 疑点**（报告称 `restore-notice.spec.ts`/`loop-preset.spec.ts` 不在任何脚本；T7.0/T7.1 称在白名单）需要最终对账。

## Decision

**memory `tests/apply.spec.ts`（6 项，用 fake ctx + 真实事件总线形状驱动真正的 `apply()`）。** fake ctx 捕获 `ctx.on`/`ctx.effect`/`ctx.tools.register`/`ctx.commands.register`/`ctx.get`/`ctx.logger`；测试按 `src/index.ts` 订阅的形状触发 `agent/session-start`、`session/event`、`session/disposed`，并对耐久产物断言（tmp 目录的 dialog jsonl、mock subagent 的 spawn 记录、追加的 `session/memory-captured` 事件、warn 日志）。覆盖：mount 注册数；captureMode off / rootAgentsOnly 子会话 / 空缓冲三条早退分支（无 spawn、无 dialog、无事件）；sessionEnd 冲刷写出净化 dialog（tool 结果剥离）加审计事件；extraction 失败被记录并审计为 `extractionRan:false` 而 dialog 仍落盘；intervalTurns 每 N 轮触发（且低于边界不重复触发）；以及 T7.5 生命周期回归网——dispose 后同一 session 重注册的 agent 是下一次 capture 的提取 parent。黑盒诚实边界：`agentsBySession` map 本身无读取缝隙，泄漏回归以结构性断言（每条 dispose 路径都不带捕获地释放；重注册观察到新 agent）落实，写在文件头。

**continual-harness：`refine-test.mts` 整体迁移为 vitest `tests/refine-test.spec.ts`（34 项，覆盖零丢失）。** 768 行脚本全部机械转写（check()→expect、分节打印→describe/it），包 `test` 脚本从 `tsx refine-test.mts` 改为 vitest 白名单，旧文件删除。审查点现在是显式 describe 块：`writeHarnessState CAS conflict (FIX-7)`（陈旧 mtime→`HarnessConflictError`、null mtime 匹配缺失文件）、`writeHarnessStates global-failure rollback compensation (P1-fix)`（既有 local 恢复与 absent-local 的 REMOVE 逆操作）、`rollbackRefine concurrent-version warning (FIX-5)`。另加一项钉住 absent-file 的 CAS 契约（`null` 匹配缺失；数值即冲突）。

**EPERM 分支诚实记录为跨平台不可单测**（在 CAS describe 里以注释说明）：vitest 无法 spy ESM namespace 导出（实测 `Cannot spy on export "rename"... Module namespace is not configurable`），而真实的 Windows 共享冲突需要并发写者持住目标文件，Linux/macOS 上无法确定性触发。mtime 冲突路径已覆盖用户依赖的同一可重试冲突契约。

**孤儿 spec 对账（T7.2④）定案：** `restore-notice.spec.ts`（kernel）与 `loop-preset.spec.ts`（verifier）都在各自包白名单内（对两个 package.json `test` 脚本逐一核实）——报告的说法早于 T6.8 修复；无缺口。

## Alternatives considered

**丢弃 `refine-test.mts` 另写新 vitest spec。** 否决：768 行沉淀了多年的边界覆盖（双向回滚、absent-local 逆操作、干扰定时器下的重试收敛、corrupt 备份修剪、auto-refine 门控）。迁移保全之；重写有静默丢用例的风险。

**为 EPERM 分支用 `vi.mock('node:fs/promises')` 或 `vi.spyOn`。** 实测失败后否决：vitest 无法重定义 ESM namespace 导出，模块级 mock 会感染文件内其他测试。真实 EPERM 平台相关，CI 无法确定性触发。

**加测试钩子暴露 `agentsBySession` map。** 否决：为可观测性改产品签名不值；结构性断言（dispose 分支不带捕获、重注册 agent 被取用）已钉住修复意图。

## Consequences

两包现在全部 vitest 化、白名单化，无绿灯假象：memory 92/92，continual-harness 34/34，仓库 typecheck RLM 零错误。审查点名的 continual-harness 三处与 memory 分支矩阵全部落入 vitest。诚实边界已写入文件：`agentsBySession` 删除为结构性断言而非直接断言；EPERM/EBUSY rename 路径保持无单测（注释说明原因）而以 mtime 冲突契约覆盖。`refine-test.mts` 式遗留脚本消失；白名单成为每包测试事实的唯一来源。