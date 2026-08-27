# Agent Note: 2026-08-25 — rlm 系列跨包导入经由包入口进行

Status: implemented

[English](2026-08-25-rlm-entry-exports-over-cross-package-src.md) | 中文

## Problem

将 rlm preset 挂载到桌面部署（基于普通 Node、通过 `node_modules`、无 vite/tsx）时，失败并报 `Stripping types is currently unsupported for files under node_modules`。该系列编译干净，但两行兄弟包通过 `@deepseek-ai/dsh-plugin-*/src/*.ts` 说明符互相导入——这种写法仅在 vitest 工具链下合法，因为那里由 tsx 剥离类型并解析 tsconfig paths。普通 Node 将这些说明符解析为 `node_modules` 下真实的 `.ts` 文件并拒绝加载。

## Decision

- 兄弟包通过所属包的**入口导出**消费共享代码，绝不使用跨包 `src/*.ts` 说明符：
  - `plugin-rlm-kernel` 从其入口重新导出 `redactReferenceText`；`plugin-rlm-moa` 从 `'@deepseek-ai/dsh-plugin-rlm-kernel'` 导入它。
  - `plugin-continual-harness` 重新导出 `HarnessConflictError`、`readHarnessStatesDetailed`、`writeHarnessStates`（以及 harness 文件类型）；`plugin-rlm-loop` 从入口导入它们。
- 仅用于测试的跨包 src 导入保持原样：按定义它们仅限 vitest，且从不会被部署加载。

## Why

插件的已发布面就是普通 Node 能够从 `node_modules` 加载的内容。相对 `.ts` 说明符在 emit 时被重写；而裸跨包说明符不会被重写，因此 vitest 之外的每个消费者都继承了一条损坏的边。入口重新导出让每个包只保留一份已编译副本，不增加额外的运行时耦合（这些依赖边早已作为 peer/普通依赖存在），并使 `pnpm pack` 产物自包含——而 profile-bundle 安装路径正是直接演练这一点。

## Alternatives considered

- 保留跨包 src 导入，并教部署在 `node_modules` 下剥离类型：这意味着为部署附带一个类型剥离加载钩子，且只为了恰好四个说明符。
- 将 redaction/CAS 代码内联复制到每个消费者中以删除这些边：会复制一份行为，而该行为目前由测试钉死一次。

## Consequences

- 收益：兄弟包现在只通过所属包的 entry export 消费共享代码；plain-Node 桌面部署挂载 rlm preset 不再出现 `Stripping types under node_modules` 失败；`pnpm pack` 产物自包含。
- 代价：移除 4 处跨包 `src/*.ts` 说明符；仅测试用的跨包 src 导入保留（vitest-only）；未将 redaction/CAS 代码内联复制到各消费者。

## Verification

- kernel 69 / moa 33 / loop 18 / continual-harness refine-test 在重新导出改动后全部通过。
- 桌面部署冒烟测试：在将新构建的包同步进部署树并挂载本地编写的 `rlm` preset 之后，先前的失败（`does not provide an export named 'HarnessConflictError'`）必须消失。注意长期运行的 host 会缓存原生加载的模块，因此任何磁盘更新之后验证都需要一个全新的进程。
