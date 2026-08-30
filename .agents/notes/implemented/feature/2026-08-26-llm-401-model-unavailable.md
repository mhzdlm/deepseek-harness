# Agent Note: T4.9 — 401 error classification escalation (MODEL_UNAVAILABLE)

Status: implemented

- **Date**: 2026-08-26
- **Status**: 已实现（真实样本校准后落地）
- **Area**: `packages/llm/llm/src/error.ts`（新增 code 常量）、`packages/llm/llm-pi-ai/src/stream.ts`（分类）、`packages/client/runtime/src/client/sessions/failure-display.ts`（GUI 显示）
- **Symptom**: `ox-alpha-free` 模型下架后，opencode 网关返回 HTTP 401；GUI 把它渲染成 "API key is invalid"，用户误以为自己的 key 坏了。

## Problem

opencode 网关对"模型下架/不存在"返回 HTTP 401（与 key 无效共用状态码）。`llm-pi-ai/src/stream.ts` 的 `classifyPiAiError` 用 `/\b(?:401|403)\b/` 把任何 401 消息归为 `AUTH`；`failure-display.ts` 把所有 `AUTH` 渲染成 "API key is invalid"（防凭据回显的安全设计）。结果是模型问题被误报成 key 问题。

**真根因是分类错误**（401 ≠ 永远 AUTH），GUI 对 `AUTH` 的掩码本身正确。

## 真实样本（代码截取，非人工探针）

用 `~/.dsh/tools/scan-session-errors.mjs` 全量扫描 110 个会话日志，从 `session-b99fde54` 截取到真实失败：

```
401: {"type":"ModelError","message":"Model ox-alpha-free is not supported"}
```

- opencode 返回 HTTP 401，body 是 Anthropic 风格结构化错误 `{"type":"ModelError","message":"Model X is not supported"}`；pi-ai 展平为 `401: {...}`。
- 同会话另一失败是 `503: {"type":"server_error","message":"...Endpoint is unavailable."}` —— 503 本就归 `SERVER`，不受本次改动影响。
- 若干会话的 `deprecated` 信号是用户/文档文本，不是错误消息（detail 提取确认无 msg）。

**关键校准点**：真实措辞是 "is not supported"，不是 "deprecated/not found/unavailable"。盲写保守正则会命不中——先截取再校准避免了。

## Decision

### 1. 新增 code（`llm/src/error.ts`）
`MODEL_UNAVAILABLE_CODE = 'MODEL_UNAVAILABLE'`：请求的模型在此路由上不被服务（缺失/未知/已下架），与 `AUTH`（凭据问题）明确区分。JSDoc 说明 opencode 网关对下架模型答 401、且该 code 终态不可重试。

### 2. 分类（`llm-pi-ai/src/stream.ts`）
新增 `isModelUnavailableMessage()`（函数式，**不用 `regex || regex`**——JS 里 `||` 对正则字面量坍缩为第一个真值操作数，会静默丢弃其余分支；这是本次修复踩到的坑）。在 `401|403 → AUTH` 之前：
```js
if (/\b(?:401|403)\b/.test(message) && isModelUnavailableMessage(message)) return MODEL_UNAVAILABLE_CODE
```
判据（任一命中）：
- `"type":"ModelError"`（Anthropic/opencode 结构化错误类型）；
- `model … not supported` 措辞；
- `model not found` / `unknown model` / `model does not exist` / `no longer available` / `is deprecated` / `not available` 措辞。

纯 "bad key" 401（无模型措辞）仍归 `AUTH`（安全默认）。

### 3. GUI 显示（`client/runtime/src/client/sessions/failure-display.ts`）
`MODEL_UNAVAILABLE` → "Model unavailable or deprecated on this provider"（无凭据回显风险，安全）。`AUTH` → "API key is invalid" 不变。

### 4. Retry
`MODEL_UNAVAILABLE` 不在 `retryableCodes` 白名单 → 自动不可重试（与 `AUTH` 一致）。无需改 retry。

## Consequences

- 收益：`MODEL_UNAVAILABLE` 成为与 `AUTH` 明确区分的终态 code；GUI 以不回显凭据的文案呈现，且不可自动重试（与 `AUTH` 一致）。
- 代价：新增一个 code 常量与 `stream.ts` 中的小分类函数；`AUTH` 掩码与重试契约不变。

## Verification

- `llm-pi-ai/tests/convert.spec.ts`：真实样本（`401: {"type":"ModelError",...}` → `MODEL_UNAVAILABLE`）+ 措辞变体（`401: model "claude-3" is deprecated` → `MODEL_UNAVAILABLE`）+ 对照组 `HTTP 401: bad key` → `AUTH` 不变。
- `client/runtime/tests/failure-display.client.spec.ts`（**新增**，原函数零覆盖）：`AUTH` 掩码、`MODEL_UNAVAILABLE` 文案、其余 code 回退 `message`、非对象回退 `String`、无 message 对象回退 JSON。
- 结果：`llm`+`llm-pi-ai` 481/481、`failure-display` 5/5；`llm`/`llm-pi-ai`/`client-runtime` typecheck 通过。

## 工具

