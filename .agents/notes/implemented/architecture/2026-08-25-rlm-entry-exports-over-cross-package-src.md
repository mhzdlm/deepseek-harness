# Agent Note: 2026-08-25 — rlm family cross-package imports go through package entries

Status: implemented

## Problem

Mounting the rlm presets into the desktop deployment (plain Node over `node_modules`, no vite/tsx) failed with `Stripping types is currently unsupported for files under node_modules`. The family compiled cleanly, but two sibling rows imported each other through `@deepseek-ai/dsh-plugin-*/src/*.ts` specifiers — legal only under the vitest toolchain, where tsx strips types and tsconfig paths resolve. Plain Node resolved those specifiers to real `.ts` files under `node_modules` and refused.

## Decision

- Sibling packages consume shared code through the owning package's **entry export**, never a cross-package `src/*.ts` specifier:
  - `plugin-rlm-kernel` re-exports `redactReferenceText` from its entry; `plugin-rlm-moa` imports it from `'@deepseek-ai/dsh-plugin-rlm-kernel'`.
  - `plugin-continual-harness` re-exports `HarnessConflictError`, `readHarnessStatesDetailed`, `writeHarnessStates` (and the harness file types); `plugin-rlm-loop` imports them from the entry.
- Test-only cross-package src imports stay as they are: vitest-only by definition and never loaded by a deployment.

## Why

The published surface of a plugin is whatever plain Node can load from `node_modules`. A relative `.ts` specifier is rewritten at emit; a bare cross-package one is not, so every consumer outside vitest inherited a broken edge. Entry re-exports keep one compiled copy per package, cost no extra runtime coupling (the dependency edges already existed as peer/regular deps), and make `pnpm pack` artifacts self-contained — which the profile-bundle install path exercises directly.

## Alternatives considered

- Keeping the cross-package src imports and teaching deployments to strip types under `node_modules`: that means shipping a type-stripping loader hook with the deployment for exactly four specifiers.
- Inlining a copy of the redaction/CAS code into each consumer to delete the edges: duplicates behavior the tests pin once.

## Consequences

- 收益：兄弟包现在只通过所属包的 entry export 消费共享代码；plain-Node 桌面部署挂载 rlm preset 不再出现 `Stripping types under node_modules` 失败；`pnpm pack` 产物自包含。
- 代价：移除 4 处跨包 `src/*.ts` 说明符；仅测试用的跨包 src 导入保留（vitest-only）；未将 redaction/CAS 代码内联复制到各消费者。

## Verification

- kernel 69 / moa 33 / loop 18 / continual-harness refine-test all green after the re-export change.
- Desktop deployment smoke: after syncing freshly built packages into the deployment tree and mounting the locally authored `rlm` preset, the previous failure (`does not provide an export named 'HarnessConflictError'`) must be gone. Note the long-lived host caches natively loaded modules, so verification requires a fresh process after any on-disk update.
