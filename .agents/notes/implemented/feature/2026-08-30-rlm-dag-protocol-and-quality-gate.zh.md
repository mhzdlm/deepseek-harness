# Agent Note: RLM DAG orchestration protocol + quality gate (LAYERS.md §4, NEXT T7.12 / T3.3)

Status: implemented

[English](2026-08-30-rlm-dag-protocol-and-quality-gate.md) | 中文

## Problem

LAYERS.md §4 的外层件缺失：论文 LongCoT 编排协议（+69.5%，arXiv:2512.24601v3 Appendix C.3——规划子调用出 DAG → 按层批量派发 → 每答案传播前做最便宜确定性验证 → 环以种子+缓存重试 → dict 装配）在 harness 里没有落地形态；"何时不递归"纪律（Observation 2：CodeQA 上 depth=0 反胜全部递归变体）只存在于调研笔记。自动 depth/用途路由已被否决（"自动判定等评估层数据"——LAYERS.md §4.2），起步形态 = 技能 + persona 指引。T3.3 的 autonomous quality gate（verify 分数阈值、prime "gate 通过 ≠ 任务成功"措辞）属本层，作并行收尾。

## Decision

**`rlm_dag` 内核技能**（`plugin-rlm-kernel/skills/rlm_dag/`，纯 stdlib python，部署同 loop-audit：复制到 `<dataDir>/skills/rlm_dag/` + 全局 harness python entry）：

- `validate_tasks`——两遍校验（先收 ids 再查依赖），任务可依赖列表中任意位置的另一任务；自依赖被过滤。
- `layers`——拓扑分层，*visiting* 集合令环形 DAG 抛 `ValueError` 而非递归栈溢出。
- `substitute`——从已算答案替换 `{{id}}` 占位；缺失依赖保持显式未决而非传播坏答案。
- `run`——每层一次批量 `llm_query(prompts=[...])`；每个答案经最便宜确定性检查（非空 + 可选调用方 `validator`）与桥的 `degenerate` 标记验证；被拒任务逐一生成为新种子重试（answers dict 即缓存，重试时故意不查缓存——重试是真重试）；结果是不带花活的 `{id: answer}` dict。
- 层批量与重试携带 `use: "dag-layer" / "dag-retry"` 与 `depth` 标签，随桥载荷进入 `session/subcall-query` 事件——§5 评估数据，暂不做自动路由。

**`llm.query` use/depth 透传**：桥 handler 把调用方 `use`/`depth` 字段转发进 subcall-query 事件（可选；常规调用省略）。

**Persona 指引**（`docs/recipes/agent-presets/rlm/agent.cordis.yml`）："何时不递归"纪律（扇出只留给信息密集、需语义变换的工作；绝不逐行/逐琐碎步骤）+ DAG 纪律（每层批量、传播前最便宜确定性检查、纯 dict 装配——"Root compute = dict lookup, string formatting, correctness checks"）。

**T3.3 quality gate**（`plugin-rlm-verifier` 的 `verify` 工具）：可选 `gate_score`（0-1）按最优候选分数报告 `gate: 'passed' | 'failed'`，并带模型可见措辞 "a passing gate does not mean the task succeeded; verify against the actual outcome"（prime 口径）。缺省 `gate: 'unset'`——行为不变。

## Testing

`tests/dag-skill.spec.ts`（6 项，真 venv 解释器执行，无 venv 自跳）：畸形形状拒绝、线性链与菱形分层、环形 ValueError、占位替换、两层 DAG 每层一次批量调用与答案传播、被拒答案新种子重试、全拒（桥 degenerate）DAG 装配空 dict。`verify.spec.ts` 增加 gate 三态用例（阈值 0 → passed、1 → failed、缺省 → unset + 免责文本）。kernel 153/153；verifier 45/45；typecheck RLM 零错误。

## Alternatives considered

**现在就做自动 depth/用途路由。** 否决（LAYERS.md §4.2 保持）："何时不递归"需要评估数据；本批只交付数据钩子（事件里的 use/depth）与 persona 指引。

**为 DAG 协议建新插件。** 否决（LAYERS.md §4.1 保持）：协议是内核技能 + preset persona，不是插件——技能走既有 python-skill 安装管线与 host 桥。

**严格传播（任答案被拒即整层失败）。** 否决：带可见占位符的部分 dict 比一次失败调用便宜；调用方按实际装配结果决定重试/回滚。

## Consequences

外层协议在 harness 中可表达：模型可分解出 DAG、按层批量扇出廉价子调用（消费 `llm.query` 桥）、确定性验证、被拒轮重试、纯 dict 装配——每个批量都在 `session/subcall-query`（含 `use`/`depth` 标签）审计。递归守卫以 persona 指引起步，不是自动策略。代价：每层一次批量桥轮 + 每个被拒任务一次生成（受 `max_retries` 约束）；`gate_score` 仅在设置时多一个小结果字段与一行免责文本；对真实任务验证技能的 dogfood 记录延迟到 T7.11 评估工具就绪后（LAYERS.md §6 建造顺序），如 NEXT.md 所记。