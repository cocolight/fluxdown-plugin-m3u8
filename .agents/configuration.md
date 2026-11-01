# 仓库与项目配置说明

本文说明代码之外还需要配置什么：环境、Git、行尾与权限、CI、分支保护、依赖安全、文档站。
AI 的行为规则见 [AGENTS.md](../AGENTS.md)。

## 1. 环境要求

| 组件 | 要求 | 说明 |
|------|------|------|
| Node.js | ≥ 20（CI 用 22） | `package.json` 的 `engines` 已声明；ESM 项目 |
| npm | ≥ 10 | 用 `npm ci` 按 `package-lock.json` 安装 |
| Git | ≥ 2.28 | 需要 `git init -b`、`git branch -m` |
| Shell | POSIX `sh` | 仓库内脚本用 `#!/bin/sh`；Windows 下请用 Git Bash |
| FluxDown | ≥ 0.6.0 | 仅装机验证需要；`validate` 与全部测试不依赖客户端 |
| 编码 / 行尾 | UTF-8 / LF | 由 `.gitattributes` 强制，见 §2「行尾」 |

构建与测试不需要 ffmpeg / ffprobe / yt-dlp：它们在引擎侧运行，测试用假宿主替代。

## 2. Git 配置

### 默认分支

`master`。本仓库自 v1.1.0 起使用 `master`，与上游模板默认的 `main` 不同；仓库内文档、CI、分支保护一律按 `master` 写，不要混用。

### 提交署名（仓库级）

只影响当前仓库，不改动全局配置：

```bash
git config user.name  "your-name"
git config user.email "you@example.com"
```

### 行尾（最容易踩的坑）

仓库自带 `.gitattributes`，**库内一律以 LF 存储，且它会覆盖你全局的 `core.autocrlf=true`** —— 这是为了防止 shell 脚本在 Windows 检出后变成 CRLF（表现为 `#!/bin/sh^M: bad interpreter`）。

验证某个文件的实际规则：

```bash
git check-attr eol -- scripts/check-fast.sh   # 期望输出: eol: lf
```

若克隆后文件已被转成 CRLF，重新归一化：

```bash
git add --renormalize .
git commit -m "chore: normalize line endings"
```

### 文件权限位

shell 脚本在索引中必须是 `100755`，否则 Linux / macOS 上 `./scripts/x.sh` 会报 `Permission denied`（Windows 上看不出来，因为 `core.filemode=false`）。

```bash
git ls-files -s scripts/            # 期望: 100755 ...
git update-index --chmod=+x scripts/check-fast.sh
```

## 3. 目录约定

| 路径 | 用途 |
|------|------|
| `manifest.json` | 插件清单源文件，构建时拷入 `dist/` |
| `src/entry/` | 五个插件入口（resolver / hooks / auth / subscribe / intercept） |
| `src/lib/` | 入口共享的纯函数模块 |
| `tests/` | 五层测试，`tests/legacy/` 为冻结基线 |
| `docs/` | **只放使用者文档**：安装、使用、配置说明。工程文档不进这里 |
| `.agents/` | 工程协作文档：架构 / 配置 / 完成定义 / 发版 / ADR / 扩展点，AI 与人共读 |
| `.agents/skills/` | 可复用的 AI skill，按需自建（契约见 `skills/README.md`） |
| `scripts/` | 辅助脚本，含 `check-fast.sh` 快速门禁 |
| `.githooks/` | 本地 git 钩子，clone 后需执行一次 `git config core.hooksPath .githooks` |
| `.github/workflows/` | CI 工作流 |

两个目录的边界只有一条判据：**不读它，AI 会做错事吗？** 会 → `.agents/`；不会 → `docs/`。

详见 [architecture.md](architecture.md)；完成标准见 [definition-of-done.md](definition-of-done.md)；「要加 X 改哪里」见 [extension-points.md](extension-points.md)。

## 4. CI（GitHub Actions）

工作流是 `.github/workflows/build.yml`，三个 job：

