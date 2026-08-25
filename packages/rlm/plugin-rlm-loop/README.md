# @deepseek-ai/dsh-plugin-rlm-loop

Loop Engineering bookkeeping for the rlm family. Registers a `loop` tool that makes the Manage→Execute→Audit round protocol enforceable in code rather than model compliance:

- **Deterministic audit parsing** — `parseAuditHeader` reads the auditor's ordered three-line verdict (`Status` / `Integrity` / `Contract audit`) or fails loudly; prose bodies are never guessed into facts.
- **Trust gate** — only a `complete/clean/aligned` verdict counts as verified progress; every other outcome is recorded as failure evidence for the next planning round.
- **Durable process record** — `session/loop-start` and `session/loop-round-done` log-only events follow the `session/title-llm-request` precedent.
- **State landing** — verified progress and the task contract upsert into the [continual-harness](../plugin-continual-harness) state through its CAS pipeline as session-local `memory` entries under the `loop/<runId>/...` id convention, so overview injection, `/refine`, and rollback apply unchanged.

The joining session stays the Manager; executor/auditor episodes ride the composition-provided delegation tools (see `docs/recipes/agent-presets/loop/`). Design rationale: `.agents/notes/implemented/architecture/2026-08-24-rlm-loop-recording-tool.md`.

## Config

| Config | Type | Default | Description |
|---|---|---|---|
| `dataDir` | string | `~/.dsh/rlm` | Harness base dir for landing progress; must match plugin-continual-harness's `dataDir`. |
| `maxRounds` | number | `32` | Soft per-run round ceiling; exceeding warns but never blocks. |

## Tool: `loop`

| Action | Arguments | Effect |
|---|---|---|
| `begin` | `task`, `contract?` | Opens a run, emits `session/loop-start`, lands the contract entry. |
| `record` | `round`, `route`, `audit_report`, `progress_note?` | Parses the header, applies the trust gate, emits `session/loop-round-done`, lands `progress_note` when accepted. |
| `status` | — | Summarizes recorded vs verified rounds for this session. |

The structured output carries `runId`/`round`/`accepted`/`status`/`integrity`/`contractAudit`/`landed`; `text` carries model-facing guidance including rejection reasons (unparseable header, `done` route without a clean audit, missing note on a clean verdict).

## Model Experience

One `loop begin` per task adds the contract once; each round adds one `loop record` whose result text replaces ad-hoc verdict reasoning. Landed entries re-enter context through the harness overview injection, so later rounds read trusted state from the prompt instead of re-deriving it from history. KV effect matches one harness-state render plus small tool results; no per-token growth beyond recorded rounds.

## Tests

```bash
pnpm_config_verify_deps_before_run=false pnpm --filter @deepseek-ai/dsh-plugin-rlm-loop run test
```

## Known Limitations and Deferred Work

- Real-runtime mounting awaits the same dependency-closure fix as the other rlm plugins (`apps/cli` does not depend on rlm packages); until then the tool reaches sessions via explicit `ctx.plugin()` mounting or vitest-toolchain compositions.
- The run registry (`runId`, recorded rounds) is in-memory per process; durable truth lives in the session-log events and harness state files, so a supervisor restart loses only the `status` convenience view.
- Verified progress rides the existing `memory` kind under an id naming convention instead of dedicated `HarnessKind` values, keeping continual-harness's kind union untouched at the cost of kind-level filtering.
