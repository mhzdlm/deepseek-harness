# RLM continual-harness automatic refinement (P0)

- **Decision**: Add an opt-in automatic refinement scheduler to
  `@deepseek-ai/dsh-plugin-continual-harness`, closing the "experience
  auto-crystallizes" loop that prime-agent reaches via `reviewAutoRefine` +
  `_maybeAutoRefine`. Refinement stays manually triggerable via `/refine`; the
  scheduler adds a turn-driven, review-gated automatic path.
- **What shipped**:
  - `src/refine.ts`: `registerAutoRefine(ctx, dataDir, config, autoRefine)`
    listens on `agent/status` and, on a root-agent turn completion (`status ===
    'idle'` while `ctx.agents.currentInitiator()` is `undefined`), increments a
    per-agent turn counter. When `turns % turnInterval === 0` and the cooldown
    gate passes, it runs an independent review LLM (`reviewAutoRefine`) and, only
    if `shouldRefine` is true, reuses the existing `runRefine` pipeline.
  - `reviewAutoRefine` is a new exported helper: a scoped subagent with an
    `outputSchema` of `{ shouldRefine: boolean; rationale: string }`.
  - Cooldown is stamped on **both** success and rejection (persisted to
    `<harnessDir>/<sessionId>/.auto-refine.json`), so a failing review cannot
    immediately re-trigger — mirroring prime's cooldown-on-failure.
  - Child agents are excluded (`currentInitiator() !== undefined`), matching
    prime's `_rlmDepth===0` rule so recursive `rlm.run` children never refine.
  - New `Config` keys: `autoRefine` (default false), `autoRefineTurnInterval`
    (default 12), `autoRefineCooldownMs` (default 600000). Defaults keep existing
    deployments manual-only until they opt in.
  - `docs/recipes/agent-presets/rlm/agent.cordis.yml`: `continual-harness`
    carries `autoRefine: false` with the interval/cooldown defaults.
- **Tests**: `refine-test.mts` adds six checks — review gate parse
  true/false, disabled registers no listener, enabled registers and fires
  `runRefine` exactly once after `turnInterval` root idle events, and child-agent
  idle events never trigger.
- **Why this shape**: prime's auto-refine is the half of its self-improving loop
  our `/refine` lacked. We reuse the proven `runRefine` CAS/validation/rollback
  pipeline rather than fork it, and gate with a separate cheap review LLM call so
  the expensive refine subagent only runs when warranted.
- **Deferred (P1/P2, recorded in
  `docs/research/prime-agent-rlm-gap-analysis.md`)**: compaction file-operation
  cross-round inheritance, split-turn summary, `<ipython_state_restored>` audit,
  `/refine` forced non-reasoning.
