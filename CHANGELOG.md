# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与
[语义化版本](https://semver.org/lang/zh-CN/)。

> 条目一行说清「改了什么」，一条一事，单条不超过 150 字符（CI 断言）。取舍只在非显而易见时
> 在条目末尾用「（理由：…）」附**一句话**，多数条目不带理由；不写破折号插入语与推导叙事。
> 小决策的留痕在此，重大决策走 `.agents/adr/`。
>
> 2.0.0 – 3.0.0 各节已完成并提交，尚未打 tag 发版，日期标「未发布」；发版时替换为实际日期。
> 原计划的 2.3.0（设置页签）从未发布，已并入 3.0.0 —— 3.0.0 移除登录入口属 breaking，故一并升大版本。

## [Unreleased]

## [3.0.0] - 未发布

### Removed

- 移除登录入口：删掉 `auth` 段与 `auth` 权限，产物入口由 6 个降为 5 个（理由：登录对话框按站点登录，与对所有站点生效的定位冲突，见 ADR-0006）
- 删除 `src/entry/auth.ts`；`tests/parity` 中 13 条 `auth` 场景随功能删除，改由 `tests/contract` 断言「已移除」
- 删除 `adfilter/` 目录：v1.4.3 停用的本地去广告清洗服务（Python，独立进程），manifest 无对应设置项、构建无对应入口、测试无引用，规则特征早已迁入 `lib/adrules.ts`

### Added

- 新增 `src/lib/credential.ts`：凭据文本解析（bearer / basic / 多行头 / Cookie），补丁与抓取两处共用
- 新增 `expertMode` 设置项：控制插件设置页是否展开专业项，默认关
- 新增设置页签「去广告规则」（`main.tsx` + `contributes.views`）：模式切换、规则即时校验、五档预设
- 新增 `src/lib/rulecheck.ts`：界面侧规则校验，与拦截器共用 `parseAdRuleSet`，不另写一套判定
- 新增 `src/lib/adpresets.ts`：从保守到激进的五档规则形态，不内置任何站点域名名单
- 新增 `tests/ui.mjs`：37 项视图契约（树合法性、受控输入、保存语义、越界、SDK 运行时例外边界）
- `scripts/check-fast.sh` 新增第 6 条：manifest 声明的入口必须在构建配置里有映射
- 新增 ADR-0005：视图用 SDK 的 `jsx-runtime`，AGPL 义务登记在 `THIRD-PARTY.md`；ADR-0004 随之被取代
- 新增 `AGENTS.md`、`.agents/` 工程文档、`ROADMAP.md`、`CONTRIBUTING.md`、`THIRD-PARTY.md`
- 新增 `scripts/check-fast.sh` 快速门禁与 `.githooks/pre-commit`，本地与 CI 共用同一份断言
- 新增 `.github/pull_request_template.md`
- `.agents/extension-points.md` 补「换或加技术栈骨架」一节（理由：模板列六项扩展点，此前只覆盖五项）

### Changed

- 登录凭据改由设置项 `authCookie` 直供：下载补丁走 `originHeaders`、抓取走 `fetchHeaders`，同源闸不变
- 设置页签改为「插件设置」：默认 12 项常用，`expertMode` 打开后追加 16 项专业项（理由：声明式设置项没有分组字段，宿主侧无法折叠）
- 28 个设置项的标题与描述改写为面向使用者的一句话，总字数从 2767 降到 711，并按使用频率重排
- 「保存」只写改动过的键，不再整份回写草稿
- 测试链路由四层扩为五层，`npm test` 增加 `ui`；`main` 视图的 schema 与交互从此有断言
- CI 由 `ci.yml` 改为 `build.yml`，新增 CHANGELOG 门禁与发版守卫两个 job
- 工程文档从 `docs/` 迁到 `.agents/`，`docs/` 只保留使用者文档（理由：两类读者不该共用一处）
- `.agents/capability-matrix.md` 同步为现状：`METHOD=NONE` 标记为已修复、请求面改用 `request` 补丁
- 发版守卫要求版本节带实际日期，`- 未发布` 占位不再通过（理由：占位与日期在旧正则下不可区分，等于放行）
- `AGENTS.md` §9 同改矩阵的「设置键」一行改指 `manifest.json` + `settings.ts`，仓库配置单列一行
- 使用者文档 `docs/configuration.md` 改名 `docs/settings.md`（理由：与 `.agents/configuration.md` 同名，跨目录引用会指错）
- `.agents/sdk-migration.md` 更正 M5 说明：`settings` 视图是**新增**页签，不替换「基础设置」页签
- `THIRD-PARTY.md` 新增「随产物分发的 AGPL 组件」一节，登记 `dist/main.js` 内联的 jsx-runtime 及义务边界
- `.agents/configuration.md` 补 ruleset 的 `enforcement` 核对步骤与合并策略（squash），分支保护改按 ruleset 描述

### Fixed

- README 的 Releases 链接写成 `../../releases`，会解析到用户级页面，改为仓库绝对地址
- `AGENTS.md` §3 漏掉「保护分支，禁止直接推送」一条，`CONTRIBUTING.md` 同步补回

### Removed

- 删除 `METHOD=NONE` 上游缺陷记录与两份补丁（理由：引擎 v0.5.4 起已修复，记录失效）
- README 移除 `METHOD=NONE` 限制条目与 `subscriptions` 未列入公开文档的免责声明

## [2.2.0] - 未发布

### Added

- 合并与转封装产出的文件用 `flux.task.recordArtifact` 登记，删任务时一并删除
- 新增设置 `rangeCapKb`，换算成 `RequestPatch.maxRangeBytes`（需引擎 0.6.0，默认关闭）

### Changed

- `onDone` 先用 ffprobe 读真实容器再决定是否转封装，扩展名不再作唯一依据
- 容器判定按 MP4 家族（`mov,mp4,m4a,3gp,3g2,mj2`）而非扩展名相等
- `minAppVersion` 0.5.8 → 0.6.0（理由：`maxRangeBytes` 自 0.6.0 提供）

### Fixed

- 视频为 `.mp4` 且音轨未合并时旧版完全静默，现按原意告警

## [2.1.0] - 未发布

### Added

- 新增第五个入口 `intercept`，在 `interceptors.segments` 阶段丢弃广告分片，默认关闭
- 新增设置 `adRulesMode`（关闭 / 仅标记 / 标记 + 推测）与 `adRulesExtra`（自定义 JSON 规则）

### Changed

- 任务标记上限 60 → 300（理由：拦截器靠它判断归属，200 集批量任务会把先建的标记挤掉）
- `permissions` 增加 `intercept`，已装用户升级后需重新授权一次

## [2.0.0] - 未发布

### Added

- 请求面改由 `resolve` 返回值中的 `request` 补丁下发：`referrer`、`userAgent`、`setHeaders`
- 登录凭据改走 `RequestPatch.originHeaders`，只对登记站点同源请求生效

### Changed

- `minAppVersion` 0.4.8 → 0.5.8

### Removed

- resolver 返回值中的 `extraHeaders` 字段，不与 `request` 并存（理由：两个来源会形成「谁生效」的长期歧义）
