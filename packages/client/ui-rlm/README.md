# @deepseek-ai/dsh-client-ui-rlm

Web tool rows for the RLM `verify` and `moa` tools. Each row is a keyed
`tool.call.toolview` over the durable call/result slice: a compact summary whose
state reflects judge/reference degradation, plus a disclosure of the exact
rendered output.

## Model Experience

- The row reads only the frozen call slice — no live service calls, so replay
  and refresh are stable.
- Degradation is detected from the result text the tool renderers already emit
  (`verify`: "N judge(s) degraded or failed (...)", `moa`: "N reference(s)
  failed (...)"). When present, the row shows a warning state and, on expand, a
  warning card naming the failed judges/references, above the full output.
- A running call shows an ongoing dot and "运行中"; a failed call shows the
  first error line with error styling; a stopped call shows the stopped state.
- The trajectory Inspect button opens the call when available.

## Known Limitations and Deferred Work

- The warning is text-derived from the renderer output, so it depends on the
  host tool renderers keeping the degradation markers in the result text. A
  future structured result projection would let the row read failed
  judge/reference fields without parsing text.
