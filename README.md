# M3U8 发现与变体解析器（FluxDown 插件）

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

一个 [FluxDown](https://github.com/zerx-lab/FluxDown) 下载器插件：输入播放页或 `master.m3u8`，自动发现正确的播放列表、解析多码率变体，并带上 `Referer`/`Origin`/`UA` 鉴权头，交给 FluxDown 内置 HLS 引擎下载合并。支持**音视频分离**（返回 `audioUrl`，由核心自动合并）、**纯音频提取**、按编码/画质筛选、**伪 m3u8 检测**、yt-dlp 委派、下载后 remux 为 MP4，以及**本地源头去广告**（下载前跳过广告段）。

> 适用场景：HLS（`.m3u8`）流媒体下载。需要 FluxDown 桌面端/服务端，推荐 **v0.4.8 及以上**（支持 `.fxplug` 一键安装）。

## 功能特性

- **自动发现 master**：直接粘贴 `.m3u8` 直链时直接处理；粘贴播放页时自动从页面源码抠出 `master.m3u8`（支持 `https:\/\/` JSON 转义与相对地址；复杂站点可自定义 `extractMaster`）。
- **多码率变体解析**：解析 `#EXT-X-STREAM-INF`，按带宽降序列出画质（标签含分辨率/码率/编码），支持手动选画质或自动选最高/指定画质。
- **音视频分离（独立音轨）**：解析 `#EXT-X-MEDIA:TYPE=AUDIO` 与纯音频变体，把音轨地址作为 `audioUrl` 返回，FluxDown 会**自动把视频与音轨合并为单文件**；可按 `LANGUAGE` 指定语言轨。默认 `auto`，只在源明确为纯视频或已单列音轨时才分离，避免音视频合一的流被拆出双音轨。
- **纯音频提取**：只下独立音轨（音乐/播客场景）。
- **鉴权头自动注入**：`Referer` 优先使用任务携带的**播放页完整 URL**（比 `Origin` 更贴近浏览器行为），并注入 `Origin`、自定义 `User-Agent`、任意自定义请求头；抓取 playlist 与抓取分片**用的是同一套头**。Cookie 由 FluxDown 引擎自动携带。
- **伪 m3u8 检测**：抓回的若是 HTML 登录页/拦截页而非 `#EXTM3U`，明确报错；装了 yt-dlp 时可自动改用它兜底重抽。
- **相对地址修正（v1.4.1 重写，零依赖）**：FluxDown 的插件沙箱是 QuickJS，其中**没有 `URL` 全局对象**（`typeof URL === "undefined"`）。旧版依赖 `new URL(u, base)` 把 master 里的相对变体地址转绝对，因此在真实运行时**全部失效**，输出相对地址被引擎以「`url scheme 不允许`」整体拒绝。现已改为自实现的纯字符串 URL 解析（`parseUrl`/`absUrl`），并同步修好了同样受影响的 `hostOf`/`safeOrigin`/`inScope`；返回前还有 `assertOutputUrl` 做最后一道拦截，出错时给可读提示而非引擎的隐晦报错。
- **默认命名更友好（v1.4.0 重写）**：文件名按「页面标题 → 上层 ID 目录 → 文件名」决策链推导，并**剔除 `index`/`playlist`/`master` 这类无信息量的基础名**；默认模板 `{title} {host}` 会把域名带进文件名。可用 `nameTemplate` 自定义。
- **增强 B（可选）：yt-dlp 委派** —— 复杂站点（m3u8 藏在 JS/JSON 里）交给 yt-dlp 抽直链。
- **增强 A（可选，默认开）：下载后 remux 兜底** —— 核心 HLS 引擎**已内置** TS→MP4 转封装（失败时保留 `.ts`）。插件只在核心 remux 失败、或非 HLS 任务（如 yt-dlp 产出的 `.mkv`/`.webm`）时用 ffmpeg 无损补转一次；产物已是 `.mp4` 则直接跳过。
- **轨对合并兜底（可选，默认开）**：若 FluxDown 未能把视频与独立音轨合并（降级留下单独音频文件），插件用 ffmpeg `-c copy` 补做合并。
- **失败可观测**：`onError` 记录本插件任务的失败原因。
- **增强 C（可选）：尝试去广告（源头跳过广告段）** —— media/master playlist 被改写为指向清洗服务的地址，**广告段根本不出现在引擎看到的 playlist 里**，引擎只下正片。属于下载前处理，非下载后切除。需先启动 `adfilter/` 下的清洗服务（exe 或 `python3 m3u8_adclean_server.py`）。

> 插件能力的完整边界（哪些能做、哪些是官方接口的硬限制）见 [`docs/plugin-capability-matrix.md`](docs/plugin-capability-matrix.md)。

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

## 配置项（插件设置）

| 设置 | 说明 | 默认 |
| --- | --- | --- |
| 目标站点主机 | 仅处理这些主机的「页面 URL」；直链 `.m3u8` 不受限。留空则插件不处理任何页面。逗号分隔。 | 空 |
| 偏好画质 | 选默认变体时优先：`best` / `1080` / `720` / `480` / `360`（按**高度**比较）。自动选时生效。 | best |
| 偏好视频编码 | `auto` / `avc`(H.264) / `hevc`(H.265) / `av01`(AV1) / `vp9`。只影响默认选中项，**不会隐藏**其他画质。 | auto |
| 自动选择 | 开启后不弹画质框，按偏好直接下载。 | 关 |
| 音视频分离 | `auto`（仅当源明确是纯视频或已单列音轨时才分离）/ `on`（总是分离）/ `off`。分离后由核心自动合并。 | auto |
| 音轨语言偏好 | 按 `LANGUAGE` 选轨（`zh`/`zh-CN`/`ja`/`en`…）。留空按 `DEFAULT`/`AUTOSELECT`。 | 空 |
| 纯音频提取 | 只下独立音轨。源无独立音轨时**明确报错**，不会静默下整个视频。 | 关 |
- **命名模板** | 占位符 `{title}` `{res}` `{lang}` `{host}` `{date}`。默认 `{title} {host}`（文件名带域名，便于区分同名剧集）；填 `{title}` 则不带域名。 | `{title} {host}` |
| 自定义 User-Agent | 留空用 FluxDown 默认 UA。部分站点按 UA 返回不同 playlist。 | 空 |
| 额外请求头 | 每行一条 `Key: Value`，`#` 注释。同时作用于抓 playlist 与抓分片；**同名头会覆盖自动推导的 `Referer`/`Origin`（显式优先）**。 | 空 |
| 防盗链/签名直链 | 跳过元数据探测，避免一次性/签名直链被用掉；恢复下载会重新解析。 | 关 |
| 启用 yt-dlp 委派 | 链接交给 yt-dlp 抽直链，适合原生抠不出的站点。需先装 yt-dlp 组件。 | 关 |
| 抓到 HTML 时用 yt-dlp 兜底 | 抓 playlist 得到 HTML（登录页/拦截页）而非 `#EXTM3U` 时，自动改用 yt-dlp。 | 开 |
| 下载后 remux 为 MP4 | 核心已内置 TS→MP4；插件仅在其失败或非 HLS 产物时补转。需装 ffmpeg 组件。 | 开 |
| 音视频合并失败兜底 | 核心未合并轨对（降级留下独立音频）时，插件用 ffmpeg `-c copy` 补做。 | 开 |
| 尝试去广告 | 把 playlist 改写为指向清洗服务，源头跳过广告段。**需先启动服务**。 | 关 |
| 去广告服务地址 | 清洗服务地址，须与服务启动参数一致。仅在开启「尝试去广告」时使用。 | `http://127.0.0.1:8787` |

## 使用说明

- **直链**：直接把 `https://.../xxx.m3u8` 丢给 FluxDown 即可，插件自动判断 master / media 并带好鉴权头。
- **播放页**：先在插件设置里填好「目标站点主机」，再把播放页 URL 交给 FluxDown；插件会从页面抠出 m3u8。
  - 复杂站点若兜底正则抠不出，请按站点结构自定义 `src/resolver.js` 里的 `extractMaster()`。
- **画质**：未开「自动选择」时会弹出画质选择框；默认选中按「偏好画质」算出的变体。
- **去广告**：见下方「源头去广告（增强 C）」。

## 音视频分离与纯音频提取

部分源（尤其 fMP4 / DASH 式 HLS）会把音轨单独列出，视频流里没有声音。插件两种都识别：

| 源里的写法 | 插件行为 |
| --- | --- |
| `#EXT-X-MEDIA:TYPE=AUDIO,...,URI="audio/zh.m3u8"` | 按该变体的 `AUDIO="组名"` 匹配音频组，选轨后作为 `audioUrl` 返回 |
| `#EXT-X-STREAM-INF:...,CODECS="avc1.640028"`（只有视频编码） | 判定为纯视频流 → 自动配上音轨 |
| `#EXT-X-STREAM-INF:...,CODECS="mp4a.40.2"`（只有音频编码） | 判定为纯音频变体 → 从画质列表里移出，作为音轨来源 |
| `#EXT-X-STREAM-INF:...,CODECS="avc1.640028,mp4a.40.2"` | 判定为音视频合一 → **不分离**（避免拆出第二条音轨） |

**返回 `audioUrl` 后由 FluxDown 核心自动合并**（`onDone` 的 `muxed` 字段即表示是否合并成功），插件不需要自己跑 ffmpeg 合并；只有在核心合并失败、降级留下独立音频文件时，插件才用 `-c copy` 补做一次。

选轨顺序：`AUDIO` 组收敛 → 「音轨语言偏好」按 `LANGUAGE` 匹配 → `DEFAULT=YES` → `AUTOSELECT=YES` → 第一条。语言未命中会回退默认轨并写日志。

若开启「纯音频提取」而源里没有独立音轨（音视频合一的 TS），任务会**明确报错**而不是静默下载整个视频——这种源在下载层无法分离音轨。

## 源头去广告（增强 C）

### 为什么是「源头」而不是「下载后切除」

FluxDown 插件只有两层：`resolver`（下载前返回要下的 URL 与请求头）和 `hooks`（任务开始/完成/出错时收通知），**没有任何 segment（分片）级钩子**。内置 HLS 引擎抓到 media playlist 后会自闭环下载全部 `#EXTINF` 段，连标准的 `#EXT-X-GAP`（空缺段跳过）标签都不理会——所以插件做不到「在分片层标记某段不下载」。

能做的，是让引擎拿到的 playlist 里**根本没有广告段**。但 `resolver` 只能返回 URL，引擎只认网络直链、`file://` 未获支持，`flux.fs` 又不暴露绝对路径——`file://` 是死路。**绕开之法**：返回一个 `http://127.0.0.1` 的普通 URL；引擎的 reqwest 客户端（无 loopback 拦截）能正常抓取，由本地服务返回「已剔广告、段已绝对化」的干净 playlist。

> 完整的源码级论证、走过的死路与实测数据，见 [`docs/ad-removal-notes.md`](docs/ad-removal-notes.md)。

### 架构

```
FluxDown 插件 resolver (src/resolver.js)
  └─ 检测到 m3u8 且开启 adClean → 返回
     http://127.0.0.1:8787/clean?src=<原始 m3u8>&ref=<referer>
                              │
              adfilter/m3u8_adclean_server.py (独立进程)
                              │ 抓原始 playlist（带 Referer 防盗链）
                              │ 剔广告段（adjump、CUE-OUT/IN、DATERANGE、GAP）
                              │ 内容段改绝对地址（指向真实源站）
                              ▼
                      返回干净 .m3u8 (plain http)
                              │
              FluxDown HLS 引擎（读干净 playlist）
                              │ 只下正片段（绝对地址 → 源站直连）
                              ▼
                          无广告成品
```

> 分片是绝对地址，引擎直接连源站下载，**不经本地服务**，所以本地服务只处理 `.m3u8`，不承担分片流量。

### 使用步骤

1. **启动本地清洗服务**（独立于 FluxDown，常驻后台）：

   Windows 用编译好的 exe（把 `m3u8_adclean_server.exe` 与 `ad_patterns.txt` 放同一目录）：
   ```bat
   m3u8_adclean_server.exe
   m3u8_adclean_server.exe --port 9000        :: 换端口
   ```
   或用源码：
   ```bash
   cd adfilter
   python3 m3u8_adclean_server.py            # 默认 127.0.0.1:8787
   ```

   验证：`curl http://127.0.0.1:8787/health` 应返回 `ok`。

2. **安装/更新插件**：按上文「安装」章节从 `.fxplug` 或源码目录安装。

3. **开启去广告**：插件设置里打开
   - `尝试去广告（源头跳过广告段）` = 开
   - `去广告服务地址` = `http://127.0.0.1:8787`（须与服务启动参数一致）

4. 正常粘贴 m3u8 链接下载即可，广告段不会进入成品；服务端会**逐条打印被剔除的分片**。

### 广告识别规则（外置配置文件）

规则放在 `adfilter/ad_patterns.txt`，纯文本、每行一条、**改完重启服务即生效**（无需重编译 exe）：

| 写法 | 含义 |
| --- | --- |
| 空行 / `#` 开头 | 注释，忽略 |
| `re:<正则>` | 正则匹配（Python 语法，忽略大小写） |
| 其它文本 | 子串匹配（出现在分片 URI 任意位置即命中） |

默认规则为 `/video/adjump/`、`/adjump/`、`/ad/`、`/ads/`、`/adsv/`、`/preroll/`、
`/midroll/`、`/postroll/`、`/spot/`、`/skip`、`/companion`、`/vast/`、`preroll`、
`midroll`、`advert`、`doubleclick`、`googlesyndication`。

标准标记 `#EXT-X-CUE-OUT` / `#EXT-X-CUE-IN`、`#EXT-X-DATERANGE`（含 SCTE-35）、`#EXT-X-GAP`
由服务内置识别，无需配置。命中即整段剔除，并清除包裹用的 `#EXT-X-DISCONTINUITY`；
**命中的规则名会打印在日志里**，便于反查。规则语法详见 [`adfilter/README.md`](adfilter/README.md)。

### 清洗日志示例

```
[clean] 命中广告 3 条  ←  https://bfeng11.com/.../index.m3u8
  - 剔除[1/3] (规则「/video/adjump/」) https://bfeng11.com/video/adjump/time/1787320001790.ts
  - 剔除[2/3] (EXT-X-CUE-OUT 广告块) https://bfeng11.com/.../cue_ad.ts
  - 剔除[3/3] (EXT-X-GAP 占位段) https://bfeng11.com/.../gap.ts
  - 正片段保留 109 条，返回 18234 字节
```

### 实测

对真实样本 `https://bfeng11.com/.../index.m3u8`（244 行、9 个 `/video/adjump/` 广告段、
被两个 `#EXT-X-DISCONTINUITY` 包裹）端到端验证：广告段全部移除（9/9），`adjump` 与
`DISCONTINUITY` 计数归零，剩余 109 个正片段全部绝对化为 `https://bfeng11.com/...`，
playlist 合法、`#EXT-X-ENDLIST` 收尾。

### 局限与注意

- **仅适用于 VOD**：直播（LIVE/EVENT）playlist 持续刷新，静态清洗跟不上。
- **服务必须先启动**：`adClean` 开启但服务没跑 → 引擎抓本地 URL 失败 → 任务直接报错
  （resolver 为 fail-closed 语义）。**插件无法自检本地服务是否在线**——`flux.fetch`
  有 SSRF 防护，会拦截 loopback 地址，插件探测不了 `/health`，因此无法做自动回退。
  请确保服务常驻后再打开开关。
- **127.0.0.1 不要走代理**：若系统/引擎在用代理，确保 `localhost`/`127.0.0.1` 在
  `no_proxy` 内，否则引擎可能把本地请求也发往代理而失败。
- **隐藏式 SSAI 无解**：若广告段被做得与正片一致、不暴露 CUE/DATERANGE/GAP，只能靠
  域名/关键词猜，可能漏杀或误伤。清洗服务在未识别到任何广告时**原样透传**，避免误伤导致空列表。

## 文件名不理想？（命名机制说明）

下载成品名由**两端共同决定**，插件只能提供一半：

| 环节 | 谁负责 | 说明 |
| --- | --- | --- |
| `fileName` 建议值 | 插件 resolver | 决策链：`ctx.fileName`（已有名）→ 页面 `<title>` → URL 推导 |
| 最终文件名 | FluxDown 核心 | 插件给了就用；**没给则回落到「取 `<title>`，站点无 title 时用 `video`」** |

**为什么会出现满屏 `video`？** 站点播放页根本没有 `<title>`（或标题就叫「视频」），而任务在下载时又没走到插件的命名分支——核心取不到 title 就回落 `video`。实测 `play.hhuus.com` 的播放页确实无 `<title>`，属此类。

**为什么会出现一堆 `index`？** 这些站的播放列表固定叫 `index.m3u8`，若直接取末段文件名会得到毫无区分度的 `index`。v1.4.0 起不再采用这类通用名。

**v1.4.0 的命名规则**（`src/resolver.js` 的 `nameFromUrl`）：

1. 文件名有信息量 → 直接用（`EP01_1080p.m3u8` → `EP01_1080p`）
2. 文件名是 `index`/`playlist`/`master` 等 → 向上找**第一个 ID 段**（`.../298d923ea9c3/index.m3u8` → `298d923ea9c3`）
3. 再不行 → 取上层非通用目录名（`.../play/mepljmpe/index.m3u8` → `mepljmpe`）
4. 全无可用信息 → `video`

再叠加默认模板 `{title} {host}`，最终形如 `298d923ea9c3_bfeng11.com`、`mepljmpe_play.hhuus.com`。

**同一站点多集名字一样怎么办？** 用模板塞入更多区分位，例如：

```
nameTemplate = {title} {date}       # 加下载日期
nameTemplate = {title} {res} {host} # 加画质与域名
```

**仍然叫 `video` 的两种硬限制**（插件无法突破）：

1. **下载时不会调用插件 resolver**：若在画质框里选「忽略插件重试」，或该链接被核心缓存复用，插件这次拿不到执行机会，给不出 `fileName`——只能靠用户手改文件名，或关掉「自动选择」后重下以确保走插件路径。
2. **弹画质框的手选模式下部分情况不返回文件名**：此时文件名由核心决定，插件只在「自动选择」或直接返回 media playlist 时给 `fileName`。

**排查建议**：打开插件日志看是否有
`[m3u8-resolver] 页面无 <title>，无法取出片名；改用 URL 推导` —— 出现即说明该站点页面本身没有标题，命名只能靠 URL 推导。

## 工作原理（简述）

1. `src/resolver.js` 的 `resolve(ctx)` 判断作用域：
   - 直链 `.m3u8` → 直接拉取。
   - 播放页 → 抓页源码，正则抠 `master.m3u8`。
2. 校验返回值确实是 playlist（`#EXTM3U`）；若是 HTML 登录页则报错或交给 yt-dlp 兜底。
3. 解析 `#EXT-X-STREAM-INF` 变体与 `#EXT-X-MEDIA` 音轨/字幕轨，按带宽排序，依「偏好编码 + 偏好画质」算默认变体（或列出供手选），并给每个变体配上 `audioUrl`。
4. 返回结果带上 `Referer`（优先播放页 URL）/`Origin`/`User-Agent`/自定义头，标记 `rangeSupported` 以启用多线程分段；
   若开启去广告，则把返回的 **视频与音轨 URL 都**改写为指向本地清洗服务的地址。
5. 下载完成后 `src/hooks.js` 的 `onDone`：核心合并失败时用 ffmpeg 补合并；开启 remux 时把非 `.mp4` 容器无损转封装为 `.mp4`。
6. `onError` 记录失败原因。**钩子只对本插件经手的任务生效**——resolver 会把 `taskId` 写入插件存储作为标记，hooks 据此判断（理由见 `src/hooks.js` 文件头）。

## 安全与隐私

- 插件只在你配置的「目标站点主机」或直链 `.m3u8` 上生效，不会处理无关页面（fail-closed）。
- 插件存储里只写入一份「本插件经手的任务 ID → 时间戳」标记（单键、上限 60 条、6 小时后自动过期），用于让钩子只对本插件任务生效；不含任何 URL、Cookie 或媒体信息。
- `onDone` 的 remux 仅对白名单容器（`ts`/`mkv`/`webm`/`flv`/`m4v`/`mov`/`m2ts`/`mpeg`/`mpg`/`ogv`）生效，避免误转 `.zip`/`.pdf`。
- 去广告清洗服务是**本机外置进程**，仅监听 `127.0.0.1`，只接收「原始 playlist 的 URL 指针」，不接收上传数据；分片直连源站。
- Cookie 由 FluxDown 引擎统一管理，插件不单独存储凭据。
- 本插件不向任何第三方上传数据。

## 限制

以下为**官方接口的硬限制**，不是本插件尚未实现（详见 [`docs/plugin-capability-matrix.md`](docs/plugin-capability-matrix.md)）：

- **字幕（WebVTT）**：resolver 的返回值里没有任何字幕字段；同时 ffmpeg 沙箱只允许访问产物目录内的相对名，而 `flux.fs` 是另一个独立工作区，抓到的字幕文件送不进去。因此**插件单层无法下载/封装/烧录字幕**。插件会识别并记录字幕轨（写日志），但不会下载。
- **任务分组**：官方明确「插件不能创建任务」，也没有分组接口 —— 无法按剧集自动建组。
- **`onMetaProbed`**：带 resolver 的插件该钩子永不触发（官方明确），因此 manifest 不订阅它。
- **SAMPLE-AES / SAMPLE-AES-CTR / FairPlay / Widevine 等 DRM 解密**、**LL-HLS（`#EXT-X-PART` 部分段）**、**真直播无限录制**：属于核心 `hls_downloader` 的能力，插件层够不到。含 Widevine / FairPlay / PlayReady 的流需要 CDM 与许可证，**任何下载工具都无法绕过**；这类场景请用 yt-dlp 委派或 [N_m3u8DL-RE](https://github.com/nilaoda/N_m3u8DL-RE)。插件会在解析时把源的加密方式（METHOD / KEYFORMAT）写进日志，便于判断失败归属。
- **`#EXT-X-KEY:METHOD=NONE`（AES-128 段之后切回明文段）当前会失败，且不是插件的问题**：核心所依赖的 `m3u8-rs 6.0.1` 有一处 IV 校验写反的上游缺陷，使该标签被降级为未知标签，于是明文段被错误地用上一段的 AES-128 密钥解密，报 `decrypt_segment: … PKCS7 decrypt error (Unpad Error)`。插件不能改写 playlist 内容，无法规避。**完整复现、根因与修复补丁见 [`docs/upstream-m3u8-rs-method-none.md`](docs/upstream-m3u8-rs-method-none.md)**。
- 播放页解析依赖兜底正则，复杂前端（m3u8 在加密 JSON / 分段加载）仍需自定义 `extractMaster` 或启用 yt-dlp 委派。
- 去广告仅对 VOD 有效，详见「源头去广告」的局限与注意。

## 文件结构

```text
.                                  # 仓库根（非插件本体，含附属内容）
├── src/                           # ← 插件本体（「从目录安装」/开发模式指向此目录）
│   ├── manifest.json              # 插件清单（identity、权限、设置、entry）
│   ├── resolver.js                # 解析入口：发现 master、选变体、音轨配对、鉴权头、去广告改写
│   └── hooks.js                   # 钩子：onDone（轨对合并兜底 / remux）、onError（失败日志）
├── adfilter/                      # 外置「源头去广告」本地清洗服务（独立进程，非插件本体）
│   ├── m3u8_adclean_server.py     # 清洗服务源码：剔广告段 + 段绝对化 + 逐条剔除日志
│   ├── ad_patterns.txt            # 广告识别规则（纯文本，改完重启服务生效）
│   ├── _build_exe.py              # Nuitka 打包脚本（本地工具，.gitignore 忽略）
│   ├── dist/                      # 打包产物：m3u8_adclean_server.exe（不入库）
│   └── README.md
├── docs/
│   ├── ad-removal-notes.md        # 去广告方案调研笔记（源码级论证 / 实测 / TODO）
│   └── plugin-capability-matrix.md# 插件能力边界（已对照官方 API 核实）
├── LICENSE
└── README.md
```

> **插件本体就是 `src/` 目录。** `manifest.json` 必须位于插件文件夹根（即 `src/` 内），
> `entry` 使用同目录相对路径（`resolver.js` / `hooks.js`）。开发模式下改 `src/*.js` 存盘即热生效。

## 发布打包

仅**发版时**打包，日常开发不必打包：

1. 把 `src/` 下的文件作为 **zip 根** 压缩（`manifest.json` 必须在 zip 根）：
   ```
   待入包：src/manifest.json、src/resolver.js、src/hooks.js  →  置于 zip 根
   ```
2. 重命名为 **`fluxdown-plugin-m3u8_<版本号>.fxplug`**（例：`fluxdown-plugin-m3u8_1.3.0.fxplug`）。
   - 版本号与 `src/manifest.json` 的 `version` 保持一致。
3. 计算校验和：`sha256sum fluxdown-plugin-m3u8_<版本号>.fxplug`。
4. `.fxplug` **不进 Git 仓库**（已在 `.gitignore` 忽略），发版时上传到 GitHub Release。

> `adfilter/`、`docs/`、`LICENSE` 是仓库附属内容，**不进 `.fxplug`**。

## 打包清洗服务 exe（Nuitka）

`adfilter/` 下的本地去广告服务可编译成单文件 exe，免装 Python 即可常驻运行：

```bat
cd adfilter
python -m pip install nuitka
python _build_exe.py                  :: auto：先试 MSVC，不可用自动回退 zig
python _build_exe.py --compiler zig   :: 直接指定 zig，最快
python _build_exe.py --keep           :: 保留中间产物，便于排查编译问题
```

等价的手动命令：

```bat
python -m nuitka --onefile --zig --assume-yes-for-downloads ^
  --output-dir=dist --output-filename=m3u8_adclean_server.exe ^
  --windows-console-mode=force --nofollow-import-to=tkinter,unittest,doctest,test ^
  m3u8_adclean_server.py
```

- 前置：Python 与一个 C 编译器。**Python ≥ 3.13 请直接用 `--zig`**（Nuitka 自动下载 Zig 0.16）：
  Nuitka 4.2.2 的 `--mingw64` 只支持 Python ≤ 3.12，而它在 3.13/3.14 上的 MSVC/Windows SDK 探测
  存在误报（机器上装了 VS + SDK 也会报 `Windows SDK must be installed`）。
- 编译前请确保 `dist/` 下没有上次失败的残留（`*.build` / `*.onefile-build`），否则 Nuitka 删不掉会抛 `WinError 5`。
- 分发：把 `dist\m3u8_adclean_server.exe` 与 `ad_patterns.txt` 放**同一目录**即可
  （规则文件缺失时 exe 会按内置模板自动生成一份）。
- 产物在 `adfilter/dist/`，已被 `.gitignore` 忽略，**不入库**；需要时随 Release 一并附上。
- 想让服务长期常驻后台，可用 `--standalone` 目录版：启动更快、杀软误报更少。

## 许可证

[MIT](LICENSE) © 2026 cocolight
