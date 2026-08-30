# Agent Note: Preset store read-error classification (NEXT Phase 7 T7.4)

Status: implemented

[English](2026-08-30-rlm-preset-store-read-error-classification.md) | 中文

## Problem

2026-08-30 复核的 P1#2：`loadPresetStoreSync` 把文件读取与 JSON 解析包进同一个 `catch`，一律将路径隔离为 `<name>.corrupt-<ts>` 并返回空 store。内容损坏值得该策略，但读取*错误*（EPERM/EACCES/EISDIR——杀毒扫描、瞬时锁、权限问题）下文件是健康的；隔离它可能把好 store 改名搬走，而下一次 `/moa use` 保存随即在原路径写回空 store——静默丢失全部托管 preset。保存路径放大了脆弱性：tmp 文件名只有 pid 作用域，任何未来的并发保存形态都会共用同一个 tmp 文件。

## Decision

`loadPresetStoreSync`（`plugin-rlm-moa/src/preset-store.ts`）将读取失败与内容失败分类：

- `ENOENT` → 空 store（取代 `existsSync` 预检，消除 exists-then-read 竞态）；
- 其他读取错误（EPERM/EACCES/EISDIR/…）→ **响亮失败**，不动任何东西——路径与其字节原地保留；
- JSON 解析或形状失败 → 隔离为 `<name>.corrupt-<ts>` + 空 store（对真实损坏的策略不变）。

`savePresetStoreSync` 每次保存写唯一的 tmp 路径（pid + 进程内单调序号），失败时先 unlink tmp 再重抛——失败的保存既不会晋升半写字节，也不会在目录里留垃圾。

测试（`tests/preset-store.spec.ts`）：store 路径上是目录（全平台 EISDIR）时现在抛错且其下内容完好、无隔离发生；重复保存 last-write-wins 且无 `.tmp-` 残留；既有的损坏隔离与分层测试不变且全绿。

关联：[moa 托管 presets](../bug-fix/2026-08-24-rlm-moa-managed-presets-and-redaction.zh.md)（拥有 store 及其损坏策略——对内容损坏保持不变）。

## Alternatives considered

**对包括损坏在内的所有读取错误一律响亮失败。** 否决：真正损坏的文件会让 `/moa` 一直卡死直到人工删除；harness 状态文件的隔离策略对真实损坏是更好的形状，复核只质疑它对读取错误的套用。

**EPERM 时带退避重试读取。** 否决：同步 store 读取不能为定时器阻塞命令路径，重试逻辑只会掩盖一个本应以报错点名的部署特定权限问题。

## Consequences

瞬时不可读的 store 现在产生点名路径的响亮错误，而不是在下次保存时静默摧毁托管 preset；损坏处理不变。代价：`loadPresetStoreSync` 现在可能抛出（此前总是返回），调用方（`/moa` 与 `moa` 工具背后的 preset 视图访问器）会把错误呈现给模型或用户——这正是预期的 fail-loud 行为。保存 tmp 文件获得逐保存序号后缀；崩溃遗留的旧 tmp 文件被覆写而非盲目复用。
