# 发版（Releasing）

> 本文是 `AGENTS.md` §3「发版」的详细版，也是 §9 同改矩阵「发版」行的落点。
> 本文只展开步骤，**不得放宽** `AGENTS.md` 的红线与 `definition-of-done.md` 的完成定义。

## 1. 什么条件才可发版

发版不是「功能做完」的自然结果，而是一次需要显式确认的独立动作。以下条件**同时**满足才可发：

- [ ] `ROADMAP.md` 中没有任何 `in-progress` 行
- [ ] 四层测试与类型检查全绿；`npm run build` 与 `npm run validate` 通过
- [ ] CI 在待发版的那个 commit 上全绿
- [ ] `CHANGELOG.md` 的 `[Unreleased]` 已写全本次要发的改动，分类正确
- [ ] 待发版 commit 已经合入 `master`（只在 `master` 上发版，不在功能分支上发）
- [ ] 装机验证项（`.agents/sdk-migration.md` 第九节）中，与本次改动相关的条目已有结论；未验证的须在 Release 说明里点明

> 这份清单有机械兜底：推送 `v*` tag 时 `build.yml` 的 `Release guard` 会校验 `CHANGELOG.md` 有对应版本节、`ROADMAP.md` 无 `in-progress` 行。漏了前置条件，流水线直接红。

## 2. 命名 —— 本次唯一的硬规则

| 对象 | 形式 | 例 |
|---|---|---|
| Git tag | `vX.Y.Z`（**带** `v`） | `v2.3.0` |
| Release title | 与 tag 完全相同 | `v2.3.0` |
| `CHANGELOG.md` 版本节 | `[X.Y.Z] - 日期`（**不带** `v`） | `[2.3.0] - 2026-11-08` |

这三处对不上是最常见的发版事故：使用者按 tag 去找 changelog 里的同名版本节，却找不到。

版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)：不兼容的对外变更提主版本、兼容地新增能力提次版本、只修缺陷提修订号。

**本项目的 breaking 判据比一般库更严**：抬 `minAppVersion` 等于放弃旧客户端（旧客户端见未知 manifest 字段会整份拒绝），属主版本级变更；新增权限（如 `intercept`）会让已装用户需要重新授权，至少要在 Release 说明里显著标注。

## 3. 步骤

1. **逐条过 §1 的清单**，有一条不满足就停下。
2. **改版本号**：两处必须同时改且相等 —— `manifest.json` 的 `version`（发给客户端，事实源）与 `package.json` 的 `version`。`scripts/check-fast.sh` 会断言两者一致。
3. **改 `CHANGELOG.md`**：把 `[Unreleased]` 改成 `[X.Y.Z] - YYYY-MM-DD`，并在文件顶部补回一个**空的** `[Unreleased]` 节。
4. **提 PR 并合并**：发版改动走正常 PR 流程，commit type 用 `chore`。
5. **打 tag**：切到合并后的 `master`，打**带注释**的 tag：

   ```bash
   git checkout master
   git pull
   git tag -a vX.Y.Z -m "release: X.Y.Z"
   git push origin vX.Y.Z
   ```

6. **建 Release**：title 填 `vX.Y.Z`（与 tag 一致）；正文直接取自 `CHANGELOG.md` 的 `[X.Y.Z]` 节，不要另写一套。
7. **附发布包**：`npm run pack` 产出 `fluxdown-plugin-m3u8_<版本>.fxplug`，上传为该 Release 的附件。附件名与版本号一致，不要手工改名。
8. **收尾核对**：Release 页面正常、tag 指向的 commit 就是刚合入 `master` 的那个 commit、附件可下载且 `identity` 未变。

## 4. 常见错误

| 错误 | 后果 | 正确做法 |
|---|---|---|
| 在功能分支上打 tag | tag 指向一个从未进 `master` 的 commit，使用者拿不到 | 先合并，再在 `master` 上打 tag |
| tag 带 `v`，CHANGELOG 也写 `v` | 不符 Keep a Changelog 惯例，工具解析不到 | `CHANGELOG.md` 里**不带** `v` |
| Release title 自拟 | 按 tag 检索不到对应 Release | title 与 tag 完全一致 |
| 忘了补回空的 `[Unreleased]` | 下次改动无处可记 | 改版本节的同一回合补回 |
| 只改 `package.json` 的版本 | 客户端看到的版本与 changelog 不一致 | 两处同改，靠 `check-fast.sh` 兜底 |
| 换了 `identity` | 被视为另一个插件，用户设置与凭据全部丢失 | `identity` 固定 `m3u8-resolver@cocolight` |
| 新增权限却没在 Release 说明里提 | 用户升级后发现插件停在「需要授权」状态 | 说明里单列一条 |
| 往已发布的版本节继续追加条目 | 已发布内容被篡改，无法回溯 | 已发布节**只读**，新改动进 `[Unreleased]` |

## 5. 预发布（需要时）

要给使用者提前试用时，用语义化版本的预发布标识，例如 `v2.3.0-rc.1`：

- tag 与 Release title 仍然保持一致；
- 在 GitHub 上把该 Release 勾选为 **pre-release**；
- `CHANGELOG.md` 里记在 `[Unreleased]` 下或单开 `[2.3.0-rc.1]` 节 —— 二选一，但同一项目内保持一致。
