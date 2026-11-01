# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与
[语义化版本](https://semver.org/lang/zh-CN/)。

> 条目一行说清「改了什么」，一条一事，单条不超过 150 字符（CI 断言）。取舍只在非显而易见时
> 在条目末尾用「（理由：…）」附**一句话**，多数条目不带理由；不写破折号插入语与推导叙事。
> 小决策的留痕在此，重大决策走 `.agents/adr/`。
>
> 2.0.0 – 2.2.0 三节已完成并提交，尚未打 tag 发版，日期标「未发布」；发版时替换为实际日期。

## [Unreleased]

### Added

- 新增 `AGENTS.md`、`.agents/` 工程文档、`ROADMAP.md`、`CONTRIBUTING.md`、`THIRD-PARTY.md`
- 新增 `scripts/check-fast.sh` 快速门禁与 `.githooks/pre-commit`，本地与 CI 共用同一份断言
- 新增 `.github/pull_request_template.md`
- `.agents/extension-points.md` 补「换或加技术栈骨架」一节（理由：模板列六项扩展点，此前只覆盖五项）

### Changed

- CI 由 `ci.yml` 改为 `build.yml`，新增 CHANGELOG 门禁与发版守卫两个 job
- 工程文档从 `docs/` 迁到 `.agents/`，`docs/` 只保留使用者文档（理由：两类读者不该共用一处）
- `.agents/capability-matrix.md` 同步为现状：`METHOD=NONE` 标记为已修复、请求面改用 `request` 补丁
- 发版守卫要求版本节带实际日期，`- 未发布` 占位不再通过（理由：占位与日期在旧正则下不可区分，等于放行）
- `AGENTS.md` §9 同改矩阵的「设置键」一行改指 `manifest.json` + `settings.ts`，仓库配置单列一行
- 使用者文档 `docs/configuration.md` 改名 `docs/settings.md`（理由：与 `.agents/configuration.md` 同名，跨目录引用会指错）

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
