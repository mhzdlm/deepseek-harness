# Agent Note: RLM hygiene batch (NEXT Phase 7 T7.9)

Status: implemented

[English](2026-08-30-rlm-hygiene-batch.md) | 中文

## Problem

2026-08-30 复核的 P3/卫生批留了一堆尾账：三个提交带着 "Agent Note: to be added by committer." 占位符；两处文件头过时；`packages/rlm/temp/` 是未跟踪空目录；T6.20 的 "turnPrefix fix" 归错提交（只删了显式 `void` 标记，死的解析仍在）；P3 代码项（use_count NaN、embedding 维度不匹配、同毫秒文件名碰撞、vendor 层四项）未清；8 篇 pre-format Agent Note 过不了格式门禁（在 `doc-sync` 强制）。

## Decision

**死代码/缺陷批（产品代码）：**
- `storage.ts` `updateUsage`：`use_count: (note.frontmatter.use_count ?? 0) + 1`——字段缺失不再产生 `NaN`（NaN 会让笔记永不退役）。
- `embedding.ts`：provider 对配置/推断 `dim` 与响应向量维度不匹配时抛错，不再静默配对不同长度向量求余弦（配置错误 fail loud）。
- 同毫秒文件名碰撞：`verify-tool.ts`（`${Date.now()}-${…}.json`）与 `ipython-tool.ts`（`${Date.now()}-${…}.log`）加 `randomUUID` 后缀，与 `harness-file.ts` corrupt-backup 命名先例一致。
- `split-turn-summarizer.ts`：死 `turnPrefix` 字段/解析器删除（这次真正落实 T6.20）；`parseRlmSummary` 只返回 `filesTouched`。mid-turn 上下文仍以 `<compacted-summary>` 文本前传，无行为丢失。测试同步。
- Vendor 层 `[local patch #18]`（登记于 `vendor/UPSTREAM`）：`boot-gate.ts` 删除（全仓零调用；audit-vendor 条目移除）；orphan-process-journal 读/身份/清理端删除（零调用；patch #17 令 `processStartId` 恒 undefined，active filter 恒假）；`kernelStderr` 封顶 1 MiB（`MAX_KERNEL_STDERR` + `appendKernelStderr`）；`bootstrap.ts` `run()` 加 120 秒单次超时——挂死的 installer 子进程被 kill，bootstrap 不再被拖死。

**卫生清理：** 两处过时文件头（memory `index.ts` "await Phase C" 自相矛盾；`memory-cmd.ts` 漏 `retire`/`unretire`）改正；`packages/rlm/temp/` 删除；compaction 的 `test` 脚本补上兄弟包都有的显式 spec 白名单（UPSTREAM-SYNC:126 口径闭合）。

**提交占位符：** `3ac8e63ae2`（T6.1–T6.22 硬化批）现在补上真正的 Agent Note——`2026-08-30-rlm-phase6-hardening-batch.md`（EN/zh）。`e1bf5b486d`（删死 recallMode 参数、清 temp cruft）与 `a9e77bc157`（删两个死代码 smell）是机械清理，适用 AGENTS.md 的"仅机械/局部改动可豁免"条款；豁免判定记录在此与 FIXES-ARCHIVE，不为没有决策可记的提交硬写 note。

**Agent Note 格式债（8 篇）清偿：** 六篇 2026-08-29 `implemented/architecture/` 与两篇 2026-08-30 `implemented/feature/` 全部重构为强制的骨架（头部块 + `## Problem` / `## Decision` / `## Alternatives considered` / `## Consequences`，Testing 与 bespoke 段作为现在时事实保留）。事实无增删；pre-format 列表风（Decision/What shipped/Why this shape）映射到骨架，"Why this shape"/"Deviations" 材料成为真正的 Alternatives 记录。八篇均无中文镜像，EN 文件即完整三元组。

## Alternatives considered

**保留 orphan journal 读端并修 filter。** 否决：dsh 宿主零调用，且 patch #17 下 `processStartId` 恒 undefined，任何 "active" filter 都会恒假；删除读/身份/清理端是诚实的裁剪（写端保留真实调用者）。

**"为上游同步"保留 `boot-gate.ts`。** 否决：全仓零调用且其本地 patch 无消费者；ORIGINAL/ 保留原始快照，re-vendor 时可再评估。audit-vendor.mts 随文件一并移除条目。

**注入 fake child 单测 bootstrap 超时。** 否决：vendored `run()` 无缝隙，为 120 秒边界给 vendored 文件加缝隙不值当；超时是机械逻辑，由 audit gate 的 `#18` mustContain 检查覆盖。

**为 `e1bf5b486d`/`a9e77bc157` 写 Agent Note。** 否决：两提交都是无决策可记录的机械清理；AGENTS.md 机械豁免条款适用，豁免在此明记。

## Consequences

格式门禁全绿（692/692）——8 篇债清零，`doc-sync` 不再带着既有违规。产品代码：NaN `use_count`、静默维度不匹配、同毫秒碰撞、无界 stderr 缓冲、可拖死的 bootstrap 子进程、死的 `turnPrefix`/`boot-gate`/journal 读端盈余全部清除；compaction 进入白名单体制。代价：embedding provider 维度不匹配现在 fail loud（配错 `embeddingsDim` 的部署者看到错误而非错误余弦比较）；1 MiB stderr 上限意味着只有尾部可用（本就只是模型可见语义）；bootstrap installer 单次运行封顶 120 秒。诚实边界：`harness-file.ts` 的 EPERM/EBUSY rename 共享路径仍无可跨平台单测，T7.7 已记录。