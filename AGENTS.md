# AGENTS.md — 给 AI 编码助手的行为规则

> 本文件供 AI 编码助手（WorkBuddy / Claude Code / Cursor 等）自动读取。
> **开始任务前先读完本文件；需求含糊时先提问，不要臆造。**

## 0. 项目

fluxdown-plugin-m3u8 — FluxDown 下载器的 HLS/DASH 发现与变体解析插件，TypeScript 源码经
`fluxdown-plugin build` 打包成 `dist/`，插件本体是 `dist/` 而非仓库根。

## 1. 上下文入口（按任务路由，不要全读）

开任何任务先读本文件；其余按下表按需读，不要一次全读 —— 全读会挤掉代码上下文。

| 你要做什么 | 先读 |
|---|---|
| 判断「算不算做完」 | `.agents/definition-of-done.md` |
| 改代码前确认分层、依赖方向、腐化信号 | `.agents/architecture.md` |
| 配置仓库 / CI / 分支保护 / 依赖安全 | `.agents/configuration.md` |
| 打 tag、建 Release | `.agents/releasing.md` |
| 动手前查「要加 X 改哪里」 | `.agents/extension-points.md` |
| 改动涉及插件系统能力、SDK 门槛、装机待验项 | `.agents/sdk-migration.md` |
| 判断某能力是「插件没做」还是「接口不存在」 | `.agents/capability-matrix.md` |
| 追溯 DASH 发现层的历史开发计划 | `.agents/archive/dash-discovery-plan.md`（历史归档，不作现行依据） |
| 追溯旧去广告路线的调研与死路 | `.agents/archive/ad-removal-notes.md`（历史归档，不作现行依据） |
| 确认当前任务与验收标准 | `ROADMAP.md` |
| 改动涉及既有架构取舍 | `.agents/adr/`（先读索引） |
| 加或改 AI skill | `.agents/skills/README.md` |
| 安装、运行、给使用者的说明 | `README.md`、`docs/settings.md` |

> 事实以源码为准：用 `read` 看结构、`grep` 查事实，文档只给坐标。
>
> `.agents/` 是点目录，`grep` 默认搜不到它，所以上表是它唯一可靠的入口。

> **文档落点**：`.agents/` 是工程协作文档（AI 与人共读），改动须走 §9 同改矩阵；**`docs/` 只放使用者文档**（安装、使用、配置说明），工程文档一律不进 `docs/`。`.agents/` 下新增 `.md` 必须在上表出现，否则 `scripts/check-fast.sh` 拦下。

## 2. 常用命令（可直接复制执行）

| 目的 | 命令 |
|------|------|
| 安装依赖 | `npm ci` |
| 运行（装机） | `npm run build`，然后在 FluxDown「设置 → 扩展 → 插件 → 从目录安装」选 `dist/` |
| 测试 | `npm test`（parity + contract + intercept + postprocess + ui 串联） |
| Lint | `npm run typecheck`（`tsc --noEmit`，兼类型检查与静态检查） |
| 格式化检查 | 无独立工具；行尾空白与冲突标记由 `./scripts/check-fast.sh` 断言（理由见 §4 第 11 条） |
| 快速门禁（提交前与 CI 同跑，无需填写） | `./scripts/check-fast.sh` |

装机前另跑 `npm run validate`：确定 manifest 与产物符合插件规范。它报 `valid (risk: elevated)` 是预期。

## 3. 工作流

- 保护分支 `master`，禁止直接推送。本仓库沿用建库分支名 `master`（与上游模板的 `main` 不同），仓库内文档、CI、分支保护一律按 `master` 写。
- 一个功能 = 一个 `feature/<名称>` 分支 = 一个 PR。
- 新功能开发前，先在 `ROADMAP.md` 加一行（状态 `planned`、写清验收标准），确认后才转 `in-progress` 开干；小改动 / bugfix 无需走计划。
- 提交：Conventional Commits，type 用英文前缀（`feat`/`fix`/`docs`/`test`/`chore`/`refactor`/`ci`）；描述可用中文；标题总长 ≤ 72 字符。
- 每完成一项，更新 `ROADMAP.md` 对应行状态，并在 `CHANGELOG.md` 的 `[Unreleased]` 对应分类补一条。

### 发版（打 tag / 建 Release）

> 发版不是「功能做完」的自然结果，而是一次独立动作：单独走一个 PR，合并后再打 tag。完整清单见 `.agents/releasing.md`。

