# Agent Note: RLM kernel namespace hygiene persona guidance

Status: implemented

English | [中文](2026-08-26-rlm-namespace-hygiene-persona.zh.md)

## Problem

A persistent IPython kernel keeps `variables` and `imports` alive for the whole
session, so an RLM agent that runs many analysis batches accumulates scratch
names in the shared namespace. Each saved name appears in the snapshot manifest
and is serialized into the dill the session log must carry; transient names
therefore bloat both the manifest and the durable log, and make later inspection
of "what this session actually produced" noisier. The harness offers no automatic
cleanup because deleting names a later cell still needs is a real mistake risk.

## Decision

Add a short guidance paragraph to the `rlm` preset persona (the inline `text:`
of the `persona` row in `docs/recipes/agent-presets/rlm/agent.cordis.yml`):
after an analysis batch, `del` its scratch variables or scope the work inside a
function so locals do not leak; note that the snapshot manifest lists every saved
name, so accumulated transient names clutter it and enlarge the dill; and warn
against `del`-ing a name a later cell might still need. This is advisory only —
the kernel still never auto-deletes (the mistake risk the decision deliberately
avoids). `packages/rlm/plugin-rlm-verifier/tests/rlm-preset.spec.ts` pins the
guidance text in the mounted preset.

## Alternatives considered

- **Auto-delete scratch variables past a threshold** (the optional "超阈值告警"
  in the task). Rejected: the harness cannot know which names a later cell still
  depends on, so any automatic removal risks breaking in-flight work; the task
  itself marks auto-deletion out of scope for exactly this reason.
- **A manifest-driven warning when `savedNames` exceeds N.** Left as the
  optional follow-up the task names: it needs a threshold Config key and a
  diagnostic path, neither required for the hygiene guidance to land, and both
  belong with the broader T4.4/T4.5 error-surfacing work.

## Consequences

- Bought: the model now has explicit, in-prompt guidance to keep the shared
  kernel namespace tidy, reducing manifest and dill bloat from transient names.
- Cost: none at runtime — pure persona text; no code path, no new event, no
  config key. The snapshot manifest and dill semantics are unchanged.
