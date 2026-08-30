# Loop Engineering 融入 rlm 体系（设计）

<!-- 本文职责：三角色循环（Manager/Executor/Auditor）融入 rlm 体系的设计论证、概念映射与插件形态规划。不写实现状态（归 STATUS.md），不写安装（归 INSTALL.md），dsh seam 行号核实记录在 VERIFY.md。 -->

> 来源：对 [AMAP-ML/LongHorizon-Harness](https://github.com/AMAP-ML/LongHorizon-Harness) 的源码分析结论。该项目的本质是**外挂式 Loop Engineering**：把现成 Agent CLI 当黑盒，在外层用子进程编排 Manage→Execute→Audit 循环，只信独立审计过的状态。 本文回答一个问题：这套循环语义如何以 rlm 家族契约融入 dsh，而不是照搬它的工程外壳。

---

## 总判断

LongHorizon 自建的四样基础设施——进程编排、轨迹落盘、状态台账、审批门控——rlm/dsh 全部已有更优的原生等价物；它真正独特的思想（三角色协议、只信审计过的状态、冷上下文 episode）恰好嵌进本体系已有的调用面（subagents）、验证面（verify/moa）与状态面（continual-harness）。因此融入的形态是**一个薄插件 + 组合配置**，预计新增代码量数百行级；它约三分之一的工程量（runs 目录台账、events.jsonl 解析、supervisor）被直接消掉。

---

## 概念映射

| LongHorizon 的做法 | rlm/dsh 原生等价物 | 结论 |
|---|---|---|
| 每次 spawn `dsh --profile headless`（冷启动 episode） | `ctx.subagents.start()` 子代理；prompt 即本轮全部输入 | 直接复用（`rlm.run` 同款缝） |
| Manager 每轮重建 prompt（task_state/task_contract/审计历史） | continual-harness 注入：可信状态存 harness 条目，每轮自动进 system prompt | 更优，见设计判断 D1 |
| Auditor 只读实地核验 | 受控子代理：persona=审计协议 + `toolFilter.deny` 写类工具 | 新增但极薄 |
| `runs/<id>/rounds/` 台账 + events.jsonl + stdout tee 解析 | 不需要：episode 本身是子代理会话（轨迹天然存在）；轮次结论记 log-only 会话事件（verify 先例） | 消掉 |
| Dashboard 审批 / human gate / 追问续跑 | dsh 原生审批流；主会话对话即追问入口 | 复用 |
| report.json | harness 条目 + 自然语言最终回复 | 复用 |
| GUI 执行支路（MCP computer-use 插件） | dsh 暂缺 | 第一阶段 CLI-only（与其对 dsh 的适配同水位） |

---

## 设计判断

### D1：Manager 不做成子代理——主会话自己就是 Manager

LongHorizon 要求 Manager 每轮冷启动，是因为它的进程模型没有别的办法让规划者拿到干净的最新状态。本体系里：

- 可信状态活在 harness 里，不活在对话里（continual-harness 核心主张）；
- 原始轨迹活在子代理会话里，永不进父上下文——父会话只见蒸馏后的审计报告；
- 配合 dsh compaction，主会话跨轮存活仍等效于"每轮重建 prompt"，并免费获得对话连续性（任务完成后直接追问，沿用已完成轮次继续）。

Manager 协议原样保留：维护 `当前任务状态:` 与稳定 `任务契约:`，输出唯一路由 `Next: cli | ask | done | blocked`（第一阶段不注册 gui）。区别仅在状态的权威副本落在 harness 条目而非临时 txt。

### D2：Auditor 与 verify 是验证面的两个互补层

verify 判"哪个候选好"（文本层，PPT 锦标赛，宿主缝）；auditor 判"现实里真的成立吗"（环境层，带只读工具的子代理）。组合配方 C（补入 MOA.md）：

1. 高风险子任务扇出 N 个 executor 子代理并行求解；
2. `verify` 在文本层选优；
3. 胜者落地后由 auditor 实地核验（真实文件内容、测试运行结果），不信任何自述；
4. 仅当 auditor 报告前三行头为 clean+complete+aligned 时，才把结论写入 harness「已验证进度」。

### D3：循环驱动器是薄工具，不是 supervisor

不照搬其 supervisor/service.py。权威边界原则（调度全在宿主缝）指向：新增第五个家族成员 `plugin-rlm-loop`，注册面仅四项：

| 注册面 | 内容 | 家族契约对应 |
|---|---|---|
| `loop` 工具 | `begin(task)/record(round)/status`（Phase B 落地形状）：**记录工具而非编排器**——executor/auditor 由 Manager 经命名委派工具调用，本工具只做三行头解析 + clean 门禁 + CAS 落 harness | defineTool 同构、sessionId 关联 |
| 会话事件族 | `session/loop-start\|round-done`，log-only ignorable envelope（沿用 title-llm 与 verify-request\|result 先例） | Tier 1 权威过程记录 |
| auditor 子代理模板 | persona（审计三行头协议）+ toolFilter 只读 | 用途归因 `purpose:'loop'` |
| harness 条目约定 | 复用既有 `memory` kind，条目 id 用 `loop_<runId>/…` 命名约定（如 `loop_ab12cd34/round_001`，不扩 HarnessKind）；审计结论经 CAS 白名单校验落地（refine 同款管线，可回滚白拿） | 状态面复用 |

审计结论→状态更新由**代码确定性写入**（解析三行头后走 CAS），不由模型自觉维护——"只信审计过的状态"必须强制在操作里，而非提示词里。

### D4（隐含原则）：不改 agent-loop

循环是插件通过文档化扩展点（subagents/sessions/systemPrompt/commands）编排的行为，不动 `agent-loop`，无需改架构文档。

---

## 角色隔离机制（seam 现状，行号见 VERIFY.md）

已逐行核实的 dsh 事实：

1. `SubagentStartRequest` 支持 per-child `persona`（影子覆盖 deployment persona）与 `toolFilter`（allow/deny；被 deny 的工具从子代理 prompt 中消失**且拒绝执行**——是真实强制，不是软约束）；**没有** per-child 权限模式字段。
2. 委派边界继承的是**父会话的显式沙箱 override**（`sandbox/mode` source:'delegation'），审批策略钉死 `'never'`；父无显式切换则落到部署默认值。
3. 子代理加入的是父 preset（`composeFrom(childCtx, parent.ctx)`），`SubagentStartRequest` 不提供跨 preset join。
4. per-child `permissionMode` 只存在于外部 CLI 后端（claude-code/codex/acp provider 的 Config 层），in-process 子代理无此参数。

由此得出隔离的三档实现路径：

| 档 | 做法 | 隔离强度 |
|---|---|---|
| A | 角色指令内联进 spawn prompt | 软（提示词约束） |
| B | 融合 preset 内挂多个 `tool-subagent` 实例行（Config 有 `toolName`，可注册 `subagent_executor`/`subagent_auditor` 等命名实例），各自配 persona + toolFilter | 工具级硬约束（受限名单外的工具对子代理消失且拒执行）。**实测教训**：filter 必须用 allow 白名单而非 deny——restrict 对未知名 loud 报错，且 shell 工具名平台门控（win32 无 bash），deny 清单跨平台必然踩雷；auditor 用 `allow: [read, glob, grep]` 恰好覆盖审计协议 |
| C | per-child 沙箱模式硬隔离 | **seam 当前不支持**；需上游扩展 `SubagentStartRequest` 增加 policy 字段（委派边界已有按子播种 `sandbox/mode` 事件的机制，扩展是自然小改），或改用外部 CLI 后端按 provider 实例配 permissionMode |

第一阶段采用 B（已按 allow 白名单实测跑通）；C 作为上游贡献候选单独评估。

---

## 家族契约符合性

新工具从第一天服从 [REPLICATE.md 家族统一契约](./REPLICATE.md)：defineTool 注册形态一致；每次辅助调用携带 sessionId 并可审计；`purpose:'loop'` 归因；隐私档位三档语义一致（auditor 报告进入 Manager 视野前可按 full 档脱敏）；全部模型调用走宿主缝，内核进程零凭据暴露。持久面判据自动满足："当时为什么这样验收"的权威副本在会话日志（loop-round 事件 + auditor 子代理会话本身），dataDir 不新增任何权威状态。

## 显式非目标

- 不向内核侧暴露 loop（无凭证 shim 不触发编排扇出，与 verify/moa 非目标一致）。
- 不复刻 runs 目录、事件文件解析器、独立 supervisor 进程。
- 第一阶段不做 GUI 支路与并行 executor 扇出（配方 C 的扇出走 verify.auto_spawn 既有机制，后续再接）。

## 分阶段路线

| 阶段 | 内容 | 新增代码 |
|---|---|---|
| A | 纯组合验证：`recipes/agent-presets/loop/` 独立 recipe（executor/auditor 两个命名 tool-subagent 实例，各配 persona+toolFilter），主会话按 Manager 协议跑通循环。**载体修正**：rlm 融合 preset 的运行时装配链未打通（见 INSTALL.md；2026-08-29 起已打通），故 Phase A 用纯 shipped 包独立成 recipe，并以隔离 `DSH_HOME` 下的 loop profile（复用 base+headless bundle）做 headless 实测；源码树直跑需 `--expose-internals`（缺 `node-addon-require-builtin` 原生回退） | 0（仅 cordis.yml + 提示词文本 + 验证 profile） |
| B | ✅ 已落地：`plugin-rlm-loop`（`@deepseek-ai/dsh-plugin-rlm-loop`）——`loop` 工具 begin/record/status、三行头确定性解析、信任门禁、`session/loop-*` 事件族、CAS 落 harness（memory kind + `loop_<runId>/` 命名约定）。包测试现 19 项（parser 9 + tool 9 + persistence-catalog 1）；决策记录见仓库内 Agent Note 2026-08-24-rlm-loop-recording-tool。真实运行时挂载已就绪（**七个** rlm 包已进 `apps/cli/package.json` 依赖闭包，`pnpm install` 后可经 CLI 解析；`docs/recipes/agent-presets/loop/` 为自包含 loop preset），无需显式 `ctx.plugin()` | 数百行 TS |
| C | 上游候选：per-child policy 字段进 SubagentStartRequest（或外部后端 permissionMode 路由），auditor 获得沙箱级只读 | 上游 PR |

阶段推进以 STATUS.md 登记为准；本文只钉设计与契约。

---

## 技能形态（T2.4，2026-08-25）

三行头协议的机械校验已固化为可调用内核技能 `loop-audit`（源：`packages/rlm/plugin-rlm-loop/skills/loop-audit/`，随仓库分发）。安装后（`<dataDir>/skills/loop-audit/` + harness 条目），内核内即可程序化校验审计报告：

```python
r = await loop_audit(auditor_report)
# r = {"ok": bool, "header": {...}|None, "problems": [...]}
```

`ok=True` 当且仅当 complete+clean+aligned（与宿主信任门同判）；`problems` 逐行给出修正提示，供 auditor 自我重写。协议文本仍是 persona 的教学层；本技能把"格式是否合规"从概率性注意力移入确定性代码。
---

## 双模式运行（2026-08-29 追加）：普通 RLM 模式 vs Loop 调度模式

Loop 不是对 RLM 执行模型的替换，而是同一套内核之上的可选调度壳。两种模式共享持久 IPython 内核、rlm() 递归原语、Continual Harness 状态与 verify/moa 工具；区别只在"是否套上三角色 Manager/Executor/Auditor 协议 + loop 记账"。

### 模式 A — 普通 RLM（默认）

- 不开 loop preset，主会话直接以内核 ipython 工具 + rlm() 递归干活。
- 传统上下文调度逻辑完整保留：模型自主任务分解、递归子代理、/refine 自我精炼、harness 状态注入全部照常。
- 无 auditor 强制核验，进度由模型自行保证；适合开放式探索、交互式开发。

### 模式 B — Loop 调度（loop preset）

- 选 `循环模式（Loop Engineering）` preset 启动 session；主会话变 Manager。
- **推进代理 = 主会话在自己的持久内核里调 `rlm("有界子任务")`**（非独立 CLI 子进程），故 `user_ns` 累积、技能、verify/moa 访问与普通模式完全一致——传统调度逻辑未被降级。
- **隔离模型（单向，2026-08-29 定）**：
  - 推进代理**可见**主代理的上下文（任务/契约/前置结论）——下行共享；
  - 主代理**不可见**推进代理的推理过程，只收**结构化结论**——上行隔离。其机制由 dsh 子代理 settlement 原生保证：settled 子代理只向父会话投递 `subagent-settled` notice + 其 closing message，**不合并完整轨迹**；协议层再要求结论是 `RESULT/ARTIFACTS/EVIDENCE` 三段式，防止信息过少或倾倒原始推理。
  - 推进代理**内部做算子隔离**（搜集信息 / 推理与动作 / 给出结论 三段，在同一个 `rlm()` 调用的内核上下文里完成、共享中间状态），**不再拆成多个子代理**——即"代理级隔离在主↔推进，算子级隔离在推进内部"。
- **Auditor 由主代理自决调用，零强制**：仅当本轮产生需实地核验的真实副作用（文件改动/测试/外部状态）时才调只读 auditor 子代理（`toolFilter.allow:[read,glob,grep]`）；纯内部推理/低风险分析可直接采信结论。撤销了早期"每轮必调 auditor"的硬规则。
- **可追问/可新开（非强制）**：主代理每轮后可选择采信结论、`rlm.message` 追问同一子代理、或新开 `rlm()` 委派，三者皆可选，由结论质量决定。
- `loop` 工具做确定性记账：complete/clean/aligned 的 verdict 经 CAS 落 harness `memory`（`loop_<runId>/round_NNN`），成为可信共享状态；未审计轮次不调用 `loop record`（工具要求可解析的审计头，缺失则拒绝落地），结论由主代理保留在自身 task_state 并带入下一轮契约。原始轨迹留在子代理会话，不进主上下文。
- **定期整理（Periodic Compaction）**：Manager 协议规定，当最近 3 轮 `progress_note` 高度冗余（无新 `user_ns` 状态/文件/已验证事实）时，不开启新 executor 轮次，而是输出 `Summary:` 把近期可信进度压成 1–2 句写回 harness（借鉴 Heuriva `progress_policy` 的"无实质进展→强制收敛"）。

### 互不干扰保证

- Preset 为 per-session（session header 记录 agentPreset），模式 A 与模式 B 的 session 各自独立内核、各自 harness 状态，无交叉。
- loop 工具仅在模式 B 被挂载/调用；模式 A 不写 loop_* 条目，harness 概览不受影响。
- 内核 rlm()、verify、moa、continual-harness 在两种模式下行为一致——Loop 只是给"执行—核验—记账"套了约束，不改动底层原语。

### 实现落点（与既有代码关系）

- plugin-rlm-loop：loop 工具（录制器，不派生子进程）；loop-audit 内核技能（三行头确定性校验）。
- docs/recipes/agent-presets/loop/agent.cordis.yml：Manager 协议 + auditor 只读子代理；executor 已改为"主会话内核 rlm()"（原 CLI 子代理形态见同目录 .bak-premode 备份）。
- 传统调度逻辑（内核 rlm() 递归、harness 注入、/refine）全部在 plugin-rlm-kernel / plugin-continual-harness，两种模式共用，未做任何分叉。
