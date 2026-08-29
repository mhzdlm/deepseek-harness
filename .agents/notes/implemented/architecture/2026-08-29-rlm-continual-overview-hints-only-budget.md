# RLM continual-harness overview budget: hints-only alignment (P3-#2)

- **Decision**: Align the harness-overview injection budget with prime-agent's
  hints-only philosophy. prime's injected overview caps at
  `DEFAULT_OVERVIEW_ENTRY_LIMIT=6` entries per kind and `CONTENT_LIMIT=180`
  chars per entry, surfacing only routing hints and forcing the model to read the
  underlying entry on demand. Our previous defaults (20 / 1000 / 16000) were far
  more generous and contradicted that intent.
- **What shipped** (`packages/rlm/plugin-continual-harness`):
  - `src/prompt.ts` `renderHarnessOverview` fallbacks changed from
    `20 / 1000 / 16000` to `6 / 180 / 6000`. The total ceiling (6000) bounds the
    four-kind routing index; across 4 kinds × 6 × ~180 + headers this matches
    prime's effective injected ceiling while leaving headroom for the model to
    locate entries by id.
  - `src/index.ts` `Config` schema gains explicit defaults
    `maxEntriesPerKind: z.natural().default(6)`,
    `maxCharsPerEntry: z.natural().default(180)`,
    `maxTotalChars: z.natural().default(6000)`, so the preset can override and
    the schema documents the intended hints-only shape. The per-turn
    `systemPrompt.section` injection and the `/refine` proposal prompt both route
    through `renderHarnessOverview`, so both surfaces now honor the cap.
  - `/harness show <id>` already lets the model read a full entry, so the tighter
    cap does not lose information — it only moves detail out of the per-turn
    context and behind an on-demand read.
- **Tests**: no new test; the budget is exercised by the existing
  `prompt.ts` rendering paths. The change is a default-value adjustment covered
  by the package's existing render tests when invoked without overrides.
- **Verification**: `pnpm --filter @deepseek-ai/dsh-plugin-continual-harness exec tsc -b` passes.
- **Why this shape**: prime deliberately keeps the injected harness small so the
  model treats it as an index, not a dump. Mirroring the 6/180 numbers keeps our
  reference implementation faithful to that spirit without inventing a new
  truncation policy.
