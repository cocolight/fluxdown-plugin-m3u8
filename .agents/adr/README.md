# 架构决策记录（ADR）

本目录记录项目的重要架构决策，供人与 AI 助手在改动前查阅。

## 约定

- 一个文件一个决策，命名 `NNNN-kebab-title.md`（四位递增序号）。
- 复制 `template.md` 起草新记录。
- 状态为「已接受」的记录**不得直接修改**；需要变更时新增一条 ADR，并在新旧记录中标注取代关系。
- 新增 / 更新 ADR 的提交类型用 `docs:`。

## 索引

| 编号 | 标题 | 状态 |
|------|------|------|
| [0001](0001-record-architecture-decisions.md) | 采用 ADR 记录架构决策 | 已接受 |
| [0002](0002-migrate-to-typescript-and-plugin-sdk.md) | 源码迁移到 TypeScript + 插件 SDK 构建链 | 已接受 |
| [0003](0003-sdk-type-only-import.md) | SDK 仅以 `import type` 引用 | 已接受 |
| [0004](0004-no-sdk-jsx-runtime.md) | 视图层不用 SDK 的 JSX 运行时，改用 `flux.ui.h` | 已接受 |
