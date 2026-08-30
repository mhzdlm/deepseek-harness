# @deepseek-ai/dsh-plugin-rlm-memory

[English](README.md) | 中文

RLM 跨会话记忆层——Phase A（写路径）+ Phase B（召回）+ Phase C（演化）+ Phase D（退场/归档）+ Phase E（嵌入缝）。ReMe 的文件权威形态、Continual Harness 论文的证据/审计纪律、dsh 的宿主主权。Phase A 捕获已结束的 root 会话：净化转写（剥离工具结果）、落盘 `dialog/<id>.jsonl`、派宿主自有抽取子代理，其草案笔记须过证据定位门才进入 `drafts/`，并追加 log-only 的 `session/memory-captured` 会话事件。Phase B 新增 `memory_search` 工具（作用于 `published/`，内存关键词/BM25 式索引每次调用从文件重建，永不漂移），回写每条命中的 `use_count`/`last_accessed` 老化信号，并注入 hints-only 的 `agent/session-start` 指引消息。Phase C（REME.md §5.3）新增发布门（`gateMode` off|observe|enforce）、在增长预算下将草案晋升到 `published/` 的确定性整编、防并发覆盖的单飞锁，以及带 harness 式改过告警的反向快照回滚（`/memory rollback`）。Phase D（REME.md §5.4）新增按 `use_count` + 时间新近性给 `published/` 笔记评分的老化扫描，与可逆的 `archived/` 移动（`/memory retire` / `/memory unretire`，受 `exitMode` off|observe|enforce 门控）——知识库不过期腐化，退场永不是删除。Phase E（REME.md §12.1）新增可选嵌入缝：`EmbeddingService` 接口 + OpenAI 兼容 `ExternalEmbeddingProvider`（默认 `off`）；配置 `embeddingsProvider: 'external'` 时 `memory_search` 将缓存余弦相似度与关键词索引融合（`hybridSearch`），整编将每条晋升笔记的向量缓存到 `index/embeddings/`。命令面：`/memory list | show | delete | consolidate | rollback <noteId> [force] | retire <noteId> [force] | archived | unretire <noteId>`。

## Config

全部字段为经校验的 `Config`（schemastery）；无硬编码 tunable。默认值在 `apply` 中显式解析，从不藏在 `??` 后面。

