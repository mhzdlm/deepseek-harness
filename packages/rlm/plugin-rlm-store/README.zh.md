# @deepseek-ai/dsh-plugin-rlm-store

[English](README.md) | 中文

RLM 家族的统一存储核心：按作用域（scope）组织的只追加事件流、其物化视图与判断通道，以 `rlm.store` Cordis 服务暴露。它是依赖图根——不 import 任何其他 rlm 包，其余七个包都消费此服务。`append` 是非判断事件的唯一写路径；`judge` 是 `rlm/judgment` 的唯一写路径；`state.json` 只是写流者同步更新的缓存，从不是权威——`rebuild` 从流重放重建视图。

## 配置

| 配置 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `dataDir` | string | `~/.dsh/rlm` | 家族产物根目录；各 scope 的流在 `<dataDir>/store/<scope>/events.jsonl`。必须与其他 rlm 插件的 `dataDir` 一致。 |

护送机制阈值是 `RlmStore` 构造参数而非插件配置：`internalClockDistance`（验证到队首的事件距离，默认 256）与 `densityAlarmActions`（密度告警锁定 promotion 前的非判断动作数，默认 50）。出厂插件实例使用这两个默认值。

## 服务：`rlm.store`

`apply` 提供一个以基例判据播种的 `RlmStore` 实例（`withBaseCriteria`）。权威作用域：`{ kind: 'session', id }` 与 `{ kind: 'mailbox' }`。

主表面（镜像 `src/store.ts`）：`append(scope, type, payload)`、`judge(scope, input)`、`rebuild(scope)` / `ensureLoaded(scope)`、`view(scope)`、`beliefs(scope)`（仅 active）、`getBelief(scope, id)`、`registerCriterion` / `listCriteria()`、`onChange(listener)`（投影消费者在此订阅）、`readEvents(scope)`（严格的全流读取）、`replayNominations(scope)`（不截断的触发器⑥历史）、`evaluateFreshness` / `enforceFreshness`、`recordWorldReconciliation`、`executeRollback`、`checkClosureInvariant`、`alarmState`。错误类型：`RlmStoreFormatError`（流不可读 / 违反目录）、`RlmJudgmentError`（判断未通过形式要件）。

## 事件词汇

七型事件（`RLM_EVENT_TYPES`）：`rlm/observation`、`rlm/mechanical`、`rlm/action-boundary`、`rlm/judgment`、`rlm/handoff`、`rlm/rollback`、`rlm/human-revision`；各类型在每个 scope 的合法性矩阵在 `src/catalog.ts`。

十五种判词形态（`RLM_VERDICT_FORMS`）：`conclusion`、`selection`、`completion`、`merge`、`promotion`、`demotion`、`voiding`、`rollback`、`unpin`、`experience`、`handoff-nomination`、`check-pass`、`check-doubt`，外加 Phase D 审计对 `freeze` / `unfreeze`。创建型判词携带 `belief` 载荷；`demotion`/`voiding`/`rollback`/`freeze`/`unfreeze` 携带 `target`；`check-doubt`/`unpin` 仅落事件。信念等级：`provisional` / `evidenced`。

判断通道强制四项形式要件（判据已注册且层级一致、data support、判词形态合法、provenance 可在流中定位）外加层级门：`open` 层判据永远不能晋升到 `evidenced`。

## 判据

层级（`RLM_CRITERION_TIERS`）：`deterministic` > `structured` > `open`。出厂基例集（`src/criteria.ts` 的 `BASE_CRITERIA`，11 条）：`crit/loop-three-line-header`、`crit/evidence-gate-locatable`、`crit/refine-whitelist`（deterministic）；`crit/verify-eq31-tournament`、`crit/audit-pass`、`crit/audit-freeze`、`crit/audit-release`、`crit/audit-objection`（structured）；`crit/moa-aggregator`、`crit/kernel-harness-write`（open）。引用未注册判据的判断被拒绝。

## 冻结锁（Phase D）

`freeze` 判断锁定一个活跃信念的信任门资格：信念处于 `frozen` 期间，`judge` 拒绝任何 `supersedes.id` 或 `basedOn` 边触及它的 `promotion`/`merge`（否则等于绕过审计冻结重新发布）。`freeze` 要求活跃目标；只有 `frozen` 信念接受 `unfreeze`。反向筛选管线在 `src/audit.ts`：`runAudit`（独立批评者 + 程序化仲裁；结局 `pass` / `objection-accepted` / `objection-rejected-frozen` / `skipped`）、`listFrozenForReview`（人工批量复核队列）、`releaseAuditFreeze`（人工放行，落 `unfreeze` 判断）。观察级统计由 `observeReport` / `renderObserveReport`（`src/observe.ts`）从流重算；消费方是 `/memory stats`。

## 状态

Phase D（2026-09-01）：store 是家族唯一写权威——生产方以判断写入，投影从中渲染，审计冻结在其上把守信任门。家族总览见 [packages/rlm/README.md](../README.md)；家族级状态见文档仓 BUILD.md。
