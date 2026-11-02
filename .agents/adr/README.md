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
| [0003](0003-sdk-type-only-import.md) | SDK 仅以 `import type` 引用 | 已接受（0005 修订） |
| [0004](0004-no-sdk-jsx-runtime.md) | 视图层不用 SDK 的 JSX 运行时，改用 `flux.ui.h` | 已被 0005 取代 |
| [0005](0005-allow-sdk-jsx-runtime.md) | 允许 SDK 的 JSX 运行时进入产物，义务登记在 THIRD-PARTY | 例外已随 0009 解除 |
| [0006](0006-drop-auth-entry.md) | 移除登录入口，凭据改由设置项 `authCookie` 直供 | 已接受 |
| [0007](0007-two-tier-settings-view.md) | 设置页分「常用 / 专业」两档，`expertMode` 控制展开 | 已被 0008 取代 |
| [0008](0008-three-tab-settings-view.md) | 设置页改三个页签（基础 / 参数 / 去广告），去掉 `expertMode` | 已被 0009 取代 |
| [0009](0009-settings-host-form-only.md) | 设置面收敛为宿主表单，删除自定义视图 | 已接受 |
| [0010](0010-credential-site-scope.md) | 凭据自带站点约束，判断下沉到解析层 | 已接受（修订 0006；0011 修订其第 1 条） |
| [0011](0011-credential-site-exact-match.md) | 凭据站点约束的裸域改为精确匹配，缺省继承 `targetHosts` | 已接受 |
