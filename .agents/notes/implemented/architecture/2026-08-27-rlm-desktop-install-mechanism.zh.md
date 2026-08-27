# Agent Note：将 RLM 插件部署到其他 DeepSeek Harness 实例

Status: implemented

[English](2026-08-27-rlm-desktop-install-mechanism.md) | 中文

## Problem

RLM（recursive language model，递归语言模型）插件系列 —— `plugin-rlm-kernel`、`plugin-rlm-verifier`、`plugin-rlm-moa`、`plugin-rlm-loop`、`plugin-continual-harness`（host）以及 `ui-rlm`（client） —— 在 `deepseek-harness` 仓库的 `packages/rlm/` 与 `packages/client/ui-rlm/` 下开发，却通过一条独立的安装路径到达运行中的 DeepSeek Harness Desktop。两类反复出现的故障模式掩盖了它是否真正被安装的事实：

- 从错误的范围查询会返回 "not installed"，即便 `rlm 融合模式` preset 已经挂载：`rlm.kernels` 与 rlm 工具都是 agent-plane 范围的（rlm preset 声明了 `isolate: { rlm.kernels: true }`），因此除非查询会话使用了 rlm preset，否则 host 级的 `Service`/`Event` 目录与当前会话的 `Tool.listTools` 都会漏掉它们。
- 通过把构建好的 `lib/` 复制到桌面 `node_modules`（即 `docs/cookbook/sync-plugin-runtime-mode-to-desktop.zh.md` 中的流程）进行安装，会在重启时导致短暂的空白页，并且无法在桌面更新后存活；对于 client 包 `ui-rlm` 而言它永远不生效，因为浏览器加载的是打包后的 `lib/client.js`，而非各包各自的 `lib/`。

## Decision

通过桌面的 pnpm **profile** 机制部署 RLM，依据运行时解析位置将 host 包与 client 包拆分：

- **Host 包**（`plugin-rlm-{kernel,verifier,moa,loop}` 与 `plugin-continual-harness`）安装到一个专用 profile，例如 `<dsh-home>/profiles/rlm/`，在 `profiles/rlm/package.json` 中以 `file:` tarball 的形式列出，并解析进 `profiles/rlm/node_modules/`。Host 代码在进程重启时从 `node_modules` 重新加载，因此无需重建 web。
- **Client 包 `ui-rlm`** 安装到 **web profile**（`profiles/web`）：在 `profiles/web/package.json` 中加入 `@deepseek-ai/dsh-client-rlm`，并在 `profiles/web/cordis.patch.yml` 中加入一个 `dsh.client` 行，然后**重建 `dsh-web-app` bundle**（rolldown）并刷新页面。仅把 `ui-rlm/lib/` 复制到 `node_modules` 永远无法到达浏览器。
- agent preset [`docs/recipes/agent-presets/rlm/agent.cordis.yml`](../../../../docs/recipes/agent-presets/rlm/agent.cordis.yml) 将 host 插件归并为同一 agent-plane realm，并带 `isolate: { rlm.kernels: true }`；该 realm 隔离是必需的，否则 preset 挂载审计会拒绝它。
- 包清单、host/client 拆分以及分步流程记录在 [`docs/cookbook/rlm-plugin-install.zh.md`](../../../../docs/cookbook/rlm-plugin-install.zh.md)；lib-copy 变体仍作为非持久、仅 host 的路径保留在 [`docs/cookbook/sync-plugin-runtime-mode-to-desktop.zh.md`](../../../../docs/cookbook/sync-plugin-runtime-mode-to-desktop.zh.md) 中。lib-copy 部署脚本的设计记录于 [2026-08-25-rlm-deploy-sync-and-audit-generalization.zh.md](2026-08-25-rlm-deploy-sync-and-audit-generalization.zh.md)，通用 profile 机制记录于 [2026-08-05-profile-plugin-bundles.zh.md](2026-08-05-profile-plugin-bundles.zh.md)；二者分别作为瞬态路径与机制支撑保持有效。

## Consequences

- 一个会话通过挂载 `rlm 融合模式` preset 来选择 RLM；只有该会话的范围才会暴露 `ipython`/`verify`/`moa`/`loop` 以及 `rlm.kernels` service。
- 通过 `cordis_inspect_query`（`Tool.listTools`、`Service.listService`、`Event.listEvents`）从一个使用了 rlm preset 的会话来验证实时挂载 —— host 级查询会漏掉 agent-plane 插件。
- `ui-rlm` 的降级警告卡片只有在 web bundle 重建且页面刷新之后才会出现。
- lib-copy 安装不可持久：桌面更新会刷新 `dependencies/dsh` 并移除手动复制进去的 `node_modules` 条目，因此 profile 安装是唯一持久的路线。

## Alternatives considered

- **lib-copy 同步进 `node_modules`**（即 `sync-plugin-runtime-mode-to-desktop` 方法）：仅作为有文档记录的瞬态、仅 host 路径保留。不采纳为默认，因为它不可持久（会被桌面更新抹除），且对 client 包无效（浏览器使用的是 bundle，而非各包的 `lib/`）。
- **将 `ui-rlm` 安装进 rlm profile**：不采纳，因为 client 插件会被编译进 web-app bundle；rlm profile 从不参与浏览器构建，因此 `ui-rlm` 放在那里什么也加载不到。
