# M3U8 发现与变体解析器（FluxDown 插件）

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

一个 [FluxDown](https://github.com/zerx-lab/FluxDown) 下载器插件：把播放页或 `master.m3u8` 解析成可直接下载的 HLS 播放列表 —— 自动发现正确清单、解析多码率变体、补齐 `Referer`/`Origin`/`UA` 等鉴权头，交给 FluxDown 内置 HLS 引擎下载合并。页面只提供 DASH 清单（`.mpd`）时，也能把该地址交给核心的 DASH 引擎。

> 适用场景：HLS（`.m3u8`）流媒体下载，兼带 DASH（`.mpd`）的**地址发现**。需要 FluxDown **最低 0.6.0**（v2.0.0 起把下载请求头改由 `resolve` 返回值的 `request` 补丁下发、v2.1.0 起用 `interceptors` 做分片级去广告，这两项自 0.5.8 提供；v2.2.0 起可下发 `maxRangeBytes`，该字段自 0.6.0 提供），推荐最新版。

## 功能特性

- **自动发现 master**：粘贴 `.m3u8` 直链直接处理；粘贴播放页则从页面源码抠出 `master.m3u8`（支持 `https:\/\/` JSON 转义与相对地址；复杂站点可自定义 `extractMaster`）。
- **DASH 清单发现（v1.8.0）**：页面里没有 m3u8 但存在 DASH 清单（`.mpd`）时，自动抠出该地址交给**核心 DASH 引擎**下载；直接粘贴 `.mpd` 直链同样放行。插件**只做地址发现，不解析清单内容** —— 分片、表征（Representation）选择、`SegmentBase` 等一律由核心处理。页面同时提供两种格式时**优先用 m3u8**（保持原有行为）。
- **多码率变体解析**：解析 `#EXT-X-STREAM-INF`，按带宽列出画质（标签含分辨率 / 码率 / 编码），支持手动选画质或按偏好自动选。
- **音视频分离与纯音频提取**：识别独立音轨并作为 `audioUrl` 返回，由核心自动合并为单文件；可按语言指定音轨，也可只下音轨。
- **鉴权头自动注入**：`Referer` 优先使用任务携带的**播放页完整 URL**，另注入 `Origin`、自定义 `User-Agent` 与任意自定义请求头；抓 playlist 与抓分片**用的是同一套头**。
- **伪 m3u8 检测**：抓回登录页 / 拦截页等 HTML 时明确报错；装了 yt-dlp 可自动改用它兜底重抽。
- **剧集页批量下载（v1.5.0）**：页面含「多集」结构时先弹出**选集窗口**，可一次勾选多集。插件只返回清单，**由引擎自动建立任务组**（插件自身仍不能创建任务）；判定只认强信号，单视频页不会被误判。
- **登录凭据（v1.6.0 / 作用域收窄于 v2.0.0）**：需要登录才能取到 m3u8 的站点，把 Cookie / `bearer:` 令牌 / `basic:用户名:密码` / 多行请求头粘到插件设置即可。凭据交给 **FluxDown 持久化**，抓**播放列表与分片**时自动带上，且只附加到**与登记站点完全同源**的请求（v2.0.0 起由引擎的 `originHeaders` 白名单强制执行）。
- **订阅追更（v1.6.0）**：把「分集列表页」加为订阅源后，插件枚举其中的条目交给引擎；引擎按 `guid` 去重，只对新集建任务。
- **反爬站处理（v1.7.0）**：自动通过站点的「安全检查」中转页，并在页面没有直接 m3u8 时**跟随内嵌播放器**（`<iframe>`）继续解析。两者**严格 fail-closed** —— 处理不了即退回原有行为，不会比不开启更差。
- **相对地址修正（v1.4.1）**：插件沙箱是 QuickJS，**没有 `URL` 全局对象**；改用自实现的纯字符串解析（`parseUrl`/`absUrl`），并在返回前用 `assertOutputUrl` 兜底校验，出错时给可读提示而非引擎的隐晦报错。
- **智能命名（v1.4.0）**：文件名按「页面标题 → 上层 ID 目录 → 文件名」决策链推导，**剔除 `index`/`playlist`/`master` 这类无信息量的基础名**；默认模板 `{title} {host}`，可自定义。
- **分片级去广告（v2.1.0）**：下载前按播放列表里的广告标记丢弃广告分片（`interceptors.segments` 阶段），**默认关闭**。两档强度：只认 `CUE-OUT`/`CUE-IN` 与 `DATERANGE` 标注（保守），或叠加「极短分片 / 广告命名」推测（激进）。三条纪律内置：标记必须成对、不跨密钥与初始化段边界、不丢空也不丢超过八成。只对本插件解析出来的任务生效。
- **去广告规则编辑页（v2.3.0）**：插件设置里多一个「去广告规则」页签（在「基础设置」旁边，不取代它）。里面能切模式、套用五档预设、手改自定义规则 JSON，并**当场**告诉你哪条规则写错了、哪条不会生效 —— 不必等到下次下载翻日志。
- **下载后处理（可选，默认开）**：核心 remux 失败、或产物来自非 HLS 任务时用 ffmpeg 无损补转一次；核心未合并轨对时用 `-c copy` 补做合并。v2.2.0 起先用 ffprobe 读**真实容器**再决定转不转（扩展名会骗人：fMP4 合并出来常叫 `.ts`，容器其实已是 MP4），并把转出的产物**登记为任务的衍生产物** —— 删任务时一并删除，不再留孤儿文件。
- **小 Range 兼容（v2.2.0）**：对「单次请求超过几 MB 就 403」的网盘 CDN，可给下载请求设 Range 上限，在不牺牲多线程的前提下拿到文件（`maxRangeBytes`，需 FluxDown ≥ 0.6.0，默认不启用）。
- **失败可观测**：`onError` 记录本插件任务的失败原因。

## 安装

### 方式一：从 Release 安装 `.fxplug`（推荐）

1. 到本仓库 [Releases](https://github.com/cocolight/fluxdown-plugin-m3u8/releases) 下载 `fluxdown-plugin-m3u8_<版本号>.fxplug`。
2. 打开 FluxDown → **设置 → 扩展 → 插件 → 从文件安装**，选择下载的 `.fxplug`。
   - 新版桌面端也支持直接把 `.fxplug` 当作 `.zip` 选择。
3. 在插件列表启用，并按需修改设置。

### 方式二：从构建产物目录安装（开发模式）

1. `git clone` 本仓库并构建（见下节「开发」）：`npm ci && npm run build`。
2. FluxDown → **设置 → 扩展 → 插件 → 从目录安装**，选择 **`dist/` 目录**（构建产物，含 `manifest.json` 与六个入口脚本）。
3. 改 `src/**/*.ts` 后需重新 `npm run build` 才生效；改根目录 `manifest.json` 后在客户端**重载插件**才生效。

> v1.8.0 及更早版本的源码目录 `src/` 即插件本体，可直接选择安装；自 TypeScript 迁移后插件本体是 `dist/`，`src/` 不再含 `manifest.json`。

> **从 2.0.x 升到 2.1.0 需要在客户端重新授权**：2.1.0 新增了 `intercept` 权限（拦截器）。引擎对已批准权限集合做**精确匹配**，新权限未批准时插件会装上但保持停用、显示「需要授权」—— 到插件页点一次授权即可，设置项与凭据都保留。

> 相同 `identity`（`m3u8-resolver@cocolight`）再次安装会替换旧版本；换个 `identity` 会被视为另一个插件，设置项不互通。

## 使用说明

- **直链**：直接把 `https://.../xxx.m3u8` 丢给 FluxDown，插件自动判断 master / media 并带好鉴权头。`.mpd` 直链也会被识别并交给核心 DASH 引擎。
- **播放页**：先在设置里填好「目标站点主机」，再把播放页 URL 交给 FluxDown；插件会从页面抠出 m3u8（找不到时再试 `.mpd`）。
  - 复杂站点若兜底正则抠不出，请按站点结构自定义 `src/lib/discovery.ts` 里的 `extractMaster()`。
- **画质**：未开「自动选择」时会弹出画质选择框，默认选中按「偏好画质 + 偏好编码」算出的变体。
- **剧集页**：页面含多集结构时，提交后会先弹出**选集窗口**，勾选即可批量下载；误判或漏判可关开关或用「自定义剧集链接正则」纠正。
- **需要登录的站点**：把凭据填进「登录凭据」即可（四种写法见[设置说明](docs/settings.md)）。
- **反爬站**：站点返回「安全检查」页、或把播放器放在内嵌框架里时，插件默认自动处理，无需额外配置。
- **DASH 源**：站点只提供 `.mpd` 时默认自动识别（可在设置里关闭）。插件不解析清单内容，分片下载与表征选择由核心 DASH 引擎完成。

## 文档

使用者文档：

| 文档 | 内容 |
| --- | --- |
| [设置说明](docs/settings.md) | 全部 28 个设置项：作用 / 怎么配 / 效果 / 示例，含登录、订阅、命名等配置细节 |

工程文档（改代码、判断能力边界时看，不是安装使用所需）：

| 文档 | 内容 |
| --- | --- |
| [能力边界矩阵](.agents/capability-matrix.md) | 核心与插件各自做了什么、哪些是官方接口的硬限制 |
| [SDK 迁移记录](.agents/sdk-migration.md) | 插件系统换代（引擎 v0.5.8）后的能力变化、模块映射、里程碑与装机待验项 |
| [架构与代码约定](.agents/architecture.md) | 目录分层、依赖方向、错误处理、测试分层 |
| [AI 协作规则](AGENTS.md) | 给 AI 编码助手的行为规则与红线；[贡献指南](CONTRIBUTING.md) 面向人 |

## 工作原理（简述）

1. `src/entry/resolver.ts` 的 `resolve(ctx)` 判断作用域：
   - 直链 `.m3u8` → 直接拉取；直链 `.mpd` → 直接返回，交给核心 DASH 引擎（不抓取）。
   - 播放页 → 抓页源码，正则抠 `master.m3u8`；抠不到且开启 `detectDash` 时再试抠 `.mpd`（v1.8.0），
     命中则把该地址原样返回给核心 DASH 引擎。
   - 抓回的是**防抓页挑战**（v1.7.0）→ 自动通过后对同一地址重取一次。
   - 页面里没有 m3u8 时（v1.7.0）→ 若有内嵌播放器则跟进解析（内层同样会试 `.mpd`）。
   - 播放页若被判定为**剧集页**（v1.5.0）→ 返回**清单**，由**引擎**自动裂变成多个子任务；
     每个子任务再以条目 id 回调一次 `resolve`（此时 `ctx.resolverItem` 非空），只返回单直链。
2. 校验返回值确实是 playlist（`#EXTM3U`）；若是 HTML 登录页则报错或交给 yt-dlp 兜底。
   （`.mpd` 分支**不做**该校验 —— 插件不读 DASH 清单内容，合法性由核心判定。）
3. 解析 `#EXT-X-STREAM-INF` 变体与 `#EXT-X-MEDIA` 音轨，按带宽排序，依「偏好编码 + 偏好画质」算默认变体（或列出供手选），并给每个变体配上 `audioUrl`。
4. 请求面以 `request` 补丁返回（v2.0.0）：`referrer`（优先播放页 URL）、`userAgent`、`setHeaders`（`Origin` + 自定义头）；若该站点存有登录凭据且**下载目标与其同源**，另附 `originHeaders`（`Cookie`/`Authorization` 等，只对该 origin 的请求生效）。同时标记 `rangeSupported` 以启用多线程分段。
5. 下载完成后 `src/entry/hooks.ts` 的 `onDone`：先用 ffprobe 读真实容器（v2.2.0），已是 MP4 家族或无视频轨就不动；否则核心合并失败时用 ffmpeg 补合并、开启 remux 时无损转封装为 `.mp4`。写出的产物随即登记为任务的衍生产物（`flux.task.recordArtifact`），删任务时一并删除。
6. `onError` / `onCancel` 记录失败原因、清理任务标记。**钩子只对本插件经手的任务生效** —— resolver 会把 `taskId` 写入插件存储作为标记，hooks 据此判断（理由见 `src/lib/handled.ts` 文件头）。
7. 另有两个独立入口与一个常驻入口：`src/entry/subscribe.ts` 的 `subscribe(ctx)` 处理订阅枚举；`src/entry/intercept.ts` 的 `intercept(ctx)` 在 `segments` 阶段决定要不要丢弃广告分片（v2.1.0，默认关）；`src/entry/main.tsx` 被求值一次，注册设置页签。它们构建后是**彼此独立的 QuickJS 上下文**，运行时无法互相引用 —— 共享逻辑靠构建期打包（源码侧正常 `import` 即可）。

## 安全与隐私

- 插件只在你配置的「目标站点主机」或直链 `.m3u8` 上生效，不会处理无关页面（fail-closed）。订阅源的地址由你在订阅列表里显式添加。
- 插件存储里只写入两类数据，**都不含任何 Cookie、Token 或凭据**：① 「本插件经手的任务 ID → 时间戳」标记（单键、上限 300 条、6 小时后自动过期；v2.1.0 起拦截器也靠它判断归属，故上限由 60 调高）；② 剧集批量下载的清单条目映射（单键、上限 400 条；仅在条目 URL 过长或含 `@` 时才落盘），用于二段解析取回地址。
- **凭据只发给任务地址的同源请求**：登录凭据存在插件自己的设置项里，注入前逐次比对 origin —— 清单在站内、分片在 CDN 时，Cookie 不会跟着发给 CDN。v3.0.0 起不再使用宿主的按站点登录对话框（那个模型要求先填一个站点，与本插件对所有站点生效的定位相冲突）。
- **拦截器只看分片表，不外发任何数据（v2.1.0）**：`intercept` 只在 `segments` 阶段被调用，拿到的是一条轨道的分片元数据（地址、时长、标签、密钥信息）。判定是**纯本地计算** —— 不发网络请求、不写存储、不上报；返回的只是「丢弃哪几片」的 id 列表。关闭该功能时连任务标记都不读。
- **凭据只进 `originHeaders`，不进全局头表**：插件把凭据放进 `request.originHeaders`，引擎只对 `scheme://host[:port]` **完全一致**的请求附加 —— 清单在站内、分片在 CDN 的混合场景下，Cookie 不会跟着分片请求发出去。插件侧另有一道同源检查（不一致即整条不注入并记日志），两层叠加。用户手写在「额外请求头」里的内容属显式声明，不受该限制。
- **下载请求头每次运行重放、不进任务记录（v2.0.0）**：`request` 补丁由官方语义保证「每次运行重放、绝不落库」，一次性签名链接与临时 Cookie 不会被写进任务数据库。
- **防抓页 Cookie 只存在于单次解析的内存里**（v1.7.0）：解开挑战得到的 Cookie 仅用于本次解析内重取页面，**不写入插件存储、不落盘**，解析结束即随上下文丢弃。
- `onDone` 的 remux 仅对白名单容器（`ts`/`mkv`/`webm`/`flv`/`m4v`/`mov`/`m2ts`/`mpeg`/`mpg`/`ogv`）生效，避免误转 `.zip`/`.pdf`。v2.2.0 起白名单只是**候选集**：真正转不转由 ffprobe 的容器结论决定，探测不可用时退回按扩展名判断（与旧版逐字一致）。
- **产物登记只登记同主干文件**：`recordArtifact` 要求文件名以任务主文件主干开头且文件已存在，插件只登记自己刚写出的 `主干.mp4`。登记失败只记一条 warn —— 文件本身可用，只是删任务时不会被连带删除。
- 插件不修改、不改写任何播放列表内容，只把 `Referer`/`Origin`/`UA` 等请求头交给引擎。本插件不向任何第三方上传数据。

## 限制

以下为**官方接口的硬限制**，不是本插件尚未实现（详见 [`.agents/capability-matrix.md`](.agents/capability-matrix.md)）：

- **字幕（WebVTT）**：resolver 的返回值里没有任何字幕字段；同时 ffmpeg 沙箱只允许访问产物目录内的相对名，而 `flux.fs` 是另一个独立工作区，抓到的字幕文件送不进去。因此**插件单层无法下载/封装/烧录字幕**。插件会识别并记录字幕轨（写日志），但不会下载。
- **插件不能创建任务**：`flux.task` 只有 `requestRetry`，官方也明确插件不能建任务。剧集批量下载（v1.5.0）走的是「插件返回清单 → **引擎**据清单自动裂变为任务组」的机制，插件自身仍不建任务。
- **`onMetaProbed`**：带 resolver 的插件该钩子永不触发（官方明确），因此 manifest 不订阅它。
- **SAMPLE-AES / SAMPLE-AES-CTR / FairPlay / Widevine 等 DRM 解密**、**LL-HLS（`#EXT-X-PART` 部分段）**、**真直播无限录制**：属于核心 `hls_downloader` 的能力，插件层够不到。含 Widevine / FairPlay / PlayReady 的流需要 CDM 与许可证，**任何下载工具都无法绕过**；这类场景请用 yt-dlp 委派或 [N_m3u8DL-RE](https://github.com/nilaoda/N_m3u8DL-RE)。插件会在解析时把源的加密方式（METHOD / KEYFORMAT）写进日志，便于判断失败归属。
- **DASH 只做「发现」，不做解析（v1.8.0）**：插件能把页面里的 `.mpd` 地址抠出来交给核心，但**分片结构、表征（Representation）选择、`SegmentBase` / `indexRange`、DASH 直播（`type="dynamic"`）、CENC/DRM** 全部取决于核心 DASH 引擎 —— 前者是插件返回值里没有「选哪条 representation」的字段，后者是核心尚未实现或本就无解（DRM）。此外插件**不能改写清单内容**（返回值 scheme 白名单没有 `data:`），因此无法翻译 SegmentBase 或改写直播清单。
- 播放页解析依赖兜底正则，复杂前端（m3u8 在加密 JSON / 分段加载）仍需自定义 `extractMaster` 或启用 yt-dlp 委派。
- **真正的 JS 指纹 / 验证码型防抓页无法处理**（v1.7.0）：插件沙箱既无 DOM 也无 JS 执行环境，只能覆盖「用内联脚本种 Cookie 后重载」这类**可解码**的校验形态。遇到指纹或验证码请改用浏览器扩展捕获或 yt-dlp。
- **剧集/订阅的枚举依赖通用启发式**：只能枚举**写在静态 HTML 里**的分集链接。分集列表由前端 JS 调 API 渲染的站点（典型如 B 站番剧页 —— 实测其页面 `m3u8` 出现 0 次、站内分集链接仅 1 条、无 `__INITIAL_STATE__`）**无法枚举**，这不是缺陷而是通用启发式的天花板；这类站点请走 yt-dlp 委派。
- **去广告只覆盖 HLS，且只在「有标记或命名规整」时可靠（v2.1.0）**：插件现在能在 `interceptors.segments` 阶段丢弃广告分片，但这是**启发式**能力 —— 只认 `CUE-OUT`/`CUE-IN`、`DATERANGE` 与分片命名，不解码画面、不做音频指纹。DASH 任务不处理（分片编号语义不同，且没有 CUE 标记）。成对性、密钥边界、不丢空三条纪律由插件强制，宁可不动也不丢正片。

## 已停用：本地源头去广告（v1.4.3 – v2.0.0）

插件曾支持「下载前把 playlist 改写为指向本地清洗服务的地址，由服务剔掉广告段」（旧称「增强 C」）。**自 v1.4.3 起该能力整体停用**：`adClean` / `adCleanServer` 两个设置项已从 manifest 移除，resolver 不再改写任何返回的 URL；`adfilter/` 目录保留在仓库中但**不再维护**，与插件之间已无任何对接通道。

**v2.1.0 起改用引擎的拦截平面重做**（见上文「分片级去广告」设置项）：不再需要外部进程，插件拿到的是引擎已解析好的分片表，只需返回要丢的 id 列表。旧的「增强 C」源码仍作为回归基线保存在 `tests/legacy/resolver.js`，仅作历史参考 —— **不要**再恢复它。历史方案论证与实测数据见 [`.agents/archive/ad-removal-notes.md`](.agents/archive/ad-removal-notes.md)。

## 文件结构

```text
.                                    # 仓库根（构建工程，非插件本体）
├── manifest.json                    # 插件清单源文件（identity、权限、设置、入口与视图声明）
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
│   └── skills/                      # 可复用 AI skill（按需自建）
├── scripts/check-fast.sh            # 快速门禁：本地 pre-commit 与 CI 共用同一份断言
├── .githooks/pre-commit             # 提交前门禁（需 git config core.hooksPath .githooks）
├── src/                             # 源码（TypeScript，构建后打包进 dist/）
│   ├── entry/                       # 五个入口：四个无状态（每次调用全新上下文）+ main（常驻）
│   │   ├── resolver.ts              # 解析入口：发现 master、选变体、音轨配对、鉴权/凭据注入、剧集清单、DASH 发现
│   │   ├── hooks.ts                 # 钩子：onDone（容器探测 → 轨对合并兜底 / remux → 登记产物）、onError、onCancel（清标记）
│   │   ├── subscribe.ts             # 订阅 provider：globalThis.subscribe（列表页枚举 → feed）
│   │   ├── intercept.ts             # 拦截器：globalThis.intercept（segments 阶段去广告，默认关）
│   │   └── main.tsx                 # 常驻脚本：注册设置页签「去广告规则」视图（contributes.views，JSX）
│   ├── lib/                         # 入口共享的纯函数模块（构建期打包，无需运行时 require）
│   │   ├── credential.ts            # 登录凭据文本 → 请求头（bearer / basic / 多行头 / Cookie）
│   │   ├── url.ts settings.ts discovery.ts hls.ts http.ts request.ts adrules.ts probe.ts ...
│   │   ├── rulecheck.ts             # 设置页的规则校验（与 adrules 同源，不另写判定）
│   │   ├── adpresets.ts             # 设置页的五档规则预设（不内置站点名单）
│   └── types.ts                     # 内部共享类型
├── tests/                           # 五层测试，共用 tests/parity/harness.mjs 的假宿主
│   ├── legacy/                      # 回归基线：v1.8.0 的四个 .js 原文件（冻结，不参与构建）
│   ├── parity.mjs                   # 行为比对器：同一批 fixture 分别喂给 legacy 与 dist
│   ├── parity/scenarios.mjs         # 67 个 fixture（直链 / 播放页 / 剧集 / DASH / 鉴权 / 订阅 / 钩子）
│   ├── parity/face.mjs              # 请求面同义归并：extraHeaders 与 request 补丁比「最终生效值」
│   ├── parity/harness.mjs           # 假宿主（日志 / 宿主调用 / 返回值三路记录）
│   ├── contract.mjs                 # 请求面契约：凭据只走 originHeaders、Basic 编码、rangeCap 区间
│   ├── intercept.mjs                # 拦截器契约：成对丢弃、密钥边界、不丢空、归属判定
│   ├── postprocess.mjs              # 后处理契约：产物登记、容器探测、探测失败必须回退
│   └── ui.mjs                       # 视图契约：树合法性、受控输入、保存语义、越界检查
├── dist/                            # ← 构建产物 = 插件本体（「从目录安装」指向此目录；不入库）
├── adfilter/                        # 早期本地去广告清洗服务（独立进程）—— 已归档，v2.1.0 起由拦截器取代
├── docs/settings.md                 # 使用者文档：28 个设置项的作用 / 配置 / 效果 / 示例
├── .github/workflows/build.yml      # CI：门禁 + 类型检查 + 构建 + 校验 + 五层测试 + CHANGELOG/发版守卫
├── LICENSE
└── README.md
```

> **插件本体是构建产物 `dist/` 目录。** `manifest.json` 位于仓库根，构建时原样拷入 `dist/`；
> `entry` 使用 `dist/` 内的相对路径（`resolver.js` / `hooks.js` / `subscribe.js` / `intercept.js` / `main.js`）。
> 构建后这些脚本仍是**彼此独立的上下文**，运行时不能互相引用；
> 源码侧可以正常 `import`，共享逻辑由构建期打包进各入口（代价是同一模块会在多个产物里各存一份）。

## 开发

```bash
npm ci              # 安装依赖（fluxdown-plugin-sdk + typescript）
npm run typecheck   # 类型检查：tsc --noEmit
npm run build       # 构建 → dist/（含 manifest.json 拷贝）
npm run validate    # 校验 manifest 与产物是否符合插件规范（装机前跑）
npm test            # 五层测试串联，等价于下面五条依次执行
npm run parity      # 行为回归：dist/ 与 tests/legacy/（v1.8.0）逐场景比对；有意改行为的场景用 diverges 声明
npm run contract    # 请求面契约：凭据只走 originHeaders、Basic 的 UTF-8 编码、凭据不落库
npm run intercept   # 拦截器契约：成对丢弃、不跨密钥边界、不丢空、只碰本插件任务
npm run postprocess # 后处理契约：产物登记、ffprobe 判容器、探测失败退回扩展名判断
npm run ui          # 视图契约：设置页签的树合法性、受控输入、保存语义、越界检查
npm run pack        # 打包 .fxplug
./scripts/check-fast.sh  # 结构门禁：文档路由表、AGENTS 行数、CHANGELOG 条目、版本号一致、入口构建映射、空白与冲突标记
```

- **改行为前先跑 `npm run parity`**：它是重构的安全网 —— 任何「以为等价、实际不等价」的改动都会落到具体场景与字段上。
- `tests/legacy/` 是冻结的基线，**不要修改**。有意改变行为的场景在 `tests/parity/scenarios.mjs` 里加 `diverges: "理由"`
  声明，比对器把它算作已知差异并打印首个不同点；一旦声明过而实际不再有差异，比对器会报「豁免过期」。
- **有意改变的行为要进 `contract` 而不是改 parity**：parity 比的是「与 v1.8.0 等价」，contract 断言的是「现在应该是什么样」。凭据作用域从「全部主机」收窄到「登记 origin」就属于后者 —— parity 里比的是最终生效值，作用域差异由 contract 单独断言。
- 依赖只用 `import type` 引用 SDK 类型（SDK 为 AGPL-3.0-or-later，本项目 MIT）。唯一例外是 `main.tsx` 的 JSX 运行时，它会被内联进 `dist/main.js` 随插件分发 —— 义务与边界写在 [THIRD-PARTY.md](THIRD-PARTY.md)，决策见 [ADR-0005](.agents/adr/0005-allow-sdk-jsx-runtime.md)。

## 开发约定

- 分支：`master` 为默认分支，功能走 `feature/<名称>`。提交前装一次钩子：`git config core.hooksPath .githooks`。
- 提交与本地检查：见 [CONTRIBUTING.md](CONTRIBUTING.md)；AI 编码助手的规则与红线见 [AGENTS.md](AGENTS.md)。
- 功能状态与验收标准：见 [ROADMAP.md](ROADMAP.md)；改动记进 [CHANGELOG.md](CHANGELOG.md) 的 `[Unreleased]`。
- 文档分层：使用者文档放 `docs/`，工程文档放 `.agents/` —— 判据只有一条「不读它 AI 会做错事吗」。
- 第三方依赖的许可证登记在 [THIRD-PARTY.md](THIRD-PARTY.md)；SDK 的类型只以 `import type` 引用，唯一的运行时代码是视图的 JSX 运行时（见 ADR-0005）。

## 许可证

[MIT](LICENSE) © 2026 cocolight
