# Agent Note：内核快照跳过活跃文件句柄

Status: implemented

[English](2026-08-28-rlm-kernel-snapshot-file-handle-skip.md) | 中文

## 问题

dill 序列化打开的文件对象时，保存的是"重新打开指令"（`dill._dill._create_filehandle(path, mode)`），而不是死数据。因此内核命名空间里活跃的写模式句柄能被快照成功保存，而之后每一次对 payload 的 `dill.loads`——内核重建后的会话恢复，或会话外对产物的分析——都会按存储的模式重新打开目标文件；写模式会截断。快照设计原本依赖 `dill.dump` 对打开文件抛错（头部注释把它们列入"不可序列化"），但 dill 对句柄从不抛错，所以防线从未生效。实际观测：分析先前会话的 `kernel-state.dill` 时，反序列化一个指向 `packages/rlm/plugin-rlm-loop/README.zh.md` 的 `BufferedWriter` blob，在加载瞬间把工作区文件截断为零字节（外围机制见[快照历史 note](../feature/2026-08-26-rlm-kernel-snapshot-history.md)）。

## 决策

`buildSnapshotCode` 在 dump 每个顶层名字前检查 `isinstance(value, io.IOBase)`，命中则记入 `skipped`，原因为 `live io.IOBase handle: dill reopens the file on load (write modes truncate)`。内存态的 `BytesIO`/`StringIO` 一并跳过：丢失的内存缓冲是可上报、可重建的，而被截断的文件是静默数据丢失。失败经既有 skip 通道暴露——manifest 的 `skipped`、`session/kernel-snapshot` 事件的 `skipped[]`——且绝不中断快照本身。

## 被否决的备选方案

**恢复侧预扫描（pickletools）中和句柄 blob。** 否决：为修复后的快照不再产生的一类 payload 付出永久性的每次恢复扫描成本；且检测无法阻止截断——重新打开发生在反序列化过程中，任何加载后的检查都来不及。

**按值保存句柄（序列化字节，恢复为 `BytesIO`）。** 否决：改变恢复后的类型，并把后续写入静默改道到别处，这是换了一副面孔的另一种数据丢失。

## 后果

持有打开句柄的名字不再进入 payload；它们与其他被跳过的变量一样在相同位置上报，模型可见的 `[lost: …]` 恢复提示不受影响，因为这类名字从来不是可恢复成员。早期构建写出的 payload 仍携带句柄 blob，恢复时仍会重放截断；没有迁移机制，因此对此变更之前生成的产物，在会话之外加载时应视为有危害。成本：每个顶层命名空间名字一次 `isinstance` 检查。

## 测试

- `snapshot-file-handle-skip.spec.ts`：对播种了 `wb` 句柄（磁盘上已有字节）的场景运行生成的快照代码，然后重放消费模式（`dill.load` + 对每个 blob `dill.loads`），断言句柄落入 `skipped` 且目标文件保住字节。对修复前构建的阴性对照：同一场景文件归零、句柄入库。
