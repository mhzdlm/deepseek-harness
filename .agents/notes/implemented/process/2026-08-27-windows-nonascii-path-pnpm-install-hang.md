# Agent Note: Windows pnpm install hang at link stage under non-ASCII path

Status: implemented

- **Date**: 2026-08-27
- **Area**: 开发环境 / pnpm Windows
- **Status**: 已诊断

## Problem

在 `C:\Users\mhzdl\Documents\学习\deepseek-harness`（`学习` 为非 ASCII 中文字符）下运行 `pnpm install --offline --frozen-lockfile`，`pnpm 11.7.0` 在依赖解析阶段结束后（`resolved 1218, reused 942`，`.pnpm` 目录已放置 939 个包）进入链接阶段时卡死：`added 0`，CPU 4 核满载持续 11 分钟以上无进展，`node_modules` 顶层始终只有 38 个 entry。

## 诊断过程

### 假设排除表

| 假设 | 实验 | 结论 |
|---|---|---|
| 网络需代理 | `--offline` 模式下 `downloaded 0` （完全不联网）同样卡 | ❌ 排除 |
| 防病毒实时扫描 | 用户关闭 Defender 后重试，仍卡 | ❌ 排除 |
| lockfile 版本不匹配 | `--no-frozen-lockfile` 允许更新 lockfile，同样卡在链接阶段 | ❌ 排除 |
| pnpm 本身 bug / 仓库太大 | 见对照实验 | ❓ 是 pnpm Windows 问题，但只在特定路径下触发 |
| **中文路径含非 ASCII 字符** | 见对照实验 | ✅ **根因** |

### 四组对照实验

同一台机器（Windows、pnpm 11.7.0、防病毒已关、全局 store 共享）：

| 实验 | 内容 | 路径 | 结果 |
|---|---|---|---|
| A | 纯官方 `git clone --depth 1`（246 workspace） | 英文 `C:\dsh-probe\official` | ✅ **16.7s 完成**，`added 935` 平滑推进 |
| B | 同一纯官方副本（robocopy，排除 node_modules） | 中文 `…\学习\dsh-official-probe` | ⚠️ 推进到 933/935 后 **EPERM rename** 失败（文件锁竞争） |
| C | **我们的工作区+所有 Phase 4 改动**（251 workspace） | 英文 `C:\dsh-probe\deepseek-harness` | ✅ **18.9s 完成**，`added 938` 平滑推进 |
| 原 | 我们的工作区+所有改动 | 中文 `…\学习\deepseek-harness` | ❌ 卡死 11 分钟+，`added 0` |

### 根因

**仓库路径包含非 ASCII 中文字符（`学习`）** 是导致 `pnpm 11.7.0` 在 Windows 链接阶段卡死的唯一决定性变量：

- 同一份代码、同一台机器、同一个 pnpm 版本，仅路径从英文换成中文后，install 从 **18.9 秒完成** 变成 **链接阶段 >11 分钟 CPU 满载无法完成**。
- 纯官方代码在中文路径下也会出现 `EPERM rename` 文件系统冲突（虽然症状较轻，因为它是全新 node_modules）。
- 官方已知问题记录：[pnpm Windows 长路径 Issue #7355](https://github.com/pnpm/pnpm/issues/7355)。

pnpm 在 Windows 上使用 junction/symlink 创建 node_modules 连接。当工作路径包含非 ASCII 字符时，pnpm 11 内部对海量（~938 个）包的链接计算可能触发：
1. 文件系统 API 的 ANSI/UTF-8 转换退化；
2. junction 创建失败→重试循环→CPU 满载；
3. 或与 Windows 路径归一化机制的交互 bug。

## Decision

**将仓库迁移到全英文、无空格路径**（如 `C:\dev\deepseek-harness`）即可一劳永逸。

迁移步骤：
1. `robocopy <中文路径> <英文路径> /E /XD node_modules .git`（或 `git clone` + 手工搬运未提交改动）
2. 在新路径跑 `pnpm install --no-frozen-lockfile`（首次需更新 lockfile 收录新包依赖，< 30s）
3. 后续 `pnpm install --frozen-lockfile` 稳定运行

## Consequences

- 收益：定位了 `pnpm install` 在 Windows 中文路径下链接阶段卡死的根因（非 ASCII 路径触发 pnpm junction 计算问题），并给出迁移到全英文路径的解决方案。
- 代价：需将工作区迁到全英文无空格路径（或用 `node-linker hoisted` 绕行）；官方代码在中文路径下仍可能出现 EPERM 冲突。

## Alternatives considered

- 新机器 / 新 clone 时避免将仓库放在含非 ASCII 字符或空格的路径下。
- 若必须在中文路径下工作，考虑 `pnpm config set node-linker hoisted`（传统 npm 风格布局，绕开海量 junction；但需验证兼容性）。