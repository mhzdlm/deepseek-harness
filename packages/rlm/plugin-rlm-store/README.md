# @deepseek-ai/dsh-plugin-rlm-store

English | [中文](README.zh.md)

Unified storage core of the rlm family: per-scope append-only event streams, their materialized views, and the judgment channel, exposed as the `rlm.store` Cordis service. It is the dependency-graph root — it imports no other rlm package, and the other seven consume this service. `append` is the single write path for non-judgment events; `judge` is the single write path for `rlm/judgment`; the `state.json` file is a cache the stream's writer updates, never the authority — `rebuild` regenerates the view from the stream.

## Config

| Config | Type | Default | Description |
|---|---|---|---|
| `dataDir` | string | `~/.dsh/rlm` | Family artifact root; the store's scope streams live under `<dataDir>/store/<scope>/events.jsonl`. Must match the other rlm plugins' `dataDir`. |

The escort-mechanism thresholds are `RlmStore` constructor options, not plugin config: `internalClockDistance` (verification-to-head event distance, default 256) and `densityAlarmActions` (non-judgment actions before the density alarm locks promotion, default 50). The shipped plugin instance runs with these defaults.

## Service: `rlm.store`

`apply` provides one `RlmStore` instance seeded with the base criteria (`withBaseCriteria`). Scopes of authority: `{ kind: 'session', id }` and `{ kind: 'mailbox' }`.

Main surface (mirrors `src/store.ts`): `append(scope, type, payload)`, `judge(scope, input)`, `rebuild(scope)` / `ensureLoaded(scope)`, `view(scope)`, `beliefs(scope)` (active only), `getBelief(scope, id)`, `registerCriterion` / `listCriteria()`, `onChange(listener)` (projection consumers subscribe here), `readEvents(scope)` (strict full-stream read), `replayNominations(scope)` (untruncated trigger-6 history), `evaluateFreshness` / `enforceFreshness`, `recordWorldReconciliation`, `executeRollback`, `checkClosureInvariant`, `alarmState`. Errors: `RlmStoreFormatError` (stream unreadable / catalog violation), `RlmJudgmentError` (a judgment failed a formal requirement).

## Event vocabulary

Seven event types (`RLM_EVENT_TYPES`): `rlm/observation`, `rlm/mechanical`, `rlm/action-boundary`, `rlm/judgment`, `rlm/handoff`, `rlm/rollback`, `rlm/human-revision`; the scope-legality matrix lives in `src/catalog.ts`.

Fifteen verdict forms (`RLM_VERDICT_FORMS`): `conclusion`, `selection`, `completion`, `merge`, `promotion`, `demotion`, `voiding`, `rollback`, `unpin`, `experience`, `handoff-nomination`, `check-pass`, `check-doubt`, plus the Phase D audit pair `freeze` / `unfreeze`. Creating verdicts carry a `belief` payload; `demotion`/`voiding`/`rollback`/`freeze`/`unfreeze` carry a `target`; `check-doubt`/`unpin` are event-only. Belief grades: `provisional` / `evidenced`.

The judgment channel enforces the four formal requirements (criterion registered and tier-consistent, data support, legal verdict form, provenance locatable in the stream) plus the tier gate: `open`-tier criteria can never promote to `evidenced`.

## Criteria

Tiers (`RLM_CRITERION_TIERS`): `deterministic` > `structured` > `open`. The shipped base set (`BASE_CRITERIA` in `src/criteria.ts`, 11 entries): `crit/loop-three-line-header`, `crit/evidence-gate-locatable`, `crit/refine-whitelist` (deterministic); `crit/verify-eq31-tournament`, `crit/audit-pass`, `crit/audit-freeze`, `crit/audit-release`, `crit/audit-objection` (structured); `crit/moa-aggregator`, `crit/kernel-harness-write` (open). A judgment referencing an unregistered criterion is refused.

## Freeze lock (Phase D)

A `freeze` judgment locks a live belief's trust-gate eligibility: while a belief is `frozen`, `judge` refuses any `promotion`/`merge` whose `supersedes.id` or `basedOn` edges touch it (re-publishing would route around the audit freeze). `freeze` requires a live target; only a `frozen` belief accepts `unfreeze`. The reverse-filtering pipeline lives in `src/audit.ts`: `runAudit` (independent critic + procedural arbiter; outcomes `pass` / `objection-accepted` / `objection-rejected-frozen` / `skipped`), `listFrozenForReview` (the batch human-review queue), `releaseAuditFreeze` (human release landing the `unfreeze` judgment). Observe-grade statistics are recomputed from the stream by `observeReport` / `renderObserveReport` (`src/observe.ts`); consumed by `/memory stats`.

## Status

Phase D (2026-09-01): the store is the family's single write authority — producers judge into it, projections render from it, the audit freeze gates trust on top of it. Family overview: [packages/rlm/README.md](../README.md); family-level status: see BUILD.md in the docs repo.
