# Agent Note: Keyless contract tests close the two highest-value rlm coverage gaps

Status: implemented

[English](2026-08-26-rlm-coverage-gap-closers.md) | 中文

## Problem

仓库 per-file 100% 覆盖率门禁在依赖闭包打通前排除 `packages/rlm/*/src/**`，rlm 的正确性完全依赖自己的套件。2026-08-26 审查发现其三个最重缺陷各自从一条无人测的接缝逃逸：持久化重载路径、缝到评分的流契约、插件挂载路径。修复落地后仍有两条接缝敞开——没有任何用例以真实 chunk 形状驱动过 `callSeamModel` 的 BlockAssembler 消费；T3.2 cap 驱逐决策矩阵还剩一个测试不可达分支（全部内核 busy）。

## Decision

两个无 key 套件在公共入口钉住敞开的接缝：

- `plugin-rlm-verifier/tests/seam-contract.spec.ts` 经真实 `apply()` 挂载捕获工具，用假 `ctx.llm.stream` 发射真实 `StreamChunk` 形状（`block-start`/`text-delta`/`logprobs`/`block-end`/`finish`，每字符一条 logprob）。钉住：判卷字母贯穿全链落入最终排名；每次评分调用都带 `logprobs: { topLogprobs: 20 }` 并路由到配置的 provider/model；相同字母在悬殊的 verdict logprob 下得分完全一致——v1 单备选退化是被测试固化的有意语义，未来缝服务 top-k 变体时该套件会有意失败。
- `plugin-rlm-kernel/tests/keep-alive.spec.ts` 在公共路径补上最后一个 cap 驱逐分支：存活内核超过 `maxLiveKernels` 且全部 busy 时，`disposeIdle()` 不驱逐、不强制快照（busy 硬豁免连探测都不发生），压力顺延到下一轮有合格 LRU 受害者的周期落地。

seam 套件的假判卷必须槽位感知：`scorePairOnSeam` 在奇数轮对调提示槽位再映射回候选，静态回复会在相邻轮投给相反候选、把每个比较平均成 0.5/0.5 平局。按提示内容判断哪个候选在哪一槽，所有轮次才一致。

## Alternatives considered

**把 callSeamModel 当单元测。** 否决：它是模块私有的，为测试导出会加宽入口面；驱动挂载后的工具走的是同一条消费路径外加路由。

**mock 掉锦标赛只测流。** 否决：本套件的价值恰恰在于 chunk 形状必须活到最终排名；mock 消费方等于把刚关上的缝隙重新挖开。

**把 all-busy 并进白盒 grace-window 用例。** 否决：既有 T3.2 用例在必要处已借助私有状态访问，而这个分支经 `disposeIdle()` 完全可观察——公共路径断言才是它可信的原因。

## Consequences

放行真缺陷的两条逃生口在其确切接缝处关闭，退化语义成了可执行文档。代价：seam 套件编码了当前 chosen-token-only 的缝形状——上游暴露变体时它会失败，这是有意设置的「有意识重访」触发器，但也意味着这些测试与 `StreamChunk` 细节耦合。all-busy 用例依赖该文件既有 harness 已建立的 `markBusy`/`markIdle` 内部访问。

## Testing

- `seam-contract.spec.ts`：4 项全绿；verifier 包全套 34 项无 key 用例全绿。
- `keep-alive.spec.ts`：9 项全绿；T3.2 驱逐矩阵（LRU 序、无租约优先、租约强制快照成功/失败/grace、pinned 对扫场、all-busy 顺延）现全部经公共路径演练。
