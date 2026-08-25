# 2026-08-25 — harness-to-kernel python skill installer (NEXT T2.1)

## Context

The vendored bootstrap already contained the full python-skill pipeline — `normalizePythonSkills`, pyproject parsing, dependency collection, `uv pip install` into the shared kernel venv, and `.bootstrap-version` tracking with per-skill `pyprojectHash` change detection — but nothing on the plugin side ever fed it: `KernelManager` options accepted `pythonSkills` and no caller passed any. The prime upstream resolved this through its repo-internal `skills.js`, which was never vendored.

## Decision

- Package convention: a harness skill entry with `reference.type === "python"` and `reference.import === "<name>"` is backed by a real project at `<dataDir>/skills/<entryId>/pyproject.toml`. The convention lives in `skill-source.ts` JSDoc and NEXT.md; there is no config key for it because it is a contract, not a deployment-varying tunable.
- Global scope only. All sessions share one kernel venv, so honoring per-session skill sets would make sessions fight over the `.bootstrap-version` manifest and thrash reinstalls. Local python skills stay text-only until a per-session venv story exists (recorded in NEXT as part of T3.2's design space).
- Collection is lazy, per provision, via `SessionKernelOptions.pythonSkillsProvider`. The vendored version comparison then reinstalls incrementally when the entry set or any pyproject hash changes — no separate refresh flow needed.
- Missing packages are reported (`missing` ids, one console.warn each) but never fail provisioning: a half-created skill must not take down kernel startup.
- `@deepseek-ai/dsh-plugin-continual-harness`'s compiled entry now also re-exports `globalHarnessStatePath` / `readHarnessStateDetailed`; consumed cross-package through the entry, per the no-src-specifiers rule.

Orthogonal to the host-side markdown skill registry ([skill system](../architecture/2026-07-05-skill-system.md)): that registry serves instruction bundles into prompts; this pipeline installs executable Python packages into the kernel venv for direct in-REPL calls. They share only the vocabulary.

## Given up

- A `/skill-create` host command and routing-consistency invariants in this change (NEXT T2.2/T2.3): the collector only trusts entries that pass the vendored runtime's own reference validation on write.
- Per-session venvs.

## Required verification

- `collectPythonSkills` unit tests: materialization against the convention, missing-package reporting, non-python/non-skill filtering.
- Kernel suite green with the provider wired through `forSession`.
