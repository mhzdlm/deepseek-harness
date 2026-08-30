# RLM 记忆演化层设计（plugin-rlm-memory，"RLM 的 ReMe"）

<!-- 本文职责：跨会话知识记忆层的设计论证——目标、架构、写/读/演化/退场四条路径，每项设计决策标注理念来源与借鉴来源（见 §8 溯源总表）。不写实现状态（归 STATUS.md），不写安装配置（归 INSTALL.md），不写调研对比（归 research/QwenPaw深度分析.md P3.4-P3.5 与 research/ReMe与dsh集成分析.md）。领取任务时由 NEXT.md 引用本文。 -->

> 背景（2026-08-29）：对 ReMe（agentscope-ai/ReMe，Apache-2.0，`学习/ReMe`）的源码核实结论 + 《ReMe与dsh集成分析》四路线评估。判定：ReMe 的**形态**值得吸收（文件权威知识库、检索式召回、自发整编），其**自治形态**不可照搬（自有密钥、自有定时器、双 LLM、决策审计不落盘——均经源码证实）；Continual Harness 论文（arXiv 2605.09998）的管理策略恰好补足其治理缺口。本设计取集成分析四路线中的**最省路线（§10：RLM 原生扩展）**：新建第五个家族成员 `plugin-rlm-memory`，把论文纪律装进 ReMe 形态，全部模型调用走宿主缝。

---

## 0. 一句话定调

**ReMe 做形态，论文做纪律，dsh 做主权。** 文件权威的 Markdown 知识库（借 ReMe）、证据支撑的写入与可回滚的演化（承论文与既有 /refine 资产）、触发权与模型层全归宿主（承集成分析 L2 裁决与家族契约）。

## 1. 为什么是"原生扩展"而不是接 ReMe（决策 D1）

集成分析 §3 已证实 ReMe 作为 sidecar 运行时是**带自己 LLM 的自治记忆子系统**：`example.env` 独立密钥、每日 auto_dream 自有定时器、`integrate` 步骤派带写权限的 agent 直接改知识树（`integrate.py:14`）、`DreamState` 决策审计只进 HTTP 响应（`utils.py:25-30` store_state）且被 dsh 侧丢弃（`runtime-status.ts` 自述 "content-free"）。这与家族契约"全部模型调用走宿主缝、内核/旁路零凭据"直接冲突。

同时 §10.2 的成本核算表明：RLM 家族**已有的最贵部件**（持久化、CAS、回滚、跨会话、自动演化门）无需重造，需新增的只有 ReMe 的差异化特征（文件形态、检索、整编编排）与论文的管理策略。故：**新建 `@deepseek-ai/dsh-plugin-rlm-memory`，不引入 ReMe 运行时，不复刻其 HTTP 服务面**。命名避开 "ReMe" 字样以避免与上游混淆。

## 2. 目标与非目标

**目标**：给 RLM 家族补上"跨会话知识资产"这一层——会话经验经证据门固化为用户可读可编的 Markdown 笔记；召回按相关度（而非仅时间）按需取全文；周期整编把笔记变厚且每一步可审计、可回滚；陈旧知识按使用信号退场且退场可逆。

**显式非目标**：

- 不做 sidecar HTTP 服务、不让任何组件持有独立模型凭据（双 LLM 教训，集成分析 §3）。
- v1 不引入 FAISS/向量库/本地嵌入模型依赖；不重写 ReMe（§9 复现成本分析已淘汰）。
- wikilink 图召回推迟（集成分析 §10.2(b) 判定为最贵增量，待 Phase B 使用证据表明需要）。
- 不向内核暴露记忆工具（家族契约既定：无凭证 shim 不触发计费面）。
- 不做跨机同步、多租户、技能市场（NEXT.md 既有非目标沿用）。

## 3. 与既有资产的边界（决策 D2）

| 层 | 拥有者 | 存储形态 | 管什么 |
|---|---|---|---|
| 会话内工作状态 | plugin-rlm-kernel | dill 快照（`user_ns`） | 进程状态续命，不碰 |
| 会话内路由状态 | plugin-continual-harness | `harness_state.json`（CAS） | 四类条目、hints-only 注入、/refine，不碰 |
| **跨会话知识资产** | **plugin-rlm-memory（本设计）** | **Markdown 笔记（文件权威）+ 派生索引** | capture/recall/consolidation/retire |

