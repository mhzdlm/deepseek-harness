# Agent Note: The rlm family bounds model-driven resource use

Status: implemented

English | [中文](2026-08-26-rlm-hardening-sweep.zh.md)

## Problem

The 2026-08-26 review found a cluster of places where a model-driven loop could spend unbounded host resources or silently lose data: `rlm.run` accepted unlimited prompts and spawned unlimited concurrent children per session; `session.query` grep compiled a model-supplied regex over an unbounded transcript with no evaluation bound; the idle sweep discarded its own promise, so one throwing snapshot became a recurring unhandled rejection; interrupt recovery warned about double-execution but stayed silent about namespace rollback; and the skill collector joined hand-editable harness ids straight into filesystem paths handed to `uv pip install`.

## Decision

Five shipped bounds, each failing loud or degrading visibly rather than silently:

- **Fan-out governors** (`rlm.run`): new Config keys `maxChildrenPerSession` (default 8, outstanding one-shot children per parent session; retained exempt) and `maxRunPromptChars` (default 24000). Exceeding either throws actionable text at spawn time.
- **Bounded grep**: patterns over 200 characters are rejected; chronological regex scanning stops at a 400k-character rendered-text budget and marks the result `truncated`. V8 cannot time out backtracking, so input volume is the bound that holds.
- **Follow-ups address retained children only**: `rlm.message`'s service-listing fallback now accepts continuable rows exclusively — messaging a one-shot run failed downstream anyway.
- **Recovery warning states rollback**: the interrupt-retry prefix now says the namespace was restored from the last snapshot, so changes made by the interrupted attempt may be absent (alongside the existing double-run risk and the `[lost: …]` restore notice).
- **Skill-id path safety**: `collectPythonSkills` rejects non-slug entry ids (`^[a-z][a-z0-9-]*$`, shared with `create_python_skill`) into a reported `invalid` list instead of joining them into paths; traversal-shaped ids from a hand-edited state file never reach `uv pip install`.
- **Sweep containment**: the idle-sweep timer catches its own rejections and warns, so one bad cycle cannot recur as an unhandled rejection every interval.

## Alternatives considered

**Regex timeout via worker threads for grep.** Rejected: moving transcript rendering off-thread duplicates session state access for one call; the character budget bounds total work deterministically and keeps the handler synchronous.

**Counting retained children against the fan-out cap.** Rejected: retained children idle until messaged, so they are memory-only; counting them would starve long-lived follow-up workflows without bounding any LLM burn.

**Backing out snapshot verification into the recovery path.** Deferred: the dispose-time snapshot outcome is not currently surfaced by the vendored manager; the warning-plus-restore-notice pair already tells the model what survived. Revisit if the vendor exposes snapshot results.

## Consequences

A looping model can no longer grow child fan-out, prompt size, or grep evaluation past published caps, and every cap failure names its Config key. Costs: prompts near the cap must be summarized by the caller (the error says so); pathological-but-under-budget regexes can still burn the scan budget's worth of CPU once before truncation — bounded, not free. The governors are deployment-tunable Config, so a heavy legitimate workflow can raise them deliberately.

## Testing

- `host-handlers.spec.ts`: governor boundary/exceeded cases (retained exempt), retained-only follow-up refusal for service-listed one-shot children, find_models through `ctx.get`.
- `session-query.spec.ts`: over-long pattern refusal; scan-budget exhaustion marks `truncated` mid-transcript.
- `ipython-tool.spec.ts`: extended recovery-warning copy pinned verbatim.
- `skill-source.spec.ts`: traversal-shaped and non-slug ids land in `invalid`, never in package paths.
