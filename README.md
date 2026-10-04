# M3U8 发现与变体解析器（FluxDown 插件）

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

一个 [FluxDown](https://github.com/zerx-lab/FluxDown) 下载器插件：把播放页或 `master.m3u8` 解析成可直接下载的 HLS 播放列表 —— 自动发现正确清单、解析多码率变体、补齐 `Referer`/`Origin`/`UA` 等鉴权头，交给 FluxDown 内置 HLS 引擎下载合并。页面只提供 DASH 清单（`.mpd`）时，也能把该地址交给核心的 DASH 引擎。

> 适用场景：HLS（`.m3u8`）流媒体下载，兼带 DASH（`.mpd`）的**地址发现**。需要 FluxDown **最低 0.4.8**（登录与订阅所依赖的引擎能力自 v0.4.8 起提供；v1.8.0 未引入新引擎字段，门槛不变），推荐最新版。

## 功能特性

- **自动发现 master**：粘贴 `.m3u8` 直链直接处理；粘贴播放页则从页面源码抠出 `master.m3u8`（支持 `https:\/\/` JSON 转义与相对地址；复杂站点可自定义 `extractMaster`）。
- **DASH 清单发现（v1.8.0）**：页面里没有 m3u8 但存在 DASH 清单（`.mpd`）时，自动抠出该地址交给**核心 DASH 引擎**下载；直接粘贴 `.mpd` 直链同样放行。插件**只做地址发现，不解析清单内容** —— 分片、表征（Representation）选择、`SegmentBase` 等一律由核心处理。页面同时提供两种格式时**优先用 m3u8**（保持原有行为）。
- **多码率变体解析**：解析 `#EXT-X-STREAM-INF`，按带宽列出画质（标签含分辨率 / 码率 / 编码），支持手动选画质或按偏好自动选。
- **音视频分离与纯音频提取**：识别独立音轨并作为 `audioUrl` 返回，由核心自动合并为单文件；可按语言指定音轨，也可只下音轨。
- **鉴权头自动注入**：`Referer` 优先使用任务携带的**播放页完整 URL**，另注入 `Origin`、自定义 `User-Agent` 与任意自定义请求头；抓 playlist 与抓分片**用的是同一套头**。
- **伪 m3u8 检测**：抓回登录页 / 拦截页等 HTML 时明确报错；装了 yt-dlp 可自动改用它兜底重抽。
- **剧集页批量下载（v1.5.0）**：页面含「多集」结构时先弹出**选集窗口**，可一次勾选多集。插件只返回清单，**由引擎自动建立任务组**（插件自身仍不能创建任务）；判定只认强信号，单视频页不会被误判。
- **登录凭据（v1.6.0）**：需要登录才能取到 m3u8 的站点，把 Cookie / `bearer:` 令牌 / `basic:用户名:密码` / 多行请求头粘到插件设置即可。凭据交给 **FluxDown 持久化**，此后抓**播放列表与分片**都会自动带上，且**只在与登记站点同源时注入**。
- **订阅追更（v1.6.0）**：把「分集列表页」加为订阅源后，插件枚举其中的条目交给引擎；引擎按 `guid` 去重，只对新集建任务。
- **反爬站处理（v1.7.0）**：自动通过站点的「安全检查」中转页，并在页面没有直接 m3u8 时**跟随内嵌播放器**（`<iframe>`）继续解析。两者**严格 fail-closed** —— 处理不了即退回原有行为，不会比不开启更差。
- **相对地址修正（v1.4.1）**：插件沙箱是 QuickJS，**没有 `URL` 全局对象**；改用自实现的纯字符串解析（`parseUrl`/`absUrl`），并在返回前用 `assertOutputUrl` 兜底校验，出错时给可读提示而非引擎的隐晦报错。
- **智能命名（v1.4.0）**：文件名按「页面标题 → 上层 ID 目录 → 文件名」决策链推导，**剔除 `index`/`playlist`/`master` 这类无信息量的基础名**；默认模板 `{title} {host}`，可自定义。
- **下载后处理（可选，默认开）**：核心 remux 失败、或产物来自非 HLS 任务时用 ffmpeg 无损补转一次；核心未合并轨对时用 `-c copy` 补做合并。
- **失败可观测**：`onError` 记录本插件任务的失败原因。

## 安装

### 方式一：从 Release 安装 `.fxplug`（推荐）

1. 到本仓库 [Releases](../../releases) 下载 `fluxdown-plugin-m3u8_<版本号>.fxplug`。
2. 打开 FluxDown → **设置 → 扩展 → 插件 → 从文件安装**，选择下载的 `.fxplug`。
   - 新版桌面端也支持直接把 `.fxplug` 当作 `.zip` 选择。
3. 在插件列表启用，并按需修改设置。

### 方式二：从源码目录安装（开发模式）

1. 把本仓库 `git clone` 到本地。
2. FluxDown → **设置 → 扩展 → 插件 → 从目录安装**，选择 **`src/` 目录**（即含 `manifest.json` 的那一层）。
3. 开发模式下修改 `src/*.js` 存盘即热生效，方便调试。

> 相同 `identity`（`m3u8-resolver@cocolight`）再次安装会替换旧版本；换个 `identity` 会被视为另一个插件，设置项不互通。

## 使用说明

- **直链**：直接把 `https://.../xxx.m3u8` 丢给 FluxDown，插件自动判断 master / media 并带好鉴权头。`.mpd` 直链也会被识别并交给核心 DASH 引擎。
- **播放页**：先在设置里填好「目标站点主机」，再把播放页 URL 交给 FluxDown；插件会从页面抠出 m3u8（找不到时再试 `.mpd`）。
  - 复杂站点若兜底正则抠不出，请按站点结构自定义 `src/resolver.js` 里的 `extractMaster()`。
- **画质**：未开「自动选择」时会弹出画质选择框，默认选中按「偏好画质 + 偏好编码」算出的变体。
- **剧集页**：页面含多集结构时，提交后会先弹出**选集窗口**，勾选即可批量下载；误判或漏判可关开关或用「自定义剧集链接正则」纠正。
- **需要登录的站点**：把凭据填进「登录凭据」即可（四种写法见配置说明）。
- **反爬站**：站点返回「安全检查」页、或把播放器放在内嵌框架里时，插件默认自动处理，无需额外配置。
- **DASH 源**：站点只提供 `.mpd` 时默认自动识别（可在设置里关闭）。插件不解析清单内容，分片下载与表征选择由核心 DASH 引擎完成。

## 文档

| 文档 | 内容 |
| --- | --- |
| [配置说明](docs/configuration.md) | 全部 24 个设置项：作用 / 怎么配 / 效果 / 示例，含登录、订阅、命名等配置细节 |
| [能力边界矩阵](docs/plugin-capability-matrix.md) | 核心与插件各自做了什么、哪些是官方接口的硬限制 |
| [上游缺陷：`METHOD=NONE`](docs/upstream-m3u8-rs-method-none.md) | `m3u8-rs` 上游 IV 校验缺陷的复现、根因、四态矩阵与 PR 状态 |
| [去广告方案调研笔记](docs/ad-removal-notes.md) | 历史调研：源码级论证、走过的死路与实测数据（已停用） |

## 工作原理（简述）

1. `src/resolver.js` 的 `resolve(ctx)` 判断作用域：
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
4. 返回结果带上 `Referer`（优先播放页 URL）/ `Origin` / `User-Agent` / 自定义头；若该站点存有登录凭据且**下载目标与其同源**，则一并并入 `Cookie`/`Authorization` 等（v1.6.0）。同时标记 `rangeSupported` 以启用多线程分段。
5. 下载完成后 `src/hooks.js` 的 `onDone`：核心合并失败时用 ffmpeg 补合并；开启 remux 时把非 `.mp4` 容器无损转封装为 `.mp4`。
6. `onError` / `onCancel` 记录失败原因、清理任务标记。**钩子只对本插件经手的任务生效** —— resolver 会把 `taskId` 写入插件存储作为标记，hooks 据此判断（理由见 `src/hooks.js` 文件头）。
7. 另有两条独立入口：`src/auth.js` 的 `authenticate(ctx)` 处理登录（由宿主以 `begin`/`poll`/`cancel`/`logout`/`status` 驱动）；`src/subscribe.js` 的 `subscribe(ctx)` 处理订阅枚举。三者是**彼此独立的 QuickJS 上下文**，不共享作用域。

## 安全与隐私

- 插件只在你配置的「目标站点主机」或直链 `.m3u8` 上生效，不会处理无关页面（fail-closed）。订阅源的地址由你在订阅列表里显式添加。
- 插件存储里只写入两类数据，**都不含任何 Cookie、Token 或凭据**：① 「本插件经手的任务 ID → 时间戳」标记（单键、上限 60 条、6 小时后自动过期）；② 剧集批量下载的清单条目映射（单键、上限 400 条；仅在条目 URL 过长或含 `@` 时才落盘），用于二段解析取回地址。
- **登录凭据不落在插件存储里**：v1.6.0 起凭据经 `flux.auth` 交给 FluxDown 统一持久化（与站点绑定、按 `插件ID::站点` 引用），卸载插件即可一并清除；插件只在运行时读回使用。
- **凭据只在同源时注入下载请求**：插件比对「凭据登记站点」与「下载目标站点」（`scheme://host[:port]` 完全一致），不一致就不注入 —— 避免把站点 Cookie 发给 CDN 主机。用户手写在「额外请求头」里的内容属显式声明，不做该检查。
- **防抓页 Cookie 只存在于单次解析的内存里**（v1.7.0）：解开挑战得到的 Cookie 仅用于本次解析内重取页面，**不写入插件存储、不落盘**，解析结束即随上下文丢弃。
- `onDone` 的 remux 仅对白名单容器（`ts`/`mkv`/`webm`/`flv`/`m4v`/`mov`/`m2ts`/`mpeg`/`mpg`/`ogv`）生效，避免误转 `.zip`/`.pdf`。
- 插件不修改、不改写任何播放列表内容，只把 `Referer`/`Origin`/`UA` 等请求头交给引擎。本插件不向任何第三方上传数据。

## 限制

以下为**官方接口的硬限制**，不是本插件尚未实现（详见 [`docs/plugin-capability-matrix.md`](docs/plugin-capability-matrix.md)）：

- **字幕（WebVTT）**：resolver 的返回值里没有任何字幕字段；同时 ffmpeg 沙箱只允许访问产物目录内的相对名，而 `flux.fs` 是另一个独立工作区，抓到的字幕文件送不进去。因此**插件单层无法下载/封装/烧录字幕**。插件会识别并记录字幕轨（写日志），但不会下载。
- **插件不能创建任务**：`flux.task` 只有 `requestRetry`，官方也明确插件不能建任务。剧集批量下载（v1.5.0）走的是「插件返回清单 → **引擎**据清单自动裂变为任务组」的机制，插件自身仍不建任务。
- **`onMetaProbed`**：带 resolver 的插件该钩子永不触发（官方明确），因此 manifest 不订阅它。
- **SAMPLE-AES / SAMPLE-AES-CTR / FairPlay / Widevine 等 DRM 解密**、**LL-HLS（`#EXT-X-PART` 部分段）**、**真直播无限录制**：属于核心 `hls_downloader` 的能力，插件层够不到。含 Widevine / FairPlay / PlayReady 的流需要 CDM 与许可证，**任何下载工具都无法绕过**；这类场景请用 yt-dlp 委派或 [N_m3u8DL-RE](https://github.com/nilaoda/N_m3u8DL-RE)。插件会在解析时把源的加密方式（METHOD / KEYFORMAT）写进日志，便于判断失败归属。
- **DASH 只做「发现」，不做解析（v1.8.0）**：插件能把页面里的 `.mpd` 地址抠出来交给核心，但**分片结构、表征（Representation）选择、`SegmentBase` / `indexRange`、DASH 直播（`type="dynamic"`）、CENC/DRM** 全部取决于核心 DASH 引擎 —— 前者是插件返回值里没有「选哪条 representation」的字段，后者是核心尚未实现或本就无解（DRM）。此外插件**不能改写清单内容**（返回值 scheme 白名单没有 `data:`），因此无法翻译 SegmentBase 或改写直播清单。
- **`#EXT-X-KEY:METHOD=NONE`（AES-128 段之后切回明文段）当前会失败，且不是插件的问题**：核心所依赖的 `m3u8-rs 6.0.1` 有一处 IV 校验写反的上游缺陷，使该标签被降级为未知标签，于是明文段被错误地用上一段的 AES-128 密钥解密，报 `decrypt_segment: … PKCS7 decrypt error (Unpad Error)`。插件不能改写 playlist 内容，无法规避。**完整复现、根因与修复补丁见 [`docs/upstream-m3u8-rs-method-none.md`](docs/upstream-m3u8-rs-method-none.md)**。
- 播放页解析依赖兜底正则，复杂前端（m3u8 在加密 JSON / 分段加载）仍需自定义 `extractMaster` 或启用 yt-dlp 委派。
- **真正的 JS 指纹 / 验证码型防抓页无法处理**（v1.7.0）：插件沙箱既无 DOM 也无 JS 执行环境，只能覆盖「用内联脚本种 Cookie 后重载」这类**可解码**的校验形态。遇到指纹或验证码请改用浏览器扩展捕获或 yt-dlp。
- **剧集/订阅的枚举依赖通用启发式**：只能枚举**写在静态 HTML 里**的分集链接。分集列表由前端 JS 调 API 渲染的站点（典型如 B 站番剧页 —— 实测其页面 `m3u8` 出现 0 次、站内分集链接仅 1 条、无 `__INITIAL_STATE__`）**无法枚举**，这不是缺陷而是通用启发式的天花板；这类站点请走 yt-dlp 委派。
- **订阅（`subscriptions`）未列入 FluxDown 公开插件文档**：按引擎实现接入（自 v0.4.8 起提供），引擎升级后行为若有变化以引擎源码为准。这也正是 `minAppVersion` 抬到 `0.4.8` 的原因。
- **去广告不在插件能力范围内**：插件层没有分片级钩子，只能整条 playlist 下载。v1.4.3 起已移除原有的「本地源头去广告」方案（详见下文）。

## 已停用：本地源头去广告（v1.4.3 起）

插件曾支持「下载前把 playlist 改写为指向本地清洗服务的地址，由服务剔掉广告段」（旧称「增强 C」）。**自 v1.4.3 起该能力整体停用**：`adClean` / `adCleanServer` 两个设置项已从 manifest 移除，resolver 不再改写任何返回的 URL；`adfilter/` 目录保留在仓库中但**不再维护**，与插件之间已无任何对接通道。

若确需去广告，只能自行恢复 `src/resolver.js` 里被注释掉的「增强 C」小节（原实现完整保留在那里）。方案论证与实测数据见 [`docs/ad-removal-notes.md`](docs/ad-removal-notes.md)，服务用法见 [`adfilter/README.md`](adfilter/README.md)。

## 文件结构

```text
.                                    # 仓库根（非插件本体，含附属内容）
├── src/                             # ← 插件本体（「从目录安装」/开发模式指向此目录）
│   ├── manifest.json                # 插件清单（identity、权限、设置、entry、auth、subscriptions）
│   ├── resolver.js                  # 解析入口：发现 master、选变体、音轨配对、鉴权/凭据注入、剧集清单、DASH 发现
│   ├── hooks.js                     # 钩子：onDone（轨对合并兜底 / remux）、onError、onCancel（清标记）
│   ├── auth.js                      # 登录入口：globalThis.authenticate（凭据规范化 + 落库）
│   └── subscribe.js                 # 订阅 provider：globalThis.subscribe（列表页枚举 → feed）
├── adfilter/                        # 本地去广告清洗服务（独立进程）—— 已归档、不再维护，插件不再对接
├── docs/
│   ├── configuration.md             # 配置说明：24 个设置项的作用 / 配置 / 效果 / 示例
│   ├── plugin-capability-matrix.md  # 插件能力边界（已对照官方 API 核实）
│   ├── dash-discovery-plan.md       # v1.8.0 DASH 发现层开发计划（含遗留验证收口）
│   ├── ad-removal-notes.md          # 去广告方案调研笔记（源码级论证 / 实测 / TODO）
│   ├── upstream-m3u8-rs-method-none.md        # METHOD=NONE 上游缺陷的证据链与 PR 状态
│   ├── upstream-m3u8-rs-method-none.patch     # 上游 m3u8-rs 修复补丁（可 patch -p1）
│   └── engine-hls-ext-x-key-method-none.patch # 引擎侧兜底补丁（可 patch -p1）
├── LICENSE
└── README.md
```

> **插件本体就是 `src/` 目录。** `manifest.json` 必须位于插件文件夹根（即 `src/` 内），
> `entry` 使用同目录相对路径（`resolver.js` / `hooks.js` / `auth.js` / `subscribe.js`）。
> 四个脚本是**彼此独立的 QuickJS 上下文**，不能互相 `require`，共享的纯函数只能逐文件复制。
> 开发模式下改 `src/*.js` 存盘即热生效。

## 许可证

[MIT](LICENSE) © 2026 cocolight