边界纪律：**两套存储不共写任何文件**；capture 的输入取自**已完成会话**（QwenPaw P3.6 "auto_memory 输入取自已完成对话"的同款边界）。harness `memory` 条目与知识笔记的跨层晋升走 consolidation 管线（`/memory consolidate`，见 §5.3；初稿设想的 `/memory promote` 未实现）——harness 的 local→global 与本层的 draft→published 是同构的受控晋升。

## 4. 存储形态与目录布局（决策 D3、D4）

**文件权威**：知识=带 YAML frontmatter 的 Markdown；一切索引（关键词倒排、未来向量）皆为**可重建的派生物**。

```
<memoryDir>/                      # 默认 <dataDir>/memory/，Config 可指向项目目录（见开放问题 2）
  published/<kind>/<slug>.md      # 已发布笔记（进入召回索引）
  drafts/<kind>/<slug>.md         # 已固化的候选（证据门已过，发布门未过/observe 不拦截）
  archived/<kind>/<slug>.md       # 退场笔记（索引摘除，可随时移回——退场即移动，天然可逆；实现目录名为 archived/，非本稿早先写的 archive/）
  dialog/<sessionId>.jsonl        # 捕获的原始对话（剥离工具结果后的原文）
  index/keyword.json              # 派生：关键词倒排索引（可删可重建）
  logs/consolidation/<date>.jsonl # 派生：整编决策审计（追加写）
  events.jsonl                    # 派生：本层自身操作史（capture/promote/retire 事件，回滚依据）
```

frontmatter 契约（全部字段进 Config 校验的 schema）：

```yaml
---
kind: procedure|personal|wiki     # 三桶沿用 ReMe 分桶（低成本借借鉴）
scope: session|global             # 对齐 harness 双作用域语义
session_id: <id>                  # 溯源：产自哪个会话
source: <事件引用或对话区间>        # 证据门产物：必填
source_conversation: dialog/<id>.jsonl   # 溯源：原文指针
created_at / updated_at / version: 3
use_count: 0                      # 退场信号：召回命中计数
last_accessed: <iso>              # 退场信号：最近命中时间
gate: {mode: observe, verdict: pass, reviewed_at: <iso>}   # 发布门留痕
---
```

**决策溯源**：文件权威与"索引可重建"借 ReMe（README_ZH "Memory as File, File as Memory"；`FaissLocalFileStore`——"chunk JSONL stays authoritative"）；frontmatter 溯源双字段（`session_id`/`source_conversation` wikilink）直接借 ReMe `auto_memory.py`（`_ensure_session_frontmatter`，源码核实存在）；`source` 必填证据承论文 "small, evidence-backed updates" 与我们 /refine 的 FIX-8（"unsupported proposals are rejected"）；`use_count`/`last_accessed` 承论文管理策略的 aging/demotion（ReMe 无此字段，源码核实全仓唯一 TTL 是搜索去重的 `seen_ttl_hours`）；三桶借 ReMe `dream_bucket_enum`。

## 5. 四条路径

### 5.1 写路径：capture → draft（证据门）

宿主在会话结束（或每 N 轮，Config）捕获已完成轮次：**剥离工具结果块后**的原文落 `dialog/<sessionId>.jsonl`；派一个非 reasoning 的子代理（`ctx.subagents.start`，`reasoningEffort:'none'`）从原文产出候选笔记 JSON（含 `source` 证据引用）；`validateProposals` 式白名单校验（证据引用必须能在 dialog jsonl 中定位命中）通过后写 `drafts/`，记录 capture 事件。

