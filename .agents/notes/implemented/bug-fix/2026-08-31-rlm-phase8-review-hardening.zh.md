# Agent Note: RLM Phase 8 审查加固批（T8.1–T8.17）

Status: implemented

[English](2026-08-31-rlm-phase8-review-hardening.md) | 中文
## Problem

第六轮交叉审查（五份独立 AI 审查报告，先逐条判真伪再动手）发现一个关键接线缺陷、两个承重契约缺口，以及一批此前各轮全部漏掉的健壮性缺陷：

- `DEFAULT_MAX_LIVE_KERNELS = 4` 定义后从未被使用——未配置的部署**完全没有存活内核上限**，而 INSTALL/LIFETIME 记载"默认 4"。
- verify 输出 schema 设了 `additionalProperties: false` 却未声明 `failedJudges`，而降级评委路径确实会把它附在工具结果上——任何一次评委降级都会被宿主输出校验器拒掉、整个 verify 炸掉。单测直调 `execute` 绕过宿主校验，45/45 全绿掩盖了它。
- ReDoS 守卫只检查**第一个**量化组、也不归一化字符类：`(ab)+(a+)+` 整体放行，`((a)+)+`（指数级：26 个输入字符 8.6 秒）不在覆盖范围。
- continual-harness 的构建产物 import 了 memory 包的 `src/search.ts`——纯 Node 无法加载的指示符——而且就在警告过该反模式的那个文件里。
- 长尾一批：prompt 装配回调无异常兜底、verify 扇出既无墙钟预算也无规模上限、`llm.query` 桥无会话中止通道、memory slug 对中文塌缩、published 路径跨会话碰撞、provision/disposeAll 进程泄漏、`import_name` 可覆写内核自身的 `rlm` 运行时绑定、frontmatter 引号往返令每次召回反斜杠翻倍、`/memory unretire` 命令层拒绝一切输入形态等（完整清单见 NEXT.md Phase 8）。

## Decision

一个工作树提交同时落地此前未提交的 Phase 7 实现（T7.3–T7.13：调用面超时、preset-store 错误分类、memory 生命周期与审计诚实、内核正确性批、`llm.query` 桥、`rlm_dag` 技能与质量门、召回注入 observe、vitest 迁移）与 Phase 8 修复（NEXT.md 的 T8.1–T8.17）。关键耐久决策：

- **默认值必须接线，不许只是摆设**：`enforceLiveCap` 回退 `DEFAULT_MAX_LIVE_KERNELS`；本轮新增的每个治理旋钮（`maxSubcallPromptChars`、`maxCandidates`、`maxEvaluations`、`maxAutoSpawn`、`verifyTimeoutMs`）同时进 Config interface、schema 与 INSTALL.md，越界值响亮报错而非静默降级（`gate_score` 修复是模板：配错的门绝不允许悄悄停止把关）。
- **宿主会校验工具输出，即使包测试不经过**：`failedJudges` 已入 schema，新增的 verifier 测试把降级结果跑过 `validateJsonSchemaValue`——钉住的是宿主层契约，不只是引擎行为。
- **ReDoS 守卫看结构，不做形状枚举**：平衡括号扫描把每个量词归属到其包裹组，unbounded 量词作用于"含量化/交替/嵌套组"的组即拒；字符类先折叠为单个原子。有界形态（`(1|2)?`、`(ab)+`、`(\w+)@…`、`.*error.*failed`）保持放行。
- **兄弟插件经包的编译入口导入**：memory 从根入口 re-export `search`/`hybridSearch`/`SearchHit`（kernel `redactReferenceText` 先例），harness 改走包根并补 memory 的 tsconfig 项目引用；跨包 `src/*.ts` 指示符从此只允许出现在测试文件。
- **memory 身份按会话区分**：published 路径带 8 字符会话后缀（`turn-0-<sid8>.md`），两会话的"第 0 轮笔记"不再互相覆盖；内容级去重（`dedupTarget`）仍是合并机制。slug 保留 Unicode 字母（中文标题不再塌缩为 `note`）。dialog 持久化改累计式（读-合-写），`turn:N` 证据在 `intervalTurns` 多窗之后仍可解析，提取器消费的累计文本与门校验同源。
- **consolidate 锁是排队不是 join**：每个调用者拿自己的结果（原 join 会把第二个草稿报成 promoted 而其文件操作从未执行）、去重目标锁内重算、锁为进程级全局——每次晋升本就要扫共享的 `published/` 树。
- **回滚诚实**：`restoreSnapshot` 把快照 mtime 带回被恢复文件，第二次 rollback 不再误报"用户改过"；去重覆盖保留 `created_at`/`use_count`/`last_accessed`，高频笔记不再被静默 rejuvenate 成退场候选。

