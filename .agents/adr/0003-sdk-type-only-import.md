# SDK 仅以 `import type` 引用

- 状态：已接受（部分被 [0005](0005-allow-sdk-jsx-runtime.md) 修订：JSX 运行时随产物分发，其余导出仍只用 `import type`）
- 日期：2026-11-01
- 决策者：fluxdown-plugin-m3u8 维护者

## 背景

`fluxdown-plugin-sdk` 的许可证是 AGPL-3.0-or-later，本项目是 MIT。若产物中混入 SDK 的运行时符号，
分发插件即可能被认定为构成 AGPL 衍生作品，与 MIT 授权链冲突。另一方面，迁移到 TypeScript 的收益
很大一部分来自 SDK 提供的类型（`ResolveContext`、`RequestPatch`、拦截器阶段形状）。

## 决策

全仓只允许 `import type { ... } from "fluxdown-plugin-sdk"`。产物中不得出现任何 SDK 运行时符号。
把这条做成可验证的纪律：构建后检查 `dist/*.js` 中 SDK 符号命中数为 0，该数字记录在
`.agents/sdk-migration.md` 的验收表里。

## 后果

- 正面：类型收益保留，授权链保持 MIT；不需要在仓库分发 SDK 源码。
- 负面：SDK 提供的运行时辅助函数（如校验工具）不可用，同类逻辑需自行实现并测试；
  类型与运行时行为不一致时，只能靠 `.agents/sdk-migration.md` 第九节的装机实测发现。

## 备选方案

- 直接依赖 SDK 运行时并把项目改为 AGPL：授权链简单，但放弃 MIT，且用户侧分发条款变重。
- 完全不用 SDK 类型、手写 `any`：无授权风险，但失去类型检查带来的编译期门禁（ADR-0002 的核心收益之一）。
