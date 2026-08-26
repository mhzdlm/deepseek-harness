# Agent Note: Keyless contract tests close the two highest-value rlm coverage gaps

Status: implemented

English | [中文](2026-08-26-rlm-coverage-gap-closers.zh.md)

## Problem

The repo's per-file 100% coverage gate excludes `packages/rlm/*/src/**` while the family sits outside every shipped dependency closure, so rlm's correctness rests entirely on its own suites. The 2026-08-26 review found that its three heaviest defects each escaped through an untested seam: the persistence reload path, the seam-to-scoring stream contract, and the plugin mount path. Two of those seams stayed open after the fixes — nothing drove `callSeamModel`'s BlockAssembler consumption with realistic chunk shapes, and the T3.2 cap-eviction decision matrix still had one unreachable-by-tests branch (every kernel busy).

## Decision

Two keyless suites pin the open seams at their public entry points:

- `plugin-rlm-verifier/tests/seam-contract.spec.ts` mounts the real plugin via `apply()`, captures the registered tool, and feeds a fake `ctx.llm.stream` that emits true `StreamChunk` shapes (`block-start`/`text-delta`/`logprobs`/`block-end`/`finish`, one logprob entry per character). Pinned: verdict letters survive the whole chain into the ranking; every scoring call opts in with `logprobs: { topLogprobs: 20 }` and routes to the configured provider/model; and identical letters under wildly different verdict logprobs produce identical scores — the v1 single-alternative degeneration is a deliberate, tested semantic, so serving top-k variants later fails this suite on purpose.
- `plugin-rlm-kernel/tests/keep-alive.spec.ts` adds the last cap-eviction branch on the public path: when live kernels exceed `maxLiveKernels` and all of them are busy, `disposeIdle()` evicts nothing and forces no snapshot (busy is a hard exemption down to the probe level), and the pressure lands on the next cycle with an eligible LRU victim.

The fake judge in the seam suite is slot-aware by necessity: `scorePairOnSeam` swaps prompt slots on odd repetitions and maps rewards back, so a static reply votes for opposite candidates on alternating reps and averages every comparison to the 0.5/0.5 tie. Reading which candidate sits in each slot keeps all repetitions consistent.

## Alternatives considered

**Test callSeamModel as a unit.** Rejected: it is module-private, and exporting it for tests would widen the entry surface; driving the mounted tool exercises the identical consumption path plus routing.

**Mock the tournament instead of running it.** Rejected: the value of this suite is precisely that chunk shapes must survive into final rankings; mocking the consumer would re-create the gap it closes.

**Fold the all-busy case into the white-box grace-window test.** Rejected: existing T3.2 tests already reach into private state where needed; this branch is fully observable through `disposeIdle()`, and public-path assertions are what make it trustworthy.

## Consequences

The two escape hatches that let real defects ship green are closed at their exact joints, and the degeneration semantics are now executable documentation. Costs: the seam suite encodes the current chosen-token-only seam shape — an upstream change that surfaces variants will fail it, which is the intended trigger for a conscious revisit, but it does couple these tests to `StreamChunk` details. The all-busy test depends on `markBusy`/`markIdle` internals access already established by the file's harness.

## Testing

- `seam-contract.spec.ts`: 4 items, all green; full verifier package suite 34 keyless items green.
- `keep-alive.spec.ts`: 9 items, all green; T3.2 eviction matrix (LRU order, unleased-first, leased forced-snapshot success/failure/grace, pinned-vs-sweep, all-busy deferral) now fully exercised through public paths.
