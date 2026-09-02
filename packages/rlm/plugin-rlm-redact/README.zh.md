# @deepseek-ai/dsh-plugin-rlm-redact

[English](README.md) | 中文

RLM 家族共享的凭据/PII 参考文本脱敏。它不是 Cordis 插件——没有 `apply`，没有服务，没有配置。它是一个零依赖库，只导出一个脱敏器，让 `plugin-rlm-moa` 与 `plugin-rlm-verifier` 无需 import kernel 包（及其原生 zeromq 依赖链）即可对 advisor/候选文本打码。

## 导出

来自 `src/redact.ts`（包根再导出）：

- `redactReferenceText(text)` —— 对一段 advisor 文本做凭据形态材料加 email/带分隔符电话 PII 打码；非字符串输入原样通过。打码形态：PEM 私钥块、`sk-`/`pk-`/`rk-` 前缀密钥、GitHub token 家族（`ghp_`/`gho_`/`ghs_`/`ghr_`/`gpu_`）、JWT 三段式、`Authorization: bearer …` 值（保留 scheme）、以及 URL/连接串中的 `password=`/`pwd=`/`api_key=`/`token=`/`secret=` 等键值。
- `MOA_EMAIL_RE` —— email 模式，导出给需要自行组合脱敏流程的消费方。
- `MOA_PHONE_RE` —— 带格式电话模式；要求显式分隔符（括号区号或 `-`/`.` 分组），因此无分隔数字串、日期、时间、十六进制 id、点分四段地址永不命中。

模式安全性：advisor 文本常是代码评审形态（行号、SHA、IP、版本号），因此所有模式都要求强区分标记，绝不命中裸数字串。

## 消费方

- `plugin-rlm-moa`（`src/index.ts`）：`privacyFilter: 'full'` 时以 `redactReference` 接入 `moa` 工具——参考建议文本在进入聚合器与 trace 前被打码。
- `plugin-rlm-verifier`（`src/index.ts`）：同法接入 `verify` 工具——`privacyFilter: 'full'` 下候选摘要与 `<dataDir>/session-artifacts/` 下的持久化详情档案被打码。

`plugin-rlm-memory` 不消费本包；其捕获路径的 `privacyFilter: 'full'` 使用自带的极简打码流程。

## 状态

Phase D（2026-09-01）：家族共享的打码原语，刻意保持自包含，直到 harness 长出中心化 redactor（落地后再议）。家族总览见 [packages/rlm/README.md](../README.md)；家族级状态见文档仓 BUILD.md。
