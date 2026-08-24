# Agent Note: MoA preset 获得运行时管理与 full 级脱敏

Status: implemented

[English](2026-08-24-rlm-moa-managed-presets-and-redaction.md) | 中文

## Problem

`plugin-rlm-moa` 首版只从静态插件 Config 读取面板定义：调整参考阵容或默认面板都要改 `cordis.yml` 并重载；而且 advisor 回答未经任何过滤直达聚合器提示——advisor 从对话里复述的凭据材料会原样流进另一次模型调用与渲染结果附近。

## Decision

两项叠加增强，均不触碰工具编排契约：

- **托管 preset 存储**——`<dataDir>/moa-presets.json` 保存运行时管理的 preset 与活动默认指针（`/moa use <name>` 写入）。视图将 store 叠在 Config preset 之上（同名时 store 胜出），每次调用重读，管理操作对后续工具执行即时生效。损坏的 store 以 `<file>.corrupt-<ts>` 隔离并按空处理，沿用 harness 状态文件策略。
- **`/moa` 命令**——`list | show <name> | use <name> | remove <name>`。`remove` 只删 store 托管的 preset；来自 Config 的会被明确告知不可移除而非静默跳过。
- **隐私 `full`**——advisor 文本进入聚合器提示前经 `redactReferenceText` 掩码：PEM 私钥块、provider 风格密钥（`sk-…`、`gh[posr]_…`）、JWT、Bearer 头值、`password=/api_key=/token=` 键值对、邮箱、以及要求分隔符的电话号码。模式安全性与上游 advisory panel 同一推理：版本号、IP、日期、SHA、无分隔数字串永不匹配。trace 行只存长度，advisor 文本不落其他位置。

工具通过注入缝消费这些能力——`resolvePreset`/`availablePresets`（分层视图）与 `redactReference`——编排单测无需 LLM 运行时，文件侧也只需 tmp 目录。

## Alternatives considered

**把托管 preset 持久化进 cordis.yml。** 否决：插件 Config 属部署所有；dataDir 下的 JSON 文件把用户变更留在组合文件之外，同时仍处于共享 artifact 根内。

**改用参考系统提示词约束（"不要复述密钥"）。** 单独使用时否决：提示级请求只是劝告，掩码是确定且可审计的。两者并用可以，但只有掩码是强制的。

**复用 harness 状态文件模块实现存储。** 否决：该模块面向 harness 条目形态（kinds、scopes、CAS）；存储只需要两个字段的 last-writer-wins 语义，值得继承的只有损坏隔离行为。

## Consequences

面板阵容与默认值可经 `/moa` 在会话运行期调整，`full` 为跨模型流程提供确定性保密档位。代价：store 文件成为 dataDir 下新的可变产物（last-writer-wins、单主机假设，与 RLM 家族其余部分一致）；出现新密钥族时需有意识地扩充脱敏模式清单。未被覆盖的 Config 声明 preset 保持权威。

## Testing

- `tests/redact.spec.ts`: 6 项——密钥/JWT/PEM/键值对/Bearer 掩码、邮箱与分隔电话识别，以及对版本、IP、日期、SHA、裸数字串的不匹配保证。
- `tests/preset-store.spec.ts`: 6 项——分层优先级（store 压 Config、同名覆盖）、默认解析顺序（store → Config → 首个）、损坏隔离、`use` 持久化即时可见、remove 仅限托管规则、list/show 渲染含默认标记。
- `tests/moa.spec.ts`: 新增 1 项断言 `full` 模式下 advisor 邮箱/密钥材料在聚合器提示前被掩码；既有 13 项更新为注入视图形态。包套件三文件 26 项全绿；tsc 全净。
