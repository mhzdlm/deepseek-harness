# rlm preset 装配说明

[English](README.md) | 中文

<!-- 本文职责：说明 `agent-presets/rlm/` 组合的用途、为何不在 shipped roster 中、以及可用装配路径。 -->

`agent-presets/rlm/` 是 RLM 融合模式的 Cordis 组合（`preset.yml` + `agent.cordis.yml`）。它不放在 `apps/cli/config/agent-presets/`：真实 `dsh` 运行时无法从 profile 目录解析 `@deepseek-ai/dsh-plugin-rlm-*` 四个包——CLI 的依赖闭包不含它们，tsconfig paths 别名只在 vitest 工具链生效。放进 shipped config 会得到一个 roster 里可选、选中即装配失败的选项。

## 装配路径

1. 显式挂载：在同一 host 内用 `ctx.plugin()` 挂载四个插件，并保持四者的 `dataDir` 配置一致。
2. 参考本组合：以 `agent.cordis.yml` 的插件声明为蓝本自建 preset；解析前提是四个包对加载器可见（workspace 源码树或已安装进 profile）。

四个插件的 npm 包 `files` 含 `src/**/*` 与 vendored Python runtime，发布形态与源码树的解析行为一致。`packages/rlm/plugin-rlm-verifier/tests/rlm-preset.spec.ts` 以本目录为 AgentPresets root，在 vitest 工具链下验证 roster 发现与工具注册。

除四个 rlm 插件外，`agent.cordis.yml` 还装配了 host 层通用的 `compaction`（自动压缩，isolate realm）、`goal`（持久目标）与 `schedule`（定时重入）能力——支撑跨长会话的自动上下文压缩与非阻塞长任务，是对 Prime Agent 的非阻塞长任务面（compaction + schedule + persistent goals）的对齐。