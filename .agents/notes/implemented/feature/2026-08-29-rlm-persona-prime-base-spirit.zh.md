# Agent Note: RLM persona 对齐 Prime Agent base prompt 的精神

Status: implemented

[English](2026-08-29-rlm-persona-prime-base-spirit.md) | 中文

## Problem

`rlm` preset 的 `persona` 文本（`docs/recipes/agent-presets/rlm/agent.cordis.yml`）
约 350 词，只有 Prime Agent base system prompt（约 1.5K 词，
`coding-agent/src/core/prompts/rlm.ts`）的四分之一左右。它覆盖了内核命名空间卫生
指引和我们自己加的 `verify`/`moa` 组合配方，却漏掉了 Prime 写进其不可变 base prompt
的通用 RLM 行为。对"按原版意图运行"而言，有两处缺口最关键：

- **IPython 是控制面，不是被研究系统的原生运行时。** Prime 让模型通过仓库/服务/数据集
  自己的接口去驱动它，并用项目自身的环境（`uv run`、其 `.venv`、仓库根解释器）跑项目
  命令——绝不为让外部项目 import 或运行而往 IPython kernel 装依赖。我们的 persona 全然
  没提这点，只警告了命名空间杂乱。
- **长任务非阻塞。** Prime 要求非阻塞控制循环（启动工作、记录句柄、结束本轮、稍后读取）
  并禁止 `time.sleep`/长阻塞 `await` 轮询。我们的 persona 没有这类指引。

缺了这些，递归/长任务的 RLM 可能轮询、阻塞或污染 kernel——正是 Prime base prompt
要防止的那类失败。

## Decision

把 Prime 的 `IPYTHON_CONTROL_PROMPT` 与 `LONG_RUNNING_WORK_PROMPT` 的精神精简补充进
`rlm` persona：

- 新段落声明 IPython 是控制面、不是被研究对象的原生运行时；通过外部系统自己的接口驱动
  它，并用 `%%bash` 单元借项目自身环境跑项目命令；不要为了外部项目能在 kernel 里 import
  而往 kernel 装依赖；用 Python 读写文件，使结果成为可复用的具名变量。
- 新段落声明慢速或独立工作的非阻塞控制循环、并行优于串行 await、以及禁止
  `time.sleep`/阻塞 `await` 轮询。
- `rlm`/`refine` 调用约定从一句话扩成一小段：`rlm` 只是准入一个子代理并只返回句柄（答案
  永远不会回来；结果经由消息能力或文件到达），`/refine` 是小的、有证据支撑的更新，只改
  最小相关的持久组件，而非重写整个 harness。

既有的命名空间卫生与 `verify`/`moa` 段落保留并重新锚定。persona 增至约 600 词——仍不到
Prime base prompt 的一半，这是可接受的：我们的 kernel bootstrap 已提供预导入包与 `rlm`
全局，而 `verify`/`moa`/`refine` 扩展是 Prime 没有的、base prompt 也不会描述的增补。

挂载测试逐字断言新指引
（`packages/rlm/plugin-rlm-verifier/tests/rlm-preset.spec.ts`）。

## Alternatives considered

- **把 Prime 的 `buildRlmPrompt` 原样 vendored 进我们的 prompt 层。** 否决：它约 1.5K 词
  的 Prime 专属脚手架（预装包清单、子代理准则措辞、refine 哲学），其中大部分已被我们的
  kernel bootstrap 与 `verify`/`moa` 扩展覆盖或取代；整段复制只会重复且漂移。精简对齐而非
  复刻，能保留唯一权威的模型可见指引源。
- **改由 `plugin-rlm-kernel` 的 Python 端注入 IPython 控制文本，而非写在 persona。** 否决：
  我们模型可见的 system prompt 就是 TS 的 `persona` 行，且 vendored kernel 已提供 bootstrap
  （预导入包、`rlm` 全局）。把所有 persona 指引放在一处，避免模型无法调和的分裂来源。
- **保持 persona 单薄。** 否决：缺口不是表面的。Prime 把这些规则写进不可变 base，正是因为
  递归/长任务的 correctness 依赖模型知道"IPython 是控制面、不得阻塞或轮询"。

## Consequences

- 买到的：现在 `rlm` agent 在它自己的 system prompt 里就读到——IPython 是控制面（不是被研究
  的运行时）、用项目自身环境跑项目命令、慢速工作非阻塞驱动。这补齐了与原版在"最影响递归/
  长任务的行为"上的精神缺口。
- 代价：persona 更长了（约 600 词）。仍远不到 Prime base 的一半；无运行时开销（只是 prompt 文本）。
- 已知边界：我们仍未复刻 Prime 的两层 prompt 结构（不可变 base + 经 `/refine` 增长的补充
  harness-state 层注入 prompt）。continual-harness 插件提供了 `rlm.harness` 状态与 `/refine`，
  但 persona 尚未把那层状态描述成 prompt 的一层；那一步结构对齐留待后续。
- 交叉引用：扩展了
  [rlm 命名空间卫生 persona](../feature/2026-08-26-rlm-namespace-hygiene-persona.zh.md)
  引入的 persona；让该 preset 能在 pnpm 开发检出下挂载的发现解析器记录于
  [preset health 解析它能证明会启动的行](../architecture/2026-08-26-preset-health-resolves-rows.zh.md)。
