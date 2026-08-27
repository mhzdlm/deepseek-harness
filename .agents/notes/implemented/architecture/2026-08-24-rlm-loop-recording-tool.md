# Agent Note: 2026-08-24 — rlm-loop: a recording tool, not an autonomous supervisor

Status: implemented

## Problem

LongHorizon-Harness analysis (see the operator's `docs/LOOP.md`) suggested porting its Manage→Execute→Audit loop into dsh. The tempting shape is a supervisor plugin: `loop.start(task)` drives rounds autonomously, spawning manager/executor/auditor children host-side. We built the opposite: `plugin-rlm-loop` is a recording tool, and the joining session stays the Manager.

## Decision

- The main session plans each round itself; executor/auditor episodes ride composition-level named instances of `dsh-tool-subagent` (`toolName: executor` / `auditor`, one-shot). The plugin never spawns children.
- The `loop` tool owns only what must not depend on model compliance: strict three-line audit-header parsing, the clean/complete/aligned trust gate, `session/loop-start|round-done` log-only events, and CAS landing of contract + verified progress into continual-harness state.
- Verified progress rides the existing `memory` kind under `loop/<runId>/...` entry ids. No new `HarnessKind` values.

## Why

A persistent Manager with harness-injected state beats per-round cold managers here: verified facts live in harness entries, raw trajectories stay in child sessions, so parent context grows by distilled reports only — LongHorizon's ledger-rebuild machinery becomes unnecessary while conversation continuity (follow-up turns continuing a finished run) comes free.

New kinds would touch continual-harness's kind union, render pipeline, and `/refine` whitelist — its refinement logic is upstream-derived IP we deliberately do not reshape for convenience. The id convention buys injection and rollback for zero cross-package surgery.

## Alternatives considered

- No autonomous overnight runs from one `begin` call; orchestration costs one model turn per round. Acceptable: rounds are minutes, not hours, in this CLI-only phase.
- The run registry is in-memory; after a process restart `status` is empty even though events and state files remain authoritative.

## Consequences

- 收益：loop 作为"录制工具"交付，加入会话即 Manager；严格的三行审计头解析、clean/complete/aligned 信任门、log-only 事件与契约+已验证进度的 CAS 落盘全部集中在 `loop` 工具内，绝不自主派生子进程。
- 代价：不支持一次 `begin` 的隔夜自主运行（每轮耗一个模型回合）；运行注册表在内存（重启后 `status` 为空，但事件与状态文件仍权威）；CLI-only 阶段接受该编排成本。

## Verification

- `parseAuditHeader` rejects out-of-order lines, off-enum values, prose before the header, and non-normalized case (the lowercase normalization bug was caught by test, not review).
- Tool tests cover: contract landing, clean-audit progress landing, dirty-verdict refusal, unparseable-header refusal, `done` rejection without clean audit, missing-note warning, CAS-file assertions against real temp dirs.

## Phase A evidence carried into this design

- Auditor child isolation must use `toolFilter.allow` ([read, glob, grep]): deny lists break cross-platform because shell tool names are platform-gated (win32 has no `bash` row) and `tools.restrict()` fails loud on unknown names — four consecutive auditor spawn failures in the Phase A headless run before the fix.
