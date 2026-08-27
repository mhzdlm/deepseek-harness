# Agent Note: 2026-08-24 — rlm 家族覆盖率缺口测试，以及两处潜在的 Windows/持久化缺陷

Status: implemented

[English](2026-08-24-rlm-coverage-gap-tests.md) | 中文

## Problem

对 `packages/rlm`（当时 179 个测试）针对仓库的每文件 100% 门禁做一次覆盖率缺口审计，发现该家族位于门禁的 include glob 之内且无任何排除项，此外还有若干“已记为修复”的行为从未被测试钉死。本批次在五个包中新增 51 个无 key 用例，在 Windows 上跑通真实 key 的 e2e 套件，并且——因为编写测试本身即审计——当场修复了新断言立即暴露的两处缺陷。

## Decision

- 通过真实的公共入口测试 handler/tool 接缝：在结构化伪造的 `agents`/`subagents`/`llm` 之上测试 `createHostHandlers`；通过一个真实的 `ctx.plugin(PluginRlmVerifier)` 挂载配合桩服务测试验证器的销毁接线；通过记录型伪造 session 测试 loop 事件；通过真实临时文件测试 harness CAS。除一个 vendor helper（见下）外，未为可测性放宽任何源码导出。
- Vendor 获得 `[local patch #16]`：`run()` 将通过 PATHEXT 解析得到的 `.bat`/`.cmd` 目标，经 `%COMSPEC% /d /s /c "<quoted command line>"` 加上 `windowsVerbatimArguments` 路由。Node 的 CVE-2024-27980 缓解措施会使直接 spawn 批处理文件以 `EINVAL` 失败，因此在 `uv` 解析到一个启动器 shim 的机器上（观察到：`C:\WINDOWS\system32\uv.bat`），内核引导永远无法运行。这扩展了 [2026-08-24-rlm-publish-surface-and-platform-residues](../bug-fix/2026-08-24-rlm-publish-surface-and-platform-residues.zh.md)（#13f/#13b/#15）中的平台残留批次；来自 #15 的 PowerShell 安装器选择保持权威。该 spec builder 被导出并在 `platform.spec.ts` 中以单测钉死；audit-vendor 新增检查项 #16（现共 43 项）。
- `writeHarnessStates` 的回滚存在双重损坏：写前快照在本地一半落地*之后*才拍摄（恢复的是新内容——等于空操作），而补偿写却用调用方过期的期望去 CAS，而非用写操作产生的 mtime，因此其冲突被静默吞掉。修正为：在本地写之前拍摄快照，并针对刚观测到的 mtime 进行补偿；回滚失败时的撕裂视图仍属文档化限制。
- FIX-7 的过期-mtime 检查在相互竞争的写之间新增了 20 ms 的停顿：在 NTFS 上，前后紧接的重命名可能落在同一 mtime 刻度内，使冲突（及其断言）变得不稳定。

## Why

handler 表与销毁接线，恰恰是 AUDIT P1-1 此前已经抓到过单边修复的地方；没有回归测试，同样的漂移会无声地再次发生。对于 #16，修补共享的 `run()` 可在单一位置覆盖每一个引导子进程（uv 安装/升级、pip、python 导入探测），保持来自 #14 的已擦除环境边界完好，并与 #13e 已让 `.bat` shim 可达的方式一致。仅放宽纯 spec builder（而非 `run` 本身）的导出，使 spawn 路径仍保持 vendor 形态，同时仍可测试。

## Alternatives considered

- 针对内联的 `findExecutable`（#13e）和 `state-snapshot` 容量上限直接写单测：两者都需要导出更多 vendor 面或一个真实内核；危险的 `.bat/.cmd` spawn 面已通过 #16 单测覆盖，而快照上限仍由 idle-reclaim/e2e 间接覆盖。
- 一个目标 exe 缺失的过期 shim 仍会使引导失败（`isExecutable` 只检查 shim 的存在性）。选择了修复机器状态（重装 uv），而非教解析器去探测执行候选；记录于 windows-compatibility §7.6。

## Consequences

- 收益：rlm 家族补齐 51 个无 key 回归用例（落进每文件 100% 门禁），并由新断言当场暴露、就地修复两处真实缺陷——vendor #16 批量 `.bat`/`.cmd` spawn、以及 `writeHarnessStates` 回滚快照/补偿 CAS 双重损坏。
- 代价：为可测性外扩了一个 vendor helper（`run()` 的 spec builder）导出；`findExecutable` 与 state-snapshot 容量上限等内联路径因需活内核/vendor 面而仍未单测。

## Verification

- Package 套件在 win32 上全绿：kernel 69（13 文件）、verifier 30、moa 33、loop 18；continual-harness refine-test 80 项检查。修复后真实 key e2e 5/5（`rlm-e2e` + `refine-e2e`），含 depth-2 递归。
- `pnpm --filter @deepseek-ai/dsh-plugin-rlm-kernel run vendor:check` → 43/43，含新增的 #16 条目。
- venv 经修补后的引导路径从零重建（`ensureKernelPython` 在先前以 `spawn EINVAL` 失败之处成功）。