文档同行：NEXT.md Phase 8（T8.1–T8.17 + 延后裁决）、STATUS 测试统计（414 keyless/venv + 15 real-key e2e）与已知限制更新、INSTALL 配置表（补 11 个缺失键、retained 计入措辞）、DEPLOY 包表（+memory/+compaction）、MOA 成本公式（N + k(N−k) + C(k,2)）、LOOP 回滚措辞、audit 计数 49→45 同步、README 索引修复、moa README 双语重写。

## Verification

keyless/venv 全量：414 全绿（kernel 158、verifier 48、moa 39、memory 100、loop 19、compaction 10、harness 40），含 17 项 Phase 8 新测试（ReDoS 组/字符类用例、llm.query 中止与 prompt 上限、failedJudges 宿主 schema 校验、gate fail-loud、候选池上限、moa 调用方中止传播、以及专钉本轮修复的 memory `phase8-fixes.spec.ts`：CJK slug、会话区分路径、累计 dialog、引号往返、快照唯一性、二次回滚 mtime、unretire 解析、零 `use_count` 退场）。typecheck RLM 侧零错误；vendor 审计 45/45。ReDoS 重写除断言外做了实测：爆炸形态在守卫处被拒，常见 grep 形态 1 万字符 ≤52ms。

## Alternatives considered

**Phase 7 与 Phase 8 拆成两个提交。** 否决：两批改动在同一批文件内交织（llm.query 桥与它的 Phase 8 中止通道在相邻代码块），按文件拆分只能制造未验证的中间树。单提交保证每个提交状态都是验证过的状态。

**`llm.query` 批级预算（整批 deadline = N × 单次超时）。** 延后：单次超时 + 新增的会话中止通道已封住无界计费口子；整批 deadline 是否需要属 R1 语义裁决（LAYERS.md §2.2），应跟真实使用数据一起裁，与批内并行是同一条裁决线。

**内容哈希草稿文件名（替代保留 Unicode 的 slug）。** 否决：草稿身份有意采用内容前缀以保持重抽取稳定（T6.19）；在前缀里保留 CJK 精准修复实际缺陷（中文标题塌缩为 `note`），且不改变身份方案。

**validate 阶段校验 harness `evidence` 是否真在 transcript 中。** 延后（NEXT.md 8C）：完整闭环需要 transcript 反查 + 注入围栏；observe 门"证存在不证真实"是已记载的属性，不是本批可以悄悄改变的意外。

## Consequences

文档记载的安全包络从此按构造成立：存活内核上限默认 4 生效、verify 无法无界计费、销毁的会话停止子调用计费、配错的门响亮报错。memory 对 CJK 与多会话部署可信（无静默覆盖），降级的 verify 带具名失败通过宿主校验。成本与残余（有意记录在案）：Phase 7 的两处 ✅ 汇总仍部分超前（loop T6.17 六子项落地 1/6——查重这半由本批补上；`deleteEmbedding` 接线由本批经 `archiveNote` 补上）；hybrid 检索对单汉字查询仍返回空（T7.8 延后项——零词元返回空是 T6.7 的验收本身，不是回归）；多评委 verify 的 Borda 序数与均分 gate 口径错位按语义裁决记录、待 dogfood 数据而非当 bug 修；harness 源码改动后必须重跑构建，否则 `lib/types` 相对 `src/` 过期（本批修掉的陈旧 bundle 失败模式已记载于 NEXT.md 8A/T8.4）。
