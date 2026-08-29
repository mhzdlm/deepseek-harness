# RLM split-turn compaction provider (P1-B)

- **Decision**: Implement prime-agent's `TURN_PREFIX_SUMMARIZATION_PROMPT` behavior
  (split-turn prefix summary) for RLM as a **dedicated provider**, not as a change
  to the shared `@deepseek-ai/dsh-compaction-basic` package. The user required that
  the official package stay untouched ("不要和官方混在一起"). Only RLM mounts this
  provider.
- **What shipped**:
  - New package `packages/rlm/plugin-rlm-compaction`
    (`@deepseek-ai/dsh-plugin-rlm-compaction`) with `RlmSplitTurnCompactionEngine
    extends BasicCompactionEngine`. It overrides **only** the documented sole hook
    `summarize()`, inheriting the trigger policy, retention, the durable
    `compaction/start`–`compaction/end` transaction, and the
    `toolPairingBalancedBefore/After` cut alignment unchanged.
  - `src/split-turn-summarizer.ts`: `buildRlmInstruction` appends a `## Turn Prefix`
    section when the replayed region begins mid-assistant-turn (first message role
    is `assistant`), and always carries the `## Files Touched` section with the
    cross-round `PREVIOUS FILES TOUCHED` hint (P1-A parity, kept local so the RLM
    provider does not regress). `parseRlmSummary` decodes both sections from the
    model output. `summarizeRlm` reuses the official replay-aware prefix-cache
    protocol (`ctx.llm.stream`, `purpose: 'compaction'`, provider/model resolved via
    `conversationTarget` → `agent.options`), and does **not** import any private
    symbol from `compaction-basic` — guaranteeing the isolation.
  - `docs/recipes/agent-presets/rlm/agent.cordis.yml`: the `compaction` isolate
    group now mounts `@deepseek-ai/dsh-plugin-rlm-compaction` instead of
    `@deepseek-ai/dsh-compaction-basic`; `command-compact` and `tool-result-pruner`
    remain in the same realm and consume `ctx.compaction` (now the RLM subclass)
    without changes.
  - `package.json` / `tsconfig.json` / `src/invariant.ts` / `README.md` follow the
    dsh package conventions; `pnpm install` registers the workspace symlink.
- **Tests**: `tests/rlm-compaction.spec.ts` (7 checks) — instruction contains
  `## Turn Prefix` only when mid-turn, always contains `## Files Touched` and the
  `PREVIOUS FILES TOUCHED` hint, `parseRlmSummary` decodes both sections, and the
  prompt passed to `ctx.llm.stream` is inspected for the mid-turn branch.
- **Why this shape**: `selectCompactableRange` aligns cuts to tool-pairing, so a cut
  never breaks a step, but a long single-turn analysis batch can still be cut
  mid-turn; prime preserves that turn's opening via a prefix summary. Subclassing
  the single `summarize` hook delivers exactly that without touching shared core,
  and keeps `command-compact` / `tool-result-pruner` working unchanged.
- **Limitations / deferred**: mid-turn detection is heuristic (first replayed
  message role === `assistant`). A precise "cut inside a turn" signal would require
  extending `SummarizationInput` in `compaction-basic`, which this package avoids.
- **Recorded in** `docs/research/prime-agent-rlm-gap-analysis.md` (P1 section).
