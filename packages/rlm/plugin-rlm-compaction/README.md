# @deepseek-ai/dsh-plugin-rlm-compaction

English | [中文](README.zh.md)

RLM-specific compaction provider. A `BasicCompactionEngine` subclass that keeps
the official replay-aware, tool-pairing-aligned compaction transaction unchanged
but swaps in a **split-turn-aware summarizer** (P1-B) and a **Files Touched
cross-round carry** (P1-A) — both implemented entirely in this package, so the
shared `@deepseek-ai/dsh-compaction-basic` package stays byte-for-byte unmodified.

## Why a separate provider

`compaction-basic` is the shared compaction backend for every preset. The
split-turn prefix summary and the Files Touched cross-round carry change only the
*summarization prompt*, not the cut-point algorithm or the durable transaction,
so they belong in a dedicated provider rather than in the shared package. This
package depends on `compaction-basic` as a consumer (subclass) and overrides its
single documented hook, `summarize()`.

## Behavior

- **Inherited, unchanged**: trigger policy (`auto`/`thresholdRatio`/`retainTokens`),
  retention, the durable `compaction/start`–`compaction/end` transaction, and the
  `toolPairingBalancedBefore`/`After` cut alignment.
- **Split-turn prefix (P1-B)**: when the condensed region begins mid-assistant-turn
  (its first replayed message is an `assistant` continuation), the summary
  instruction adds a `## Turn Prefix` section so the model records what the
  in-progress turn was doing before the cut — prime's
  `TURN_PREFIX_SUMMARIZATION_PROMPT` behavior.
- **Files Touched cross-round carry (P1-A)**: the summary instruction always
  carries a `## Files Touched` section; `priorFilesTouched(session)` scans the
  session's own durable `compaction/summary` log for the most recent section and
  feeds it back as a `PREVIOUS FILES TOUCHED` hint, so later summaries inherit the
  cumulative read/modified file context (prime's `readFiles`/`modifiedFiles`). This
  keeps RLM's file-context continuity without touching the shared package.

## Model Experience

The summarizer reuses the conversation's own system prompt, tool schemas, and
messages as the request prefix (KV-cache alignment), then appends the RLM
instruction. The instruction is maintained independently of
`compaction-basic`'s internal constant and does not import any private symbol
from that package.

## Known Limitations and Deferred Work

- The split-turn detection is heuristic: it triggers when the region's first
  message is an `assistant` role. A precise "cut inside a turn" signal would
  require extending `SummarizationInput` in `compaction-basic`, which this
  package deliberately avoids.
- This provider is an alternative to `compaction-basic`, not a replacement for
  other presets. Only RLM mounts it.
