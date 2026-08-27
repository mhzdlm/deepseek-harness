# Agent Note: RLM 内核快照历史与刷新事件

Status: implemented

[English](2026-08-26-rlm-kernel-snapshot-history.md) | 中文

## Problem

dill 快照是持久化 IPython 内核唯一的命名空间连续性机制，但只有最新的 `kernel-state.dill` 会被保留：每次刷新都会以原子方式覆盖它，因此一旦最新的快照损坏或丢失，所有更早的命名空间都会随之丢失。持久的会话日志只记录 cell 操作和截断后的输出——没有按刷新粒度的对象核算——因此事后审计和跨主机迁移无法判断某个 cell 产生了哪个 dill。Session-991e6b30（19.6h，167 个 cell）具体地暴露了这两处缺口：没有可回滚的历史，也没有日志行说明某次快照承载了什么。

## Decision

- 为 plugin-rlm-kernel 新增 Config `snapshotHistory`（默认 3，`0` 表示禁用）。每次 dill 刷新成功后，`SessionKernelRegistry.rotateSnapshot` 会保留最近 N 份副本为 `kernel-state.<n>.dill`（n = 1 为最新），方法是把较旧的副本向外移位，并丢弃超出上限的最旧副本（T4.1）。
- 将所有刷新统一经由单一方法 `flushSnapshot(sessionId, reason)`，它 (a) 调用 `manager.snapshotState()` 获取真实的 `SnapshotResult`，(b) 发出仅记录日志的 `session/kernel-snapshot` 事件 `{ ok, vars, bytes, skipped[], pruned[], ms, reason }`，(c) 在成功时轮转历史。调用方来自防抖的 cell 后刷新（reason `cell`）以及 reclaim 强制快照闸门（reason `reclaim`），后者此前内联了 `manager.snapshotState()`（T4.2）。
- 供应商提供的自动快照保持启用：它负责原子的 dill 写入，除非对供应商代码 `KernelManager` 打 `[local patch]`，否则无法关闭（供应商策略禁止在同步流程之外修改源码）。因此插件显式调用的 `snapshotState()` 只是纯粹为了捕获结果并轮转而每个防抖窗口重新序列化同一命名空间一次。这是以一次刻意的额外序列化换取不触碰供应商执行代码。
- `resolveSession`（从 `ctx.sessions` 注入）解析出持久化 Session，使事件能够进入日志；事件发出为尽力而为，若无法解析出 Session 则跳过。`session/kernel-snapshot` 由 `pnpm run gen-persistence-catalog` 添加到 `KNOWN_SESSION_EVENT_TYPES`。

## Alternatives considered

- **完全接管刷新并禁用供应商自动快照。** 否决：它需要对供应商 `KernelManager` 打 `[local patch]`，而供应商策略禁止在同步流程之外这样做，且若新路径存在 bug 会导致持久化回退——供应商写入器是经过验证的。
- **通过读取已写入的 dill 来发出事件，而非重新序列化。** 否决：这放弃了事件契约所要求的准确 `vars` / `skipped` / `pruned` / `bytes` / `ms`；相比一个 cell 自身的开销，每个防抖窗口一次显式 `snapshotState()` 代价很低。
- **将历史保存在单个 tar / sqlite 中，而非编号文件。** 否决：普通的编号文件使磁盘上的形态保持可调试，且预算简单（N × maxBytes）。

## Consequences

- 收益：最近 N 个命名空间能在最新快照丢失时存活，且会话日志现在携带了按刷新粒度的对象核算，可用于审计和迁移。
- 代价：每个防抖窗口一次额外的 dill 序列化（已接受）；磁盘预算受 `snapshotHistory × maxBytes` 约束。
- `packages/rlm/plugin-rlm-kernel/tests/persistence-catalog.spec.ts` 守护事件类型 / 目录配对；`tests/snapshot-rotation.spec.ts` 用打桩的 `KernelManager` 固定 T4.1 移位与 T4.2 发出（7 个测试，绿色）。
- 已延期：`docs/persistence-catalog.zh.md` 需要通过翻译工具刷新配对（英文目录和 `KNOWN_SESSION_EVENT_TYPES` 会被重新生成）。`docs/config-catalog.md` 的重新生成目前因三个 moa 配置字段（`referenceModels.mode`、`aggregator.provider`、`aggregator.model`）预先存在的缺失 JSDoc 而受到仓库级阻断，因此尽管其源码 JSDoc 已存在，`snapshotHistory` 尚未进入生成的配置目录；修复这三个字段是独立的文档任务。