| 字段 | 类型 | 默认 | 含义 |
|---|---|---|---|
| `memoryDir` | string | `~/.dsh/rlm/memory` | 记忆根目录；子目录 `published/ drafts/ archived/ dialog/ index/ logs/` 在首次捕获时创建。 |
| `captureMode` | `off \| sessionEnd \| intervalTurns` | `sessionEnd` | 捕获时机。`off` 关闭写路径；`sessionEnd` 在 `session/disposed` 时冲刷；`intervalTurns` 为周期捕获预留钩子（Phase A 仅落地 `sessionEnd`）。 |
| `captureIntervalTurns` | natural | `16` | `intervalTurns` 模式的轮间隔（预留；尚未接入周期定时器）。 |
| `rootAgentsOnly` | boolean | `true` | 仅 root（非子代理）会话进入捕获（REME.md §5.1 D5）。 |
| `privacyFilter` | `'' \| display \| full` | `''` | `full` 在 dialog jsonl 落盘前掩码凭据/PII 形态内容；`display` 被接受但 Phase A 无展示面。 |
| `recallTopK` | natural | `5` | `memory_search` 默认返回的 top-K（REME.md §9/§10 Phase B 验收）。 |
| `recallMode` | `keyword \| auto` | `keyword` | 召回模式。为 Phase E（REME.md §12.1）预留，今日并非选择器：路径由 `embeddingsProvider` 决定——`external` 走 `hybridSearch`，否则关键词。`auto` 且无 provider 时记一次性降级日志。 |
| `language` | string | `en` | session-start 提示语言：`en` 或 `zh`。 |
| `gateMode` | `off \| observe \| enforce` | `observe` | Phase C 发布门（REME.md §5.3 D10）：`off` 不晋升（logged no-op）；`observe` 晋升每条合格草案并标记 gate `'observe'`（缺有效 `source` 也不阻塞）；`enforce` 仅晋升 `source` 能经 `admitByEvidence` 在其 `dialog` 中定位的草案（REME.md §5.1 D6），其余拒绝（留为草案并写 `rejected_at`/`rejection`）。 |
| `maxPublishedNotes` | natural | `200` | Phase C 增长预算：`published/` 笔记数达到上限后，新晋升被跳过（`observe`）或拒绝（`enforce`）（REME.md §5.3 D2）。 |
| `maxPublishedBytes` | natural | `5_000_000` | Phase C 增长预算：`published/` 总字节达到上限后，新晋升被跳过/拒绝（REME.md §5.3 D2）。 |
| `exitMode` | `off \| observe \| enforce` | `off` | Phase D 退场模式（REME.md §5.4 D12）：`off` no-op（笔记永不退场）；`observe` 记录退场意图但不移动笔记；`enforce` 将 `published/` → `archived/`（可经 `unretire` 还原）。默认 `off` 刻意保守——部署者不显式启用就什么都不退场。 |
| `agingMinAgeDays` | natural | `180` | Phase D 老化扫描：`published/` 笔记按 `last_accessed`/`updated_at` 计需早于该天数才成为退场候选（REME.md §5.4/§9——刻意取高，正常使用永不触发退场）。 |
| `agingMinUseCount` | natural | `1` | Phase D 老化扫描：`use_count` 低于该值的笔记是退场候选（REME.md §5.4/§9——用过一次的笔记永不退场）。 |
| `embeddingsProvider` | `off \| external` | `off` | Phase E 嵌入缝（REME.md §12.1）：`off` 保持纯关键词/BM25 召回（默认；无网络、无缓存）。`external` 启用 OpenAI 兼容 `ExternalEmbeddingProvider`：`memory_search` 跑 `hybridSearch`（词法 + 缓存余弦），整编将每条晋升笔记的向量缓存到 `index/embeddings/`。需要 `embeddingsBaseURL`、`embeddingsModel` 与 `embeddingsApiKey`/`embeddingsApiKeyEnv`；缺任一在加载时响亮报错。 |
| `embeddingsBaseURL` | string | —（`external` 时必填） | OpenAI 兼容 base URL（如 `https://api.openai.com/v1`）；`embeddings` 路径由实现追加，此处不要带 `/embeddings`。 |
| `embeddingsApiKey` | string | — | Provider API key。优先用 `embeddingsApiKeyEnv` 避免密钥进 cordis.yml；`external` 下两者必须提供其一。 |
| `embeddingsApiKeyEnv` | string | — | 存放 provider key 的环境变量名（如 `EMBEDDINGS_API_KEY`）；加载时读取一次。 |
| `embeddingsModel` | string | —（`external` 时必填） | 作为 OpenAI `model` 字段传入的嵌入模型 id。 |
| `embeddingsDim` | natural | 推断 | 期望向量维度；缺省时取首个 provider 响应的长度。显式提供可跳过缓存首条笔记时的预热推断。 |
| `embeddingsBatchSize` | natural | `32` | 每次 provider 请求的文本数；`hybridSearch`/`consolidate` 按此尺寸分块。 |

## Events

`session/memory-captured`（log-only，`MEMORY_EVENT_TYPES = ['session/memory-captured']`）：每次捕获追加到被捕获会话的持久化日志，携带 `sessionId`、`dialogTurns`、`draftsAdmitted`、`extractionRan`、`draftChars`。注册于 `SessionEventMap`；任何变更后须重新生成 persistence catalog（`pnpm run gen-persistence-catalog`）。

## Commands

