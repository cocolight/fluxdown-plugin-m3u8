# fluxdown-plugin-m3u8 功能清单（ROADMAP）

状态取值 `planned` / `in-progress` / `done` / `dropped`。「验收标准」须可判定，能被命令或明确检查验证。

归档规则：`done` / `dropped` 行累计约 20 条时，把最旧的移入 `.agents/archive/roadmap.md`。移动而非删除，归档不改写任何行的内容。

| # | 功能 | 分支 | 状态 | 依赖 | 验收标准 |
|---|------|------|------|------|----------|
| 1 | SDK 工程化骨架（M1）：TS 源码、`dist/` 产物、冻结基线与 parity 比对 | - | done | - | `npm run parity` 67/67 一致；`npm run build` 与 `npm run validate` 通过；`dist/` 含 5 个入口脚本与 `manifest.json` |
| 2 | 请求面改用 `RequestPatch`（M2） | - | done | 1 | `npm run contract` 全绿；凭据只对登记 origin 下发（契约断言）；parity 仍 67/67 |
| 3 | `segments` 级去广告（M3） | - | done | 2 | `npm run intercept` 33 项全绿；`adRulesMode=off` 时产物与 M2 逐字一致 |
| 4 | 后处理与产物登记（M4） | - | done | 3 | `npm run postprocess` 31 项全绿；parity 63/67 + 4 项 `diverges` 声明；`npm run validate` 通过 |
| 5 | 工程规范改造：AI 协作骨架、四层门禁、文档分层 | - | done | 4 | `./scripts/check-fast.sh` 通过；`AGENTS.md` ≤200 行；`.agents/` 下每篇 `.md` 均在 `AGENTS.md` §1 路由表；`docs/` 只剩使用者文档 |
| 6 | 设置页视图（M5）：`main` + `contributes.views` 做去广告规则编辑 | - | done | 4 | 视图在桌面与 Web 均渲染；`npm run validate` 风险等级仍为 `elevated`（未引入 `desktop` 权限） |
| 7 | 装机实测收口：`.agents/sdk-migration.md` 第九节 3 项 | - | in_progress | 3 | 该表每行都有「结论」列且非空；结论与代码不一致时已开对应改动项 |
| 13 | 装机实测缺测试源的 3 项：#4 手选变体、#13 丢分片续传、#17 `maxRangeBytes`+`ephemeral` | - | planned | 7 | 三项各自在真机上跑出结论并写进 `.agents/sdk-migration.md` 第九节 |
| 14 | 插件设置页签分流：站点生效范围、开关项、去广告三项进「插件设置」，其余参数留在「基础设置」 | - | planned | 12 | `npm run ui` 断言字段分区与顺序；`contract` 断言存在 `settings` 位置视图；桌面端两页签可切换且各自保存 |
| 15 | 凭据站点约束收紧：裸域改精确匹配 + 缺省继承 `targetHosts` | - | done | 5 | ADR-0011；`contract` 65 项；真机 A/B 确认子域不再拿到 Cookie |
| 8 | 字幕下载 / 封装 | - | dropped | - | 判定依据：resolver 返回值无字幕字段，插件亦不能写入下载目录（见 `.agents/capability-matrix.md` §4） |
| 9 | 移除登录入口，凭据改由设置项 `authCookie` 直供（v3.0.0） | - | done | 6 | `contract` 断言 manifest 无 `auth` 段/无 `auth` 权限/产物无 `auth.js`；`npm test` 五层全绿 |
| 10 | 设置页改为「大众 / 专业」两档视图 | - | done | 9 | `expertMode` 默认关时只显示 12 项常用设置；`npm run ui` 断言两档渲染与切换 |
| 11 | 设置页改三个页签（基础 / 参数 / 去广告），去掉 `expertMode` | - | done | 10 | `npm run ui` 48 项全绿；基础页只有开关、参数类项不出现在基础页；三页求和覆盖 manifest 全部 27 项 |
| 12 | 设置面收敛为宿主表单，删自定义视图与 `main` 入口（v3.0.0） | feature/settings-host-form | done | 11 | `npm run ui` 18 项全绿（开关成组 / 主题前缀 / 默认值锁定 / 产物形态）；`contract` 32 项含「无 main / 无 views」；dist 无 `main.js`、零 SDK 运行时 |

## 验收口径的现状

表内各行写的是**当时**的验收口径，按只追加规则原样保留。当前以命令实际输出为准：

| 项目 | 现行口径 |
| --- | --- |
| `npm run parity` | 46/53 一致 + 7 项 `diverges` 声明 |
| `npm run contract` | 65 项 |
| `npm run ui` | 21 项 |
| `npm run intercept` | 74 项 |
| `npm run postprocess` | 36 项 |
| `npm run subscribe` | 14 项 |
| 装机待验项 | 3 项（`.agents/sdk-migration.md` 第九节；原 18 项，2026-11-02 定案 6 项，2026-11-03 定案 9 项） |

已被取代的口径：第 1、2 行的 `parity 67/67` 是 M1 / M2 当时的标准；第 4 行的 `63/67 + 4 diverges` 是 M4 到 v2.2.0 的标准。第 10 行（`expertMode` 两档）被第 11 行取代，第 11 行（三页签、ui 48 项）被第 12 行取代。第 6 行的「视图在桌面与 Web 均渲染」已无法验证，因为视图本身在 v3.0.0 被删除，原待实测项 #19 至 #23 随之失效。