- **反污染（双层）**：捕获面剥离工具结果——借 ReMe `_sanitize_msg_for_save`（源码注释原话："让检索到的事实伪装成用户提供上下文"）；召回结果本身是工具结果，天然被同一规则挡在下一轮 capture 之外（ReMe "召回不再次进 auto_memory" 契约的等价实现）。
- **子代理隔离**：`rootAgentsOnly`——subagent 会话不进 capture（借 ReMe dsh 插件同名 Config 的先例）。
- **隐私**：捕获文本经家族 `privacyFilter` 三档（full 档对凭据/PII 掩码后才落 dialog jsonl）。
- **模型可见 ⟺ 已记日志**：capture 完成注入 `session/memory-captured` log-only 会话事件（沿用 verify-request|result 先例），进持久化目录并加 persistence-catalog 守卫 spec。
- **v1 模型不直接写知识库**：写入面只此一条宿主管线——知识库是持久注入面，写入面越窄越安全（承 Heuriva 的刻意克制与论文的 gate 精神）。模型驱动的 CRUD 写入列为开放问题 4。

### 5.2 读路径：memory_search + 使用信号（检索质量）

注册 `memory_search` 工具（`defineTool`，`purpose:'memory'`，携带 sessionId）：入参 query，返回 top-K 已发布笔记**全文** + score + id；检索只搜 `published/`（drafts 不进索引——发布门语义的一部分）。渲染走工具结果（自动入会话日志），**不进 system prompt**——harness 概览（时间索引）继续担任"最近记了什么"的常驻提示，语义召回是"此刻什么相关"的按需通道（两通道互补，见集成分析 §10.4）。每次命中宿主更新 `use_count`/`last_accessed`（退场信号采集）。

- v1 索引 = 关键词/BM25 式倒排（title+content 分词，进程内实现）。**语义召回被上游缝阻塞**：核实结论是 dsh LLM 缝**没有 embeddings API**（`adapter.spec.ts:2224` 的 "embedding" 指测试内嵌构造 adapter，非向量接口；集成分析 §10.4"复用 ctx.llm embedding"声称不成立）。向量召回列为上游贡献候选（dsh-llm 增 embeddings 面），启用前不引入任何本地嵌入依赖。
- **决策溯源**：检索式召回 + 按需全文，借 ReMe `reme_search`（BM25+embedding+wikilink）与集成分析 §10.4 的 memory_search 设计（工具面、top-K 全文、/命令复用同一后端）；"时间索引保留为常驻提示"承 prime hints-only 哲学（6/180/6000，已在 P3-#3 落地）；命中计信号承论文 aging 策略的信号采集需求；"检索只搜 published"是本设计把发布门与索引派生范围绑定的决定，理念来源为论文的 trust/conservatism。

### 5.3 演化路径：consolidation（发布门 + 增长预算）

宿主触发的整编轮（会话结束钩子或 cron，Config；触发权全在 dsh——集成分析 L2 裁决"触发权交给 dsh，ReMe 退化为被管理引擎"的同款结构）：**scan**（扫 drafts+published 变更与预算）→ **propose**（子代理产出合并/分桶/改写提案，每条带 notes 理由）→ **apply**（校验后落盘，前置反向快照）→ **audit**（决策追加写 `logs/consolidation/<date>.jsonl`）。单飞锁防并发轮（借 ReMe `_integration_lock` 串行化）。增长预算：笔记数/字节超限（Config）时，轮次只做合并去重、不新增——论文 growth evaluation 与 dedup 的落地。

- **发布门**（`gateMode: off|observe|enforce`，默认 observe）：门禁评审（独立子代理按协议复核提案：证据支撑/与既有条目冲突/质量三问）在 observe 下照跑、结论进审计日志但不拦截；enforce 下未过门提案退回 drafts。默认 observe 承 Heuriva 的"默认观察、可旋钮 enforce"哲学与 NEXT.md 的使用密度判据（策略无使用数据就是瞎调参）。
- **回滚**：apply 前对将改文件做反向快照，事件入 `events.jsonl`，`/memory rollback <noteId> [force]` 按笔记逆向恢复（回滚前先快照当前值，回滚自身可逆）——直接套用 /refine 已验证的反向快照管线（refine-test 88 项资产的文件版）。ReMe 的 `_snapshot_digest`（mtime+size）证明文件指纹快照可行，但它只服务重试分类、无恢复路径——我们补上恢复。
- **决策溯源**：四步编排（scan→propose→apply→audit）借 ReMe auto_dream 四步（topics→extract→integrate→finish）的简化版；决策审计落盘直击源码核实的最大缺口（`DreamState` 建了不落盘、dsh 丢弃），日志形状参照 OpenViking `memory_diff.json`（可审计可回滚的变更 diff）与 moa trace jsonl 的 Tier 2 先例；发布门三问的评审协议借 loop 三行头信任门禁的精神（"只信审计过的状态"必须强制在操作里）；触发权归 dsh 承集成分析 §4.2 层级 2（推荐层级）与家族"权威边界=调度全在宿主缝"。

