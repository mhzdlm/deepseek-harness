# @deepseek-ai/dsh-client-ui-rlm

English | [中文](README.zh.md)

Web tool rows for the RLM `verify` and `moa` tools. Each row is a keyed `tool.call.toolview` over the durable call/result slice: a compact summary whose state reflects judge/reference degradation, plus a disclosure of the exact rendered output.

## Model Experience

### Verify and moa tool rows

#### What the model sees

The model sees nothing new from the row itself: the row reads only the frozen call/result slice from the `verify` and `moa` tools, so replay and refresh stay stable. Degradation is detected from the result text the host renderers already emit (`verify`: "N judge(s) degraded or failed (...)", `moa`: "N reference(s) failed (...)").

#### Token effect

The row adds zero model tokens; it is a pure client presentation over an already-emitted tool result.

#### KV Cache effect

Stateless in the request path: it renders from the durable call slice and never edits earlier request tokens.

### Lifecycle states

#### What the model sees

A running call shows an ongoing dot and "运行中"; a failed call shows the first error line with error styling; a stopped call shows the stopped state; the trajectory Inspect button opens the call when available.

#### Token effect

No tokens: the states are client-side projections of the tool-call lifecycle.

#### KV Cache effect

No request-token effect; the row never reaches the model.

## Known Limitations and Deferred Work

- The warning is text-derived from the renderer output, so it depends on the host tool renderers keeping the degradation markers in the result text; a future structured result projection would let the row read failed judge/reference fields without parsing text.
