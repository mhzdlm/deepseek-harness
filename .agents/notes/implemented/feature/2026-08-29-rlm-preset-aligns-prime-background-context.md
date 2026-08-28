# Agent Note: RLM preset mounts compaction, schedule, and goal to match Prime's non-blocking long-task surface

Status: implemented

English | [中文](2026-08-29-rlm-preset-aligns-prime-background-context.zh.md)

## Problem

The `rlm` preset (`docs/recipes/agent-presets/rlm/agent.cordis.yml`) shipped only
the `rlm-stack` group — `plugin-rlm-kernel`, `plugin-rlm-verifier`,
`plugin-continual-harness`, `plugin-rlm-moa`. Its persona already claimed a
compactor "runs at turn boundaries" and instructed a "non-blocking control loop",
but the preset mounted **no** `compaction` plugin, so the claim was unbacked: a
long or recursive rlm session never auto-compressed and would overflow its
context window. It also mounted no `schedule` or `goal` surface, so the agent
could not re-enter itself on a timer (Prime's `rlm_heartbeat` / scheduled
prompts) nor drive work from a persistent goal (Prime's persistent goals +
autonomous mode). Prime Agent's non-blocking long-task story rests on exactly
these three: automatic compaction, daemon/heartbeat/scheduled re-entry, and
persistent goals — the `rlm()` async child (which our kernel already provides
natively) is only one of the three.

## Decision

Mount the three missing surfaces into the `rlm` preset, mirroring how the
shipped `standard` preset wires them:

- **compaction** — a group behind `isolate: { compaction: true, toolResultPruner: true }`
  holding `compaction-basic`, `command-compact`, and `tool-result-pruner`
  (`thresholdChars: 8192`, `headChars: 4096`, `tailChars: 1024`). The pruner's
  truncation mirrors Prime's "truncate tool output before summarizing"; ours uses
  an 8192/4096/1024 budget — same mechanism, larger window. `tokenMeter` stays
  host-plane (the group resolves that one instance).
- **goal** — `command-goal` + `tool-goal` as loose rows; the `goals` service and
  session driver remain host-plane, exactly as in `standard`.
- **schedule** — `time-context` + `schedule` as loose rows, mirroring
  `apps/cli/config/examples/schedule/cordis.yml`; the schedule service is
  host-plane.

The mount test (`packages/rlm/plugin-rlm-verifier/tests/rlm-preset.spec.ts`)
now loads the `tokenMeter`, `sessionPersistence`, and `goals` host providers in
its harness and asserts the `compaction` service, the `schedule_create` tool,
and the `goals` service are live after mounting.

## Alternatives considered

- **Mount only `compaction` (minimal).** Rejected after the user chose full
  alignment: `schedule` and `goal` are the other two legs of Prime's non-blocking
  long-task surface, and a research session that can self-schedule and pursue a
  persistent goal behaves markedly closer to Prime than one that can only spawn
  async children.
- **Vendor Prime's own compaction instead of `compaction-basic`.** Rejected: our
  `compaction-basic` already matches Prime's mechanism (threshold trigger at the
  context window, cut at turn boundaries, structured checkpoint summary,
  iterative merge of the prior summary) and adds the tool-result pruner; adopting
  Prime's prompt-only logic would be a step backward.
- **Leave `schedule`/`goal` out because `standard` does not ship them.** Rejected
  as a non-sequitur for this preset: `standard` omits `schedule` (it is an
  opt-in overlay) and `goal` is host-provided there, but the `rlm` research
  preset explicitly targets long autonomous work where those surfaces earn their
  place.

## Consequences

- Bought: the `rlm` agent now auto-compacts (long/recursive sessions no longer
  overflow silently), can re-enter itself on a timer, and can pursue a persistent
  goal. Together with the already-native async `rlm()` child, this closes the
  spirit gap with Prime's non-blocking long-task model that the persona alignment
  note described.
- Cost: the preset pulls three more host services into its mount closure
  (`tokenMeter`, `sessionPersistence`, `goals`); the mount test now provisions
  them. No runtime cost beyond what those services already cost in `standard`.
- Verified in a real-session headless e2e
  (`packages/rlm/plugin-rlm-verifier/tests/rlm-headless-real.e2e.ts`): compaction
  preserves the IPython kernel state — the dill snapshot is independent of the
  compacted transcript, and a seeded `x = 42` survives a mid-flight pressure
  compaction; schedule re-enters the session at its due time; and a goal drives
  same-session autonomous continuation.
- Cross-reference: extends the persona-spirit alignment in
  [rlm persona aligns with prime base-prompt spirit](../feature/2026-08-29-rlm-persona-prime-base-spirit.md);
  the compaction wiring follows the
  [standard preset](../presets/standard/agent.cordis.yml).