- **前置**：CI 全绿；`ROADMAP.md` 无 `in-progress` 行；`CHANGELOG.md` 的 `[Unreleased]` 已写全。
- **命名**（三处必须一致）：tag 用 `vX.Y.Z`（带 `v`）；Release title 与 tag 完全相同；`CHANGELOG.md` 版本节写 `[X.Y.Z] - 日期`（**不带** `v`）。
- **顺序**：先改版本号（`manifest.json` 与 `package.json` 两处）与 `CHANGELOG.md` → 提 PR 合入 `master` → **在 `master` 上**打 tag → 建 Release → 附 `npm run pack` 产物。
- 未经明确要求，不得 `git tag` / 推送 tag / 建 Release —— 见 §4 红线第 6 条。

## 4. 红线（违反即回滚）

红线分两级：**阻断级**是底线，触碰即回滚；**提醒级**是默认做法，偏离须在 PR 说明里写明理由。

**阻断级（不可触碰）**

1. 不得删除 / 跳过 / 弱化测试（含 `skip`、注释掉断言、放宽比较），不得伪造「测试已通过」。
2. `tests/legacy/` 是 v1.8.0 冻结基线，**不得修改**。有意改变的行为进 `contract` / `intercept` / `postprocess`，不得靠改基线或删 `diverges` 声明抹平 parity 差异。
3. 产物零 SDK 运行时：SDK 导出一律 `import type`，不得引入 `sdk/ui/jsx-runtime`、`defineMain` 等任何运行时导出（历史例外已随视图删除解除，见 ADR-0009；`tests/ui.mjs` 有产物级断言）。
4. 不得更换 `identity`（`m3u8-resolver@cocolight`）——换了即视为另一个插件，用户设置与凭据全部丢失。
5. 大改动先确认：单次改动 > 5 个文件 或 > 200 行，先给方案，等确认再动手。
6. 不得擅自 `git commit` / `push` / `push --tags` / `tag` / `rebase` / `reset` / `--force`、创建 Release、切分支或改远程；仅在明确要求时执行。
7. 不得为了让检查「变绿」而修改 CI、hook、lint 配置或测试门禁。
8. 不得修改 `.agents/adr/` 中「已接受」的记录；变更须新增 ADR。
9. 绝不提交密钥 / token / 私钥 / `.env` / 真实 Cookie（用环境变量或仓库外文件，测试用假值）。

**提醒级（须写明理由）**

10. 含糊需求先提问；同一问题连续 2 次修复失败，停下说明现状并求助。
11. 只改与任务相关的文件，不做无关重构、不顺手改格式。本项目**不引入**格式化工具：全量格式化会产生掩盖真实改动的 diff。
12. 交付物只写项目相关内容：PR 描述、CHANGELOG、文档、代码注释等面向读者的内容，不得夹带与本项目无关的本地环境 / 工具链 / 沙箱 / 认证等 Agent 运行问题，以及 AI 的执行过程。
13. 文档写给人看。每节先给结论，句子短，用具体名词。不写元话语，不写「值得注意的是」「众所周知」这类填充语。负面清单，命中即改：破折号插入语成墙；①②③④ 编号癖和多事项巨型长条目；辩护式长括号；无对应提交的「原先 / 之前」虚构历史；拟人化修辞对比；营销式分区标题；面向 AI 的过程说明与验证过程叙事。
14. 常驻上下文文档控体积：`AGENTS.md` 不超过 200 行（CI 行数断言）。超限先拆：详细内容下沉 `.agents/`，本文件只留入口指针与红线。
15. 决策即时沉淀：重要取舍 / 非显而易见的决定，落仓库即生效，不依赖会话记忆 —— 小决策随改动记 `CHANGELOG.md` 条目「（理由：一句话）」，需留痕的架构决策新增一条 ADR（§9）。

## 5. 完成定义（DoD）

详见 `.agents/definition-of-done.md`。任一功能完成须同时满足：

- [ ] `ROADMAP.md` 该行「验收标准」全部满足
- [ ] 新增 / 更新对应测试且符合测试质量基线（断言行为而非实现、测试名说清场景、拒绝空转断言、变异自检），五层测试全量通过
- [ ] 类型检查与格式检查通过
- [ ] 相关文档（README / AGENTS / architecture / ADR / CHANGELOG）同步更新
- [ ] `CHANGELOG.md` 的 `[Unreleased]` 已记录本次改动
- [ ] `ROADMAP.md` 状态更新为 `done`

