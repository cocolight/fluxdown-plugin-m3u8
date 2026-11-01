# 第三方依赖许可证记录（THIRD-PARTY）

本文件记录本项目**直接引入的开源 / 第三方依赖**及其许可证，供合规审查使用。
新增依赖时**必须**在此登记一行（规则见 [`AGENTS.md`](AGENTS.md) §8 坐标表与 [`.agents/architecture.md`](.agents/architecture.md) §5）。

## 为什么需要

引入第三方工具 / 库时，其许可证（如 GPL、MIT、Apache-2.0）可能附带分发、署名、源码提供等义务。
本文件是这些义务的**单一事实源**，避免依赖信息散落在包管理器文件或 PR 描述里、难以审计。

## 登记规则

每引入一个直接依赖，追加一行（已登记的依赖不要删除；若移除请保留该行并标注状态）：

| 依赖 | 版本 | 许可证（SPDX） | 用途 | 是否随分发 | 备注 |
|------|------|----------------|------|-----------|------|
| fluxdown-plugin-sdk | 0.5.0 | AGPL-3.0-or-later | 宿主 API 的类型定义；`main` 视图的 JSX 运行时 | **是**（仅 `ui/jsx-runtime`，内联进 `dist/main.js`） | 类型部分 `import type` 构建期擦除；运行时部分见下节，决策见 ADR-0005 |
| typescript | 5.9.3 | Apache-2.0 | 类型检查与构建期转译 | 否（devDependency） | 不进入 `dist/` |
| ffmpeg / ffprobe | 由 FluxDown 组件安装 | LGPL-2.1-or-later 或 GPL-2.0-or-later（取决于发行构建） | 容器探测、转封装、音轨合并 | 否（外部程序，用户侧安装） | 经 `flux.ffmpeg` 以进程调用，不做链接 |
| yt-dlp | 由 FluxDown 组件安装 | Unlicense | 复杂站直链抽取兜底 | 否（外部程序，用户侧安装） | 可选；未安装时相关设置项无效 |

说明：

- **直接依赖**才登记；传递依赖由包管理器自动解析，不在此列。
- **许可证**填 SPDX 标识符（如 `MIT`、`Apache-2.0`、`GPL-3.0-only`），多个许可证用 `OR` / `AND` 连接。
- **是否随分发**决定合规义务强度：随产物分发的义务最重。产物是自包含 IIFE，运行时无 npm 依赖；
  目前**唯一**随 `.fxplug` 分发的第三方代码是 SDK 的 JSX 运行时（见下节）。
- **版本**填当前生效的版本号；升级依赖时同步改这一行。登记与实际不符，审计时等于没登记。
- **漏洞响应**：收到依赖漏洞告警时先看「是否随分发」列；修复与升级记入 `CHANGELOG.md`。开关与流程见 [`.agents/configuration.md`](.agents/configuration.md) §5。

## 随产物分发的 AGPL 组件

| 项 | 内容 |
|---|---|
| 组件 | `fluxdown-plugin-sdk` 的 `dist/ui/jsx-runtime.js`（导出 `jsx` / `jsxs` / `Fragment`） |
| 许可证 | AGPL-3.0-or-later（上游 MIT 之外的唯一选择，见 SDK `package.json`） |
| 进入方式 | `main.tsx` 的 JSX 编译为对该运行时的调用，esbuild 打包时内联进 `dist/main.js`（约 +1.6 KB） |
| 影响范围 | **只有 `dist/main.js`**。其余五个入口（resolver / hooks / auth / subscribe / intercept）不含任何 SDK 运行时符号 |
| 决策依据 | [`.agents/adr/0005-allow-sdk-jsx-runtime.md`](.agents/adr/0005-allow-sdk-jsx-runtime.md)（取代 ADR-0004） |

由此产生的义务与边界：

1. **提供对应源码**：含 AGPL 代码的分发物（`dist/main.js` 及打包后的 `.fxplug`）须随附对应源码。
   本仓库公开、`npm run build` 可复现同一产物，义务可满足 —— 这一点必须在改成分发二进制或闭源前重新核对。
2. **不得附加额外限制**：不能对该分发物施加比 AGPL 更严的条款（例如禁止再分发、加商业许可限制）。
   本项目自身代码仍以 MIT 授权，但**含该运行时的分发物整体**按 AGPL 条款提供。
3. **闭源即冲突**：若日后再想闭源分发或加限制性条款，本项是第一个障碍。出路只有两条：退回
   `flux.ui.h`（见 ADR-0004 的实现记录）或整包改为 AGPL。
4. **升级需复核**：升级 `fluxdown-plugin-sdk` 时确认 `ui/jsx-runtime.js` 的实现有没有变（当前 47 行，
   会丢掉 `undefined` 值的 props、把 `key` 放进 `p.key`、用 `collect` 摊平数组与 `Fragment`）。
   行为变化会改变视图树的形状，而 `tests/ui.mjs` 只校验 schema 不校验实现细节。

## 与 LICENSE 的区别

`LICENSE` 是**本项目自身**的许可证（MIT）。本文件记录**本项目所依赖的第三方**许可证，二者不混。
SDK 是 AGPL-3.0-or-later：它的类型只以 `import type` 引用（构建期擦除），**JSX 运行时随产物分发** ——
这一处是明确接受的例外，不是遗漏，义务与边界见上节。
