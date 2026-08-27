# Agent Note: RLM 内核命名空间卫生的 persona 指引

Status: implemented

[English](2026-08-26-rlm-namespace-hygiene-persona.md) | 中文

## Problem

一个常驻的 IPython kernel 会在整个会话期间一直保留 `variables` 与 `imports`，因此一个运行了多批分析任务的 RLM agent 会在共享命名空间中不断累积临时变量名。每一个被保存的名字都会出现在快照清单（snapshot manifest）里，并被序列化进会话日志必须携带的 dill 中；于是这些临时名字同时膨胀了清单和持久化日志，也让后续检视"这个会话到底产出了什么"变得更为嘈杂。Harness 不提供自动清理，因为删除一个后续 cell 仍需要的名字是真实存在的错误风险。

## Decision

向 `rlm` 预设 persona（即 `docs/recipes/agent-presets/rlm/agent.cordis.yml` 中 `persona` 行的内联 `text:`）追加一段简短的指引：在一批分析任务结束后，`del` 掉其临时变量，或者把工作放进函数内部以便局部变量不外泄；同时指出快照清单会列出每一个被保存的名字，因此累积的临时名字会弄乱清单并增大 dill；并警告不要 `del` 掉后续 cell 可能仍然需要的名字。这仅是建议性的——kernel 依旧绝不自动删除（这正是该决策有意规避的错误风险）。`packages/rlm/plugin-rlm-verifier/tests/rlm-preset.spec.ts` 将这段指引文本固定在已挂载的预设中。

## Alternatives considered

- **超过阈值后自动删除临时变量**（即任务中可选的"超阈值告警"）。被否决：harness 无法知晓后续 cell 仍依赖哪些名字，因此任何自动删除都面临打断在途工作的风险；任务本身也正是出于这个原因将自动删除列为超出范围。
- **当 `savedNames` 超过 N 时由清单驱动的告警。** 留作任务所指的可选后续项：它需要一个阈值 Config 键和一条诊断路径，而这两者对于落实卫生指引都不是必需的，且二者都属于更宽泛的 T4.4/T4.5 错误呈现工作。

## Consequences

- 收益：模型现在拥有了明确的、内嵌于 prompt 的指引来保持共享 kernel 命名空间的整洁，从而减少由临时名字带来的清单与 dill 膨胀。
- 成本：运行时为零——纯 persona 文本；没有代码路径，没有新事件，没有 config 键。快照清单与 dill 的语义保持不变。
