# Agent Note: Plugin session events must be in the generated persistence catalog

Status: implemented

English | [中文](2026-08-26-rlm-session-events-persistence-catalog.zh.md)

## Problem

The rlm judgment plugins append log-only process events (`session/verify-request|result`, `session/moa-reference|synthesis`, `session/loop-start|round-done`) through `Session.append()`. That API builds the event envelope itself and offers no way to set the `ignorable` marker, while the persistence read path refuses any log containing an event type outside the generated `KNOWN_SESSION_EVENT_TYPES` unless that event is marked ignorable. The six types were declared via module augmentation but never added to the generated catalog, so any session whose log contained one of them — including runs written by the very build that shipped the events — refused to reload. The staleness was invisible to every rlm test because none exercised a persist-and-reload round trip, and the repo's own freshness gate (`verify-persistence-catalog`) was red on the commits that introduced the events.

## Decision

Every in-repo `SessionEventMap` member the rlm plugins declare is registered in the generated catalog: `pnpm run gen-persistence-catalog` regenerates `packages/core/session/src/known-event-types.ts` and `docs/persistence-catalog.md`, which now include the six event types. Each emitting package owns a guard spec (`tests/persistence-catalog.spec.ts`) asserting that its exported event-type tuple (`VERIFY_EVENT_TYPES` / `MOA_EVENT_TYPES` / `LOOP_EVENT_TYPES`, also used as the `emit*Event` parameter union) is contained in `KNOWN_SESSION_EVENT_TYPES`; adding an event without regenerating the catalog now fails that package's suite instead of shipping an unloadable session format. The emit signatures derive from the tuples, so the declarations have one home per package.

The catalog module is imported by relative path from the guard specs because the rlm packages sit outside every consumer's dependency closure; a workspace-name import would resolve to a stale built `lib/` or fail outright.

## Alternatives considered

**Mark the events ignorable at the call site.** Rejected: `Session.append()` constructs the envelope internally and accepts no ignorable option — there is no writer-side entry point; only tests and the sqlite reader can produce such envelopes today.

**Give plugin packages their own registration surface.** Deferred upstream: the generated-catalog header explicitly defers an out-of-repo registration surface until such a consumer exists; these packages are in-repo, where regeneration is the sanctioned path.

**Rely on session-persistence's contract tests alone.** Rejected: those tests cover the refusal mechanism generically with fixture types; nothing tied the rlm vocabulary to the catalog, which is exactly the gap that let this ship.

## Consequences

Sessions that use verify/moa/loop reload again under the same build. The cost is a maintenance pairing: a new process event requires running one generator command, and forgetting it fails the emitting package's own suite rather than surfacing as an unloadable user session. The guard imports across package trees by relative path, which is unusual for this repository but deliberate until the dependency closure exists.

## Testing

- `plugin-rlm-verifier/tests/persistence-catalog.spec.ts`, `plugin-rlm-moa/tests/persistence-catalog.spec.ts`, `plugin-rlm-loop/tests/persistence-catalog.spec.ts`: one containment assertion each over the emitted vocabulary.
- `pnpm run verify-persistence-catalog` green on HEAD.
