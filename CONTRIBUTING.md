# 贡献指南

使用 AI 编码助手开发时，请先阅读 [AGENTS.md](AGENTS.md)（规则与红线）。

## 分支策略

- `master` 为默认分支（本仓库沿用建库分支名，与上游模板的 `main` 不同），禁止直接推送。
- 从 `master` 切 `feature/<名称>` 分支，一个功能一个分支。

## 提交规范

- Conventional Commits，type 用英文前缀：
  `feat:`（新功能）`fix:`（修复）`docs:`（文档）`test:`（测试）`chore:`（杂项）`refactor:`（重构）`ci:`（CI）。
- 描述可用中文，简明；标题总长 ≤ 72 字符。
- 不加 AI 协作署名，不加 `Co-Authored-By` / `Signed-off-by` trailer。

## Pull Request

- 向 `master` 提 PR，说明做了什么、为什么，并关联 `ROADMAP.md` 对应行。
- 确保本地检查通过（见下）后再提。
- 改动同步完成的文档见 [AGENTS.md](AGENTS.md) §9「同改矩阵」；改了什么必须同回合过的那些地方都过一遍。
- 新功能先在 `ROADMAP.md` 加一行（状态 `planned`、写清验收标准），确认后才转 `in-progress` 动手；小改动与 bugfix 不走计划。
- 功能完成后把 `ROADMAP.md` 该行改为 `done`，并在 `CHANGELOG.md` 的 `[Unreleased]` 对应分类补一条。

## 本地检查

克隆后安装一次钩子，否则 `git commit` 不会跑门禁：

```bash
git config core.hooksPath .githooks
```

结构类断言只有一份，在 `scripts/check-fast.sh`，CI 调同一个脚本：

```bash
./scripts/check-fast.sh
```

其余命令与 `AGENTS.md` §2「常用命令」完全一致。提交前至少跑这三条：

```bash
npm ci                # 安装依赖
npm run typecheck     # 类型检查（兼静态检查）
npm test              # 六层测试串联
```

`npm test` 的六层各自比什么、什么时候单独跑某一层：

| 命令 | 断言什么 |
| --- | --- |
| `npm run parity` | 与 v1.8.0 行为等价（`dist/` 对 `tests/legacy/` 逐场景比对） |
| `npm run contract` | 请求面契约：凭据只走 `originHeaders`、Basic 的 UTF-8 编码、凭据不落库 |
| `npm run intercept` | 拦截器契约：成对丢弃、不跨密钥边界、不丢空、只碰本插件任务 |
| `npm run postprocess` | 后处理契约：产物登记、ffprobe 判容器、探测失败退回扩展名判断 |
| `npm run subscribe` | 订阅契约：防抓页解锁只重取一次、订阅源 Cookie 不丢 |
| `npm run ui` | 设置表单契约：开关成组、主题前缀、默认值与 `settings.ts` 对账 |

`./scripts/check-fast.sh` 已经包含格式类断言（行尾空白、冲突标记、版本号一致、文档路由表），无需另跑格式化工具。

装机前另跑 `npm run build` 与 `npm run validate`；发布包用 `npm run pack`。

## 代码约定

- **依赖边界**：SDK 只以 `import type` 引用（SDK 为 AGPL-3.0-or-later，本项目 MIT），产物零 SDK 运行时。改依赖后同步 [THIRD-PARTY.md](THIRD-PARTY.md)。
- **改动回流**：改 `src/lib/*.ts` 的共享逻辑时，检查受影响的入口是否都改了。四个入口构建后是彼此独立的上下文，运行时不能互相引用。
- **不做无关改动**：只改与任务相关的文件，不顺手重构、不顺手改格式。本项目不引入格式化工具，全量格式化会产生掩盖真实改动的 diff。

## 文档放哪里

使用者文档放 `docs/`，工程文档放 `.agents/`。判据只有一条：不读它会不会做错事。`.agents/` 下新增 `.md` 必须登记进 `AGENTS.md` §1 路由表，否则 `check-fast.sh` 会拦。

## 发版

发版**单独走一个 PR**，不要混进功能 PR 里顺手做。前置条件与步骤见 `AGENTS.md` §3「发版」，完整清单见 `.agents/releasing.md`。

## 红线与完成定义

- 提交前请阅读 `AGENTS.md` 的「红线」。
- 功能是否算完成，以 `.agents/definition-of-done.md` 为准。

## 许可证

本项目采用 MIT 许可证，详见 [LICENSE](LICENSE)。