## 6. 并发协作（多 AI / 多人）

- 一个分支只由一个执行者写入；动手前先 `git fetch`，避免同文件并发编辑。
- 遇到冲突立即停止并说明，不要擅自 `--force`。

## 7. 安全

- 绝不提交密钥 / token / 私钥 / 真实凭据。
- `tests/` 必须保持可运行。
- 插件存储与日志中不得出现 Cookie、`Authorization` 值、Basic 凭据正文。

## 8. 单一事实源坐标

> 本表只给「去哪查」，不给「查到什么」。事实层（版本号、设置项、接口、数据结构）一律以代码为准。
> 任何文档都**不得**维护「完整文件清单 / 完整设置项清单」这类每次提交都漂移的枚举；源码是唯一事实源。

| 契约 / 事实 | 唯一事实源在哪 |
|---|---|
| 设置键 / 设置项定义 | `manifest.json` 的 `settings[]`（27 项）。`docs/settings.md` 是面向使用者的逐项说明，可能滞后，冲突以 manifest 为准 |
| 外部接口契约 | `src/types.ts` + `fluxdown-plugin-sdk` 的类型定义（宿主侧字段以 SDK 为准，SDK 未声明的在 `types.ts` 补注） |
| 数据结构与存储 | `src/lib/handled.ts`（任务标记）、`src/lib/items.ts`（剧集条目映射）、`src/lib/settings.ts`（设置读取与默认值） |
| 关键算法或业务规则 | `src/lib/adrules.ts`（去广告三条纪律）、`src/lib/hls.ts`（变体与音轨解析）、`src/lib/discovery.ts`（master / mpd 发现）、`src/lib/naming.ts`（命名决策链） |
| 设置页视图 / 界面节点 | `src/entry/main.tsx`（`flux.ui.view` 注册与 JSX 节点树）、`src/lib/rulecheck.ts`（界面侧规则校验，与 `adrules` 同源）、`src/lib/adpresets.ts`（预设档位） |
| 版本号 | `manifest.json` 的 `version`（事实源）与 `package.json` 的 `version`，两者必须相等，由 `scripts/check-fast.sh` 断言 |
| 插件系统版本门槛 | `.agents/sdk-migration.md` 的版本门槛表（哪个字段自哪个引擎版本提供） |
| 第三方依赖许可证 | `THIRD-PARTY.md`（每引入一个直接依赖须登记：许可证 SPDX 标识、用途、是否随分发） |

## 9. 同改矩阵

> 改了什么，同一回合必须过一遍哪些地方；只改一处导致两份文档打架是禁止的。

| 改了什么 | 同回合必须过一遍 |
|---|---|
| `.agents/` 下新增 / 改名 / 删除 `.md` | §1 路由表（漏了 `scripts/check-fast.sh` 会拦） |
| 架构 / 分层 / 不变式 | `.agents/architecture.md`；需要留痕的追加 `.agents/adr/` |
| 设置键 / 设置项 | `manifest.json` 的 `settings[]` → `src/lib/settings.ts` → `docs/settings.md` → §8 坐标表 |
| 仓库配置 / CI / 分支保护 / 依赖安全 | `.agents/configuration.md` |
| 入口 / 构建映射 | `fluxdown-plugin.config.json`、`manifest.json` 对应段、README「文件结构」 |
| 命令或门禁 | §2 常用命令 → `CONTRIBUTING.md` → `scripts/check-fast.sh` → `.github/workflows/build.yml`，四处必须一致 |
| `scripts/check-fast.sh` 或 `.githooks/` | CI 调用同一步：本地与 CI 共用一份断言，不得各写一遍 |
| 测试分层或断言口径 | `tests/` → `.agents/architecture.md` §7 → `.agents/definition-of-done.md` |
| 红线 / DoD | `.agents/definition-of-done.md` 同步（不得放宽） |
| 章节标题 | 全仓扫一遍按「§N」引用本文件的地方 |
| 决策理由变更 | 新增一条 ADR，`.agents/adr/` 旧记录原样保留 |
| 发版（打 tag / 建 Release） | 按 §3「发版」与 `.agents/releasing.md` 的清单执行；同一回合过一遍：tag 与 Release title 都是 `vX.Y.Z`、`CHANGELOG.md` 版本节是 `[X.Y.Z] - 日期`（不带 v）且顶部已补回空的 `[Unreleased]`、两处版本号已同步 |
