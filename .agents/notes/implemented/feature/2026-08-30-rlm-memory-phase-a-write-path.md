# Agent Note: RLM memory plugin — Phase A write path

Status: implemented

English | [中文](2026-08-30-rlm-memory-phase-a-write-path.zh.md)

## Problem

The RLM family has no cross-session knowledge asset: completed sessions evaporate when their kernel snapshot is dropped, and the Continual Harness paper's five management strategies (growth evaluation, retrieval quality, dedup, aging/demotion, forgetting) have no home in RLM. ReMe (agentscope-ai/ReMe) proves the file-authoritative Markdown form, but its runtime is an autonomous sidecar with its own LLM keys, timers, and silent decision audit — incompatible with the family contract that every model call routes through the host seam and the kernel owns process state. REME.md (docs/REME.md) resolves this: build a new host-owned plugin that takes ReMe's form and the paper's discipline, and implement the write path first (capture → draft with an evidence gate).

## Decision

`packages/rlm/plugin-rlm-memory` is a function plugin (`name`/`inject`/`Config`/`apply`, no default export) that:

- Subscribes to `session/message` to accumulate user/model/tool turns per session in an in-memory `Map` keyed by session id, and flushes+persists on `session/disposed` (root sessions only when `rootAgentsOnly`).
- Sanitizes by stripping tool-role turns (`sanitize.ts`), so the stored `dialog/<id>.jsonl` carries only user/model/system text — anti-pollution (REME.md §5.1 D5). Recall results are themselves tool results, so this rule also blocks capture from self-reinforcing.
- Writes `dialog/<id>.jsonl` unconditionally (the durable, auditable artifact), then spawns a host-owned `ctx.subagents.start('spawn', { prompt, parent, signal })` child whose parent is the captured session's owning Agent. The child returns a JSON array of `{ title, kind, source, body }` proposals; a child failure rejects and is audited as `extractionRan: false` (T7.5), while an empty dialog or a clean run that finds nothing resolves to `[]`.
- Gates every proposal by `evidence.ts`: a note's `source` (`turn:N` / `turn:N-M` / `contains:<text>`) MUST locate a line in the stored dialog jsonl, else the draft is dropped (REME.md §5.1 D6 — the paper's "small, evidence-backed updates" + /refine FIX-8). Admitted drafts land in `drafts/<kind>/<slug>.md` with frontmatter provenance (`session_id`, `source_conversation`, `source`, `use_count`, `last_accessed`, `gate`).
- Emits a log-only `session/memory-captured` event (REME.md §5.1 D7) carrying `sessionId`, `dialogTurns`, `draftsAdmitted`, `extractionRan`, `draftChars`.
- Registers `/memory list | show | delete`; `delete` is drafts-only (published notes await Phase C). Every registration is an effect; disposal removes it.

`MEMORY_EVENT_TYPES = ['session/memory-captured']` is declared and the persistence catalog regenerated (`pnpm run gen-persistence-catalog`) so the read path accepts the new type. The package registers a `./invariant` companion documenting the no-runtime-invariant reason (the gate is enforced at write time, not checkable from the companion's child fiber).

Config is fully schema-validated (schemastery) with explicit default resolution in `apply`: `memoryDir` (`~/.dsh/rlm/memory`), `captureMode` (`sessionEnd`), `captureIntervalTurns` (`16`), `rootAgentsOnly` (`true`), `privacyFilter` (`''`). No FAISS/embedding/ReMe dependencies are added. Wiring: `apps/cli/package.json` gains the workspace dep, `tsconfig.host.json` gains the reference, and `docs/recipes/agent-presets/rlm/agent.cordis.yml` adds the plugin row beside `rlm-moa`.

## Alternatives considered

**Adopt ReMe as a sidecar (integrate its HTTP service).** Rejected: REME.md §1/§3 source-verified that ReMe holds its own LLM keys, runs its own daily timer, and writes the knowledge tree through a write-capable agent while dropping its decision audit at the dsh boundary — a direct breach of the family contract (no credentials in a sidecar, all model calls through the host seam, kernel owns process state).

**Make the write path a model-facing tool (`memory_write`).** Rejected for Phase A: REME.md §5.1 and §12 open question 4 defer model-driven writes; a single host-owned pipeline is the narrowest, safest write surface (Heuriva's deliberate restraint + the paper's gate spirit). The evidence gate already makes a future `memory_write` a drop-in.

**Persist the capture buffer to survive host restarts.** Rejected for Phase A: the durable artifact is the dialog jsonl written on disposal; an in-memory buffer is the known scale limitation recorded in the README, and a persistence-backed buffer is a clean Phase B/C extension point rather than Phase A scope.

**Emit capture as a surface event rather than log-only.** Rejected: capture is audit observability, not derived model history; the `model-visible ⟺ logged` rule and the verify/title precedents both use log-only session events, and the persistence catalog guard requires exactly that classification.

## Consequences

- Completed root sessions now leave a sanitized, auditable dialog jsonl plus evidence-gated draft notes under `<memoryDir>`, traceable to the source turn.
- The write surface stays single and host-owned; no model or plugin can write knowledge outside the gate, so the knowledge base is a durable injection surface, not a model scratchpad.
- Phase B (recall), C (consolidation/rollback), D (retire) remain unbuilt; `/memory delete` cannot touch published notes until Phase C lands the promotion gate.
- The in-memory per-session buffer loses buffered turns on a host restart; the dialog jsonl is the recovery point, and a periodic `intervalTurns` capture mode is specified but not wired.
- `privacyFilter: 'display'` is accepted by the schema but inert in Phase A (no display surface); only `'full'` masks credential/PII material before the dialog lands.
