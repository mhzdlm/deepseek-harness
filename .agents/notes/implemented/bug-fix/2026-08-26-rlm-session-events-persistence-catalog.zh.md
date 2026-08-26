# Agent Note: Plugin session events must be in the generated persistence catalog

Status: implemented

[English](2026-08-26-rlm-session-events-persistence-catalog.md) | 中文

## Problem

rlm 三个判定插件经 `Session.append()` 追加仅入日志的过程事件（`session/verify-request|result`、`session/moa-reference|synthesis`、`session/loop-start|round-done`）。该 API 自行构造事件信封，没有任何入口能写 `ignorable` 标记；而持久化读路径对「生成的 `KNOWN_SESSION_EVENT_TYPES` 之外的类型且未标 ignorable」的日志直接拒绝。六个类型只做了模块扩充声明、从未进生成目录——凡日志含这些事件的会话（包括由发布这些事件的同一构建写入的会话）重启后无法重载。这一过期对所有 rlm 测试不可见，因为没有用例跑过持久化-重载回路；引入这些事件的提交上仓库自带的新鲜度门禁（`verify-persistence-catalog`）本身就是红的。

## Decision

rlm 插件声明的每个仓内 `SessionEventMap` 成员都登记进生成目录：`pnpm run gen-persistence-catalog` 重生成 `packages/core/session/src/known-event-types.ts` 与 `docs/persistence-catalog.md`，现包含这六个事件类型。每个发出事件的包拥有守卫 spec（`tests/persistence-catalog.spec.ts`），断言其导出的事件类型元组（`VERIFY_EVENT_TYPES` / `MOA_EVENT_TYPES` / `LOOP_EVENT_TYPES`，同时用作 `emit*Event` 参数联合）包含于 `KNOWN_SESSION_EVENT_TYPES`；新增事件而不重生成目录时，失败的是该包自己的测试套件，而不是上线一个不可重载的会话格式。emit 签名从元组派生，声明在每包只有一个家。

守卫 spec 以相对路径导入目录模块：rlm 包位于所有消费者的依赖闭包之外，workspace 包名导入要么解析到过期的构建产物 `lib/`，要么直接失败。

## Alternatives considered

**在调用点标记事件为 ignorable。** 否决：`Session.append()` 内部构造信封且不接受 ignorable 选项——写入侧没有入口；今天能产生这种信封的只有测试与 sqlite 读侧。

**给插件包自建注册面。** 上游暂缓：生成目录的头部注释明确「仓外注册面等出现真实消费者再建」；这些包在仓内，重生成即正道。

**只依赖 session-persistence 的契约测试。** 否决：那些测试用 fixture 类型泛化覆盖拒绝机制本身；没有任何东西把 rlm 词表与目录绑在一起——这正是缺陷得以上船的缝隙。

## Consequences

使用 verify/moa/loop 的会话在同一构建下重新可加载。代价是一组维护配对：新增过程事件必须跑一次生成器命令，忘记的后果是发出包自己的套件变红，而不是用户会话不可加载。守卫以相对路径跨包树导入，在本仓库属非常规做法，但在依赖闭包打通之前是有意为之。

## Testing

- `plugin-rlm-verifier/tests/persistence-catalog.spec.ts`、`plugin-rlm-moa/tests/persistence-catalog.spec.ts`、`plugin-rlm-loop/tests/persistence-catalog.spec.ts`：各一条对发出词表的包含断言。
- `pnpm run verify-persistence-catalog` 在 HEAD 全绿。
