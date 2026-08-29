# rlm preset 装配说明

[English](README.md) | 中文

<!-- 本文职责：说明 `agent-presets/rlm/` 与 `agent-presets/loop/` 两个组合的用途、它们提供的两种 RLM 运行模式、以及现在如何在已发布 CLI 下装配。 -->

RLM 有两种运行模式，均以本目录下的 agent preset 形式提供：

- `agent-presets/rlm/` —— **模式 A（普通 RLM）**：持久 IPython 内核本身就是整个循环；模型直接驱动 `rlm()` 递归、`verify`、`moa` 与 `/refine`，无 Loop Engineering 编排。
- `agent-presets/loop/` —— **模式 B（Loop Engineering）**：加入的会话担任 Manager，在 `loop` 工具的记账下跑 Manage→Execute→Audit 循环。执行体 = Manager 在自己的持久内核里调 `rlm()`（状态仍累积在 `user_ns`/dill，与模式 A 完全一致）；独立的只读 `auditor` 子代理核验真实 workspace 证据。双模式契约见 `docs/LOOP.md`。

## 闭包状态（2026-08-29 更新）

RLM 插件包现已进入 CLI 依赖闭包：`@deepseek-ai/dsh-plugin-rlm-kernel`、`@deepseek-ai/dsh-plugin-rlm-verifier`、`@deepseek-ai/dsh-plugin-rlm-moa`、`@deepseek-ai/dsh-plugin-rlm-loop`、`@deepseek-ai/dsh-plugin-rlm-compaction`、`@deepseek-ai/dsh-plugin-continual-harness` 已加入 `apps/cli/package.json` 的 `dependencies`，`pnpm install` 已将它们在 `apps/cli/node_modules/@deepseek-ai/` 下重新软链。因此真实 `dsh` 运行时可解析这些 preset；在 roster 中选中即可装配（此前因闭包不含它们、且 tsconfig paths 别名仅在 vitest 工具链生效，才被排除在 `apps/cli/config/agent-presets/` 之外）。

## 装配路径

1. 显式挂载：在同一 host 内用 `ctx.plugin()` 挂载相关插件，并保持各插件 `dataDir` 配置一致。
2. 参考本组合：以 `agent.cordis.yml` 的插件声明为蓝本自建 preset；解析前提是这些包对加载器可见（现已通过 CLI 闭包或 workspace 源码树满足）。

各插件的 npm 包 `files` 含 `src/**/*` 与 vendored Python runtime，发布形态与源码树的解析行为一致。`packages/rlm/plugin-rlm-verifier/tests/rlm-preset.spec.ts` 与 `loop-preset.spec.ts` 以本目录为 AgentPresets root，在 vitest 工具链下验证 roster 发现与工具注册。

除 rlm 插件外，每个 `agent.cordis.yml` 还装配了 host 层通用的 `compaction`（自动压缩，isolate realm）、`goal`（持久目标）与 `schedule`（定时重入）能力——支撑跨长会话的自动上下文压缩与非阻塞长任务，是对 Prime Agent 非阻塞长任务面（compaction + schedule + persistent goals）的对齐。
