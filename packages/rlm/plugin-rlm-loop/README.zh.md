# @deepseek-ai/dsh-plugin-rlm-loop

[English](README.md) | 中文

面向 rlm 家族的 Loop Engineering 记账。它注册一个 `loop` 工具，使 Manage→Execute→Audit 轮次协议在代码层面可强制，而非依赖模型合规：

- **确定性审计解析** — `parseAuditHeader` 读取审计方有序的三行 verdict（`Status` / `Integrity` / `Contract audit`），否则直接报错；正文内容从不臆测为事实。
- **信任闸门** — 只有 `complete/clean/aligned` 的 verdict 才算已验证进度；其余结果都作为下一轮规划失败的证据记录。
- **持久化流程记录** — `session/loop-start` 与 `session/loop-round-done` 仅日志事件，沿用 `session/title-llm-request` 先例。
- **状态落地** — 已验证进度与任务契约通过 continual-harness 的 CAS 管道，以 `loop_<runId>/...` id 约定作为会话级 `memory` 条目 upsert 进 [continual-harness](../plugin-continual-harness) 状态，使概览注入、`/refine` 与回滚无需改动即可生效。

加入的会话保持 Manager 角色；executor/auditor 片段借用组合提供的委派工具（见 `docs/recipes/agent-presets/loop/`）。设计理由见 `.agents/notes/implemented/architecture/2026-08-24-rlm-loop-recording-tool.md`。

## 配置

| 配置 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `dataDir` | string | `~/.dsh/rlm` | 落地进度的 harness 基础目录；必须与 plugin-continual-harness 的 `dataDir` 一致。 |
| `maxRounds` | number | `32` | 每轮运行的软上限；超出仅告警，绝不阻断。 |

## 工具：`loop`

| 动作 | 参数 | 效果 |
|---|---|---|
| `begin` | `task`, `contract?` | 开启一次运行，发出 `session/loop-start`，落地契约条目。 |
| `record` | `round`, `route`, `audit_report`, `progress_note?` | 解析表头，应用信任闸门，发出 `session/loop-round-done`，在被接受时落地 `progress_note`。 |
| `status` | — | 汇总本会话已记录与已验证的轮次。 |

结构化输出携带 `runId`/`round`/`accepted`/`status`/`integrity`/`contractAudit`/`landed`；`text` 携带面向模型的引导，含拒绝原因（无法解析的表头、`done` 路由却没有干净审计、干净 verdict 却缺备注）。

## 测试

```bash
pnpm_config_verify_deps_before_run=false pnpm --filter @deepseek-ai/dsh-plugin-rlm-loop run test
```

## 模型体验

### 循环进度

#### 模型看到什么

模型看到一次契约（经 `loop begin`）以及每轮一条 `loop record` 的结果文本；工具用已解析的可信进度信号取代临时的 verdict 推理，而非发出新的模型引导。

#### Token 影响

每任务一次 `loop begin` 落地一次契约；每轮增加一条 `loop record`，其短小结果文本取代 verdict 正文，因此开销只随已记录轮次增长。

#### KV 缓存影响

落地条目通过 harness 概览注入重新进入上下文，因此后续轮次从提示中读取可信状态，而非从历史重新推导；工具从不修改更早的请求 token。

## 已知限制与待办工作

- 真实运行时挂载已就绪：六个 rlm 插件包（含本插件）已加入 `apps/cli/package.json` 依赖闭包，`pnpm install` 后可由 CLI 正常解析与装配；`docs/recipes/agent-presets/loop/` 即一个自包含的 loop preset（MODE B）。
- 运行注册表（`runId`、已记录轮次）为每进程内存态；持久真相存在于会话日志事件与 harness 状态文件中，因此监管进程重启只会丢失 `status` 这个便利视图。
- 已验证进度沿用既有 `memory` 种类与 id 命名约定，而非专用 `HarnessKind` 值，代价是无法按种类过滤。