| job id | 何时跑 | 作用 |
|--------|--------|------|
| `test` | push 到 `master`、`v*` tag、所有 PR | 快速门禁 + 类型检查 + 格式检查 + 构建 + manifest 校验 + 五层测试 |
| `Changelog gate` | 仅 PR | `feat`/`fix` 改了代码却没更新 `CHANGELOG.md` 时拦下 |
| `Release guard` | 仅 `v*` tag | 校验 `CHANGELOG.md` 有带**实际日期**的对应版本节（`未发布` 占位不通过）、`ROADMAP.md` 无 `in-progress` 行 |

首次推送到 GitHub 后，需要在仓库设置里补齐三步：

1. **启用 Actions**：Settings → Actions → General → Allow all actions and reusable workflows。
2. **收紧权限**：同页 Workflow permissions 选 *Read repository contents*（与 workflow 里的 `permissions: contents: read` 一致）。
3. **设置分支保护**：Settings → Rules → Rulesets → New branch ruleset，目标填 `master`，
   - 勾选 *Restrict deletions*、*Block force pushes*
   - 勾选 *Require a pull request before merging*（`Required approvals` 填 0 —— 单人仓库没有第二个人能批）
   - 勾选 *Require status checks to pass*，搜索并勾选 **`test`**，同时勾上 *Require branches to be up to date*

   ⚠️ required status checks 的名称必须与 workflow 中的 job 名称一致。`build.yml` 的 job id 是 `test` 且未设 `name`，因此在列表里显示为 `test`。若你改了 job 名，这里要同步改。

   ⚠️ **建完必须核对 `enforcement` 是否为 `Active`**。ruleset 可能停在 `Disabled`：界面上规则、目标分支、
   状态检查全都显示正常，但保护**完全没生效**，直到有人直推 `master` 成功才会暴露。核对命令：

   ```bash
   gh api repos/<owner>/<repo>/rulesets --jq '.[] | {id,name,enforcement}'
   gh api repos/<owner>/<repo>/rules/branches/master --jq '[.[].type]'
   ```

   第二条应返回 `deletion` / `non_fast_forward` / `required_status_checks` / `pull_request`；
   返回空数组即等于未保护。另注：`gh api .../branches/master/protection` 对 ruleset 恒返回 404，
   那是经典保护 API，查不到 ruleset，404 不代表没保护。

   用 ruleset 而非旧的 *Settings → Branches* 经典保护：经典保护无法表达 bypass 列表与多规则组合。
   两者可以共存，但**不要同时配**同一分支 —— 两套规则各自生效，出问题时分不清拦在哪一层。

### 合并策略

一个功能一个 PR，合并一律 **squash**（`gh pr merge <n> --squash --delete-branch`）：

- `master` 上一条提交 = 一个功能，回滚粒度与功能粒度一致；历史里不出现合并节点与半成品中间提交。
- squash 后的提交信息取 PR 标题，口径与 `CHANGELOG.md` 条目一致；PR 正文不进入提交历史，
  所以**取舍理由与验证数据要落在 ADR / `.agents/` / `CHANGELOG.md` 里**，不能只写在 PR 描述中。
- 合并后本地 `git merge --ff-only origin/master`。不要用会造合并节点的 `git pull`：本地多出合并提交后，
  再想推就得再开一个 PR 去合自己的合并提交。

**runner 镜像**：`runs-on` 显式写成 `ubuntu-24.04`，而不是 `ubuntu-latest`。跟随 latest 会在 GitHub 切换镜像时让 CI 行为突变——系统依赖的包名可能变化，CI 会在你毫无改动的一天突然变红。

本地检查与 CI 覆盖同样的三步，且与 `AGENTS.md` §2 完全一致：**安装依赖 → 类型检查 / 格式检查 → 测试**。

### 仓库公开时再补的社区健康文件

上面三步**私有仓库也该做**。GitHub 还推荐一组社区健康文件，用于公开项目接待外部使用者 —— 本仓库**没有**这些，是有意不预置，不是漏了。

| 文件 | 作用 |
|------|------|
| `CODE_OF_CONDUCT.md` | 行为准则（可套官方 Contributor Covenant 正文） |
| `SECURITY.md` | 漏洞报告渠道（同时在 Security 设置里开启私密漏洞报告） |
| `SUPPORT.md` | 求助渠道 |
| `ISSUE_TEMPLATE` | issue 表单 |

