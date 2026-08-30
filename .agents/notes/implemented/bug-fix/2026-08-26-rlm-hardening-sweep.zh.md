# Agent Note: The rlm family bounds model-driven resource use

Status: implemented

[English](2026-08-26-rlm-hardening-sweep.md) | 中文

## Problem

2026-08-26 审查发现一组「模型驱动循环可无界消耗宿主资源或静默丢数据」的位置：`rlm.run` 接受无限长 prompt、按会话可生成无限并发子代理；`session.query` 的 grep 把模型提供的正则编译后跑在无界 transcript 上且没有任何求值边界；空闲扫场丢弃自身 promise，一次抛错的快照变成每个周期复发的 unhandled rejection；中断恢复只警告重复执行、对命名空间回滚保持沉默；技能采集器把可手改的 harness id 直接拼进交给 `uv pip install` 的文件路径。

## Decision

五个已发布的边界，各自响亮失败或可见降级而非静默：

- **扇出治理**（`rlm.run`）：新增 Config 键 `maxChildrenPerSession`（默认 8，按父会话计存活子代理；T7.6 起 retained 一并计入——复核发现原"仅计 one-shot"令 retained 无界增长，见[内核正确性 note](../bug-fix/2026-08-30-rlm-kernel-correctness-batch.zh.md)）与 `maxRunPromptChars`（默认 24000）。超限在 spawn 时抛出带处置建议的错误。
- **有界 grep**：模式超过 200 字符直接拒绝；按时间顺序的正则扫描在 40 万字符渲染文本预算处停止并把结果标记 `truncated`。V8 无法超时回溯型正则，真正成立的边界就是输入量。
- **追问只寻址 retained 子代理**：`rlm.message` 的服务列表回退现在只接受 continuable 行——给 one-shot 运行发消息本就会在下游失败。
- **恢复警告写明回滚**：中断重试前缀现在说明命名空间已从最近快照恢复、被打断那次的改动可能缺失（与既有的双执行风险及 `[lost: …]` 恢复通知并列）。
- **技能 id 路径安全**：`collectPythonSkills` 把不符合 slug 规则（`^[a-z][a-z0-9-]*$`，与 `create_python_skill` 共用）的条目 id 拒入 `invalid` 列表而非拼进路径；手改状态文件里的穿越形 id 再也到不了 `uv pip install`。
- **扫场收口**：扫场定时器捕获自身 rejection 并告警，一个坏周期不会再演变为每周期复发的 unhandled rejection。

## Alternatives considered

**grep 用 worker 线程做正则超时。** 否决：为一次调用把 transcript 渲染搬到线程外会复制会话状态的访问方式；字符预算确定性地约束总工作量，并保持 handler 同步。

**让 retained 子代理也计入扇出上限。** 当时否决：retained 子代理在被追问前只是闲置内存，计入只会饿死长生命周期的追问工作流，并没有约束任何 LLM 消耗。**T7.6 反转**（2026-08-30 复核 P1#5）：豁免令失控模型可在会话内无界累积 retained 子代理——每个都是一份耐久会话加一个被跟踪的 controller；retained 现计入 `maxChildrenPerSession`，in-flight 的 spawn 同样计入（见[内核正确性 note](../bug-fix/2026-08-30-rlm-kernel-correctness-batch.zh.md)）。

**恢复路径前移快照校验。** 暂缓：vendored manager 目前不向外暴露 dispose 时快照的结果；警告加恢复通知这对组合已经告诉模型什么活了下来。等 vendor 暴露快照结果再 revisit。

## Consequences

失控的模型不能再把子代理扇出、prompt 尺寸或 grep 求值推过已公布的边界，且每个上限失败都会点名自己的 Config 键。代价：接近上限的 prompt 需要调用方自行摘要（错误文案已说明）；预算内的病态正则仍可能在截断前烧掉一份扫描预算的 CPU——有界，但不是免费。治理项是部署可调的 Config，重负载合法工作流可以有意调高。

## Testing

- `host-handlers.spec.ts`：治理边界/超限用例（T7.6 起 retained 一并计入）、服务列表中 one-shot 子代理的追问拒绝、find_models 经 `ctx.get`。
- `session-query.spec.ts`：超长模式拒绝；扫描预算耗尽在 transcript 中途标记 `truncated`。
- `ipython-tool.spec.ts`：扩展后的恢复警告文案逐字钉住。
- `skill-source.spec.ts`：穿越形与非 slug id 落入 `invalid`，绝不进包路径。
