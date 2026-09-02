# @deepseek-ai/dsh-plugin-rlm-memory

[English](README.md) | 中文

RLM 跨会话记忆层。ReMe 的形态、Continual Harness 论文的证据纪律、dsh 的宿主自有主权。捕获是拾遗路径：已完成的根会话从 `session/event` 总线累积，脱敏（剥离工具结果），落盘到 `dialog/<id>.jsonl`，由宿主自有的抽取子代理提出草稿笔记、经证据定位门把关。召回是作用于 `published/` 的 `memory_search` 工具加 `agent/session-start` 的 hints-only 指引注入。自 Phase C 起，挂载 `rlm.store` 时 store 的 mailbox scope 是跨会话权威：`published/` Markdown 文件是它的投影，consolidate 把草稿晋升为 mailbox 中的 provisional 信念，人工改文件会被检测并回写为 `rlm/human-revision` 事件，新会话把 mailbox 提名取件为本会话的 PROVISIONAL 信念。Phase D 增加退休/归档（`exitMode`）与发布冻结锁。Phase E 增加可选的外部 embedding 缝（默认 `off`）。

## 配置

所有字段由 `Config` schema 校验；默认值在 `apply` 中显式解析。

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `memoryDir` | string | `~/.dsh/rlm/memory` | 记忆根目录；子目录 `published/ drafts/ archived/ dialog/ snapshots/ index/ logs/`。 |
| `captureMode` | `off \| sessionEnd \| intervalTurns` | `sessionEnd` | 何时捕获。`intervalTurns` 每 `captureIntervalTurns` 个 turn 落一次。 |
| `captureIntervalTurns` | natural | `16` | `intervalTurns` 模式的 turn 间隔。 |
| `captureTimeoutMs` | natural | `120000` | 抽取子代理的墙钟预算；超时则只落 dialog、不落草稿。 |
| `rootAgentsOnly` | boolean | `true` | 仅根（非子代理）会话进入捕获（REME.md §5.1 D5）。 |
| `privacyFilter` | `'' \| display \| full` | `''` | `full` 在 dialog jsonl 落盘前掩码凭据/PII 形态材料；`display` 被接受但尚无展示面。 |
| `recallTopK` | natural | `5` | `memory_search` 默认 top-K。 |
| `recallMode` | `keyword \| auto` | `keyword` | `auto` 且无 embedding provider 时降级到 keyword 并记一次日志。 |
| `language` | string | `en` | 会话开始提示语语言：`en` 或 `zh`。 |
| `gateMode` | `off \| observe \| enforce` | `observe` | 发布门（REME.md §5.3 D10）：`off` 不晋升；`observe` 晋升合格草稿（打标）；`enforce` 只晋升 `source` 能在其 dialog 中定位的草稿。 |
| `maxPublishedNotes` | natural | `200` | 增长预算：`published/` 笔记数上限，超过则跳过/拒绝晋升。 |
| `maxPublishedBytes` | natural | `5_000_000` | 增长预算：`published/` 总字节上限。 |
| `exitMode` | `off \| observe \| enforce` | `off` | 退休退出模式（REME.md §5.4 D12）：`off` 空转；`observe` 只记意图；`enforce` 移动 `published/` → `archived/`（可逆）。 |
| `agingMinAgeDays` | natural | `180` | 老化扫描：成为退休候选的最小年龄。 |
| `agingMinUseCount` | natural | `1` | `use_count` 达到此值的笔记永不退休。 |
| `embeddingsProvider` | `off \| external` | `off` | `external` 启用 OpenAI 兼容 provider；`memory_search` 走 `hybridSearch`，consolidate 在 `index/embeddings/` 缓存向量。缺 base URL/model/key 加载时响亮报错。 |
| `embeddingsBaseURL` / `embeddingsModel` | string | —（`external` 必填） | OpenAI 兼容 base URL（不含 `/embeddings` 后缀）与模型 id。 |
| `embeddingsApiKey` / `embeddingsApiKeyEnv` | string | — | provider 密钥，或读取密钥的环境变量名。 |
| `embeddingsDim` | natural | 推断 | 固定向量维度；缺省时取首个响应的长度。 |
| `embeddingsBatchSize` | natural | `32` | 每次 embeddings 请求的最大文本数。 |
| `embeddingsTimeoutMs` | natural | `30000` | 单次请求墙钟预算；超时召回降级为纯词法。 |

