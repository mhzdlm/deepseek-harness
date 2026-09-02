# 评估报告 · <YYYY-MM-DD>

> 电池版本：`eval-battery.json` v1 · 模型：`<model>` · 机器：`<cpu/ram/os>` · key：DeepSeek
> 每个 `<task> × <depth>` 一行；`solved` 依据 `eval-battery.json` 的 `expect` 锚点人工辅助判定。
> 数字来源：`eval-log-query.mts --json`。空档写「未跑」，不写 0。

## 单格结果

| task | depth | solved | subcall calls | answerChars median | answerChars p95 | answerChars max | durationMs median | durationMs max | root tokens in/out | 备注 |
|---|---|---|---|---|---|---|---|---|---|---|
| b01-batch-cap | 0 | — | | | | | | | | |
| b01-batch-cap | 1 | — | | | | | | | | |
| b01-batch-cap | 2 | — | | | | | | | | |
| … | | | | | | | | | | |

## 按档汇总（solved 率 + 成本分布）

| depth | solved/total | subcall calls 中位数 | answerChars p95 | durationMs max | 截断率 | 退化批次 |
|---|---|---|---|---|---|---|
| 0 | | | | | | |
| 1 | | | | | | |
| 2 | | | | | | |

## 结论（照抄纪律：好坏都写）

1. **递归收益曲线（DeepSeek）**：<depth=0/1/2 对照结论；与论文 Qwen3-Coder（depth=0 反胜）/
   GPT-5（高 depth 胜）形状比较>。
2. **长尾观察**：<p95/max 与中位数的比值；「单次合规、总账烧穿」是否出现；对
   `maxSessionSubcalls`/`maxSessionSubcallChars` 默认值的定标建议>。
3. **意外发现**：<任何与预期相反的结果，含失败 run 的 transcript 摘引>。

## 原始数据

- `eval.json` 文件清单：<paths>
- 判定记录：<谁、何时、依据哪个锚点>
