# Agent Note: T4.6 — Plugin combination usage guidance

Status: implemented

- **Date**: 2026-08-26
- **Area**: `docs/recipes/agent-presets/rlm/agent.cordis.yml` persona
- **Status**: 已落地

## Problem

`docs/MOA.md` 已有完整的 `moa` × `verify` 组合配方（配方 A：综合→选优；配方 B：选优→综合），但这是**人类可读文档**，rlm 会话里的模型看不到。NEXT.md T4.6 记录：实测中 `verify`/`moa` 被当普通工具零星调用，而非编排闭环——缺**模型可见引导**。

## Decision

rlm preset persona 新增一段插件组合引导（在 compaction 段之后）：

- `verify` 排名候选、`moa` 综合多模型视角；**仅在高价值决策点组合**，绝不作为每 cell 的常规调用。
- 开放答案空间：先 `verify.auto_spawn` 收集候选 → `moa` 融合 top 视角 → `verify` 再排名融合结果。
- 异构草稿融合为单一交付：先 `verify` 排名 → top-K 传给 `moa`。
- 指向 `MOA.md` 获取完整配方。

测试钉住（`packages/rlm/plugin-rlm-verifier/tests/rlm-preset.spec.ts`）：`rlm persona guides plugin-combination usage` 断言 persona 含 `rank candidate solutions` 与 `high-value decision points`（短语取单行连续，规避 YAML `>-` 折叠分行）。`rlm-preset.spec` 5/5 通过。

## Alternatives considered

- 不把配方全文搬进 persona——persona 是引导，详细配方留在 MOA.md（单一事实源，避免双份维护）。
- 不改 `verify`/`moa` 工具实现或 schema——纯提示层引导，组合靠提示词而非硬接线（与 MOA.md 设计一致）。

## Consequences

- 收益：rlm persona 新增 verify×moa 组合引导，模型可见，避免被当普通工具零星调用。
- 代价：纯提示层引导，无代码/事件变更；详细配方仍留在 MOA.md（单一事实源），避免双份维护。

## Verification

- `rlm-preset.spec.ts` 5/5（含 T4.3 namespace 卫生、T4.4 compaction 预算、T4.6 组合引导三组 persona 断言）。
