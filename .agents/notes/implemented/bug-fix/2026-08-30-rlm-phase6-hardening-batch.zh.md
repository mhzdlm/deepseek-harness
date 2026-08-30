# Agent Note: RLM Phase 6 hardening batch (T6.1–T6.22, commit 3ac8e63ae2)

Status: implemented

## Problem

2026-08-30 复核的 Phase 6 审计在 RLM 各包发现一批小而真实的缺陷：`/memory` 参数接受穿越形态；召回的 `use_count` 触碰令文件 mtime 移动、使 `/memory rollback` 误报"用户改动"；capture 失败被吞；hybrid search 有无守卫的零词元路径与未处理的 embed 失败；config 在要求 `min(1)` 处接受 0；若干失败路径不记日志。

## Decision

提交 `3ac8e63ae2`（message 头 "harden memory/kernel/verifier/loop/harness against traversal, mtime false-positive, silent failures, config traps"）按 NEXT.md 落实 T6.1–T6.22 修复：

- **穿越加固**：`/memory` 参数经 published 界内 sanitizer 解析，拒绝 `..` / 绝对路径 / 出树（T6.4）；`archiveNote` 拒绝非 `published/` relPath（T6.18）。
- **mtime 假阳性**：`updateUsage` 冻结 pre-write mtime——召回不再移动文件，`/memory rollback` 不再把每次召回误判为用户改动（T6.5）。
- **静默失败浮出**：`runCapture` 失败记日志并清缓冲（T6.6）；hybridSearch 补零词元守卫 + embed 失败降级 lexical + `embedding.data` 缺失兜底（T6.7）；continual-harness auto-refine 用可取消 AbortController、review/run 错误不再被吞（T6.10）；verifier in-flight abort 短路 tournament 而非中性平局（T6.13）；verifier detail 归档掩码 `rawText` 与 logprob 词元（T6.14）；kernel dispose 错误浮出（T6.15）；`landEntry` 记录落盘失败（T6.17）。
- **上限**：capture 缓冲封顶 `MAX_CAPTURE_TURNS`（T6.19）。
- **Config 陷阱**：moa/kernel/verifier 的 config 键补 `min(1)`（T6.9）。
- **内核生命周期**：`rlm.delete_subagent` 从会话集合清掉自己的 controller（T6.16）。
- **测试基建**：两个孤儿 spec（`restore-notice.spec.ts`、`loop-preset.spec.ts`）入各自包脚本白名单（T6.8）；compaction test 脚本补 `--root`（T6.1）；`finishError` 对齐官方 `max-tokens`/`code`（T6.3）。
- **订正（T7.9）**：T6.22 的 "drop dead void turnPrefix" 只删了显式 `void` 标记——`parseRlmSummary` 仍计算 `turnPrefix` 且无调用者消费。死字段/解析器在 T7.9 真正删除；mid-turn 上下文仍以 `<compacted-summary>` 文本形式前传。见 `2026-08-30-rlm-hygiene-batch.md`。

文档同行：STATUS/INSTALL/README/NEXT、recipe 头、memory/compaction 双语 README（EN/zh + i18n 配对），并更新 Phase E embedding-seam note。

## Verification

提交时各包 typecheck + keyless 测试全绿；修复至今仍由包套件钉住（memory `consolidate.spec.ts`/`memory-cmd.spec.ts` 增加穿越/拒绝用例；kernel `restore-notice.spec.ts` 与 verifier `loop-preset.spec.ts` 进入各自包白名单）。

## Alternatives considered

**`/memory` 参数逐字段运行时校验。** 否决：统一走单个 published 界内 resolver——一个 sanitizer 覆盖所有触路径的子命令，新子命令不可能忘记自己的检查。

**restore/rollback 改为比较内容而非 mtime。** 否决：内容比较每次召回 O(n) 且仍有歧义（相同内容可能是用户重写）；冻结 pre-write mtime 是 O(1) 且保持既有快照 mtime 纪律。

**extraction 失败直接 fail capture。** 本批否决：capture 本是最佳努力——错误记日志并清缓冲（T6.6）；"失败传播为 `extractionRan:false` 而非静默"的审计诚实升级在 T7.5 落地。

## Consequences

Phase 6 的 P0/P2 全部单提交落地并有测试；穿越 sanitizer、mtime 冻结、失败日志是持久机制，config `min(1)` 陷阱消除。代价：hybrid 召回在 embed 失败时按设计静默降级 lexical（warn 记日志）；穿越 sanitizer 拒绝一切出树路径形态，即使未来某子命令合法需要（应扩展 resolver 而非绕过）。