# Agent Note: T4.5 ③ — RLM tool card degradation warning (ui-rlm plugin package)

Status: implemented

- **Date**: 2026-08-26
- **Status**: 已实现（新 client 插件包 `@deepseek-ai/dsh-client-ui-rlm`）
- **Area**: `packages/client/ui-rlm/`（新包）、`packages/rlm/plugin-rlm-moa/src/moa-tool.ts`（host 侧配合）
- **前置**: 方案 A（`2026-08-26-rlm-verify-degradation-observable.md`）已让 verify 降级进结果 text；本篇是 GUI 警示块（T4.5 ③ 的渲染层收尾）。

## Problem

verify/moa 工具卡片在 GUI 里**亮出降级警示块**——评委/引用失败不再只是文本角落，而是醒目警告。

## 关键前提（实现前确认）

- verify/moa 的 `output.render` 输出是**纯 text**（不含结构化 failedJudges/failedLabels 字段）。所以 GUI 只能从 text 消费。
- verify：方案 A 已在结果 text 加 `N judge(s) degraded or failed (names)` / `scoring degraded`。
- **moa 缺口**：`failedLabels` 默认不进 content（只有 `N/M references` 数字减少）。host 侧补：`moa-tool.ts` render 在 `failedLabels` 非空时追加 `moa: N reference(s) failed (labels)`（对齐 verify）。

## Decision

### 1. host 侧（moa-tool.ts render）
`value.failedLabels.length > 0` 时追加 `moa: ${n} reference(s) failed (${labels})`。moa 测试仅断返回对象与 aggregator prompt，不断 render text → 无回归（47/47）。

### 2. 新 client 插件包 `packages/client/ui-rlm`
- `RlmToolRow.tsx`：keyed toolview（verify + moa 共用一个组件）。从 `block.content` 的 text 检测降级标记（`DEGRADED_PATTERNS`：verify `N judge(s) degraded or failed (...)`/`scoring degraded`；moa `N reference(s) failed (...)`/`Reference failed:`）。有降级 → `data-degraded` + warning StateDot + 摘要 `已降级 (N)` + 展开后 warning 卡列出失败名；无降级 → 普通生命周期行。折叠披露完整输出 + 可选 Inspect。纯函数于冻结 call slice（replay 稳定）。
- `client/index.ts`：注册 `tool.call.toolview` key `verify` 与 `moa`（`ctx.slots.inject`），locale 注册 `rlm` 命名空间（zh/en）。
- `locales.ts`：`rlm` NS（Verify/MoA/已降级/运行中/输出/检查）。
- 包骨架：package.json（exports `./invariant`/`./client`/`./src/*`、`dsh.client` manifest、files）、tsconfig（extends base.client + references）、tsdown.config（`clientBundle`）、空 node-half `index.ts`、`invariant.ts`、`css-modules.d.ts`、README。
- 三面注册：`tsconfig.client.json` references、`packages/bundle/web-app/cordis.patch.yml` `ui-rlm` 行、`web-app/package.json` 依赖。
- 依赖声明（verify-client-packages 修正）：ui-primitives/ui-slots 是**静态 client 输入**（只能 devDependencies，不能 peer）；runtime/locale/ui-tool/invariants/cordis 在 peer+dev。

### 3. 构建（本环境 pnpm 挂起的绕行）
- `pnpm install` 在本环境**卡在链接阶段**（postinstall 或 workspace 链接挂起）→ 手动克隆 ui-skill 的 node_modules 链接到 ui-rlm（junction：`@deepseek-ai/*` → workspace 源目录、`react`/`react-dom`/`@types/react` → 根 `.pnpm`）。同级目录相对 target 相同，直接复用。
- `tsc -p tsconfig.json` emit `lib/types`，再 `node node_modules/tsdown/dist/run.mjs` bundle → `lib/index.js`/`lib/invariant.js`/`lib/client.js`（12.19 kB）。

## Consequences

- 收益：新增 `ui-rlm` client 插件包，verify/moa 工具卡片在 GUI 亮出降级警示块；host 侧 moa `failedLabels` 对齐 verify。
- 代价：警示依赖 host renderer 在结果文本保留降级标记（结构化投影为后续）；GUI 实际生效需 web-app 重建 + 刷新；本环境 pnpm 挂起下未跑全量 `test:gui`。

## Verification

- `tests/browser-plugin.client.spec.ts`：注册 verify/moa 两个 keyed toolview + locale 字典 + fiber teardown 移除（HMR safety）。
- `tests/rlm-tool-row.client.spec.tsx`：verify/moa 降级警示（`data-degraded`、warning 卡列失败名）、健康调用无降级标记、running/error 生命周期、Inspect 透传。
- ui-rlm 9/9；ui-tool+ui-skill+ui-rlm 262/262；`verify-client-packages` 通过（41 包）。

## Alternatives considered

- **GUI 实际生效**需 web-app 重新构建（cordis.patch.yml 加了行）+ 页面刷新；本会话未起 dev:web watcher，需用户刷新或后续 build。
- 警示是 **text-derived**（依赖 host renderers 保留降级标记在结果文本）；结构化结果投影（toolview 直接读 failed 字段）是后续演进。
- verify-client-packages 已过；`test:gui` 全量在本环境 pnpm 挂起下未跑（相关包 ui-tool/ui-conversation/ui-skill/ui-rlm 已直接 vitest 验证）。