`/memory list` — 全部草案笔记（kind/scope + 证据 `source`）。
`/memory show <name>` — 单条草案的完整 frontmatter + 正文。
`/memory delete <name>` — 删除一条草案笔记。已发布笔记不可删除，只能经反向快照回滚降级。
`/memory consolidate` — 对全部草案运行 Phase C 发布门 + 增长预算，晋升合格草案到 `published/`（对被覆盖笔记先拍反向快照）并移除已消费草案（REME.md §5.3）。
`/memory rollback <noteId> [force]` — 用最新 `snapshots/<noteId>/<iso>.md` 还原已发布笔记。若发布笔记在上次快照后被编辑过（用户/外部编辑），返回改过告警且不带 `force` 不覆盖（REME.md §5.3 D11，借用 harness `writeHarnessStates` 改过告警纪律）。
`/memory retire <noteId> [force]` — 退场一条已发布笔记（REME.md §5.4 D12）：`exitMode: off` 下为 logged no-op；`observe` 下记意图但不移动；`enforce` 下移动 `published/` → `archived/`（字节保留，可逆）。`force` 为显式用户退场绕过年龄/使用阈值（仅 enforce）。
`/memory archived` — 列出 `archived/` 下全部已退场笔记及其 `retired_at` 时间与 kind/scope。
`/memory unretire <noteId>` — 将已退场笔记移回 `published/`（REME.md §5.4 D12，"退场可逆"）；清除 `retired_at` 并重新进入召回索引。

## Storage layout

```
<memoryDir>/
  published/<kind>/<slug>.md   # Phase B recall scope; search reads ONLY here (publish-gate semantics, REME.md §5.2 D8)
  drafts/<kind>/<slug>.md      # admitted draft notes (evidence-gated); not indexed by recall
  archived/<kind>/<slug>.md    # Phase D retire target: moved (never deleted) published notes, reversible via /memory unretire (REME.md §5.4 D12)
  dialog/<sessionId>.jsonl     # sanitized captured conversation (tool results stripped)
  snapshots/<relPath>/<iso>.md # Phase C reverse-snapshot store; one timestamped prior version per published note, restored by /memory rollback (REME.md §5.3 D11)
  index/                       # keyword index is NOT persisted — rebuilt from published/ each call (REME.md §5.2). `index/embeddings/` IS written when `embeddingsProvider: 'external'`: one `<relPath>.json` cached vector per promoted note (Phase E, REME.md §12.1).
  logs/                        # Phase C consolidation audit (not written in Phase A)
```

每条笔记是 YAML frontmatter Markdown。frontmatter 溯源字段（`session_id`、`source_conversation`）借 ReMe `auto_memory.py _ensure_session_frontmatter`；`source` 是证据门产物，必须能在所引 `dialog/<id>.jsonl` 内定位（REME.md §5.1 D6）。

## Phase C/D evolution

- **Phase C** — 整编四步（scan→propose→apply→audit）+ 发布门 + 反向快照回滚；`published/` 是晋升目标（REME.md §5.3）。
- **Phase D** — 退场/归档：已实现。`scanAging` 按 `use_count` + 时间新近性给 `published/` 笔记评分（无 LLM、无 embeddings——评分确定性，REME.md §12 Q1 将 embeddings 留作开放问题）；`retireNote`/`unretireNote` 在 `published/` ⇄ `archived/` 间移动（永不删除），受 `exitMode` off|observe|enforce 门控，默认保守（exitMode:off、agingMinAgeDays:180、agingMinUseCount:1）保证正常使用永不退场（REME.md §5.4 D12）。

## Storage read path (Phase B)

`memory_search(query, limit?, kind?)` 返回 top-K 已发布笔记全文（标题、路径、分数、正文）。索引每次调用从 `published/` 内存重建（`search.ts` 的 `buildIndex`）：`term -> Set<noteId>`，覆盖标题+正文，分词为小写 ASCII 词（长度 ≥ 2）与 CJK 字符二元组，中英混查可命中。分数 = Σ tf × idf（BM25 平滑 idf：`log(1 + (N - n + 0.5)/(n + 0.5))`），按分数降序再 `updated_at` 降序（确定性、稳定）。关键词索引是可派生工件、从不持久化，删除后重跑逐字节等价（REME.md §5.2/§10 Phase B 验收）。每次命中工具重写笔记 frontmatter：`use_count` 自增、`last_accessed` 置为当前，不递增 `version`（内容身份而非访问记录）——即 Phase D 老化信号（REME.md §8 D4）。草案与归档不进索引（发布门语义，REME.md §5.2 D8）。

