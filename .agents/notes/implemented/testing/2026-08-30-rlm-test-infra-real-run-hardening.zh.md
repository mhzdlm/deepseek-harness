# Agent Note: RLM test infrastructure real-run hardening (NEXT Phase 7 T7.0/T7.1)

Status: implemented

[English](2026-08-30-rlm-test-infra-real-run-hardening.md) | 中文

## Problem

2026-08-30 终版复核给出两个阻断判断：kernel 包 vitest「跑完进程永不退出」（该包无法进 CI）、「STATUS.md 的全绿从未被实跑验证」（全量实跑屡次卡在 venv 慢供应上）。两者阻塞一切下游实跑验收——包括同包内的 `llm.query` 桥开发（NEXT T7.10）。报告还声称两个孤儿 spec（`restore-notice` 与 verifier 的 `loop-preset`）、断言「七包 `tsc --noEmit` 全绿」，并把 conversation-snapshot 标记为 60ms 固定 sleep 的 flaky。这些结论从未与一次真正跑完的全量套件对过账。

## Decision

以 CI 等价形态（仓库根 cwd、仓库根相对路径 filter、日志重定向后台执行）实跑裁决阻断项：

- **挂死不复现**——单文件×3 与全量×2 全部在 ~60s 内干净退出。报告的 `EXIT=124` 与其方法论注记自认的 `timeout | tail` 假象特征一致，按工具产物结案，非产品缺陷。
- **首次跑完的全量套件立即挖出六个真实隐藏失败**，根因单一：测试替身 `dispose: () => undefined` 违反 `KernelManager.dispose(): Promise<void>` 真实契约（`vendor/kernel/index.ts:1871`），`kernels.ts:570` 的 `void manager.dispose().catch(...)` 打在 undefined 上抛 TypeError。修复三处 fake 为 `async () => undefined`（host-handlers.spec 既有先例），并给 `fakeManager` 加显式返回类型，让未来同类漂移变成编译错误。产品代码无缺陷——是 fake 契约漂移。
- **仓库级 typecheck 揭穿「七包全绿」并清零**（包级程序 `rootDir: src` 从不包含 `tests/`）：`tsconfig.host.json` references 补上漏列的 `plugin-rlm-compaction`（TS6307）；`restore-notice.spec.ts` 对私有 `appendRestoreNotice` 补白盒 cast、字面量改用真 `RestoreResult` 类型（TS2341）；memory 两 spec 类型收紧（TS18048 用具体 cast 形状、TS2345 修正 `fm()` 实参位置）。修后仓库 typecheck 恰好只剩 6 个已记录的官方 pre-existing。
- **conversation-snapshot 固定 sleep 改事件轮询**（`waitForCellEvents`，5s 死限、10ms 步进）；「dispose 后无事件」用例保留 300ms 固定观察窗。运行时不再依赖机器速度。
- **两条「孤儿 spec」均为误报**：`restore-notice` 与 verifier `loop-preset` 都在各自包级 test 白名单里（T6.8 已修，STATUS.md 携带的是修复前旧账，现已清除）。实跑计数闭环：kernel 静态 135 − 2 项 `it.skip` = 133 实跑；memory 78 单元 + 5 real-key e2e = 83。
- **验收纪律成文**：venv-gated / real-key 的 self-skip 不构成验收——必须在具备 venv / key 的机器上实跑确认（STATUS.md 测试统计节）。

关联：[coverage gap closers](2026-08-26-rlm-coverage-gap-closers.zh.md)（拥有 fake 漂移所在的 keep-alive 驱逐矩阵）、[restore notice + refine non-reasoning](../architecture/2026-08-29-rlm-kernel-restore-notice-and-refine-nonreasoning.zh.md)（拥有被改类型的 spec）。

## Alternatives considered

**产品侧防御：在 `kernels.ts:570` 写 `Promise.resolve(manager.dispose()).catch(...)`。** 否决：这是同进程类型化边界，仓库惯例信任 TypeScript；防御包装会把未来一切 fake 漂移静默吸收，而不是响亮失败。

**把挂死当真实产品 bug 追查。** 基于证据否决：CI 路径五次运行全部干净退出后，报告剩余观察与其自认的工具假象吻合；守着一个不可复现的前提会阻塞全部下游工作。

**conversation-snapshot 用更大的固定 sleep（≥300ms）。** 否决：仍是对着真实计时的 flush（debounce + dill 序列化）猜预算；轮询断言的是真实事件，只有「无事件」用例需要固定窗。

**把 venv 实跑门禁自动化进 CI。** 暂缓：按框架裁决，评估现阶段保持手动；纪律以文字形式活在 STATUS.md，待有携带 venv 的 CI lane 时再升级为门禁。

## Consequences

kernel 与 memory 包现在拥有可信的全量全绿基线（×2 次运行），仓库 typecheck 的 RLM 侧清零，T7.10 开发前提成立。类型化 fake 的代价是少量持续仪式：新内核 fake 必须声明 `dispose(): Promise<void>`。审查报告三条结论被实证修正（挂死、孤儿 spec、七包全绿），报告文档本身不改——修正活在 NEXT.md Phase 7 各行、STATUS.md 测试统计与本 Note 中；提交时由 FIXES-ARCHIVE 记录本批。
