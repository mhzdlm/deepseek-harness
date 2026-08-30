# Agent Note: Kernel correctness batch — snapshot race, retained cap, ReDoS guard (NEXT Phase 7 T7.6)

Status: implemented

[English](2026-08-30-rlm-kernel-correctness-batch.md) | 中文

## Problem

2026-08-30 复核的三个缺陷，全在 `plugin-rlm-kernel`。

**中断恢复快照竞态（P1#4）。** `KernelManager.dispose()` 是 async 且以最终 dill 冲刷收尾（`flushSnapshotForDispose`，vendored `vendor/kernel/index.ts`）。`SessionKernelRegistry.disposeSession` 以 `void manager.dispose()` 点火并立即返回。中断恢复路径随即对同一会话调用 `forSession`——从同一个 `kernel-state.dill` 供应新内核，而旧内核的冲刷可能仍在写它。两个写者争同一份 dill 会损坏快照。"the snapshot flush happened inside disposeSession" 的注释在实践中不成立：disposeSession 在冲刷完成前就返回了。

**retained 子代理记录在会话内无界（P1#5）。** `rlm.run` 的扇出上限只计 `!record.retained` 记录，失控模型可无界创建 retained（continuable）子代理——每个都是一份耐久子会话加一个 `sessionRuns` 里被跟踪的 `AbortController`——无每会话边界。记录只在 `await startContinuable` 解析后才落 `sessionRuns`，并行的 `rlm.run` 调用也可能在 cap 检查时一个都还没计数。

**模型可控正则 ReDoS（P2）。** `session.query` 的 grep 用至多 200 个模型提供的字符 `new RegExp(source, 'i')`，并在 40 万字符预算内扫描渲染消息。预算约束的是总输入量，不是单次 `pattern.test()` 在一条消息上的耗时：`(a+)+` 之类在单条 1 万字符消息上可指数回溯，卡死单线程宿主。

## Decision

**dispose 等待冲刷。** `disposeSession` 改为 `async` 并 `await manager.dispose()`（以及 in-flight 供应的处置）。中断恢复路径在 `forSession` 前 `await disposeSession`。`disposeIdle` 与 `enforceLiveCap` 收集目标后 `await Promise.all(...)`——一次扫场不因单次冲刷串行化，但也绝不在其落定前返回；`disposeAll` 变 async，两处调用点改 `void`。dispose→重新供应的顺序契约由此从碰巧变成显式。

**上限计每个存活子代理加 in-flight 的 spawn。** `rlm.run` 治理改为检查 `sessionRuns.size + inflightSpawns`——retained 一并计入（反转 2026-08-26 hardening-sweep 否决计入的决策）。新增每会话 `inflightSpawns` 计数：在 spawn 的 await 前加一，记录落盘（或失败）时减一——并行的 `rlm.run` 调用互相看得见对方的待定 spawn，在"尚无记录"的窗口内也无法突破上限。`abortSession` 清空计数。

**正则复杂度守卫，而非更多输入上限。** `assertReDosSafePattern(source)` 用带处置文案拒绝两个危险族，然后 grep 才构造 pattern：
1. 无界量词（`+`、`*`、`{n,}`）套在自身含量词或交替的组上——`(a+)+`、`(a|b)*`、`(a?)+`、`(a{1,2})*`；
2. 同一量化原子重复 3 次以上——`a*a*a*`、`\d+\d+\d+`（歧义切分使扫描成多项式）。

扫描前把转义序列中和为占位符（`\\.` → `x`），使 `\d+\d+\d+` 被抓住而 `\d+\s*\d+` 仍放行。有界形态保持合法：`(1|2)?`、`(ab)+`、`\d+\s*\d+`。既有扫描预算保留为总量界。

测试：retained 现能触顶 cap（旧的"retained 豁免"断言按"测试描述行为"重写）；挂起的 `startContinuable` 证明 in-flight 窗口被计入；两组 ReDoS 测试钉住拒绝（`(a+)+`、`(a|b)*`、`(a{1,2})*`、`a*a*a*`、`\d+\d+\d+`）与放行（`(1|2)?\d`、`(ab)+`、`\d+\s*\d+`）。

关联：[hardening sweep](../bug-fix/2026-08-26-rlm-hardening-sweep.zh.md)（拥有本批收紧的扇出与 grep 边界；其 retained 豁免决策在此反转）。

## Alternatives considered

**worker 线程做正则超时。** 与 hardening sweep 相同的理由否决：为一次调用把 transcript 渲染搬到线程外会复制会话状态的访问方式。构造期复杂度守卫是诚实的同步界——单条消息上的单次 `test()` 从构造上变得有界，扫描预算仍约束总量。

**删除转义而非替换占位符。** 先试且错了：从 `\d+\d+\d+` 剥掉 `\d` 剩 `+++`，破坏守卫需要识别的结构。占位符（`x`）保留量词位置。

**retained 与 one-shot 各设独立上限。** 否决：两个计数器让模型两边都顶满；单一存活子代理上限是更简单的恒等式，错误文案点名 `rlm.delete_subagent` 回收已完成的子代理。

## Consequences

dispose→重新供应的顺序得到保证：刚被处置的会话上的后续 `forSession` 不可能与旧内核的 dill 冲刷竞态。扇出上限如今真正约束会话的存活子代理（retained 在内），且在并行 spawn 下依然精确；合法需要超过 `maxChildrenPerSession` 个 retained 子代理的工作流必须调高 Config 或经 `rlm.delete_subagent` 删除已完成者。grep 以带处置文案拒绝 ReDoS 形 pattern，同时保留有界形态与扫描预算。代价：`disposeSession`/`disposeAll` 变 async（调用点用 `void`），驱逐等待冲刷；一条值得明说的诚实边界——快照竞态本身没有确定性单测（无 fake-manager 缝；venv-gated 的 `idle-reclaim` spec 端到端演练 dispose→restore 顺序，如今由构造保证而非碰运气）。