## Model Experience

### 模型看到什么

Phase B 将 `memory_search` 工具加入模型可见工具面。`agent/session-start` 时插件注入一条 hints-only 指引消息（`source: { kind: 'plugin', plugin: 'plugin-rlm-memory', form: 'instructions' }`）指向 `memory_search`——只点名工具与用途，不倾倒任何笔记内容（hints-only 纪律，prime 6/180/6000）。召回结果是指入会话日志的普通工具结果，从不进 system prompt。continual-harness 时间索引概览仍是"最近记了什么"通道；`memory_search` 是"现在什么相关"通道（双通道召回，REME.md §5.2 D8）。

### Token 影响

`memory_search` 以工具结果返回笔记全文，成本随 `recallTopK` 与命中笔记体量伸缩。session-start 指引是一条短消息。harness 时间索引概览不变。

### KV Cache 影响

指引消息是每会话的固定短前缀；`memory_search` 结果是普通工具结果轮次，走 agent loop 常规工具调用缓存行为。召回不重塑任何其他前缀。

## Known Limitations and Deferred Work

- **内存态捕获缓冲** — 每会话轮次累积在按 session id 键控的 `Map` 中；会话中途宿主重启丢失缓冲轮次。持久化工件是 disposal 时写出的 `dialog/<id>.jsonl`。持久化-backed 缓冲是 Phase C 扩展点。
- **嵌入为可选项（默认关）** — Phase E 增加 `EmbeddingService` 缝与 OpenAI 兼容 `ExternalEmbeddingProvider`，但 `embeddingsProvider` 默认 `off`，出货行为仍是关键词/BM25 召回（无网络、无缓存）。配置 `embeddingsProvider: 'external'` 并提供 `embeddingsBaseURL`、`embeddingsModel` 与 key 后，`memory_search` 将缓存余弦相似度与关键词索引融合（`hybridSearch`），整编为每条晋升笔记在 `index/embeddings/` 下写一个向量。只要设了 `external` 融合即生效（不受 `recallMode` 门控）；`recallMode: 'auto'` 无 provider 仅记一次性降级。DeepSeek 无 embeddings API，external provider 指向 OpenAI 兼容端点。该缝是 Phase E 过渡实现：将来 dsh 原生 `Embedding` 能力（`packages/core`）应在不触碰调用点的前提下替换 `external`（REME.md §12.1）。
- **索引每次调用重建** — 关键词索引每次 `memory_search` 从 `published/` 派生；大规模知识库下增量/常驻索引（布局中预留的 `index/` 目录）是 Phase C/D 优化项，非正确性需求。
- **Phase D 老化扫描仅词法/使用计数** — `scanAging` 组合 `use_count` 与 `last_accessed`/`updated_at` 新近性；不用语义 embeddings（REME.md §12 开放问题 1——无 dsh embeddings 缝）。仅当早于 `agingMinAgeDays` 且 `use_count < agingMinUseCount` 才是退场候选。评分确定性且有单测，非模型调用。
- **`intervalTurns` 模式预留** — `captureIntervalTurns` 与周期定时器已规格化但未接线；Phase A 仅出货 `sessionEnd` 捕获。
- **`privacyFilter: 'display'` 惰性** — schema 接受，但 Phase A 无消费溯源标签的展示面；仅 `'full'` 执行掩码。
- **工具无 `purpose`** — `defineTool`（packages/core/tools/src/schema.ts `DefineToolOptions`）不接受 `purpose` 字段，`memory_search` 无法携带 REME.md §5.2 设想的 `purpose: 'memory'` 归因。工具 `name` 仍经宿主自有缝路由。
