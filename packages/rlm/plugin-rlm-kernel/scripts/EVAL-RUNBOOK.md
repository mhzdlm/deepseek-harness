# T7.11 评估电池 · 运行手册

> LAYERS.md §5 / NEXT.md T7.11：手动评估工具的第一块电池。本手册 + `eval-battery.json` +
> `eval-report-template.md` + `eval-log-query.mts` 四件套构成完整评估链路。
> **只手动，不 CI（R3）**；需要真实 `DEEPSEEK_API_KEY` 的机器，本仓库开发机（Windows、无 key）不执行。

## 前置

- 机器具备：`DEEPSEEK_API_KEY`（仓库根 `.env` 亦可）、Node ≥ 24、pnpm。
- `pnpm install` 完成（电池不依赖 venv；任务不涉内核执行）。
- 评估变量：`kernel.maxRecursionDepth`（Phase 10 新增 Config，默认 2）= 0 / 1 / 2 三档——
  这正是「递归优于不递归是否成立（在 DeepSeek 上）」的自变量。

## 步骤（每个任务 × 每档 depth 各跑一次）

1. 为每次运行建独立工作目录（会话日志落在 `<cwd>/.sessions/`，互不污染）：
   ```sh
   RUN=<abs-path>/batteries/$(date +%Y%m%d)-d<DEPTH>-<TASK_ID>
   mkdir -p "$RUN"
   ```
2. 在该目录下以 rlm preset 无头启动，把任务 prompt 作为用户输入（复用
   `rlm-headless-real.e2e.ts` 的装配方式；depth 档位经 kernel Config 注入）：
   - depth=0：`maxRecursionDepth=0`（llm.query 桥对子调用响亮拒绝——退化为「纯根对话」基线）
   - depth=1 / 2：同名键设 1 / 2
3. 运行结束后把最终回答存 `$RUN/answer.md`，判定 solved：
   逐条核对 `eval-battery.json` 的 `expect` 锚点是否出现在回答或其引用的文件结论中
   （人工辅助判定，判定结果记入报告模板）。
4. 五源统计不需要读回答——直接跑查询脚本：
   ```sh
   npx tsx packages/rlm/plugin-rlm-kernel/scripts/eval-log-query.mts "$RUN/.sessions" --json > "$RUN/eval.json"
   ```
   人体可读版去掉 `--json`。日志为 zstd 压缩时脚本自动解压。
5. 把 `eval.json` 的数字与 solved 判定填进 `eval-report-template.md`。

## 报告要回答的四个问题（批评优先级对应）

1. **递归优于不递归？** depth=0/1/2 的 solved 率对照（优先级 7；论文结论是模型相关的，
   DeepSeek 无数据，这是第一份）。
2. **长尾有多长？** 每次 run 的 subcall `answerChars`/`durationMs` 的 median vs p95 vs max——
   单次护栏全部合规时总账烧穿的速度（优先级 2 的证据）。
3. **降档省成本？** 若同时采集 subcallModel 变体，对照两档的成本/质量（后续批次）。
4. **预算门定多少？** 用实测分布给 `maxSessionSubcalls`/`maxSessionSubcallChars` 的默认值定标。

## 纪律

- 结果无论好坏都进 `eval-report-<date>.md`，与代码同 commit 归档；**self-skip 不构成验收**
  （STATUS.md 验收纪律），没跑就明说没跑。
- 电池任务与 `expect` 锚点改动须同步 bump `eval-battery.json` 的 `version`。