这几份全都要**项目级信息** —— 举报渠道、求助渠道、issue 字段。预置只会得到一份写着 TODO 的存根。要补时不必手写：GitHub 在 **Insights → Community Standards** 会列出缺哪几项，每项都有 **Add** 按钮。

## 5. 依赖更新与漏洞防护

许可证登记（`../THIRD-PARTY.md`）解决「能不能用」，本节解决「用得安不安全」。

### 平台侧开关

路径：Settings → Code security and analysis。

| 开关 | 作用 | 公开仓库 | 私有仓库 |
|------|------|---------|---------|
| Dependabot alerts | 依赖有已知漏洞时告警 | 免费 | 免费 |
| Dependabot security updates | 自动开 PR 把漏洞依赖升到安全版本 | 免费 | 免费 |
| Dependabot version updates | 定期开 PR 升级过期依赖（需 `dependabot.yml`） | 免费 | 免费 |
| Secret scanning + push protection | 检出并拦截提交 / 推送里的密钥 | 免费 | 需付费方案 |
| Code scanning | 静态安全扫描（默认设置用 CodeQL） | 免费 | 需付费方案 |

Dependabot 三项在所有仓库免费；版本更新也可用第三方 bot（如 Renovate）替代，与 Dependabot 二选一，同时开会产生重复 PR。

### 漏洞响应约定

- 收到漏洞告警先查 `../THIRD-PARTY.md` 的「是否随分发」列：随分发的优先处理。
- 本项目运行时零 npm 依赖，`devDependencies` 均不随产物分发，实际风险面是构建期。
- 升级依赖后同步更新该表的「版本」列，登记与实际不符等于没登记。
- 修复记入 `CHANGELOG.md`；已发版的按 [releasing.md](releasing.md) 评估是否发补丁版本。

## 6. 文档站与静态发布

工程文档在 `.agents/`、不在 `docs/` 下，所以把 `docs/` 直接当发布源时它天然不会被带上。

要留意的是反方向：`docs/` 里**所有**内容都会被发布，而发布出去的内容**在公网可访问，即使仓库是私有的**。不要把内部草稿、未定稿的运营材料放进 `docs/`。

`.agents/` 是点目录：git 与 GitHub 网页都能浏览、能搜索到，只是静态站生成器与 ripgrep 默认跳过它。代价是 `grep` 默认搜不到里面的内容，所以 `AGENTS.md` §1 的路由表是唯一可靠的入口。

## 7. 落地配置清单

- [ ] 填写 `AGENTS.md` §2「常用命令」表（AI 依赖它）
- [ ] 执行一次 `git config core.hooksPath .githooks`（否则提交时不跑门禁）
- [ ] 确认 `./scripts/check-fast.sh` 通过
- [ ] 确认 `.gitattributes` 已随仓库提交（库内 LF）
- [ ] 确认 `scripts/check-fast.sh`、`.githooks/pre-commit` 索引模式为 `100755`
- [ ] GitHub：启用 Actions、收紧 Workflow permissions
- [ ] GitHub：为 `master` 开启分支保护 + required status checks（`test`）
- [ ] GitHub：开启 Dependabot 漏洞告警与自动修复 —— 见 §5
- [ ] （可选，仅仓库要公开时）补齐社区健康文件 —— 见 §4
- [ ] （可选，仅做文档站时）确认 `docs/` 里没有不该公开的内容 —— 见 §6

## 8. 常见问题

| 现象 | 原因 | 处理 |
|------|------|------|
| `bad interpreter: /bin/sh^M` | 脚本被检出为 CRLF | 见 §2 行尾 |
| `Permission denied: ./scripts/x.sh` | 索引缺可执行位 | 见 §2 文件权限位 |
| CI 里 `git diff --check` 出现大量行尾改动 | 全局 `autocrlf` 与 `.gitattributes` 冲突 | `git add --renormalize .` 后提交 |
| 改了 job 名后 PR 一直卡在 "Expected" | required status checks 名称未同步 | 见 §4 第 3 步 |
| `validate` 报 `elevated` 而非 `valid` | `auth` + `ffmpeg` 权限决定的风险等级，属预期 | 不是缺陷 |
