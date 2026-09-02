---
description: "The RLM (recursive language model) plugin family: persistent kernel substrate, loop engineering, memory, verify, MOA, compaction, and continual-harness plugins that implement the three-layer framework (task orchestration, context management, model-call management) from docs/LAYERS.md."
kind: "package-group"
---

# rlm/ — RLM plugin family

The RLM plugin family implements the recursive-language-model research loop on top of the harness: a persistent IPython kernel substrate (`plugin-rlm-kernel`), subagent fan-out (`rlm.run` / `rlm.message`), an LLM-as-a-Verifier selection tool (`plugin-rlm-verifier`), multi-reference-model synthesis (`plugin-rlm-moa`), a file-authoritative cross-session memory (`plugin-rlm-memory`), split-turn compaction (`plugin-rlm-compaction`), and the continual-harness CAS state store with `/refine` (`plugin-continual-harness`). Each package README owns its per-package contract; the group-level design lives in [docs/REME.md](../../docs/REME.md) (memory discipline), [docs/LAYERS.md](../../docs/LAYERS.md) (the three-layer framework and its build order), and [docs/LOOP.md](../../docs/LOOP.md) (loop engineering). The canonical recipe that assembles the family is [docs/recipes/agent-presets/rlm/agent.cordis.yml](../../docs/recipes/agent-presets/rlm/agent.cordis.yml).

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)

## Packages

- `plugin-rlm-kernel` — per-session persistent kernel + host bridge (the only surface the Python side can touch) + python-skill install pipeline.
- `plugin-rlm-verifier` — LLM-as-a-Verifier best-of-N selection over candidate trajectories with surviving-judge mean fusion and judge profiles.
- `plugin-rlm-moa` — multi-reference-model fan-out with aggregator synthesis.
- `plugin-rlm-memory` — capture → evidence gate → consolidation → archived retirement; `memory_search` recall over `published/`.
- `plugin-rlm-compaction` — split-turn prefix summarization + Files Touched carry-over on top of the official compaction engine.
- `plugin-continual-harness` — CAS-backed harness state, `/refine` + `/refine-rollback`, `/harness`, and the per-turn harness-overview prompt section with observe-first recall injection.
- `plugin-rlm-loop` — minimal loop-recording tool (begin/record/status) with the three-line-heading audit discipline.
- `plugin-rlm-redact` — zero-dependency shared credential/PII reference-text redactor consumed by verifier and moa (kept out of the kernel package so judgment tools do not drag its native dependency chain).
- `plugin-rlm-store` — unified storage core: per-scope append-only event streams + materialized views, with the judgment channel as the only belief-writing path; dependency-graph root of the family.

## Related documentation

- [docs/REME.md](../../docs/REME.md) — memory-layer discipline (phases, gates, budgets).
- [docs/LAYERS.md](../../docs/LAYERS.md) — the three-layer framework, the `llm.query` bridge, DAG orchestration, and the build order.
- [docs/LOOP.md](../../docs/LOOP.md) — loop engineering.
- [docs/recipes/agent-presets/rlm/agent.cordis.yml](../../docs/recipes/agent-presets/rlm/agent.cordis.yml) — the assembled preset.