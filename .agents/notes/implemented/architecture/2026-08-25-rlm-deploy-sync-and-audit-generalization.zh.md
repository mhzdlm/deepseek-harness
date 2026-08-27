# Agent Note: 2026-08-25 — rlm 部署同步工具与通用化供应商导入审计

Status: implemented

[English](2026-08-25-rlm-deploy-sync-and-audit-generalization.md) | 中文

## Problem

将 rlm 家族安装进桌面部署曾是一段耗时数小时的手动流程：构建，手工复制五个包（通过 robocopy 并排除 node_modules），从它们恰好所在的位置拉取运行时依赖，然后在"已部署预设挂载失败"时才发现——有三个被 vendored 的文件带有无扩展名的相对导入（`../../util/platform`），tsx 能解析，但纯 Node 在 node_modules 下无法解析。

## Decision

- `scripts/sync-rlm-deployment.mts`（+ 根目录 `pnpm run sync:rlm -- --deploy-root <dir>`）：构建（可跳过），通过带 node_modules 过滤的 `cpSync` 复制五个包，确保运行时依赖（`zeromq`/`uuid`/`cmake-ts`/`node-addon-api`）来自可选的扁平 `--deps-from`，并在任何已部署包缺少入口或包含无扩展名相对导入时使运行失败。
- audit-vendor 新增第四条 COMMON_FORBIDDEN 规则（`noExtensionlessRelativeImports`）：任何相对说明符不以 `.ts` 结尾的物理导入行。锚定到行首导入，因此注释中的迁移示例不会误报。审计计数现为 49 = 4 条规则 × 6 个文件 + 25 个文件级检查；三个 platform-helper 正则表达式也收紧为要求 `.ts` 后缀。

## Why

同步脚本之所以存在，是因为这五个包有意不声明 dsh.bundle：bundle 补丁属于 host/profile-plane 层，而这些行属于 agent preset（且 `rlm.kernels` 必须留在 isolate realm 之后）。"纯依赖 + junction 视图 + 用户 preset"是受支持的形态，因此它理应得到一键维护。审计的通用化把今天的一次性修复转化为结构性保证——下一个被 vendored 的 helper 导入无法再静默地重新引入同样的"仅部署期"失败。

## Alternatives considered

- 为这五个包声明 dsh.bundle（已调研并否决：错层；见 NEXT.md T0.2）。
- 为 pnpm 提供一个跨平台共享 spawn helper：脚本仅在 win32 上以 `shell: true` 派生 `pnpm`（.cmd shim / EINVAL 约束，与 vendor patch #16 同族），argv 固定，无组合字符串。

## Consequences

- 收益：把 rlm 家族装进桌面部署现为一命令（`pnpm run sync:rlm`），且 audit 新增通用 `noExtensionlessRelativeImports` 规则（49/49），从结构上阻止该"仅部署期"失败被重新引入。
- 代价：五个包仍不声明 dsh.bundle（有意为之，错层）；sync 脚本仅在 win32 以 `shell: true` 派生 `pnpm`（EINVAL/.cmd shim 约束）。

## Verification

- `pnpm exec tsx scripts/sync-rlm-deployment.mts --deploy-root <desktop> --skip-build` → 在真实桌面部署上输出五行 ok，退出码 0。
- `pnpm run vendor:check` → 49/49，且新的通用规则存在。
