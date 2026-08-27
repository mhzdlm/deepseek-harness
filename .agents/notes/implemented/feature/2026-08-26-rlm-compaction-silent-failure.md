# Agent Note: T4.4 — Compaction threshold and long-session measurement and root cause

Status: implemented

- **Date**: 2026-08-26
- **Area**: `packages/compaction/*`, rlm 长会话经济性
- **Status**: 测量完成；根因明确；persona 引导已落地；静默失败修复移交 T4.5/T4.9

## Problem

会话 `session-991e6b30`（19.6h、167 cell、10 turns、route `opencode-go/ox-alpha-free`），用 `session-stats.mjs` 读取：

```
usage: events=398 input=2258164 output=294478 cacheRead=69288960
ipython cells: 167 (retried: 0)
error finishes: 0
```

## 推翻的假设

初判"零压缩是因为没到阈值"——**错误**。input 225 万 tokens 远超任何合理窗口的 0.8 阈值（即便 `contextWindow: 131072`，阈值也仅 ~105k）。long conversation 的实际 token 表面（含 225 万 input）必然 ≥ 阈值，因此零压缩不可能是"压力未达"。

## 根因：compaction 静默失败

`packages/compaction/compaction-basic/src/index.ts` 的压力路径（`compactIfNeeded`）：

- `routedTarget(session)` 取 `session.requestHeader()?.config` 的 provider/model；若空则 `return null`（无日志）。
- 若 `llm.resolveModelInfo(target).context` 为空（**模型 adapter 未报告 contextWindow**），抛 `TargetPressureConfigError`；该异常在 `agent/pre-step` 监听器（L155-162）被 `logger.warn` 吞掉一次（`warnedPressureConfigTargets` 去重），随后 `continue the turn`。

991e 的 route 是 `ox-alpha-free`——T4.8/T4.10 已确认该模型**已下架，且 adapter 无 contextWindow 配置**。所以每次 turn 边界的压力检查都抛 `TargetPressureConfigError` → 被 warn 吞 → **compaction 永远不触发**，且用户与模型都看不到任何诊断。

这是"错误被静默"的典型：compaction 失败 ≠ 压缩阈值问题，而是**配置缺失导致的能力不可用被降级为一次 logger.warn**。

## 为什么 cacheRead 69M 是干扰项

`cacheRead` 是 KV-cache 命中计数，不计入 `tokenMeter.measure` 的 `totalTokens` 预算，也不进 surface 压缩范围。它解释"为什么 19.6h 会话还能跑"（命中缓存省 token 费），但不解释"为什么没压缩"。真正越过阈值的是 225 万 input，与 cacheRead 无关。

## Decision

1. **根因修复移交 T4.5/T4.9**：compaction 的 `TargetPressureConfigError` 不应只是 `logger.warn`，应上浮为用户可见诊断（区分"模型容量未配置"/"鉴权失败"/"模型不可用"），与 loop finish.kind=error 走同一诊断通道。
2. **模型配置纪律**：所有用于长会话的路由模型必须在 adapter 配 `contextWindow`。T4.10 已给 `deepseek-v4-flash`/`mimo-v2.5-free` 配 `131072`；`ox-alpha-free` 无 contextWindow 且已下架，不再作为长会话路由。
3. **persona 引导已落地**（见 `docs/recipes/agent-presets/rlm/agent.cordis.yml`）：告知模型——压缩器在 **turn 边界**触发、按对话的 **context-window 预算**；单 turn 内塞大批 cell 不会 mid-turn 压缩；模型 adapter 无 context-window 容量时压缩器无法运行。

## Alternatives considered

- **不调低 `thresholdRatio` 默认值**：根因不是阈值高，调阈值治标不治本，且会增大所有会话的压缩频率/摘要开销。
- **不做离线"压缩预算观测 CLI"**：离线工具无法调用运行时 `tokenMeter.measure` 与 `resolveModelInfo`，只能从 usage 事件近似 totalTokens，会制造"已到/未到阈值"的误导读数，与 T4.11/T4.12 的诚实局限原则冲突。该观测应作为在线能力（接入 tokenMeter）列入 T4.5 后续，而非仓促离线近似。

## Consequences

- 收益：定位了 compaction 静默失败的根因（模型 adapter 缺 contextWindow → `TargetPressureConfigError` 被 warn 吞掉），persona 引导已落地。
- 代价：compaction 根因修复（错误上浮为用户可见诊断）移交 T4.5/T4.9，本轮未做；未调低 `thresholdRatio`。

## Verification

- `session-stats.mjs session-991e6b30` 输出 usage 量级，确认 input 225 万越阈值 → 推翻"未达阈值"假设。
- `rlm-preset.spec.ts` 新增 `rlm persona guides long-session compaction budget` 断言钉住 persona 引导文本（`large token surface` / `mid-turn`）。
