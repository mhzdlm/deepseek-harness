# Agent Note: The kernel allowlist excludes credential-bearing tool namespaces

Status: implemented

[English](2026-08-26-kernel-env-excludes-tool-namespace-credentials.md) | 中文

## Problem

`buildKernelEnv` 的默认拒绝白名单整前缀放行了 `UV_*` 与 `npm_config_*`。两个命名空间都携带秘密变体——`UV_PUBLISH_TOKEN`（PyPI 发布令牌）、npm auth/代理配置（`npm_config__auth`、逐 registry 的 authtoken）——而内核进程运行模型编写的任意 Python，宿主上存在的这类变量会进入模型可读取并可外传的进程。「黑名单先于白名单」的排序帮不上忙：这些名字不匹配任何被阻断前缀，决定权全在白名单，而白名单说了 yes。这与家族契约「内核进程不获得外部凭据」相悖。

## Decision

内核进程白名单（`packages/rlm/plugin-rlm-kernel/src/kernel-env.ts` 的 `ALLOWLIST_PREFIXES`）不再包含 `UV_` 与 `npm_config_`。vendored 内核运行时没有任何地方读这些变量：uv 调用发生在宿主侧 bootstrap，经 `buildScrubbedEnv`——其仅黑名单语义不变，安装器子进程照常拿到工具配置。Windows 大小写折叠对这条排除与对其余放行项一视同仁。负向用例钉住 `UV_PUBLISH_TOKEN`、`UV_CACHE_DIR`、`npm_config__auth`、`NPM_CONFIG_REGISTRY` 在两种平台语义下都不出现在内核子进程中。

## Alternatives considered

**逐个枚举安全的 UV_/npm_config_ 变量。** 现阶段否决：内核运行时一个都不需要，每个枚举条目都是没有消费者的暴露面；将来出现内核侧真实消费者时再显式添加。

**把两个前缀加进凭据黑名单。** 否决：它们并非总是凭据（`UV_CACHE_DIR` 是普通配置），且在 `buildScrubbedEnv` 里阻断会破坏合法需要这些配置的 uv/npm 子进程。排除放在信任边界所在处——内核白名单。

## Consequences

导出 `UV_PUBLISH_TOKEN` 的宿主不再把它泄漏进模型可达的进程环境。代价与白名单既有收费一致：未来内核功能确实需要某个工具变量时，必须走显式、经审阅的单条目添加，而不是命名空间级继承。helper 子进程行为不变——净化构造器从不查询内核白名单。

## Testing

- `tests/kernel-env.spec.ts`：两条新 buildKernelEnv 负向用例（POSIX 精确名、Windows 折叠大小写），外加扩展的 buildScrubbedEnv 正向用例证明工具配置对子进程存活。
