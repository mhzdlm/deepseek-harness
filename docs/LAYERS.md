# 三层关切框架设计稿：任务编排 / 上下文管理 / 模型调用管理

<!-- 本文职责：RLM 体系"三层关切"框架的设计论证——分层依据、各层新建件设计、建造顺序与评估方式，以及本次框架讨论的全部裁决记录。不写实现状态（归 STATUS.md），不写任务排期（归 NEXT.md），不写安装配置（归 INSTALL.md），不重复记忆层/循环/保活/成本的既有设计（归 REME/LOOP/LIFETIME/MOA.md）。版本锁定见 README.md。调研笔记（research/）不参与版本锁定，本文只引用一手出处（论文 arXiv 号与源码锚点）。 -->

> 本文是**已部分裁决**的设计稿：标记 ✅裁决 的条目已经讨论定案；未标记者为提案，实施前可再议。排期归 NEXT.md，本文不代表实施承诺。

---

## 0. 一句话定位

**三层不是三个新子系统，而是套在既有 RLM 底座上的三个嵌套控制回路**——内层管每次模型调用、中间层管每轮上下文、外层管每个任务的编排。框架的价值是把已有插件族看清格子、把缺口定位到层，并给新建件定序：内层先行，因为外层消费内层。

## 1. 框架：三层嵌套回路 + 底座 + 评估横切

```
外层回路（per-mission）任务编排：任务怎么分解、谁做、做完了吗
  │ 消费
中间回路（per-turn）上下文管理：这一轮模型看到什么
  │ 消费
内层回路（per-call）模型调用管理：这次调用选谁、花多少、谁把关质量
```

- **底座（不动）**：持久内核（dill）、host bridge 窄白名单、harness CAS、会话日志（Tier 1 权威）、kernel-env/toolFilter 治理面。权威边界不变：计费与执行在宿主，内核永无凭证（REPLICATE.md）。
- **与栈分层的正交关系**：既有的"底层内核 / 中层原语 / 应用壳"回答**代码放哪**；本文三层回答**管什么**。同一关切可落在多个栈位（例：上下文管理同时在底层 dill、中层 memory/compaction、应用壳按需装配）。
- **每层共享的纪律**：①守卫在代码不在提示词（loop 三行头、memory 证据门同哲学）；②`off | observe | enforce` 三分支、默认不动现状（memory gateMode/exitMode 惯例）；③新件出生即带 log-only 会话事件，让开/关对照成为免费的实验设计。

### 1.1 现状盘点（插件填格子）

| 层 | 已有 | 厚度 |
|---|---|---|
| 外层 编排 | `plugin-rlm-loop`（记账非编排）、loop/rlm 双 preset、`rlm()` 递归 | 薄且刻意薄 |
| 中间 上下文 | `plugin-rlm-compaction`、`plugin-rlm-memory`（Phase A–E）、continual-harness 注入、`session.query`、内核态 | 最厚，收尾为主 |
| 内层 调用 | `plugin-rlm-verifier`、`plugin-rlm-moa`、purpose 归因 | **最薄，优先补强** |

## 2. 内层新建件：`llm.query` 桥（本框架的第一建造项）

**动机**：RLM 原论文（arXiv:2512.24601v3）的核心定量技巧——根模型把超长输入切片、在循环内同步扇出廉价子调用并编程化聚合——在 dsh 当前不可表达：`rlm()` 是完整子会话（`maxChildrenPerSession=8`、fire-and-forget），host bridge 七个 handler 无一是"直接查 LLM"。论文主表全部结果的子调用均用弱一档模型（GPT-5 根 + GPT-5-mini 子调用），证明**子调用默认降档**是质量无损的免费成本规则。

### 2.1 形态

- **内核侧**：bootstrap 注入 `llm_query(prompt | prompts, **kwargs)`，数组载荷即批量（论文 `llm_batch` 的对应物）；经 `host_request("llm.query", {...})` 走既有桥。
- **宿主侧**：新增第 8 个 handler，经宿主 llm 缝执行（verify/moa 同款 `ctx.llm.stream` 路径），计费归宿主会话、`purpose:'rlm-subcall'` 进 token-meter 归因。
- **事件**：`session/subcall-query` log-only 事件（verify-request/result 先例）：批量大小、解析到的模型、各答案字符数、重试次数、耗时。这是评估层（§5）的数据源。
- **截断**：每答案字符上限（防子调用结果打爆内核上下文），超限截断并标记，家族 `MAX_OUTPUT_CHARS` 同思路。

### 2.2 配额：并发数思路 ✅裁决

**裁决**：配额按**并发数**实现——per-session 在途子调用流上限（Config 字段，默认对齐家族直觉 8）+ 单请求批组长度上限；超限响亮报错点名键名（`maxChildrenPerSession` 同款风格）。 **记录**：按会话聚合 purpose 账的**总量+成本台账**是最准确方案（论文成本结论：中位数便宜、长尾贵，要防的是挣扎轨迹），当前实现成本偏高，**作为未来可替换方向记录于此**，届时以 `session/subcall-query` 事件积累的真实分布评估。

### 2.3 降档路由表：kernel Config 统一管理 ✅裁决