新增 `~/.dsh/tools/scan-session-errors.mjs`（零依赖只读）：遍历 `~/.dsh/sessions/` 解压全部会话（多帧 zstd），统计 `AUTH`/`finish-error`/`401`/`ox-alpha`/`deprecated`/`model-not-found` 出现次数定位失败会话；`--detail <id>` 提取含模型不可用/认证措辞的 `message` 值去重 + AUTH 上下文。用于 T4.9 采样，亦可复用为通用失败会话体检。

## 后续：T4.5 ① 完整文案映射（同一机制扩展，2026-08-26）

`displayFailureMessage` 从"仅 AUTH/MODEL_UNAVAILABLE 专用"扩展为**完整文案表** `FAILURE_COPY`（`packages/client/runtime/src/client/sessions/failure-display.ts`）：每个已编目 LLM 错误码 → 固定中文文案 + 一句处置建议；未知 code 回退原始 `message`。

**先统计后写文案**（避免盲写）：扩展 `~/.dsh/tools/scan-session-errors.mjs` 加 `--codes`，全量扫 110 会话统计真实 code 分布：
```
SERVER=500(12会话)  TRANSPORT=94(11)  RATE_LIMIT=94(2)  PI_AI_ERROR=18(4)
AUTH=8(2)  ABORTED=6(4)  INVALID_REQUEST=6(2)  TIMEOUT=4(2)  QUOTA=2(1)  CONTEXT_WINDOW_EXCEEDED=1(1)
```
- **SERVER/TRANSPORT 最频发**——处置提示优先（"稍后重试"/"检查网络"）。
- 6 个未观测 code（`STREAM_CLOSED`/`EMPTY_RESPONSE`/`MALFORMED_RESPONSE`/`NO_ADAPTER`/`INVALID_CREDENTIAL`/`MODEL_UNAVAILABLE`）也给了文案（未来可能触发）；`MODEL_UNAVAILABLE` 是 T4.9 新增，历史统计自然无（旧 401 全被归 AUTH）。

文案表（中文，`AUTH`/`INVALID_CREDENTIAL` 掩码防凭据回显）： `AUTH`→"API key 无效或已过期，请检查凭据设置"；`MODEL_UNAVAILABLE`→"模型不可用或已下架，请更换模型"；`QUOTA`→"账户额度不足，请检查余额或配额"；`RATE_LIMIT`→"请求过于频繁，请稍后重试"；`CONTEXT_WINDOW_EXCEEDED`→"上下文超出模型容量上限，请精简或压缩对话"；`INVALID_REQUEST`→"请求参数无效，请检查请求内容"；`SERVER`→"模型服务端错误，请稍后重试"；`TIMEOUT`→"请求超时，请稍后重试"；`TRANSPORT`→"网络或连接异常，请检查网络后重试"；`STREAM_CLOSED`→"响应流意外中断，请重试"；`EMPTY_RESPONSE`→"模型返回了空响应，请重试"；`MALFORMED_RESPONSE`→"模型响应格式异常，请重试"；`PI_AI_ERROR`→"模型网关返回未知错误，请重试"；`NO_ADAPTER`→"未配置该模型的适配器，请检查模型路由"；`INVALID_CREDENTIAL`→"凭据格式无效，请更正后重试"。

**为什么这一步不需要真实返回信息**（与 T4.9 本质不同）：T4.9 修的是**分类**（判据藏在消息文本里，需样本校准）；T4.5 ① 消费的是**分类结果**（`failure.code` 稳定枚举），文案映射是 code→文案的纯函数，输入是 code 而非消息文本——甚至应避免解析消息文本（不稳定、可能含凭据，同掩码理由）。分布统计只为"覆盖真实触发过的 code + 聚焦处置提示"，不决定文案内容。

**同步改动**：
- `failure-display.ts` 重写为 `FAILURE_COPY` 表 + 兜底（索引访问取值判 undefined，避免 strict 下 `string | undefined`）。
- `tests/failure-display.client.spec.ts`：扩为全表覆盖 + 兜底。
- `ui-conversation/tests/chat-view.client.spec.tsx`、`conversation-node-definitions.client.spec.ts`：AUTH/TRANSPORT 断言同步为新中文文案。
- `runtime/README.md`/`README.zh.md`：投影描述从"AUTH 替换为 API key is invalid"更新为"全 code 映射 + AUTH/INVALID_CREDENTIAL 掩码"。
- 验证：runtime + ui-conversation 836/836、typecheck 过。

## Alternatives considered

- 不改 `failure-display.ts` 的 `AUTH`/`INVALID_CREDENTIAL` 掩码语义（凭据安全，正确）。
- 不新增独立事件类型（`finish.failure.code` 是既有 chunk 内的字符串值，无需 persistence catalog 重生成）。
- 不把 503 `server_error`（Endpoint unavailable）纳入 `MODEL_UNAVAILABLE`——那是上游/网络问题，归 `SERVER` 语义更准确。
- **T4.5 ③**（verify `failedJudges` / moa `failedLabels` 警示块）仍待 shell/web 渲染层（数据已在事件 payload 与工具结果，缺口是 UI 高亮）。
