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

## 本地检查

克隆后安装一次钩子，否则 `git commit` 不会跑门禁：

```bash
git config core.hooksPath .githooks
```

结构类断言只有一份，在 `scripts/check-fast.sh`，CI 调同一个脚本：

```bash
./scripts/check-fast.sh
```

其余命令与 `AGENTS.md` §2「常用命令」完全一致：

```bash
npm ci                # 安装依赖
npm run typecheck     # 类型检查（兼静态检查）
npm test              # 六层测试：parity / contract / intercept / postprocess / subscribe / ui
```

`./scripts/check-fast.sh` 已经包含格式类断言（行尾空白、冲突标记、版本号一致、文档路由表），无需另跑格式化工具。

装机前另跑 `npm run build` 与 `npm run validate`；发布包用 `npm run pack`。

## 发版

发版**单独走一个 PR**，不要混进功能 PR 里顺手做。前置条件与步骤见 `AGENTS.md` §3「发版」，完整清单见 `.agents/releasing.md`。

## 红线与完成定义

- 提交前请阅读 `AGENTS.md` 的「红线」。
- 功能是否算完成，以 `.agents/definition-of-done.md` 为准。

## 许可证

本项目采用 MIT 许可证，详见 [LICENSE](LICENSE)。
