# 把插件运行模式同步进运行中的 DeepSeek Harness Desktop

English | [中文](sync-plugin-runtime-mode-to-desktop.md)

如何把动态 Cordis 插件系统——`dsh-cordis-host-runner`、`dsh-cordis-client-runner`、`dsh-host-plugin-inventory`、`dsh-client-ui-cordis`、`dsh-client-ui-rlm`、`dsh-tool-cordis`——及其支撑包（`dsh-client-runtime`、`dsh-session`、`dsh-llm`、`dsh-llm-pi-ai`、`dsh-web-app`）外加 RLM 系列，从源码工作区推送到运行中的 DeepSeek Harness Desktop 安装包里。

桌面进程从一个已构建的安装包加载代码。在 Windows 上，安装包位于 `%APPDATA%\io.github.hairyf.deepseek-harness-desktop\dependencies\dsh`；其 `node_modules\@deepseek-ai\*` 是编译后的 `lib/` 产物。该同步把刚构建好的 `lib/` 拷入该目录树，作为对上一次安装的更新。

## 前置条件

- 源码工作区可编译：运行 `pnpm run build:lib` 并确认退出码为 0。
- 确定桌面安装根目录（即包含 `node_modules\@deepseek-ai` 的目录），下文以 `<desktop-install>` 指代。
- 一份可恢复的、带时间戳的待覆盖包备份。

## 步骤

1. 构建工作区。
   `pnpm run build:lib`
   该命令把 host 与 client 两面编译进每个包的 `lib/`、`lib/types/` 与 `lib/client.js`。

2. 备份即将改动的安装包。
   把每个目标 `@deepseek-ai/<pkg>` 目录从 `<desktop-install>/node_modules/@deepseek-ai` 拷到一个带时间戳的同级目录，以便出错时可恢复。

3. 同步 RLM 系列。
   `pnpm exec tsx scripts/sync-rlm-deployment.mts --deploy-root <desktop-install> --skip-build`
   该脚本拷贝五个包、补齐运行时依赖，并校验每个已部署包都有入口文件、且不含 extensionless 相对导入。参见 `scripts/sync-rlm-deployment.mts`（详见 RLM 同步架构笔记）。

4. 同步其余包。
   对其余每个包，把构建后的包目录（排除 `node_modules`）拷入 `<desktop-install>/node_modules/@deepseek-ai/<dsh-pkg-name>`。使用 Node `fs.cpSync`（不要用 PowerShell `Copy-Item`，它会递归进入嵌套的 `node_modules` 符号链接并导致路径溢出）：
   ```js
   import { basename } from 'node:path'
   import { cpSync, rmSync } from 'node:fs'
   rmSync(to, { recursive: true, force: true })
   cpSync(fromPkgDir, to, { recursive: true, filter: (s) => basename(s) !== 'node_modules' })
   ```
   目标目录名必须是完整的 `@deepseek-ai/dsh-<name>`（例如 `dsh-cordis-host-runner`），而非源码路径的 basename（它缺少 `dsh-` 前缀）。

5. 重新应用 `DSH_PKG_ALLOW_LAN` 守卫。
   `dsh-web-app/lib/startup.js` 里的该守卫是安装包上的本地补丁，源码中并不存在，因此第 4 步会覆盖掉它。拷贝完成后，恢复该 host 检查：
   ```js
   const allowLan = process.env.DSH_PKG_ALLOW_LAN === "1";
   if (options.host === "0.0.0.0" && !allowLan) program.error("error: --host 0.0.0.0 is blocked for safety: it would expose remote code execution to the network; set DSH_PKG_ALLOW_LAN=1 to opt in");
   ```
   安装包根目录保留着原始补丁文件（`dsh-web-app@<version>.patch`）作为依据。

6. 校验部署产物。
   对每个已同步的包，确认其 `package.json#main` 文件存在于 `lib/` 下，且不存在字面的 extensionless `.js`/`.ts` 相对导入。`sync-rlm-deployment` 脚本已覆盖 RLM 包；对其余包复刻同一检查。

7. 重启桌面。
   Node 会缓存已 require 的模块，因此运行中的进程会保留旧代码，直到重启。重启时页面短暂变白是预期内的重新加载，并非崩溃。

## 校验

- `pnpm exec tsx scripts/sync-rlm-deployment.mts --deploy-root <desktop-install> --skip-build` 对每个 RLM 包打印 `ok` 并以退出码 0 结束。
- 每个非 RLM 包的 `lib/<main>` 文件存在，且可在纯 Node 下加载。
- `dsh-web-app/lib/startup.js` 含有 `DSH_PKG_ALLOW_LAN` 守卫。

## 易错点

- **PowerShell 会递归进入 `node_modules`。** `Copy-Item -Recurse` 配合 `-Exclude node_modules` 仍会下钻；源码包带有嵌套的 pnpm 符号链接，会形成无限长的路径。改用 Node `fs.cpSync` 并加 `filter: (s) => basename(s) !== 'node_modules'`。
- **目标目录名写错。** 安装包期望的是 `@deepseek-ai/dsh-<name>`；源码路径的 basename 缺少 `dsh-` 前缀。拷到 basename 会生成无用的死目录，而真正的包保持陈旧。务必映射到完整的 `dsh-*` 名称。
- **`DSH_PKG_ALLOW_LAN` 是安装包本地的。** 它只存在于已安装的 `dsh-web-app/lib/startup.js` 里（作为补丁）；源码的 `lib/startup.js` 不含它。每次拷贝 `dsh-web-app` 后都要重新应用。
- **`.css` 导入是误报。** `lib/types/client/*.js` 文件会导入 `./X.module.css`；extensionless 导入检查会标记它们，但这些是未打包的客户端模块。运行时加载的是打包后的 `lib/client.js`（由 rolldown 产出），其中 css 已被解析——确认该 bundle 不含字面的 `from './X.module.css'`。一次成功的 `pnpm run build:lib` 已经证明 rolldown 解析了这些 css。
- **必须重启。** 运行中的进程在重启前一直提供旧代码；重启时页面短暂变白是预期的重新加载，不是崩溃。
