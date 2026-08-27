# Agent Note: 2026-08-25 — harness-to-kernel python skill installer (NEXT T2.1)

Status: implemented

## Problem

The vendored bootstrap already contained the full python-skill pipeline — `normalizePythonSkills`, pyproject parsing, dependency collection, `uv pip install` into the shared kernel venv, and `.bootstrap-version` tracking with per-skill `pyprojectHash` change detection — but nothing on the plugin side ever fed it: `KernelManager` options accepted `pythonSkills` and no caller passed any. The prime upstream resolved this through its repo-internal `skills.js`, which was never vendored.

## Decision

- Package convention: a harness skill entry with `reference.type === "python"` and `reference.import === "<name>"` is backed by a real project at `<dataDir>/skills/<entryId>/pyproject.toml`. The convention lives in `skill-source.ts` JSDoc and NEXT.md; there is no config key for it because it is a contract, not a deployment-varying tunable.
- Global scope only. All sessions share one kernel venv, so honoring per-session skill sets would make sessions fight over the `.bootstrap-version` manifest and thrash reinstalls. Local python skills stay text-only until a per-session venv story exists (recorded in NEXT as part of T3.2's design space).
- Collection is lazy, per provision, via `SessionKernelOptions.pythonSkillsProvider`. The vendored version comparison then reinstalls incrementally when the entry set or any pyproject hash changes — no separate refresh flow needed.
- Missing packages are reported (`missing` ids, one console.warn each) but never fail provisioning: a half-created skill must not take down kernel startup.
- `@deepseek-ai/dsh-plugin-continual-harness`'s compiled entry now also re-exports `globalHarnessStatePath` / `readHarnessStateDetailed`; consumed cross-package through the entry, per the no-src-specifiers rule.

## Verification gate (NEXT T2.2, same day)

Once the bootstrap ran, provisioning executes one probe cell that dumps the bootstrap-recorded `_PRIME_AGENT_SKILL_IMPORT_ERRORS` map and parses the stdout. Non-empty → provisioning fails loud naming each offending skill and its first error line, and the kernel is disposed. This covers every mismatch shape statically undecidable from disk (wrong import name vs module layout, broken dependencies, packaging errors) against ground truth, mirroring the catalog philosophy of failing at the earliest point that can name the offending key. A probe that returns unparsable output warns and skips — that is our own code misbehaving, not a skill mismatch. Missing package directories stay on the T1.1 warn-only path: those entries never enter the install set, so there is no promise to verify.

Orthogonal to the host-side markdown skill registry ([skill system](../feature/2026-07-05-skill-system.md)): that registry serves instruction bundles into prompts; this pipeline installs executable Python packages into the kernel venv for direct in-REPL calls. They share only the vocabulary.

## Alternatives considered

- A `/skill-create` host command and routing-consistency invariants in this change (NEXT T2.2/T2.3): the collector only trusts entries that pass the vendored runtime's own reference validation on write.
- Per-session venvs.

## Skill creation tool (NEXT T2.3, same day)

`create_python_skill` (kernel package, `skill-create.ts`) is the model-facing last step of the workflow: distill the repeated workflow from the transcript via `transcript.grep`, write `<dataDir>/skills/<name>/` yourself, then call the tool with name/import_name/title/description. The tool validates slug/identifier shapes, checks the package on disk (pyproject present; module body as `<import>.py` or `<import>/__init__.py`), fails loud naming each concrete missing file, then registers the global entry under CAS (`upsertPythonSkillEntry`, `skill-source.ts`) and reports that the callable goes live at the next kernel provision.

Given up:
- A `/skill-create` slash command: `CommandResult` is success/error only — there is no prompt-expansion result kind, so a handler cannot hand a workflow brief to the model. Revisit when commands grow a prompt variant.
- Hosting the upsert in continual-harness: in vitest suite workers the continual-harness entry namespace arrived partially initialized (`upsertPythonSkillEntry` undefined) while the same entry's collector bindings resolved fine — a cross-worker module-graph quirk around its heavyweight service imports. The upsert therefore lives beside the collector in kernel's `skill-source.ts`, composed from the same proven entry primitives (readHarnessStatesDetailed/writeHarnessStates). Symptom to watch: cross-package entry imports resolving `undefined` for some named exports only inside full-suite workers.

## Consequences

- 收益：harness python skill 现在从插件侧经约定 + 惰性 provider + CAS 条目流入内核 venv；验证门针对真实真相校验任何 skill import 不匹配并响亮失败。
- 代价：本次不含 `/skill-create` 宿主命令与路由一致性不变量；per-session venv 推迟；由于跨 worker 模块图怪象，upsert 落在 kernel 的 `skill-source.ts` 而非 continual-harness。

## Verification

- `collectPythonSkills` unit tests: materialization against the convention, missing-package reporting, non-python/non-skill filtering.
- Kernel suite green with the provider wired through `forSession`.
