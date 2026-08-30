# Agent Note: RLM JSDoc and vendor-gate debt cleanup (2026-08-30)

Status: implemented

[English](2026-08-30-rlm-jsdoc-and-vendor-gate-debt.md) | 中文

## Problem

三项仓库级 gate 债务落在 RLM 功能批之外：RLM 包自身的导出名缺 JSDoc（`verify-export-jsdoc` 报 `packages/rlm` 下 147 项）；同一 gate 扫描上游本无 JSDoc 的 vendored 源码（kernel `src/vendor/kernel/**` 与其 `ORIGINAL/**` pristine 镜像——147 中约 128 项，每文件双份计数）；`rlm` 包组无声明子系统归属的组 README（`verify-subsystem-pages`），因为插件族的设计居 `docs/REME.md` 与 `docs/LAYERS.md`，不在核心 catalog 子系统页。

## Decision

**RLM 自有 JSDoc 补齐（13 项）**——剩余每项都是真实文档缺口，就地修复：

- `harness-file.ts` `HARNESS_KINDS`——补用途 JSDoc。
- `storage.ts` `embeddingCacheDir`——补 `@param memoryDir` + `@returns`；`unarchiveNote`——陈旧的 `@param relPath` 改名为实际的 `archivedRelPath`；`writePublished`——记录可选 `targetRel`。
- `split-turn-summarizer.ts` `parseRlmSummary`——补 `@param text` + `@returns`。
- `refine.ts` `reviewAutoRefine`——补 5 个缺失 `@param`。

**vendored 源从 gate 排除**——`collectExportJsdocViolations` 的扫描现过滤 `**/vendor/**` 与 `**/ORIGINAL/**`：vendored prime 内核无上游 JSDoc，向每次 re-vendor 都要重推的代码里硬塞注释只会制造同步噪音；ORIGINAL 镜像必须保持 pristine。gate 自身 41 项 fixture 套件保持全绿。结果：166 → 19 项，全部是官方/其他包既有债（api/client/fs/preset），`packages/rlm` 归零。

**`rlm` 组 README + subsystem 豁免**——新建 `packages/rlm/README.md` 声明家族子系统归属（各包契约、组设计在 REME/LAYERS/LOOP、装配 preset），并在 `verify-subsystem-pages` 豁免登记表加 `rlm` 并记录理由（设计居 docs 的插件族，不在核心 catalog 页）。两 gate 现皆通过；`verify-md-links` 零新增死链（其余失败为官方包既有）。

## Alternatives considered

**给 vendored 源码补 JSDoc。** 否决：上游 prime 内核无 JSDoc；注释会在每次 re-vendor 时丢失或被反复争抢，且 ORIGINAL 镜像必须 pristine。从 API 文档 gate 排除 vendored 路径是对 gate 自身"non-vendored"契约的诚实解读。

**建 `docs/subsystems/rlm.md` 供组 README 链接。** 否决：catalog 子系统页是为核心包生成；RLM 家族设计住所（REME.md、LAYERS.md）已存在且被新组 README 链接——只为复述它们再建一页会违反 slop 清单。豁免登记表正是为此而设，且记录理由。

## Consequences

`verify-export-jsdoc`：RLM 归属归零，剩 19 项官方既有 violations（已记录，不在本批范围）。`verify-subsystem-pages` 通过，新组 README 给读者一个家族级入口。代价：vendored 排除过滤放宽了 gate 的扫描定义（新增 vendored 目录须加入过滤）；豁免使 `rlm` 明确非 catalog——未来若有核心 subsystems 页应移除豁免并改链组 README。