# Agent Note: Harness CAS writes map Windows rename collisions to conflicts

Status: implemented

[English](2026-08-26-harness-cas-write-rename-conflict-mapping.md) | 中文

## Problem

`writeHarnessState` 以 `rename(tmp, dest)` 收尾写入。Windows 上并发写者持有目标文件时，rename 会以 EPERM/EBUSY 失败而非干净替换。`/refine` 与回滚的冲突重试只认 `HarnessConflictError`，rename 撞车于是以裸 fs 错误冒出：实测中 refine-test 的「冲突重试收敛」一节在并发负载下一次崩掉整个进程、两次产生假失败——测试的干扰写手还在盲写（不带期望 mtime），可以在管线成功落地之后落盘并覆盖已落地状态，让持久性断言对一条明明报了成功的管线失败。

## Decision

两处改动，一个契约：

- `writeHarnessState` 把 code 为 `EPERM`/`EBUSY` 的 rename 失败映射为 `HarnessConflictError`（先强制清理临时文件）；其余错误保留原样。撞车在可观测上就是「目标在本写者脚下变了」——与 mtime 检查报告的是同一件事，两者现在都流入既有的单次重试路径。磁盘满与权限失败不与冲突混同。
- refine-test 干扰写手（bump）改为真 CAS 写：带 mtime 读、按该期望 mtime 写、冲突即跳过。干扰仍使在途尝试观察到的 mtime 过期（重试路径照常被演练），但不再可能覆盖在其读取之后落地的状态。

## Alternatives considered

**在 writeHarnessState 内部对裸 rename 失败通用重试。** 否决：重试策略归调用方所有（一次，带重读与重放）；writer 内静默循环会掩盖持续争用并无上限放大写入。

**给干扰写手调更长的 sleep／更少的 tick。** 否决：调延时是用覆盖率换假阳性率；竞态是结构性的（一个没有比较交换义务的写手），不是时间常数问题。

**所有 harness 写入过单一队列串行化。** 现阶段否决：单写者假设加 CAS 是与内核侧 Python 写手共享的成文契约；宿主侧队列反正覆盖不到内核写手。

## Consequences

Windows 上的并发 harness 写退化为类型化冲突而不是崩溃，FIX-7 收敛套件在负载下确定。残余：stat→rename 窗口仍不是原子比较交换——两个写者的检查若在同一窗口双双通过则都会 rename；成文的单写者假设仍是权威防线，与此前一致。

## Testing

- `refine-test.mts`：85 项在单独运行与携带 kernel 包套件的并发负载下全绿（此前可复现假失败）。
