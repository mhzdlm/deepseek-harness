# Agent Note: RLM 插件发布面收口与 Windows 平台残留落地

Status: implemented

[English](2026-08-24-rlm-publish-surface-and-platform-residues.md) | 中文

## Problem

`packages/rlm/*` 三个插件的 npm `files` 只声明了 `lib/**`，而运行时需要更多：`exports["./src/*"]` 承诺了从未随包发布的源码路径，`plugin-rlm-verifier` 跨包导入 `@deepseek-ai/dsh-plugin-rlm-kernel/src/env.ts` 与 `/src/kernel-env.ts`，内核 bootstrap 从包根的 `vendor/prime-agent-runtime/` 解析 vendored Python 运行时。因此发布的 tarball 无法启动内核——这还没算装配链本身的缺口。rlm preset 组合此前放在 `apps/cli/config/agent-presets/`，shipped roster 提供了一个在 vitest 工具链外无法挂载的模式。

同批还有四个小缺陷：`forkedKernelDied()` 用裸零信号 kill 探活，Windows 上 EPERM 语义歧义；`fork-server.ts` 用递归 `rmSync` 删自己的 socket 目录——正是 #13b 补丁在其他位置禁止的模式；`ensureUv()` 调 `sh -c`，全新 Windows 主机不存在该命令；`safeRmDirSync()` 以 `rmSync(path, { recursive: false })` 收尾，而它在所有平台上对目录直接抛 `ERR_FS_EISDIR`——该 helper 只删除了文件，静默留下空目录骨架。

## Decision

发布面与代码实际加载的内容对齐：

- 三个包的 `files` 增加 `"src/**/*"`；kernel 包另加 `"vendor/prime-agent-runtime/**"`。
- `runtimeCandidateDirs()` 同时覆盖两种布局——tsc 输出（`lib/types/vendor/kernel`）与源码树（`src/vendor/kernel`）——候选链都终结于 `<packageRoot>/vendor/prime-agent-runtime`。
- rlm preset 组合迁至 `docs/recipes/agent-presets/rlm/`；shipped roster 不再提供它。`rlm-preset.spec.ts` 从新位置挂载，验证层级保持 vitest-only。

Windows 残留经既有平台层收口：

- `forkedKernelDied()` 改为返回 `!isPidAlive(pid)`（[local patch #13f]）；审计器禁止 `index.ts` 出现裸零信号 kill。
- forkserver socket 目录走 `safeRmDirSync`（[local patch #13b] 扩展到 `fork-server.ts`，审计器强制）。
- `ensureUv()` 经 `uvInstallSpec()` 选择安装器：win32 用 PowerShell `irm … install.ps1 | iex`，其余平台保留 POSIX 管道（[local patch #15]；审计器禁止字面 `run("sh", …)`）。
- `safeRmDirSync` 对每个清空后的目录用 `rmdirSync` 删除；`rmSync(recursive:false)` 会拒绝目录。

测试卫生：`kernel-env-runtime.spec.ts` 改植入 `DSH_RLM_TEST_CREDENTIAL` 金丝雀变量，不再触碰真实 provider 密钥名；`cancel/warmup/idle-reclaim` 补上与 runtime spec 相同的 venv 缺失自跳过守卫；kernel 包级 `test` script 收口全部九个 keyless spec；新增 `tests/platform.spec.ts`（13 项）覆盖四个 helper，`spawnSync`/`writeFileSync` 用委托式 mock、平台语义靠 stub `process.platform`。`scripts/audit-vendor.mts` 现为 42 项检查。

## Alternatives considered

**把三个包加进 CLI 依赖闭包以打通装配。** 暂缓：在 tarball 修复前发布只会扩大暴露面，profile 安装流程也未设计；preset 迁移在该工作落地前可逆。

**经 kernel 包入口 re-export `env`/`kernel-env`，不随包发 `src`。** 本次否决：verifier 的导入当前在源码平面经 tsconfig paths 解析，随包发 `src` 让 vitest、tsx 与未来安装布局共用同一套解析故事。

**审计器一刀切禁零信号 kill。** 否决：POSIX 路径存在合法探针；检查只针对 Windows 歧义位点。

## Consequences

三个插件任一发布的 tarball 都包含其代码运行时解析的全部内容，roster 不再宣传不可挂载的模式。Windows 清理、探活与首次 uv 安装统一走一层受审计的平台代码。代价：`files` 随包发布 TypeScript 源码（rc 阶段内部包可接受）；审计器增至 42 项，需跟随未来的 spawn 位点增长；fork-server 路径仍只有测试与审计门验证——本仓库不存在真实 Linux fork 实测环境。

## Testing

- `tests/platform.spec.ts`: 13 项——taskkill 形状与 POSIX 信号透传（`killSignalSafe`）、ESRCH/EPERM/tasklist 语义（`isPidAlive`）、嵌套树删除、junction 切断且目标完好、缺失目录 no-op（`safeRmDirSync`）、POSIX 应用 mode 与 win32 忽略 mode（`writeFileSecureSync`）。嵌套树用例暴露了 `ERR_FS_EISDIR` 缺陷。
- kernel 包套件：9 文件 / 44 项全绿，含真内核的 `cancel`、`idle-reclaim`、`warmup` 与基于金丝雀变量的运行时 env 项。
- verifier 套件：16 项全绿，含从 `docs/recipes/agent-presets/rlm/` 发现 preset 与注册工具。harness：73 项全过。
- `pnpm exec tsc --noEmit` kernel 与 verifier 全净；`pnpm --filter @deepseek-ai/dsh-plugin-rlm-kernel run vendor:check` 报告 42/42。
