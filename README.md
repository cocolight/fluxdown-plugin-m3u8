# M3U8 发现与变体解析器（FluxDown 插件）

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

一个 [FluxDown](https://github.com/zerx-lab/FluxDown) 下载器插件。把播放页或 `master.m3u8` 解析成可直接下载的 HLS 播放列表：自动发现正确清单、解析多码率变体、补齐 `Referer`/`Origin`/`UA` 等鉴权头，交给 FluxDown 内置 HLS 引擎下载合并。页面只提供 DASH 清单时，把 `.mpd` 地址交给核心 DASH 引擎。

适用场景是 HLS 流媒体下载，兼带 DASH 的地址发现。需要 FluxDown 0.6.0 及以上，推荐最新版。

## 功能特性

### 解析

- **自动发现 master**：粘贴 `.m3u8` 直链直接处理。粘贴播放页时从页面源码抠出 `master.m3u8`，支持 `https:\/\/` JSON 转义与相对地址。复杂站点可自定义 `extractMaster`。
- **多码率变体解析**：解析 `#EXT-X-STREAM-INF`，按带宽列出画质，支持手动选择或按偏好自动选。
- **音视频分离**：识别独立音轨并作为 `audioUrl` 返回，由核心合并为单文件。可按语言指定音轨，也可只下音轨。
- **DASH 清单发现**：页面没有 m3u8 但有 `.mpd` 时，抠出该地址交给核心 DASH 引擎。直接粘贴 `.mpd` 同样放行。插件只做地址发现，不解析清单内容，分片与表征选择由核心处理。页面同时提供两种格式时优先用 m3u8。
- **伪 m3u8 检测**：抓回登录页或拦截页时明确报错。装了 yt-dlp 可改用它兜底重抽。

### 请求

- **鉴权头自动注入**：`Referer` 优先使用任务携带的播放页完整 URL，另注入 `Origin`、自定义 `User-Agent` 与任意自定义请求头。抓 playlist 与抓分片用同一套头。
- **登录凭据**：需要登录才能取到 m3u8 的站点，把 Cookie、`bearer:` 令牌、`basic:用户名:密码` 或多行请求头粘到插件设置。凭据只附加到与登记站点完全同源的请求。
- **反爬站处理**：自动通过站点的「安全检查」中转页，并在页面没有直接 m3u8 时跟随内嵌播放器继续解析。两者都是 fail-closed，处理不了就退回原有行为。
- **小 Range 兼容**：对「单次请求超过几 MB 就 403」的网盘 CDN，可给下载请求设 Range 上限，在不牺牲多线程的前提下拿到文件。需 FluxDown 0.6.0 及以上，默认不启用。

### 批量与订阅

- **剧集页批量下载**：页面含多集结构时先弹选集窗口，可一次勾选多集。插件只返回清单，由引擎建立任务组，插件自身不建任务。判定只认强信号，单视频页不会被误判。
- **订阅追更**：把分集列表页加为订阅源后，插件枚举其中的条目交给引擎。引擎按 `guid` 去重，只对新集建任务。
- **分片级去广告**：下载前按播放列表里的广告标记丢弃广告分片，默认关闭。两档强度，可选只认 `CUE-OUT`/`CUE-IN` 与 `DATERANGE` 标注，或叠加「极短分片 / 广告命名」推测。只对本插件解析出来的任务生效。
- **去广告自定义规则**：模式之外可写站点级白名单与黑名单，覆盖内置判定。格式见 [`docs/settings.md`](docs/settings.md)。

### 产物

- **智能命名**：文件名按「页面标题 → 上层 ID 目录 → 文件名」推导，剔除 `index`/`playlist`/`master` 这类无信息量的基础名。默认模板 `{title} {host}`。
- **下载后处理**：核心 remux 失败、或产物来自非 HLS 任务时用 ffmpeg 无损补转一次。核心未合并轨对时用 `-c copy` 补做合并。先用 ffprobe 读真实容器再决定转不转，因为扩展名会骗人：fMP4 合并出来常叫 `.ts`，容器其实已是 MP4。转出的产物登记为任务的衍生产物，删任务时一并删除。
- **失败可观测**：`onError` 记录本插件任务的失败原因。

## 安装

### 从 Release 安装（推荐）

1. 到本仓库 [Releases](https://github.com/cocolight/fluxdown-plugin-m3u8/releases) 下载 `m3u8-resolver@cocolight-<版本号>.fxplug`。
2. 打开 FluxDown，进入 **设置 → 扩展 → 插件 → 从文件安装**，选择下载的 `.fxplug`。新版桌面端也支持直接把 `.fxplug` 当 `.zip` 选择。
3. 在插件列表启用，按需修改设置。

### 从构建产物目录安装（开发模式）

1. `git clone` 本仓库并构建：`npm ci && npm run build`。
2. FluxDown 进入 **设置 → 扩展 → 插件 → 从目录安装**，选择 `dist/` 目录。
3. 改 `src/**/*.ts` 后需重新 `npm run build`。改根目录 `manifest.json` 后在客户端重载插件。

插件本体是构建产物 `dist/`。v1.8.0 及更早版本的源码目录 `src/` 即插件本体，TypeScript 迁移后改为 `dist/`，`src/` 不再含 `manifest.json`。

相同 `identity`（`m3u8-resolver@cocolight`）再次安装会替换旧版本。换个 `identity` 会被视为另一个插件，设置项不互通。

从 2.0.x 升到 2.1.0 需要在客户端重新授权。2.1.0 新增了 `intercept` 权限，引擎对已批准权限集合做精确匹配，新权限未批准时插件会装上但保持停用、显示「需要授权」。到插件页点一次授权即可，设置项与凭据都保留。

## 使用说明

| 场景 | 做法 |
| --- | --- |
| 直链 | 直接把 `https://.../xxx.m3u8` 交给 FluxDown，插件自动判断 master / media 并带好鉴权头。`.mpd` 直链也会被识别 |
| 播放页 | 先在设置里填好「目标站点主机」，再把播放页 URL 交给 FluxDown |
| 画质 | 未开「自动选最高画质」时会弹出画质选择框，默认选中按「偏好画质 + 偏好编码」算出的变体 |
| 剧集页 | 页面含多集结构时，提交后会先弹选集窗口，勾选即可批量下载 |
| 需要登录的站点 | 把凭据填进「站点 · 登录凭据」，四种写法见 [设置说明](docs/settings.md) |
| 反爬站 | 站点返回「安全检查」页、或把播放器放在内嵌框架里时，默认自动处理 |

复杂站点若兜底正则抠不出，按站点结构自定义 `src/lib/discovery.ts` 里的 `extractMaster()`。剧集误判或漏判可关开关，或用「自定义剧集链接正则」纠正。

## 文档

使用者文档：

| 文档 | 内容 |
| --- | --- |
| [设置说明](docs/settings.md) | 全部 27 个设置项的作用、配法、效果与示例 |

工程文档（改代码、判断能力边界时看，安装使用不需要）：

| 文档 | 内容 |
| --- | --- |
| [能力边界矩阵](.agents/capability-matrix.md) | 核心与插件各自做了什么，哪些是官方接口的硬限制 |
| [SDK 迁移记录](.agents/sdk-migration.md) | 插件系统换代后的能力变化、模块映射、装机待验项 |
| [架构与代码约定](.agents/architecture.md) | 目录分层、依赖方向、错误处理、测试分层 |
| [AI 协作规则](AGENTS.md) | 给 AI 编码助手的行为规则与红线 |
| [贡献指南](CONTRIBUTING.md) | 面向人的分支、提交与 PR 规范 |

## 工作原理

`resolve(ctx)` 先判断作用域：

- 直链 `.m3u8` 直接拉取。直链 `.mpd` 直接返回，交给核心 DASH 引擎。
- 播放页抓源码抠 `master.m3u8`。抠不到且开启 `detectDash` 时再试 `.mpd`。
- 抓回防抓页挑战时，自动通过后对同一地址重取一次。
- 页面没有 m3u8 时，若有内嵌播放器则跟进解析。
- 播放页被判为剧集页时返回清单，由引擎裂变成多个子任务。每个子任务再以条目 id 回调一次 `resolve`，此时只返回单直链。

之后校验返回值确实是 playlist（`#EXTM3U`）。若是 HTML 登录页则报错或交给 yt-dlp 兜底。`.mpd` 分支不做该校验，因为插件不读 DASH 清单内容。

解析 `#EXT-X-STREAM-INF` 变体与 `#EXT-X-MEDIA` 音轨，按带宽排序，依「偏好编码 + 偏好画质」算默认变体，并给每个变体配上 `audioUrl`。

请求面以 `request` 补丁返回：`referrer`（优先播放页 URL）、`userAgent`、`setHeaders`（`Origin` + 自定义头）。若该站点存有登录凭据且下载目标与其同源，另附 `originHeaders`。同时标记 `rangeSupported` 以启用多线程分段。

下载完成后 `onDone` 先用 ffprobe 读真实容器，已是 MP4 家族或无视频轨就不动。否则核心合并失败时补合并，开启「转成 MP4」时无损转封装。写出的产物随即登记为任务的衍生产物。

`onError` 与 `onCancel` 记录失败原因、清理任务标记。钩子只对本插件经手的任务生效，resolver 会把 `taskId` 写入插件存储作为标记。

另有三个独立入口：`subscribe(ctx)` 处理订阅枚举，`intercept(ctx)` 在 `segments` 阶段决定要不要丢弃广告分片。四个入口构建后是彼此独立的 QuickJS 上下文，运行时无法互相引用。共享逻辑靠构建期打包，源码侧正常 `import` 即可。

## 安全与隐私

- 插件只在配置的「目标站点主机」或直链 `.m3u8` 上生效，不处理无关页面。订阅源地址由用户在订阅列表里显式添加。
- 插件存储只写入两类数据，都不含 Cookie、Token 或凭据：一是「本插件经手的任务 ID → 时间戳」标记，上限 300 条，6 小时后过期；二是剧集批量下载的清单条目映射，上限 400 条，仅在条目 URL 过长或含 `@` 时落盘。
- 凭据只发给任务地址的同源请求。清单在站内、分片在 CDN 时，Cookie 不会跟着发给 CDN。
- 凭据只进 `originHeaders`，不进全局头表。引擎只对 `scheme://host[:port]` 完全一致的请求附加，插件侧另有一道同源检查，两层叠加。用户手写在「额外请求头」里的内容属显式声明，不受该限制。
- 下载请求头每次运行重放、不进任务记录。一次性签名链接与临时 Cookie 不会被写进任务数据库。
- 防抓页 Cookie 只存在于单次解析的内存里。解开挑战得到的 Cookie 仅用于本次解析内重取页面，不写存储、不落盘。
- 拦截器只看分片表，不外发任何数据。判定是纯本地计算：不发网络请求、不写存储、不上报，返回的只是「丢弃哪几片」的 id 列表。
- `onDone` 的 remux 只对白名单容器生效（`ts`/`mkv`/`webm`/`flv`/`m4v`/`mov`/`m2ts`/`mpeg`/`mpg`/`ogv`），避免误转 `.zip`/`.pdf`。白名单只是候选集，真正转不转由 ffprobe 的容器结论决定。
- 插件不修改播放列表内容，只把请求头交给引擎，不向任何第三方上传数据。

## 限制

以下都是官方接口的硬限制，不是本插件尚未实现。详见 [`.agents/capability-matrix.md`](.agents/capability-matrix.md)。

**字幕**：resolver 的返回值里没有字幕字段，ffmpeg 沙箱只允许访问产物目录内的相对名，而 `flux.fs` 是另一个独立工作区，抓到的字幕文件送不进去。插件单层无法下载、封装或烧录字幕。插件会识别并记录字幕轨到日志，但不会下载。

**插件不能创建任务**：`flux.task` 只有 `requestRetry`。剧集批量下载走的是「插件返回清单 → 引擎据清单裂变为任务组」的机制。

**DRM 与直播**：SAMPLE-AES、SAMPLE-AES-CTR、FairPlay、Widevine 等 DRM 解密，LL-HLS 的部分段，真直播无限录制，都属于核心 HLS 下载器的能力，插件层够不到。含 Widevine / FairPlay / PlayReady 的流需要 CDM 与许可证，任何下载工具都无法绕过，这类场景请用 yt-dlp 委派或 [N_m3u8DL-RE](https://github.com/nilaoda/N_m3u8DL-RE)。插件会在解析时把源的加密方式写进日志，便于判断失败归属。

**DASH 只做发现**：插件能把页面里的 `.mpd` 地址抠出来交给核心，但分片结构、表征选择、`SegmentBase`/`indexRange`、DASH 直播、CENC/DRM 全部取决于核心引擎。插件返回值里没有「选哪条 representation」的字段，也无法改写清单内容，因为返回值 scheme 白名单没有 `data:`。

**其他**：

- `onMetaProbed` 对带 resolver 的插件永不触发，因此 manifest 不订阅它。
- 播放页解析依赖兜底正则。复杂前端（m3u8 在加密 JSON 或分段加载）需自定义 `extractMaster` 或启用 yt-dlp 委派。
- 真正的 JS 指纹与验证码型防抓页无法处理。插件沙箱既无 DOM 也无 JS 执行环境，只能覆盖「用内联脚本种 Cookie 后重载」这类可解码的校验形态。
- 剧集与订阅的枚举依赖通用启发式，只能枚举写在静态 HTML 里的分集链接。分集列表由前端 JS 调 API 渲染的站点无法枚举，这是启发式的天花板，不是缺陷。这类站点请走 yt-dlp 委派。
- 去广告只覆盖 HLS，且只在有标记或命名规整时可靠。这是启发式能力，不解码画面、不做音频指纹。DASH 任务不处理，因为分片编号语义不同且没有 CUE 标记。

## 已停用：本地源头去广告

插件曾支持「下载前把 playlist 改写为指向本地清洗服务的地址，由服务剔掉广告段」，旧称「增强 C」。自 v1.4.3 起该能力整体停用，`adClean` 与 `adCleanServer` 两个设置项已从 manifest 移除，resolver 不再改写任何返回的 URL。`adfilter/` 目录自 v3.0.0 起已从仓库删除，实现可回溯：`git log --diff-filter=D -- adfilter/`。

v2.1.0 起改用引擎的拦截平面重做，不再需要外部进程。旧的「增强 C」源码作为回归基线保存在 `tests/legacy/resolver.js`，仅作历史参考，不要恢复。历史方案论证与实测数据见 [`.agents/archive/ad-removal-notes.md`](.agents/archive/ad-removal-notes.md)。

## 文件结构

```text
.                                    # 仓库根（构建工程，非插件本体）
├── manifest.json                    # 插件清单源文件（identity、权限、设置、入口声明）
├── fluxdown-plugin.config.json      # 构建配置：TS 入口 → 产物文件名映射
├── package.json / tsconfig.json     # 构建、测试与类型检查配置
├── AGENTS.md                        # AI 编码助手规则：路由表、常用命令、红线、DoD、事实源坐标
├── ROADMAP.md                       # 功能清单，每行带可判定的验收标准
├── CHANGELOG.md                     # 变更记录（Keep a Changelog）
├── CONTRIBUTING.md                  # 分支 / 提交 / PR 规范与本地检查
├── THIRD-PARTY.md                   # 第三方依赖许可证登记
├── .agents/                         # 工程协作文档（AI 与人共读，不是安装所需）
│   ├── architecture.md              # 分层、依赖方向、错误处理、测试分层
│   ├── configuration.md             # 环境 / Git / 行尾 / CI / 分支保护 / 依赖安全
│   ├── definition-of-done.md        # 完成定义与测试质量基线
│   ├── extension-points.md          # 「要加 X 改哪里」
│   ├── releasing.md                 # 发版清单与命名规则
│   ├── sdk-migration.md             # SDK 迁移记录、版本门槛表、装机待验项
│   ├── capability-matrix.md         # 能力边界矩阵（哪些事插件做不到）
│   ├── adr/                         # 架构决策记录
│   ├── archive/                     # 历史计划与调研（不作现行依据）
│   └── skills/                      # 可复用 AI skill
├── scripts/check-fast.sh            # 快速门禁：本地 pre-commit 与 CI 共用同一份断言
├── .githooks/pre-commit             # 提交前门禁（需 git config core.hooksPath .githooks）
├── src/                             # 源码（TypeScript，构建后打包进 dist/）
│   ├── entry/                       # 四个入口（每次调用全新上下文）
│   │   ├── resolver.ts              # 解析入口：发现 master、选变体、音轨配对、鉴权注入、剧集清单、DASH 发现
│   │   ├── hooks.ts                 # 钩子：onDone（容器探测 → 合并兜底 / remux → 登记产物）、onError、onCancel
│   │   ├── subscribe.ts             # 订阅 provider：列表页枚举 → feed
│   │   └── intercept.ts             # 拦截器：segments 阶段去广告
│   ├── lib/                         # 入口共享的纯函数模块（构建期打包）
│   └── types.ts                     # 内部共享类型
├── tests/                           # 六层测试，共用 tests/parity/harness.mjs 的假宿主
│   ├── legacy/                      # 回归基线：v1.8.0 的四个 .js 原文件（冻结）
│   ├── parity.mjs                   # 行为比对器：同一批 fixture 分别喂给 legacy 与 dist
│   ├── parity/scenarios.mjs         # 67 个 fixture（直链 / 播放页 / 剧集 / DASH / 鉴权 / 订阅 / 钩子）
│   ├── parity/face.mjs              # 请求面同义归并：比「最终生效值」
│   ├── parity/harness.mjs           # 假宿主（日志 / 宿主调用 / 返回值三路记录）
│   ├── contract.mjs                 # 请求面契约
│   ├── intercept.mjs                # 拦截器契约
│   ├── postprocess.mjs              # 后处理契约
│   ├── subscribe.mjs                # 订阅契约
│   └── ui.mjs                       # 设置表单契约
├── dist/                            # 构建产物 = 插件本体（不入库）
├── docs/settings.md                 # 使用者文档：27 个设置项
├── .github/workflows/build.yml      # CI：门禁 + 类型检查 + 构建 + 校验 + 测试 + 守卫
├── LICENSE
└── README.md
```

插件本体是构建产物 `dist/`。`manifest.json` 位于仓库根，构建时原样拷入 `dist/`，`entry` 使用 `dist/` 内的相对路径。构建后这些脚本仍是彼此独立的上下文，运行时不能互相引用。源码侧可以正常 `import`，共享逻辑由构建期打包进各入口。

## 开发

```bash
npm ci              # 安装依赖（fluxdown-plugin-sdk + typescript）
npm run typecheck   # 类型检查：tsc --noEmit
npm run build       # 构建 → dist/（含 manifest.json 拷贝）
npm run validate    # 校验 manifest 与产物是否符合插件规范（装机前跑）
npm test            # 六层测试串联
npm run parity      # 行为回归：dist/ 与 tests/legacy/（v1.8.0）逐场景比对
npm run contract    # 请求面契约：凭据只走 originHeaders、Basic 的 UTF-8 编码、凭据不落库
npm run intercept   # 拦截器契约：成对丢弃、不跨密钥边界、不丢空、只碰本插件任务
npm run postprocess # 后处理契约：产物登记、ffprobe 判容器、探测失败退回扩展名判断
npm run subscribe   # 订阅契约：防抓页解锁只重取一次、订阅源 Cookie 不丢
npm run ui          # 设置表单契约：开关成组、主题前缀、默认值与 settings.ts 对账
npm run pack        # 打包 .fxplug
./scripts/check-fast.sh  # 结构门禁：文档路由表、AGENTS 行数、CHANGELOG 条目、版本号一致、空白与冲突标记
```

**改行为前先跑 `npm run parity`**。它是重构的安全网，任何「以为等价、实际不等价」的改动都会落到具体场景与字段上。

`tests/legacy/` 是冻结基线，不要修改。有意改变行为的场景在 `tests/parity/scenarios.mjs` 里加 `diverges: "理由"` 声明，比对器把它算作已知差异并打印首个不同点。声明过而实际不再有差异时，比对器会报「豁免过期」。

**有意改变的行为要进 `contract` 而不是改 parity**。parity 比的是与 v1.8.0 等价，contract 断言的是现在应该是什么样。凭据作用域从「全部主机」收窄到「登记 origin」就属于后者。

## 开发约定

- 分支：`master` 为默认分支，功能走 `feature/<名称>`。提交前装一次钩子：`git config core.hooksPath .githooks`。
- 提交与本地检查见 [CONTRIBUTING.md](CONTRIBUTING.md)。AI 编码助手的规则与红线见 [AGENTS.md](AGENTS.md)。
- 功能状态与验收标准见 [ROADMAP.md](ROADMAP.md)。改动记进 [CHANGELOG.md](CHANGELOG.md) 的 `[Unreleased]`。
- 文档分层：使用者文档放 `docs/`，工程文档放 `.agents/`。判据只有一条：不读它会不会做错事。
- 依赖只用 `import type` 引用 SDK 类型（SDK 为 AGPL-3.0-or-later，本项目 MIT），产物零 SDK 运行时。第三方依赖许可证登记在 [THIRD-PARTY.md](THIRD-PARTY.md)。

## 许可证

[MIT](LICENSE) © 2026 cocolight