**裁决**：路由表**不独立成插件、不做跨插件复用**；作为 `plugin-rlm-kernel` 的校验 Config 字段（如 `subcallModel` 选择器，默认对齐 verify 后端的廉价档先例），经 cordis.yml preset 配置面**统一管理**。规则路由起步，不做 ML 路由。

### 2.4 子调用质量门

宿主侧检测退化答案（空/极短/自我重复——论文 Appendix F.1 的"子 LM 放弃"模式），自动重试一次；仍退化则返回带 `degenerate` 标记的错误，**细分决策留在内核侧**（论文做法即根模型检测后自行 chunk），宿主不猜测文本结构。守卫在代码，不依赖模型自觉。

## 3. 中间层收尾项（不新建子系统）

| 项 | 形态 | 状态 |
|---|---|---|
| 主动召回注入 | harness section 渲染时以最近 user message 轻量检索、top-N 全文注入、预算硬上限，默认 `observe` | 提案（设计雏形见 research 调研） |
| ReTree 依赖一致性 F 段 | 覆盖落盘时记 `derived_from` 等零成本项 | 按 RETREE.md 既定裁决推进，本文不改优先级 |
| Scroll 式结构性无损 | **不做**：dsh 会话日志已是权威回放源 | 裁决：非目标 |
| prompt cache 管理 | 先记账（token-meter 已有归因）后优化 | 非目标（本期） |

## 4. 外层新建件：DAG 编排协议与"何时不递归"

1. **DAG 编排协议**：论文 LongCoT 实验（+69.5%，arXiv:2512.24601v3 Appendix C.3）的编排协议——规划子调用出 DAG → 按层批量派发（消费 §2 的 `llm_query` 批量能力）→ 每答案传播前用最便宜确定性检查验证 → 环以种子+缓存重试 → 最终只做 dict 装配——落地形态为**内核技能 + preset persona 模式**，不是新插件。"Root compute = dict lookup, string formatting, correctness checks" 进 Manager/Director 类 persona。**这就是内层必须先建的具体原因**。
2. **"何时不递归"守卫**：论文 Observation 2（CodeQA 上 depth=0 反胜全部递归变体）与 Qwen3-Coder 过度调用警告证明递归不是免费午餐。起步形态 = 路由 Config 的 depth/用途策略 + persona 指引；自动判定不做，等评估层数据。
3. **T3.3 autonomous quality gates**：NEXT.md 唯一活跃项，归本层收尾。
4. **穿书应用壳**：全栈第一个真实 dogfood，其里程碑顺序（机械函数先行、再叠 LLM 角色）与本框架建造顺序同构。

## 5. 评估：手动研究工具 ✅裁决

**裁决**：评估**只做手动工具，不 CI 化、不做自动门禁**——自动评估当前无准确方法学，做出来只是架子。

- **形态**：对会话日志的确定性查询脚本 + 固定任务电池；不进运行时、不动插件。
- **数据源全已存在**：`session/subcall-query`（§2）、verify-request/result、loop 三行头、memory use 信号、token-meter purpose 账。
- **分层度量**：内层=单位质量成本与降档质量差（verify 锦标赛分数即现成真值）；中间层=召回命中率与压缩保真（use 信号）；外层=任务成功率与审计 clean 率。
- **方法学**：固定根模型变 scaffold、固定 scaffold 变子模型；报告中位数与长尾两个统计量；任务电池按复杂度轴（常数/线性/二次）设计；所有结论须能分离组件能力与组织贡献（三层开关矩阵天然支持消融）。
- **第一块电池**：OOLONG 式聚合任务可直接出在本仓代码库上；穿书一致性检查为第二块。

## 6. 建造顺序（已排期：NEXT.md Phase 7 · 7D）

1. `llm.query` 桥：handler + 内核函数 + 路由 Config + 并发配额 + 质量门 + 事件（内层，解锁论文技巧）；
2. 手动评估工具：日志查询脚本 + 第一块电池（先有尺子再加盖）；
3. DAG 编排协议（内核技能）+ 何时不递归守卫起步（外层，dogfood 于真实任务）；
4. 召回注入 observe（中间层，带数据决定 enforce）。

## 7. 非目标（本期）

不做 ML 路由；不训模型（论文的 RLM-Qwen3-8B 路线明确出局，harness 自我改进是既定路线）；不动 agent-loop / kernel vendor 核心；不做 supervisor/scheduler（宿主已有）；不做 Scroll 式结构无损；不做评估 CI 化。

## 8. 裁决记录

| # | 裁决 | 内容 |
|---|---|---|
| R1 | ✅ | `llm.query` 配额用**并发数**实现；总量+成本台账记为最准确方案，未来可替换（§2.2） |
| R2 | ✅ | 路由表放 kernel Config、统一经 preset 配置面管理；不独立成插件、不做跨插件复用、不做 ML（§2.3） |
| R3 | ✅ | 评估只做手动研究工具，不 CI 化（§5） |
| R4 | 既定 | Scroll 式结构无损、prompt cache 管理、训练路线均为非目标（§7） |
| R5 | ✅ | 建造顺序已排期：NEXT.md Phase 7（7A 地基 → 7B P1 清场 → 7C 覆盖卫生 → 7D 新建 T7.10–T7.13），与 2026-08-30 终版复核发现项统一编排，原则「先清场、后加盖」 |