## 工具：`memory_search`

`memory_search(query, limit?, kind?)` 返回 top-K `published/` 笔记全文。关键词索引每次调用从 `published/` 在内存重建（永不持久化，因此不可能漂移）；每次命中递增 `use_count` 并更新 `last_accessed`，不动 `version`（Phase D 老化信号，REME.md §8 D4）。草稿与归档不进索引。`embeddingsProvider: 'external'` 时走 `hybridSearch`（词法 + 缓存余弦）。

## 命令：`/memory`

`/memory list | show <name> | delete <name>` —— 草稿笔记（delete 仅限草稿）。`/memory consolidate` —— 发布门 + 增长预算跑全部草稿；挂载 `rlm.store` 时晋升落为 mailbox 的 provisional 信念、`published/` 由投影重渲染（无 store 时退化为旧式直写文件）。`/memory rollback <noteId> [force]` —— 用最新快照覆盖已发布笔记（覆盖警告，除非 `force`）。`/memory retire <noteId> [force]` / `/memory archived` / `/memory unretire <noteId>` —— `exitMode` 门控下的 Phase D 退休。`/memory stats` —— 来自 `observeReport`/`renderObserveReport` 的观察级报告（需要 `rlm.store`）。`/memory criteria list | propose <id> <tier> <title> | approve <id> <tier> <title>` —— 判据修订轨：propose 把修订泊入 mailbox；approve 是仅人工的注册动作（需要 `rlm.store`）。

## 信箱面（Phase C/D，`src/mailbox.ts`）

挂载 `rlm.store` 时：`publishToMailbox` 先把发布记入 mailbox 流，再记会话侧移交记录；最新活跃 mailbox 信念为 `frozen` 的 subject 跳过发布（`frozenSkips`）——重新发布会绕过审计冻结。`syncMailboxProjection` 把 `published/` 渲染为 mailbox 视图的纯函数；`watchMailboxProjection` 在进程生命周期内监视该目录，`detectHumanRevisions` 把直接改文件转为 `rlm/human-revision` 事件（人工的语义豁免写仍走流）。`importLegacyNotes` 把 Phase C 之前的笔记以 human-revision 事件收编。`pickupMailboxSeeds` 把 mailbox 提名取件为新会话的 PROVISIONAL 信念并标注同主题冲突集，在 `agent/session-start` 注入一条 hints-only 提示。无 store 时所有信箱面退化为旧式直写文件行为，并一次性告警。

## 事件

`session/memory-captured`（仅日志）：每次捕获追加到被捕获会话的持久日志，携带 `sessionId`、`dialogTurns`、`draftsAdmitted`、`extractionRan`、`draftChars`。

## 已知限制与待办工作

- **内存中的捕获缓冲** —— 按会话累积在 `Map`；宿主中途重启丢失缓冲的 turn。持久产物是 `dialog/<id>.jsonl`。
- **索引每次调用重建** —— 关键词索引每次 `memory_search` 从 `published/` 派生；增量索引是优化项而非正确性要求。
- **老化扫描仅词法/使用次数** —— `scanAging` 结合 `use_count` 与新旧程度；确定性、无模型调用。
- **`privacyFilter: 'display'` 惰性** —— schema 接受，但没有消费来源标注的展示面；只有 `'full'` 做掩码。
- **Embedding 可选（默认 `off`）** —— DeepSeek 无 embeddings API，外部 provider 指向 OpenAI 兼容端点；未来 dsh 原生缝替换它时调用点不动（REME.md §12.1）。

## 状态

Phase D（2026-09-01）：家族记忆的权威面——捕获是拾遗路径，mailbox（经 `rlm.store`）是跨会话权威，`published/` 是其投影，冻结锁保证被审计信念在人工放行前不可再发布。家族总览见 [packages/rlm/README.md](../README.md)；家族级状态见文档仓 BUILD.md。