### 5.4 退场路径：retire（退场门，`exitMode: off|observe|enforce`）

扫描 `published/` 的 `use_count`/`last_accessed`（+version 陈旧度）：超阈（Config：`agingMinAgeDays`、`agingMinUseCount`）者 observe 下仅记入审计日志的候选清单；enforce 下移入 `archived/`（索引摘除）。**退场即移动文件**——文件权威使遗忘天然可逆（移回即复活），不删除任何字节。跨会话 `global` scope 的笔记需要更保守阈值（论文 local-by-default 的镜像：晋升快的退场慢）。

- **决策溯源**：五项管理策略中的 aging/importance demotion/forgetting（论文，[emergentmind 摘要](https://www.emergentmind.com/papers/2605.09998)列明；prime 产品化时完全未实现，源码与 README 双重证实）——本层是论文理念在 RLM 侧的主要增量；"移动而非删除"借文件权威形态（ReMe 承诺"文件始终由用户掌控"的推论）；observe-only 起步承 Heuriva 旋钮哲学。

## 6. 指引注入

会话启动注入一条简短指引（告知 `memory_search` 存在与用途），走 `agent.inject` + `source:{kind:'plugin', form:'instructions'}`——机制原样借 ReMe dsh 插件（`index.ts` agent/session-start → `agent.inject(createUserMessage(...))`，它本身即是 dsh 原生且满足"模型可见 ⟺ 已记日志"的现成先例）。措辞从简：只指路，不灌内容（hints-only 纪律）。

## 7. 家族契约符合性

`defineTool` 注册形态与 verify/moa/loop 同构；每次检索携带 sessionId、`purpose:'memory'` 归因；隐私三档语义一致；全部模型调用（capture 抽取、门禁评审、整编提案）走 `ctx.subagents`/`ctx.llm` 宿主缝，插件零独立凭据。持久面：capture/门禁结论挂 log-only 会话事件（Tier 1，进持久化目录+守卫 spec）；整编决策审计与 events.jsonl 为 Tier 2 dataDir 副产物（moa trace 同级定性）——与 REPLICATE.md 持久面契约的分级判据一致："当时为什么这么判断"在审计日志可回放，dataDir 不新增权威状态之外的任何东西。包内注册 `./invariant`（事件/数据关系检查，如"drafts 中的笔记必有可定位 source"）。新 Config 全部走校验 schema，无硬编码 tunable。

## 8. 设计决策溯源总表

| # | 决策 | 理念来源 | 借鉴来源（具体形态） |
|---|---|---|---|
| D1 | 原生扩展新插件，不接 ReMe 运行时 | 家族契约"模型调用走宿主缝"；集成分析 §3 双 LLM 问题 | 集成分析 §10 四路线排序（最省路线）；plugin-rlm-loop 薄插件先例 |
| D2 | 与 harness 分层：会话内路由状态 vs 跨会话知识资产 | QwenPaw P3.6"上下文与记忆两套管线"；论文 local-by-default | 集成分析 §10.1 能力对照表；边界="capture 输入取自已完成会话"（ReMe dsh bundle 同款） |
| D3 | 文件权威 Markdown + 派生索引可重建 | 论文 state outlives turn 的用户可控形态 | ReMe "Memory as File"；`FaissLocalFileStore` "chunk JSONL stays authoritative" |
| D4 | frontmatter 溯源字段（session_id/source_conversation/use_count/last_accessed/gate） | 论文 evidence-backed + aging 信号采集 | ReMe `auto_memory.py` 双字段+dialog jsonl（源码核实）；use 信号为本设计新增（论文 aging 落地） |
| D5 | capture 剥离工具结果 + rootAgentsOnly | 反污染：召回不得自我强化 | ReMe `_sanitize_msg_for_save`（:23-39，含原话理由）；ReMe dsh 插件 rootAgentsOnly |
| D6 | 证据门：source 必填且须在 dialog 原文中可定位 | 论文 "small, evidence-backed updates" | /refine FIX-8 evidence 必填 + validateProposals 白名单（已实现资产）；ReMe DreamUnit.paths |
| D7 | 决策审计落盘 logs/consolidation/*.jsonl | 家族持久面契约 Tier1/Tier2；"当时为什么这么判断"可回放 | ReMe `DreamState`（建了不落盘——反面教材，utils.py:25 证实）；OpenViking `memory_diff.json`；moa trace jsonl 先例 |
| D8 | memory_search 工具 + 时间索引常驻（双通道） | 论文 retrieval quality；hints-only 纪律 | 集成分析 §10.4 memory_search 设计；ReMe reme_search；prime 6/180/6000（已落地 P3-#3） |
| D9 | consolidation 四步 + 触发权全在宿主 | 集成分析 L2"dsh 托管生命周期"；论文 growth evaluation/dedup | ReMe auto_dream 四步简化；`_integration_lock` 单飞；watcher quiesce 的职责由宿主钩子天然承担 |
| D10 | 发布门 gateMode off\|observe\|enforce，默认 observe | 论文 trust/conservatism；Heuriva observe→enforce 旋钮 | loop 三行头信任门禁（complete/clean/aligned）；NEXT.md 使用密度判据；ReMe job 产物写 inbox 的提案区形状 |
| D11 | 反向快照回滚 /memory-rollback | 论文 refinement history + rollback | /refine 反向快照+RefinementEvent 管线（文件版套用）；ReMe `_snapshot_digest`（可行但无恢复——补全） |
| D12 | 退场=移动到 archived，永不删除 | 论文 aging/demotion/forgetting | 文件权威推论（ReMe"文件由用户掌控"）；seen_ttl 与记忆退场的区分（源码核实） |
| D13 | 指引走 agent.inject 插件消息 | 模型可见 ⟺ 已记日志 | ReMe dsh 插件 index.ts 的注入机制（dsh 原生合规先例） |

## 9. Config 面（草案）

`memoryDir`、`captureMode: off|sessionEnd|intervalTurns`、`captureIntervalTurns`、`rootAgentsOnly`、`privacyFilter: ''|display|full`、`recallTopK`、`recallMode: keyword|auto`、`language`、`gateMode`、`maxPublishedNotes`、`maxPublishedBytes`、`exitMode`、`agingMinAgeDays`、`agingMinUseCount`、`embeddingsProvider: off|external` 及 `embeddings*` 细分键（Phase E）。实现权威是 `src/index.ts` 的 `Config` schema（本节为设计草案，键名以代码为准）；无通用 TTL 键——退场由持有方语义决定（LIFETIME.md 租约 TTL 的同款裁决）。

## 10. 分阶段落地

| 阶段 | 内容 | 验收 |
|---|---|---|
| A 写路径 | 目录布局+frontmatter schema；capture（sanitize/rootAgentsOnly/证据门）+dialog 落盘；capture 会话事件+catalog 守卫；`/memory list|show|delete` | sanitize 单测；证据定位校验单测；审计 writer 单测；host-smoke 全链 |
| B 读路径 | 关键词倒排索引；`memory_search` 工具+use 信号；指引注入 | 索引可重建性测试（删索引重跑等价）；工具 schema 快照；命中信号单测 |
| C 演化 | consolidation 四步+单飞锁；发布门三分支；反向快照回滚；增长预算 | observe/enforce 分支真断言；回滚含"改过告警"用例（refine 同款）；预算触发单测 |
| D 退场 | 老化扫描+archived 移动+恢复 | observe 只记不动；enforce 移动可逆；global 阈值更保守的用例 |

阶段推进以 STATUS.md 登记为准；本文只钉设计与契约（LOOP.md 同款纪律）。

## 11. 与论文五项管理策略的对照（忠实度声明）

| 论文策略 | 本设计落点 | 阶段 |
|---|---|---|
| growth evaluation | 增长预算：超限轮只合并不新增 | C |
| retrieval quality | memory_search + 命中信号 + 只搜 published | B |
| dedup | 整编轮合并决策 + 标题/内容规范化去重 | C |
| aging/importance demotion | use_count/last_accessed + 阈值降级 | D |
| forgetting | archive 移动（可逆），永不物理删除 | D |

保留：论文"在线适应不动权重、经验固化为耐久状态"的完整能力。放弃：ReMe 的独立部署与自有模型栈（主动放弃，理由见 D1）；wikilink 图（推迟，非放弃，见 §2 非目标）。

## 12. 开放问题

1. **上游 embeddings 缝（已实现 = Phase E / T5.4，2026-08-30）**：dsh-llm 仍无 embeddings API（核实同前：`adapter.spec.ts:2224` 系测试用语，非向量接口）。决定**不在上游等**——按 dsh 能力缝三件套（Service Definition / Provider / Consumer）在 `plugin-rlm-memory` 内先接外部实现；dsh 原生缝到位后仅增一个 Provider + 翻 Config 默认值，Consumer 零改动。
   - **Service Definition**：包内定义 `EmbeddingService` 接口——`embed(texts: string[]): Promise<number[][]>` + `dim`/`model` 元数据；无 `any`。
   - **Provider A（现在）** `ExternalEmbeddingProvider`：走 **OpenAI 兼容** embeddings 协议——`POST {baseURL}/embeddings`，`baseURL` 为 OpenAI 兼容基址（含 API 路径，如 `https://api.openai.com/v1`），线上等于 `/v1/embeddings`；请求 `{ model, input: string[] }`，响应 `{ data: [{ embedding: number[] }] }`。`baseURL`/`apiKey`/`model` 走 Config（或从 `credentials` 服务读），绝不硬编码、绝不进仓库。该格式被 DeepSeek / Voyage / 多数厂商原生支持，故"换供应商"= 改 baseURL+key+model，零代码改动。默认 `embeddingsProvider: 'off'`，lexical BM25 永远兜底，现有行为不变绿。
   - **Provider B（将来）** `DshEmbeddingProvider`：包 `ctx.get('embeddings')`（dsh 一旦定义原生缝）；若原生缝也暴露 OpenAI 兼容面，则 Provider A 的 HTTP 客户端可直接复用（仅换 baseURL）。同一 `EmbeddingService` 接口。
   - **Consumer**：`search.ts` 改成 lexical BM25 + 向量相似度融合/rerank；`consolidate.ts` 的 Jaccard 去重、`retire.ts` 的 aging 后续可选择性用向量。把 `recallMode:'auto'` 的 warn-回退（`src/index.ts:174-180`）改为"provider≠off 走向量，否则 keyword"。`src/memory-search-tool.ts:77` 已留 closure 分支点，可直接接。
   - **迁移成本/约束（现在就铺）**：①存储缓存每 note embedding（`storage.ts` 加 `embeddings/` 缓存或 sidecar），索引重建优先读缓存，缺失时优雅降级；②确定性——外部向量跨模型轮换不确定，不进 keyless snapshot，测试用确定性 fake/local provider；③成本/延迟——在**写入**（capture/consolidate 批处理）时 embed，不在每次读取；④fail-loud——`embeddingsProvider:'external'` 但缺 key/endpoint 时加载即抛，不静默掉回 lexical（`'auto'` 才是优雅回退那条）。
   - **溯源**：非 ReMe/论文概念，是"等 dsh 原生前的过渡"；实现时代码注释 + 一条 Phase E Agent Note 标清（REME.md §8 D 风格）。
   - 注：本决策取代 §10.4 中"向量召回需先推上游 seam"的暂缓表述；§10.4 的"不引入任何本地嵌入依赖"仍成立（本方案接外部 API，不引入本地嵌入模型/依赖）。
2. **memoryDir 默认值**：`<dataDir>/memory`（全局、随 profile）vs 项目内目录（文件所有权卖点最大化、随仓库走）。倾向 Config 双轨 + 默认 dataDir，待首个真实使用场景裁决。
3. **门禁执行器选型**：评审子代理（便宜）vs verify PPT（更强但 K×(N-1) 次往返）——MOA.md 成本裁决的同款问题，默认前者，高风险知识库可配后者。
4. **模型驱动写入**：v1 写入面只有宿主管线；是否给模型 `memory_write` 类工具（经同一证据门）待真实需求出现再裁决（写入面越窄越安全的既定倾向）。
