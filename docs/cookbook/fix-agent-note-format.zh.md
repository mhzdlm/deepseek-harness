# 把一篇 Agent Note 修正为合规格式

English | [中文](fix-agent-note-format.md)

`verify-agent-note-format`（属于 `doc-sync` 的一部分）会拒绝任何不符合统一文件内格式的活跃 Agent Note。本指南把用旧式写法写的笔记修复为合规，同时保留其全部正文。

## 前置条件

- 本仓库与一个 Node/pnpm 工具链。
- 待修复笔记的路径，例如 `.agents/notes/implemented/feature/2026-08-25-recording-completeness.md`。

## 步骤

1. 查看违规项。
   `pnpm exec tsx scripts/verify-agent-note-format.ts`
   输出会列出每个违规文件及其违反的确切规则（缺 `Status:`、首节错误、缺 `## Consequences` 等）。

2. 应用机械修复。
   `node scripts/fix-agent-note-format.mjs --write .agents/notes/implemented/feature/2026-08-25-recording-completeness.md`
   修复器给标题加 `Agent Note: ` 前缀、在第 3 行插入 `Status: implemented`、把首节改名为 `## Problem`、把 `## Given up` 改名为 `## Alternatives considered`、把 `## Required verification` 改名为 `## Verification`，并在 `## Verification` 前插入一个 `## Consequences` 占位小节。先加 `--check` 可预览。

3. 补写 `## Consequences` 正文。
   打开文件，把 `## Consequences` 的 TODO 行替换为一两句"这笔权衡换来了什么、付出了什么"。门禁仅凭该节标题即可通过，但笔记在补完前是不完整的。

4. 重新运行门禁。
   `pnpm exec tsx scripts/verify-agent-note-format.ts`
   必须报告 `all conform`。

5. 若门禁仍报错，手工修。
   implemented 笔记不得含有 `## Proposal`、`## Plan`、`## Migration plan` 或 `## Acceptance criteria`。修复器只对其告警，不会改写；请手工改名或删除，把内容并入 `## Decision` 或 `## Consequences`。

6. 提交。
   把笔记加入暂存并提交。lefthook 的 pre-commit 空白检查会拦截行尾空白，因此请确保编辑行干净收尾。

## 校验

- `pnpm exec tsx scripts/verify-agent-note-format.ts` 打印 `all conform`（或零文件）。
- 修复提交的 `git show --stat HEAD` 只列出被修复的笔记。

## 易错点

- **`Status:` 行必须唯一。** 若笔记带有 `- **Status**:` 要点，修复器会丢弃它；门禁在存在多于一个 `Status:` 行时失败，因此绝不能留下重复。
- **`.zh.md` 副本不会被自动修复。** 格式门禁跳过 `.zh.md`；请手工把同样的头部记号（`# Agent Note:` 与 `Status: implemented`）逐字翻译，并在改完任一侧后重跑翻译配对检查。
- **被禁标题在提交前静默失败。** `## Proposal`/`## Plan`/… 是 implemented 骨架拒绝的"规划腔"；修复器只告警不改写。
- **pre-commit 空白检查。** lefthook 运行的 `git diff --cached --check` 会对编辑引入的行尾空白失败；保持新增行干净。
