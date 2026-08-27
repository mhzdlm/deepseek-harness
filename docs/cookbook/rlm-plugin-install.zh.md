# 把 RLM 插件族安装到另一个 DeepSeek Harness

English | [中文](rlm-plugin-install.md)

RLM（recursive language model，递归语言模型）插件族是一组 Cordis 插件，让 agent 拥有持久化 IPython 内核，外加 LLM-as-a-Verifier 裁判、Mixture-of-Agents 融合、带审计的循环录制，以及可持久化的自我改写。本文列出这些包、说明它们如何配合，并演示如何把它们安装到另一个 DeepSeek Harness Desktop 或运行时。

## 包清单

所有 host 包位于 `packages/rlm/`；client 包位于 `packages/client/`。

| 包 | 类型 | 提供 | 关键事件 / 服务 |
|---|---|---|---|
| `plugin-rlm-kernel` | host | `ipython` 工具（持久内核）、`rlm.run` 递归子代理、`create_python_skill`；服务 `rlm.kernels`（按会话的内核注册表） | `session/kernel-snapshot` |
| `plugin-rlm-verifier` | host | `verify` 工具（对候选轨迹做概率支点锦标赛裁判） | `session/verify-result`（携带 `failedJudges`） |
| `plugin-rlm-moa` | host | `moa` 工具（参考槽融合）+ `/moa` 命令 | `session/moa-reference` |
| `plugin-rlm-loop` | host | `loop` 工具（Manage→Execute→Audit 录制；审计头解析 + 信任门） | `session/loop-start`、`session/loop-round-done` |
| `plugin-continual-harness` | host | harness 总览注入；`/refine` + `/refine-rollback`；`/harness`；CAS 写入路径 | harness 状态文件 |
| `ui-rlm`（`packages/client/ui-rlm`） | client | `verify`/`moa` 的 `tool.call.toolview` 行，展示降级警示 | — |

`plugin-rlm-verifier` 消费 `rlm.kernels`，在同一持久内核里跑候选代码；`plugin-rlm-loop` 与 `plugin-rlm-kernel` 通过 `plugin-continual-harness` 的 CAS 管线落地持久状态。

## 它们如何配合

agent preset [`docs/recipes/agent-presets/rlm/agent.cordis.yml`](../recipes/agent-presets/rlm/agent.cordis.yml) 把 `plugin-rlm-kernel`、`plugin-rlm-verifier`、`plugin-continual-harness`、`plugin-rlm-moa` 组装进同一个 agent-plane 分组，并声明 `isolate: { rlm.kernels: true }`，于是内核注册表活在 realm 私有符号里，而不是进程全局 root。

- `plugin-rlm-kernel` 是计算与状态基座。
- `plugin-rlm-verifier` 与 `plugin-rlm-moa` 对候选解做裁判与融合（走 LLM seam 与 subagents；verifier 还走 `rlm.kernels`）。
- `plugin-rlm-loop` 录制带审计的轮次，并把已验证进度落地进 `plugin-continual-harness`。
- `plugin-continual-harness` 把持久记忆/技能注入系统提示，并通过 `/refine` 支持可逆自我改写。
- `ui-rlm` 在浏览器里把 verifier/moa 的降级可视化。

持久化主线是：`plugin-continual-harness` 状态（重新注入提示）+ `session-artifacts/<sessionId>/` 文件 + 仅日志型的会话事件。

## 安装到其他环境

有两种安装机制。**host/client 之分决定每个包装到哪里。**

### Host 包：通过 pnpm profile 做持久安装

DeepSeek Harness Desktop 按 **profile** 存放已安装的包。新建或扩展一个列出 host rlm 包的 profile：

- Profile 目录：`<dsh-home>/profiles/rlm/`
- `profiles/rlm/package.json` 把 `@deepseek-ai/dsh-plugin-rlm-{kernel,loop,moa,verifier}`（若该模式需要 `/refine`，再加上 `plugin-continual-harness`）列为 `file:` tarball，例如 `file:<dsh-home>/rlm-pkgs/deepseek-ai-dsh-plugin-rlm-kernel-0.1.1-rc.2.tgz`。
- 执行 profile 安装，使 `profiles/rlm/node_modules/@deepseek-ai/dsh-plugin-rlm-*/lib/` 被填充。

桌面随后会在 agent-preset 选择器里暴露该模式（例如"rlm 融合模式"）。Host 包在进程重启时从 `node_modules` 重新加载，因此不需要重建 web。

### Client 包 `ui-rlm`：必须进 web profile + 重建 bundle

`ui-rlm` 是 **client** 插件。浏览器不会加载逐包的 `lib/`，它加载的是 `dsh-web-app` 用 rolldown 产出的那一个打包文件 `lib/client.js`。因此 `ui-rlm` 必须装进 **web profile**，而不是 rlm profile：

1. 把 `@deepseek-ai/dsh-client-rlm` 加进 `profiles/web/package.json`（作为带版本依赖，或 `link:` 到本地构建）。
2. 在 `profiles/web/cordis.patch.yml` 里用 `dsh.client` 行注册它（现有文件已挂载 `win-terminal-inspector`，按相同方式加上 `ui-rlm`）。
3. **重建 `dsh-web-app` bundle**，让 rolldown 把 `ui-rlm` 折进 `lib/client.js`。
4. 刷新页面。

跳过重建，即便包"已安装"，降级警示行也不会出现。

### Lib 拷贝同步（临时；不持久）

[`sync-plugin-runtime-mode-to-desktop`](sync-plugin-runtime-mode-to-desktop.zh.md) 这篇 cookbook 描述了把刚构建好的 `lib/` 拷进 `<desktop-install>/node_modules/@deepseek-ai/<dsh-pkg>`（通过 `scripts/sync-rlm-deployment.mts` 与 `fs.cpSync`）。这对 **host** 包有效，对 **client** 包无效，因为浏览器加载的是 web-app 打包文件，不是逐包的 `lib/`。在桌面运行期间覆盖 `node_modules` 还会在重启时造成**短暂白屏**——旧进程一直服务缓存的模块，直到重启重新加载更新后的代码。那次白屏是预期的重新加载，不是崩溃。

桌面一次 **更新** 会刷新 `dependencies/dsh` 并清除手动拷入的 `node_modules` 条目；只有 profile 安装能扛过更新。凡是要持久的东西，请用上面的 profile 机制。

## 校验

- Host 包：用 `cordis_inspect_query` 查询运行中的 host，`Tool.listTools`（应有 `ipython`、`verify`、`moa`、`loop`）、`Service.listService`（应有 `rlm.kernels`）、`Event.listEvents`（应有 `session/verify-result`、`session/loop-start`……）。这些是 agent-plane 作用域的，要从使用了 rlm preset 的会话去查，而不是别的方式。
- Client 包：web 重建并刷新后，打开 `verify` 或 `moa` 工具卡片；当某个裁判/参考失败时，应出现一行降级警示。

## 易错点

- **host 与 client 目的地不同。** Host rlm 包 → rlm profile；`ui-rlm` → web profile。把 `ui-rlm` 放进 rlm profile 毫无作用。
- **client 包需要重建 web。** 把 `ui-rlm/lib/` 拷进 `node_modules` 永远不会进浏览器 bundle。
- **`rlm.kernels` 是 realm 隔离的。** rlm preset 必须声明 `isolate: { rlm.kernels: true }`；不带该 realm 挂载插件会通不过 preset 审计。
- **lib 拷贝不持久。** 桌面更新会清掉手动拷入的 `node_modules`；优先用 profile 安装。
- **重启时白屏是预期的**（lib 拷贝法）；那是重新加载，不是崩溃。
