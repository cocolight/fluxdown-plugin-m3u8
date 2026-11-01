# fluxdown-plugin-m3u8 功能清单（ROADMAP）

> 状态取值：`planned` / `in-progress` / `done` / `dropped`。
> 「验收标准」须**可判定**（能被命令或明确检查验证），AI 助手据此判断功能是否完成。
>
> **归档规则**：`done` / `dropped` 行累计约 20 条时，把最旧的移入 `.agents/archive/roadmap.md`
> （移动而非删除，历史可追溯）；本表保留未完成行与最近完成项。归档不改写任何行的内容与验收标准。

| # | 功能 | 分支 | 状态 | 依赖 | 验收标准 |
|---|------|------|------|------|----------|
| 1 | SDK 工程化骨架（M1）：TS 源码、`dist/` 产物、冻结基线与 parity 比对 | - | done | - | `npm run parity` 67/67 一致；`npm run build` 与 `npm run validate` 通过；`dist/` 含 5 个入口脚本与 `manifest.json` |
| 2 | 请求面改用 `RequestPatch`（M2） | - | done | 1 | `npm run contract` 全绿；凭据只对登记 origin 下发（契约断言）；parity 仍 67/67 |
| 3 | `segments` 级去广告（M3） | - | done | 2 | `npm run intercept` 33 项全绿；`adRulesMode=off` 时产物与 M2 逐字一致 |
| 4 | 后处理与产物登记（M4） | - | done | 3 | `npm run postprocess` 31 项全绿；parity 63/67 + 4 项 `diverges` 声明；`npm run validate` 通过 |
| 5 | 工程规范改造：AI 协作骨架、四层门禁、文档分层 | - | done | 4 | `./scripts/check-fast.sh` 通过；`AGENTS.md` ≤200 行；`.agents/` 下每篇 `.md` 均在 `AGENTS.md` §1 路由表；`docs/` 只剩使用者文档 |
| 6 | 设置页视图（M5）：`main` + `contributes.views` 做去广告规则编辑 | - | done | 4 | 视图在桌面与 Web 均渲染；`npm run validate` 风险等级仍为 `elevated`（未引入 `desktop` 权限） |
| 7 | 装机实测收口：`.agents/sdk-migration.md` 第九节 22 项 | - | planned | 4 | 该表每行都有「结论」列且非空；结论与代码不一致时已开对应改动项 |
| 8 | 字幕下载 / 封装 | - | dropped | - | 判定依据：`.agents/capability-matrix.md` §4 —— resolver 返回值无字幕字段，插件亦不能写入下载目录 |
| 9 | 移除登录入口，凭据改由设置项 `authCookie` 直供（v3.0.0） | - | done | 6 | `contract` 断言 manifest 无 `auth` 段/无 `auth` 权限/产物无 `auth.js`；`npm test` 五层全绿 |
| 10 | 设置页改为「大众 / 专业」两档视图 | - | in-progress | 9 | `expertMode` 默认关时只显示 12 项常用设置；`npm run ui` 断言两档渲染与切换 |

> 第 1、2 行写的「parity 67/67 一致」是 M1 / M2 当时的验收口径，按只追加规则原样保留。
> M4 起 parity 口径为 63/67 一致 + 4 项 `diverges` 声明（见第 4 行），以 `npm run parity` 实际输出为准。
> 第 6 行的「视图在桌面与 Web 均渲染」在无图形环境里无法自证：可判定部分（`validate` 仍为 `elevated`、
> `npm run ui` 37 项通过、未声明 `desktop` 因而恒为可移植视图）已满足，两端实际渲染留作装机待实测项 #19。
> v3.0.0 起 parity 口径再次变化：移除登录入口后 13 条 `auth` 场景一并删除，凭据 3 条改为 `authCookie` 驱动，
> 现为 46/53 一致 + 7 项 `diverges`；数字以 `npm run parity` 实际输出为准。
