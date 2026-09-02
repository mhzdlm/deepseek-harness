# @deepseek-ai/dsh-plugin-rlm-loop

[English](README.md) | 中文

面向 rlm 家族的 Loop Engineering 记账。注册 `loop` 工具，使 Manage→Execute→Audit 轮次协议在代码层面可强制，而非依赖模型合规：

- **确定性审计解析** —— 审计方有序的三行 verdict（`Status` / `Integrity` / `Contract audit`）由代码解析，否则直接报错；正文内容从不臆测为事实。
- **信任闸门** —— 只有 `complete/clean/aligned` 的 verdict 才算已验证进度；judge 调用以 `crit/loop-three-line-header` 判据在会话 store 流中落 `check-pass`（干净）或 `check-doubt` 判词。
- **store 写入** —— `begin` 与每次 `record` 向会话 scope 追加 `rlm/action-boundary` 事件；已验证进度经判断通道落地，continual-harness 投影从 store 视图拾取。

加入的会话保持 Manager 角色；executor/auditor 片段借用组合提供的委派工具（见 `docs/recipes/agent-presets/loop/`）。`rlm.store` 服务为必需：缺失时 `apply` 直接抛错——先挂载 `@deepseek-ai/dsh-plugin-rlm-store`。

## 配置

| 配置 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `dataDir` | string | — | Phase A 起废弃：工具写统一 store，不再写 harness 文件。为 preset 兼容保留；忽略。 |
| `maxRounds` | number | `32` | 单次运行的软轮次上限；超出仅告警，绝不阻断。 |

## 工具：`loop`

| 动作 | 参数 | 效果 |
|---|---|---|
| `begin` | `task`（必填）、`contract?` | 开启一次运行；向会话 scope 追加一条 `rlm/action-boundary` 事件。 |
| `record` | `round`、`route`（`gui\|cli\|done\|blocked\|ask`）、`audit_report`、`progress_note?` | 解析表头，应用信任闸门，追加本轮 action-boundary 事件并落 `check-pass`/`check-doubt` 判断；被接受且带 `progress_note` 时落地已验证进度。 |
| `status` | — | 汇总本会话已记录与已验证的轮次。 |

结构化输出携带 `runId`/`round`/`accepted`/`status`/`integrity`/`contractAudit`/`landed`；`text` 携带面向模型的引导，含拒绝原因（无法解析的表头、`done` 路由却没有干净审计、干净 verdict 却缺备注）。运行状态存于按会话的内存 Map，`session/disposed` 时清除；持久真相是 store 流。

遗留的 `session/loop-start` / `session/loop-round-done` 事件类型仍在 `src/events.ts` 中声明，仅为让旧会话日志可加载；工具不再发出它们。

## 模型体验

### 循环进度

#### 模型看到什么

模型看到一次契约（经 `loop begin`）以及每轮一条 `loop record` 的结果文本；工具用已解析的可信进度信号取代临时的 verdict 推理，而非发出新的模型引导。

#### Token 影响

每任务一次 `loop begin` 落地一次契约；每轮增加一条 `loop record`，其短小结果文本取代 verdict 正文，因此开销只随已记录轮次增长。

#### KV 缓存影响

落地的信念经 harness 概览注入（store 投影）重新进入上下文，因此后续轮次从提示中读取可信状态，而非从历史重新推导；工具从不修改更早的请求 token。

## 已知限制与待办工作

- 运行注册表（`runId`、已记录轮次）为每进程内存态；持久真相存在于 store 流，因此监管进程重启只会丢失 `status` 这个便利视图。
- `maxRounds` 是建议性的——越过上限只告警，绝不阻断轮次。

## 状态

Phase D（2026-09-01）：loop 协议写统一 store 的路径——action boundary 加确定性表头的 check 判断；harness 投影渲染落下来的内容。家族总览见 [packages/rlm/README.md](../README.md)；家族级状态见文档仓 BUILD.md。
