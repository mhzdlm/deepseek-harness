# Agent Note: Kernel processes get one default-deny environment boundary

Status: implemented

[English](2026-08-24-kernel-env-default-deny-boundary.md) | 中文

## Problem

RLM 内核从三处派生子进程——`vendor/kernel/index.ts` 的直接 `spawn()`、`fork-server.ts` 的 forkserver 模板进程、`bootstrap.ts` 的引导子进程。此前只有第一处过滤环境变量：forkserver 模板原样携带宿主完整环境，内核子进程经 `os.environ.update`（只增不减）继承全部凭据类变量；必须运行安装器的引导子进程也收到了本不需要的凭据。Windows 上还有相反的问题：真实键名为混合大小写（`Path`、`SystemRoot`、`windir`），大小写敏感匹配把它们全部丢弃——缺 `SystemRoot` 是 Windows 子进程的经典故障源。

## Decision

单一模块 `packages/rlm/plugin-rlm-kernel/src/kernel-env.ts` 拥有两组环境构造：

- `buildKernelEnv(overrides?, platform?, source?)` —— 内核进程的默认拒绝白名单，用于直接 spawn 与 forkserver 模板。凭据类前缀（`DSH_`、`DEEPSEEK_`、`OPENAI_`、`ANTHROPIC_`、`GOOGLE_`、`AZURE_`、`AWS_`、`PRIME_`、`PI_`、`CODEBUDDY_`、`CLAUDE_`）在任何白名单检查之前阻断；运行必需项（`RLM_*`、`PATH`、`HOME`、`USERPROFILE`、`SYSTEMROOT`、`SYSTEMDRIVE`、`TMP`、`TEMP`、locale、`PYTHON*`）放行。工具命名空间（`UV_*`、`npm_config_*`）不放行——二者都携带凭据形态变体（`UV_PUBLISH_TOKEN`、npm auth/代理配置）；需要它们的 uv/bootstrap 子进程改经 `buildScrubbedEnv` 获取。win32 上匹配折叠键名大小写但输出保留源键原始大小写；POSIX 上为精确大小写匹配，与既有内联实现逐字节等价。
- `buildScrubbedEnv(platform?, source?)` —— 仅凭据黑名单剥离，供合法需要宽环境的引导子进程使用（uv 安装器、bootstrap shell 步骤）。代理、XDG、locale 设置保留，仅移除含密钥命名空间。

`overrides` 并入时不复筛；调用方只传内部 `RLM_*` 接线。黑名单导出为规范常量 `CREDENTIAL_BLOCKLIST_PREFIXES`，verifier 的子进程剥离直接导入该常量而非自持副本。`platform` 与 `source` 参数使两种大小写语义在任何主机上确定性可测（`tests/kernel-env.spec.ts` 共 12 项，注入式 source，不改真实 `process.env`）。`scripts/audit-vendor.mts` 新增 #14 检查项与全量 env 直通禁令（所有 vendor 内核文件禁止 `...process.env` / `env: process.env`，共 49 项）钉住导入与调用点防回归。

## Alternatives considered

**在各调用点各自维护过滤器。** 否决：三个独立过滤器会漂移，本次缺陷正是漂移的产物——三处中已有两处不一致。单一模块提供单一可审计边界。

**在 fork 出的内核子进程内过滤。** 否决：`os.environ.update` 只增不减，子进程侧过滤无法移除模板已携带的内容；模板进程是唯一的收口点。

**全部改用仅黑名单剥离。** 对内核进程否决：黑名单要求永久枚举所有 provider 前缀，未知凭据命名空间默认放行。白名单反转该默认；黑名单只保留在确实需要宽环境的地方（安装器）。

**所有子进程一律空环境。** 否决：`PATH` 查找、locale、依赖 Windows `SystemRoot` 的子进程全部失效；故障模式从凭据暴露变为内核不可用。

## Consequences

三条 spawn 路径上的内核子进程都不再看到 provider 凭据，Windows 也保住了此前丢失的运行变量。代价是需维护的白名单：内核功能需要新变量时必须在模块里显式添加，而不是被动继承宿主环境。fork-server 路径仅在 Linux 启用且本仓库开发机为 Windows，该路径经 tsc、单测与审计门验证，但未经真实 Linux fork 实测。env 过滤收窄的只是凭证面——模型仍可写任意 Python 访问网络；这不是沙箱。

## Testing

- `tests/kernel-env.spec.ts`：12 项，经注入式 source 覆盖双平台的阻断、放行、大小写、overrides、工具命名空间排除与剥离语义。
- `tests/kernel-env-runtime.spec.ts`：1 项端到端——宿主植入的凭据不会出现在真实内核子进程的 os.environ 中（无内核 venv 时自动跳过）。
- `scripts/audit-vendor.mts` #14 检查（`index.ts` 共享模块导入、`fork-server.ts` 净化启动环境、`bootstrap.ts` 净化引导环境）加全量 env 直通禁令，共 39 项。
- `pnpm exec tsc --noEmit -p packages/rlm/plugin-rlm-kernel/tsconfig.json` 与包内 vitest 保持全绿。
