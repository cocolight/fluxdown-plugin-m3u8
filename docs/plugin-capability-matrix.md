# FluxDown 插件能力矩阵（已对照官方文档核实）

> 依据：FluxDown 官方插件文档 `website/src/content/docs/zh/plugins/{overview,manifest,api-reference}.md`
> 与引擎源码（`native/engine/src/`；完整克隆在 `E:/Project/FluxDown`）。
> 核对日期 2026-10-01，对应插件版本 **1.6.0**。
> 2026-10-01 本轮：读引擎 `plugin/runtime.rs` 与 `plugin/manifest.rs`，核实三项公开文档未列的能力
> （`manifest` / `subscriptions` / `auth`）与 `onCancel`，更正 §1 / §4 中两处旧判断（详见 §7）；
> 其中 **① 多文件清单在 v1.5.0 落地，② 订阅源 / ③ 登录认证在 v1.6.0 落地**。
> 另核实一条对 v1.6.0 至关重要的事实：**宿主只在 `flux.fetch` 内注入认证档案**
> （`plugin/bridge.rs::http_request` 调 `AuthProfile::apply_to_headers`，下载链路无调用点）
> ⇒ 下载 playlist / 分片所需的凭据必须由插件自己并进 `extraHeaders`（见 §7.4）。
>
> 本文的用途：把「哪些能靠插件补、哪些是接口硬限制」钉死，避免再按二手分析文档
> 去实现不存在的字段。凡是标 ❌ 的，都已验证接口不存在，**不要尝试**。

---

## 1. 接口事实清单（决定一切的约束）

| 事实 | 含义 / 影响 |
| --- | --- |
| `resolve(ctx)` 返回字段**穷举**为：`url`、`audioUrl`、`fileName`、`totalBytes`、`extraHeaders`、`ephemeral`、`rangeSupported`、`variants`、`defaultVariantIndex` | **没有字幕字段**。任何「返回字幕 URL」的设计都不成立 |
| `variants[]` 每项允许：`label`、`url`、`audioUrl`、`fileName`、`totalBytes`、`bandwidth`、`width`、`height`、`container` | 变体可带 `width`/`height`/`bandwidth`/`container`；**没有 `codecs`**（编码只能在插件的 label 里展示） |
| `onDone(ctx)` 额外字段：`filePath`、`audioPath`、`muxed` | `muxed` = 轨对任务**是否已成功合并为单文件**；`audioPath` 仅在**核心合并失败降级**时非空 → **核心自己做音视频合并**，插件不要重复合并 |
| hooks `events`：公开文档列 4 个（`onStart` / `onError` / `onDone` / `onMetaProbed`），**引擎 `VALID_EVENTS` 实为 5 个（含 `onCancel`）** | v1.5.0 起已订阅 `onCancel`，用于清理 `handledTasks` 标记 |
| `resolvers[0]` 可带 **`multi: bool`**，配合 `ResolveResult.manifest` | 引擎支持**多文件清单**：声明后可返回 `manifest{name, items[]}`，引擎自动裂变为 N 个子任务（详见 §7） |
| manifest 额外字段 **`subscriptions[]`**（`{providerId, entry, timeoutMs}`） | 引擎支持**插件订阅源**，entry 定义 `globalThis.subscribe(ctx)`；v1 每插件至多一个 provider（详见 §7） |
| manifest 额外字段 **`auth`** + `permissions:["auth"]` | 引擎支持**登录认证**，entry 定义 `globalThis.authenticate`；`resolve(ctx).authRef` **仅声明 `auth` 权限的插件才有值**（详见 §7） |
| **带 resolver 的插件，`onMetaProbed` 永不触发** | 订阅它无意义（加载时还会被记一条警告） |
| `hooks.match` 只按**任务的原始 URL**过滤 | 播放页入口（原始 URL 不含 `m3u8`）会漏掉所有钩子 → 本插件改用 `taskId` 存储标记 |
| `permissions` 只接受 `ffmpeg` / `ytdlp` / `auth` | 未知值会让整份 manifest 校验失败 |
| `flux.fetch` 拦截 loopback / 局域网 / link-local / 云元数据 IP | 插件**无法探测本地服务**（`adfilter` 的 `/health` 探不到），去广告不能做自动回退。**注意：该守卫只作用于 `flux.fetch`，不拦引擎自身的下载客户端**（源码复核 `bridge.rs` + `hls_downloader.rs`） |
| `flux.ffmpeg` / `flux.ffprobe` **只在 `onDone` 可用**，工作目录 = 产物目录，参数禁止绝对路径/`..`/URL scheme | 想用 ffmpeg 处理某个文件，该文件必须在产物目录里且用相对名引用 |
| `flux.fs` 是**独立的** scratch 工作区（与 `flux.ytdlp` 的 cwd 同一处） | 写进它的文件**到不了** ffmpeg 的产物目录沙箱 |
| ★ **认证档案只在 `flux.fetch` 内被注入**：全仓库 `apply_to_headers` 唯一调用点在 `bridge.rs::http_request`（且要求 `site_key(req.url) == profile.site`） | **下载链路（playlist / 分片 / KEY）拿不到插件凭据** ⇒ 插件必须把凭据并进返回值的 `extraHeaders`（v1.6.0 的 `authHeadersAsync`） |
| **插件不能创建任务、不能读任意文件、不能操作界面** | 没有任务/分组管理能力。**但引擎会据插件输出代为建任务**：清单（`manifest`）→ 裂变建组；订阅条目 → 建任务。插件自身仍不建任务 |
| `flux.task` 只有 `requestRetry`（且只在 `onError` 有效） | 没有分组 CRUD、没有查询任务的接口 |

---

## 2. 核心原生能力 vs 插件增益（即「插件是否冗余」的答案）

> 起因：用 5 条公开直链 `.m3u8` 测「不用插件也能下」，观察到「和插件没区别」。
> 已核实：该现象是**结构性的**（不是巧合），且这 5 条恰是插件历史上唯一真正搞坏过的一批。

### 2.1 核心自己就能处理 `.m3u8` —— 靠**扩展名嗅探**

| 事实 | 位置 |
| --- | --- |
| HLS 路由判据 = 扩展名 `.m3u8` / `.m3u` | `hls_downloader::is_hls_url()`（`hls_downloader.rs`） |
| 任务启动时据此分流，**完全不经过插件** | `download_manager.rs`：`let use_hls = hls_downloader::is_hls_url(&task.url);` |
| 核心 HLS 引擎完整：解析 master → `select_variant` → 下载分片 → remux | `hls_downloader.rs` |
| 自动选变体策略 = **最高 bandwidth**；单变体或免打扰时直接选，否则弹框 | `hls_downloader.rs::select_variant` |

→ 任何**公开、免鉴权、直链 `.m3u8`** 都 100% 走核心原生路径。插件在这条路径上是**纯透传**
（抓一次 playlist → 解析 → 交回同一 URL），所以「结果与裸核心相同」是设计使然，
**不能作为「插件冗余」的证据**。

### 2.2 核心做不到的 —— 插件唯一的价值区间

全 `native/` 检索确认：**引擎本身没有页面解析 / 自动抽流**；yt-dlp 在核心侧只有**组件管理**
（安装 / 版本 / 状态，见 `native/hub/src/actors/download_actor.rs`），运行时唯一消费方是
插件桥（`flux.ytdlp`，权限 `ytdlp`）。→ **引擎层面，播放页 URL 只会得到 HTML。**

> ⚠️ **但有一条会削弱该结论的路径（务必知悉）**：桌面端另有**浏览器扩展**
> （`native/agent/`：NMH 原生消息中继 `nmh.rs` + 捕获事务 `capture.rs`），可把浏览器中的
> **真实媒体 URL** 与**浏览器自身的请求头**送进下载任务 —— 见 `engine/src/model.rs` 的
> `source_page_url`（注释：Source page URL captured by the browser extension）与
> `capture.rs`「留空则沿用**浏览器头** / 已保存站点凭据」。
> → 若装了该扩展并用「浏览器触发下载」，**播放页发现 + 防盗链这两项护城河都可能被浏览器覆盖**。

| 输入 / 需求 | 裸核心 | 插件 | 依据 |
| --- | --- | --- | --- |
| 公开直链 `.m3u8` | ✅ 完整 | 无增益 | `is_hls_url` 扩展名分流 |
| **播放页 URL**（不含 `.m3u8`） | ❌ 按普通 HTTP 下载 → 得到 HTML | ✅ 抓页抠 master | 引擎无页面解析；yt-dlp 非插件不可达。**浏览器扩展路径可覆盖** |
| **防盗链**（Referer / Origin / UA / 自定义头） | ❌ 无从得知页面来源 | ✅ `extraHeaders` | resolver 专属 |
| **广告段剔除** | ❌ 引擎自闭环下载全部 `#EXTINF`，无 segment 钩子 | ✅ 改写 playlist | 见 §4 |
| 选轨（语言）/ 纯音频提取 / 按编码筛 | ⚠️ 只有 `select_variant`（最高带宽），无选轨 | ✅ `audioUrl` + `audioOnly` | |
| 命名 | ⚠️ 有 `title → video` 兜底链 | ✅ 更优取值 | |
| 复杂前端（m3u8 藏在 JS/JSON） | ❌ | ✅ yt-dlp 委派 | |

**判断**：插件不是"下载器"，是**下载之前的发现层 + 鉴权层 + 预处理层**。
它在公开直链上与核心重叠，但在播放页 / 防盗链 / 去广告场景下核心无法替代。

### 2.3 反证：这批「证明冗余」的链接，正是插件唯一搞坏过的

v1.4.1 修掉的 `new URL` 缺陷（QuickJS 无 `URL` 全局对象 → `absUrl()` 返回相对串 →
引擎报 `url scheme 不允许: <相对URI>`），其报错串与这 5 条的**变体名逐字命中 5/5**：

| 测试链接的变体名 | v1.4.1 报错串 |
| --- | --- |
| `url_8/193039199_mp4_h264_aac_fhd_7.m3u8` | `url_8/...` |
| `tears-of-steel-audio_eng=64008-video_eng=401000.m3u8` | `tears-of-steel-audio_eng=...` |
| `tos_1080p/index.m3u8` | `tos_1080p/index.m3u8` |
| `v9/prog_index.m3u8` | `v9/prog_index.m3u8` |
| `25774983_…_1@2320000pb.m3u8` | `25774983_…_1@2320000pb.m3u8` |

→ **修好之前对比是反的**：裸核心能下，装插件直接失败。
故这批链接是**最强反例**，不是「插件冗余」的有效对照。

### 2.4 唯一的真实负增益

`adClean` 开着但 `adfilter` 服务未启动 → **fail-closed**，本可成功的任务直接报错
（插件无法探测本地服务，`flux.fetch` 拦 loopback）。这是可复现的负增益，须保证服务常驻。

### 2.5 综合判断（已把浏览器扩展路径计入）

| 能力 | 有无核心 / 浏览器等价路径 | 插件是否冗余 |
| --- | --- | --- |
| 公开直链 `.m3u8` | 核心原生完整 | **是**（插件纯透传） |
| 播放页发现 master | 引擎无；浏览器扩展可能有 | 取决于是否用扩展 |
| 防盗链（Referer/UA/Cookie） | 引擎无；浏览器扩展可能带上 | 取决于是否用扩展 |
| 广告段剔除 | **无任何等价** | 否 |
| 纯音频提取 / 按语言选轨 / 按编码筛 | **无**（`select_variant` 只按最高带宽） | 否 |
| 非浏览器场景（NAS / 远程 / 直接粘 URL） | 无 | 否 |

→ 插件的**确定独有能力**只有三项：**广告剔除、选轨·纯音频、无浏览器时的发现 + 鉴权**。
其余能力在「装了浏览器扩展 + 用浏览器触发下载」的前提下会被核心或扩展覆盖。

---

## 3. 插件对核心下载器的补足清单（全量逐项）

> 本节回答「插件到底弥补了核心哪些能力」。口径分三类：
> - **独占** —— 核心与浏览器扩展都做不到；缺了插件就是做不到。
> - **增益** —— 核心能做，但插件做得更准 / 更省事。
> - **重叠 / 条件性** —— 核心已覆盖，插件只在特定分支上还有价值。

| # | 能力 | 裸核心的行为 | 插件怎么补 | 开关 | 判定 |
| --- | --- | --- | --- | --- | --- |
| 1 | 播放页 URL → 发现 master | 按普通 HTTP 下载 → 得到 HTML 文件 | 抓页面源码 + 正则抠 `master.m3u8`（支持 `https:\/\/` JSON 转义与相对地址） | `targetHosts` 限定生效站点 | **独占** |
| 2 | 防盗链 `Referer` / `Origin` | 无从得知页面来源，403 | 返回 `extraHeaders`，`Referer` 优先取页面 URL（非 origin） | 自动 | **独占** |
| 3 | 自定义 `User-Agent` / 任意请求头 | 无入口 | `userAgent` + `extraHeadersRaw`（多行 `Key: Value`），**抓 playlist 与抓分片共用同一套头** | `userAgent`、`extraHeadersRaw` | **独占** |
| 4 | 广告段剔除 | 引擎自闭环下载全部 `#EXTINF`，**无 segment 钩子** | 把 playlist 改写为指向 `adfilter` 清洗服务，广告段不进引擎视野 | `adClean` + `adCleanServer` | **独占** |
| 5 | 独立音轨（`#EXT-X-MEDIA:TYPE=AUDIO`） | 核心**支持** `audioUrl` 并自动 mux（`muxed`），但**自己选不出音轨** | 解析 AUDIO 组与纯音频 `STREAM-INF` 变体，输出 `audioUrl` | `separateAudio` | **独占（发现层）** |
| 6 | 多语言选轨 | 无选轨概念 | `AUDIO` 组收敛 → `LANGUAGE` → `DEFAULT` → `AUTOSELECT` → 首条 | `audioLang` | **独占** |
| 7 | 纯音频提取 | 能下指定 URL，但选不出「哪个是音轨」 | 定位独立音轨；源无独立音轨时 **fail-closed 并给明确原因** | `audioOnly` | **独占（发现层）** |
| 8 | 按编码筛画质（H.264/H.265/AV1/VP9） | `select_variant` 只看 `bandwidth` | 按 `CODECS` 改**默认选中项**，不隐藏其他变体 | `preferCodec` | **独占（增益）** |
| 9 | 按分辨率档位偏好 / 免弹框 | 只有「最高带宽」+ 弹框二选一 | `pickVariant` 按**高度**命中 1080/720/…（顺带修了旧代码用宽度比较的缺陷） | `preferResolution`、`autoPick` | **增益** |
| 10 | 命名 | `title → video` 兜底链，直链常得到裸名 | 四层取值链（`ctx.fileName` → `<title>` → 上层 ID 段 → 文件名）+ 模板占位符 | `nameTemplate` | **增益** |
| 11 | 伪 m3u8（HTML 登录页 / 拦截页）识别 | 当成视频下载 → 得到一个 HTML | `#EXTM3U` 校验 + HTML 特征识别 → 可自动切 yt-dlp 兜底 | `htmlFallbackYtdlp` | **独占** |
| 12 | 复杂前端（m3u8 藏在 JS / 加密 JSON） | 无 | `flux.ytdlp` 委派抽直链 | `useYtdlp` | **独占** |
| 13 | 下载后 remux 为 MP4 | **核心已内置**：`remux_ts_to_mp4()`（best-effort，失败保留 `.ts`；fMP4 仅改名 `.mp4`） | 仅在①核心 remux **失败的降级分支**、②**非 HLS 任务**（yt-dlp 产出的 `.mkv`/`.webm` 等）上补一次；对已是 `.mp4` 的产物**直接跳过**，不会双重转封装 | `remuxToMp4` | **重叠 / 条件性** |
| 14 | 轨对合并失败兜底 | 核心合并失败会**降级**留下独立音频文件 | `onDone` 用 ffmpeg `-c copy -map` 补做合并 | `fixMuxFallback` | **独占（补核心降级）** |
| 15 | 加密方式体检 / 故障归因 | 报 `PKCS7 … Unpad Error` 之类，无归因 | `noteEncryption()` 打印 `METHOD` / `KEYFORMAT`，并区分 **DRM 无解 / 引擎能力边界 / 上游缺陷** | 自动（仅日志） | **增益（可观测性）** |
| 16 | 作用域限制 | 无（任何 URL 都尝试处理） | `inScope()`：只处理配置站点与直链 `.m3u8` | `targetHosts` | **独占** |
| 17 | 相对地址绝对化 | 核心自己会处理 | **插件必做的自保**：QuickJS 沙箱无 `URL` 全局对象，需自实现 `absUrl()`（v1.4.1 修复过此处） | 自动 | **必要条件**（非增益） |

**汇总**：独占能力 **11 项**（1/2/3/4/6/11/12/16 + 5/7 的发现层 + 14）、增益 **4 项**（8/9/10/15）、
重叠·条件性 **1 项**（13）、必要自保 **1 项**（17）。

**唯一真实负增益**（§2.4）：`adClean` 开而 `adfilter` 未启动 → 任务**直接报错**而非静默下原片；
且插件**无法探测**本地服务（`flux.fetch` 拦 loopback），没有自动回退。见 §6 待验证项。

---

## 4. 能力矩阵

图例：✅ 已实现 ｜ ⚪ 可实现但本次未做 ｜ ❌ 接口不支持（硬限制）

| 能力 | 状态 | 依据 / 实现方式 |
| --- | --- | --- |
| master 发现（直链 / 播放页） | ✅ | `resolver.js: extractMaster()`，支持 `https:\/\/` JSON 转义与相对地址 |
| 多码率变体解析与手选/自动选 | ✅ | `parseMaster()` + `pickVariant()` |
| **独立音轨下载 + 合并** | ✅ | 解析 `#EXT-X-MEDIA:TYPE=AUDIO` 与纯音频 `STREAM-INF` → 返回 `audioUrl`；**合并由核心完成**（`muxed`） |
| 多语言/多音轨选默认 | ✅ | `AUDIO` 组收敛 → `LANGUAGE` 偏好 → `DEFAULT` → `AUTOSELECT` → 首条 |
| 按 `CODECS` 筛选变体 | ✅ | `preferCodec`：只改默认选中项，不隐藏其他变体 |
| 纯音频提取 | ✅ | `audioOnly`；源无独立音轨时 fail-closed 并给明确提示 |
| 自定义 UA / 任意请求头 | ✅ | `userAgent` + `extraHeadersRaw`，同时作用于抓 playlist 与抓分片 |
| 精确 Referer（播放页 URL 而非 origin） | ✅ | `refererValue()`：`ctx.referrer` 优先，回落 origin |
| 伪 m3u8（HTML 登录页）检测 | ✅ | `looksLikeHtml()` + `#EXTM3U` 校验；可自动切 yt-dlp 兜底 |
| 嵌套 master 递归解析（master 里再指 master） | ⚪ | master 与内层 master 的**结构完全相同**，无可靠信号；只能靠额外抓一次子 playlist 才能判断，为省一次 RTT 未实现 |
| 按容器（fMP4 vs TS）筛选 | ❌ | master 层没有容器信息（`container` 需在返回变体里给出，而 master 不提供）；只能在 `label` 里展示编码 |
| key URI（`#EXT-X-KEY`）单独带鉴权头 | ❌ | 密钥请求由核心引擎发出，插件无法按请求区分；只能通过 `extraHeaders` 全局覆盖 |
| `ephemeral` 升级为周期性 re-resolve | ❌ | 核心已是「每次开始/恢复都重新执行 `resolve`」的惰性模型，无需插件干预 |
| **字幕轨道（WebVTT）** | ❌ | 返回值无字幕字段；且 `flux.fs` ≠ ffmpeg 沙箱，抓到的字幕送不进去。**只能识别并记录** |
| **多文件清单 / 批量建任务（`manifest` + `multi`）** | ✅ | **已实现（v1.5.0）**：`resolvers[0].multi=true` 时 `resolve()` 返回 `manifest{name, items[]}`，引擎**自动裂变为 N 个子任务**，二段用 `resolver_item`（`<id>` / `<id>@<variantId>`）回调取直链。约束：与 `url`/`variants`/`audioUrl` **互斥**、**仅初段可返回**、`path` 深度 ≤8 且 `path/name` ≤180。误判防护见 §7.3 |
| **订阅源（自动追更）** | ✅ | **已实现（v1.6.0）**：`subscriptions:[{providerId:"m3u8play",entry:"subscribe.js",timeoutMs:25000}]`，v0.4.8 起订阅来源可选插件，条目**自动建任务 / 去重 / 调度 / 重试**复用内置能力。插件只枚举并输出 feed（不碰订阅表、不建任务），`guid` 由「主机 + 路径」的 FNV-1a 生成（丢 query 以防签名抖动）。接口契约见 §7.2 / 实现要点见 §7.4 |
| **登录认证** | ✅ | **已实现（v1.6.0）**：`auth:{entry:"auth.js"}` + `permissions:["auth"]`，v0.4.8 起支持 Cookie/Basic/Bearer/Headers；凭据经 `ctx.authRef` 自动附加到 `flux.fetch`。★ **下载链路不自动注入** ⇒ 插件自建 `authHeadersAsync()` 把凭据并进 `extraHeaders`（见 §7.4） |
| 全钩子通知/日志 | ✅（部分） | 已用 `onDone` + `onError` + **`onCancel`（v1.5.0 起订阅，用于清理任务标记）**。`onMetaProbed` 对本插件永不触发；`onStart` 仅纯日志、徒增噪音，未订阅 |
| 命名模板 | ✅ | `nameTemplate`，占位符 `{title} {res} {lang} {host} {date}` |
| 合并完整性校验（段数 vs manifest） | ❌ | 插件拿不到下载进度/段清单；`flux.task` 无查询接口 |
| **SAMPLE-AES / SAMPLE-AES-CTR / FairPlay / Widevine 等 DRM** | ❌ | 解密在核心 `hls_downloader.rs`（只实现 `NONE` / `AES-128`，其余在解析阶段直接拒绝）；插件拿不到 key。含 Widevine/FairPlay/PlayReady 的流**任何工具都无法绕过**（需 CDM + 许可证）。插件侧仅在 `noteEncryption()` 里报明加密方式，不尝试解密 |
| **`#EXT-X-KEY:METHOD=NONE`（AES-128 段之后切回明文）** | ❌ | **上游缺陷**：`m3u8-rs 6.0.1` 的 `Key::from_hashmap` IV 校验写反，把该标签降级为未知标签 → 引擎粘性密钥不重置 → 明文段被误用上一段密钥解密 → `PKCS7 … Unpad Error`。插件不能返回 playlist 内容，**插件层无法规避**；但**引擎侧兜底已实现，PR [zerx-lab/FluxDown#715](https://github.com/zerx-lab/FluxDown/pull/715) 已提**（在 `hls_downloader.rs` 识别 `unknown_tags` 里的 `X-KEY` + `METHOD=NONE` 并重置密钥状态），上游修复 PR #95 亦已提；**兜底与上游修复的兼容性已用三配置差分实测证明**（上游修复后兜底静默失效、不重复生效，且届时可安全删除）。详见 [upstream-m3u8-rs-method-none.md](upstream-m3u8-rs-method-none.md) §6 / §6.2 |
| **LL-HLS（`#EXT-X-PART` 部分段）** | ❌ | partial segments 的抓取/拼接在核心引擎 |
| **真直播无限录制** | ❌ | 滚动窗口的持续追加落盘需核心引擎配合；插件只能「轮询 + re-resolve」，做不了边播边追加 |
| **ISM / 平滑流式** | ❌ | 不是 m3u8 体系 |

---

## 5. 本次修掉的两个既有缺陷

1. **`preferResolution` 用宽度比较 → 选 1080p 反而落到 480p**
   旧代码 `variants[i].resolution <= want`，而 `resolution` 存的是**宽度**（1920），
   降序数组里 `1920 <= 1080` 为假、`1280 <= 1080` 也为假，于是错落到 `854 <= 1080` 的 480p。
   现改为按**高度**比较（`1080 <= 1080` 命中 1080p），已加回归测试（测试 07/08）。

2. **`hooks.match: ["*://*m3u8*"]` 让 remux 对播放页入口静默失效**
   `hooks.match` 只过滤**任务原始 URL**。播放页 URL（如 `https://site.com/watch/123`）
   不含 `m3u8` ⇒ remux 与轨对合并兜底**永远不会触发**，用户无感知。
   现改为不设 `match`，由 resolver 把 `taskId` 写入插件存储作为标记，hooks 侧据此只处理
   本插件任务（单键、上限 60 条、6 小时 TTL、异常全吞），已加跨脚本回归测试（测试 20/21）。

---

## 6. 遗留 / 待验证

- [x] ~~去广告链路是否被引擎的 loopback 拦截~~ —— **已由源码复核排除**：
      `native/engine/src/plugin/bridge.rs` 的 SSRF 守卫只作用于 `flux.fetch`
      （`is_loopback`/`is_private` 拦截），**引擎自身的下载 HTTP 客户端不受限**，
      因此 resolver 返回 `http://127.0.0.1:8787/clean?...` 后引擎能正常抓取本地代理。
      同时 `hls_downloader.rs` 在 `select_variant` 后**不再回经 resolver**，
      所以 master 里的内层 variant/media/key URI 必须由清洗服务**自指改写**才算彻底
      ——`adfilter` 已按此实现（master 的变体 URI 会被改写成指向服务自己）。
      剩下的只有「真机端到端跑一次」的确认，不是设计风险。
- [ ] 音轨分离后产物命名与多轨封装行为，需在真实 fMP4 源上观察（核心如何命名 `.audio.m4a`）。
- [ ] `extraHeaders` 是否确实作用于**分片与密钥请求**（官方描述是「下载解析后直链时附带」），
      若只作用于首次请求，则 `#EXT-X-KEY` 的防盗链头需要另想办法。
- [x] ~~源码中 `ResolveResult` 的 `manifest` 字段语义未核实~~ —— **已核实并落地**（2026-10-01，读 `native/engine/src/plugin/runtime.rs`）：多文件清单，配 `resolvers[0].multi=true` 使用，引擎自动裂变建任务。**v1.5.0 已实现**（剧集页识别 + 二段解析，见 §7 / §7.3）。

---

## 7. 引擎已支持但公开文档未列的能力（2026-10-01 核实）

读引擎源码（`native/engine/src/plugin/runtime.rs`、`.../plugin/manifest.rs`）核实：引擎已支持、公开文档未列的三块能力，均直接命中剧集/动漫站场景。这三项都是「插件不建任务，但引擎据插件输出自动建任务」的机制，因此**不违反**「插件不能创建任务」这一约束。

> **落地进度**：① 多文件清单 —— **v1.5.0 已实现**（见 §7.3）；② 订阅源、③ 登录认证 —— **v1.6.0 已实现**（见 §7.4）。

| # | 能力 | 声明方式 | 价值 | 关键约束 |
| --- | --- | --- | --- | --- |
| 1 | **多文件清单（批量建任务）** | `resolvers[0].multi=true` → `resolve()` 返回 `manifest` | 一个剧集页 → 批量 N 集，引擎自动裂变建任务 | 与 `url`/`variants`/`audioUrl` 互斥；**仅初段**可返回（二段拒，防递归）；`items` 1..=1000；`path` ≤8 级、`path/name` ≤180 |
| 2 | **订阅源（自动追更）** | `subscriptions:[{providerId,entry,timeoutMs}]` → `globalThis.subscribe(ctx)` | 订阅页 → 新集自动入队（去重/调度/重试复用内置能力） | v1 至多一个 provider；`providerId` = 小写字母/数字/`_`/`-`，≤64，且不得为内置保留字 `rss` |
| 3 | **登录认证** | `auth:{entry,timeoutMs}` + `permissions:["auth"]` → `globalThis.authenticate` | 解锁需登录站点；`ctx.authRef` 自动带凭据（`flux.fetch` 复用） | 声明 `auth.entry` 时 `permissions` 必须含 `auth`，否则整份 manifest 校验失败 |

### 7.1 `manifest` 的契约细节（`ResolveManifest` / `ManifestItem`）

- `ResolveManifest`：`{ name, items: ManifestItem[] }`；`name` 为空时由宿主用母任务文件名/首个条目名兜底。
- `ManifestItem`：`{ id, name, path, size?, kind, variants? }`
  - `id`：插件自定义标识，非空、≤200 字符；**二段回调原样回传**在 `ResolveRequest.resolver_item`。
  - `name`：文件名，须过与 `file_name` 相同的合法性检查（禁 `/`、`\`、`..`、控制字符）。
  - `path`：组根相对子路径（空 = 根），按 `/` 计深度 ≤8 级，`path + "/" + name` ≤180 字符。
  - `kind`：`""` / `"file"`（`"folder"` 预留，v1 不实现；其余一律拒绝）。
  - `variants`：可选的规格列表（≤50），每项 `{id, label, size?}`。
- **二段解析**：引擎对每个条目以 `resolver_item` = `id`（无规格）或 `id@variantId`（有规格）**再次调用同一个 `resolve()`**；此时 `resolver_item` 非空，须返回**单直链**（返回 `manifest` 会被拒），且变体收敛静默取默认（不为 N 个子任务弹 N 个选择框）。

### 7.2 硬前提（务必遵守）

manifest 为 `deny_unknown_fields` —— **旧版 FluxDown 见到 `multi` / `subscriptions` / `auth` 会拒绝整份 manifest**（表现为插件被跳过，而非忽略该字段）。因此：

1. 落地前必须抬 `minAppVersion`。**引入版本已用 `git tag --contains` 确证**：
   `multi` / `ResolveManifest`（`6bb74507`）随 **v0.3.0** 落地；`subscriptions`（`eca60efe`）与 `auth`（`0f08118f`）随 **v0.4.8** 落地。
2. ★ **`minAppVersion` 救不了旧版**：它是在 **serde 解析成功之后**才检查的，而旧版在**解析阶段**就因 `deny_unknown_fields` 失败、插件被跳过。它只能让新版**主动**跳过。
3. 故按能力分设门槛：**v1.5.0（`multi`）= `0.3.0`**（保住 0.3.x–0.4.7 用户的剧集批量下载）；**v1.6.0（订阅 / auth）= `0.4.8`**。
4. 这些字段属引擎契约、**未进公开文档**，存在随版本变动的风险，落地时须绑定实际安装版本复验。

### 7.3 v1.5.0 实现要点（`multi` 落地）

- **声明**：`resolvers[0].multi = true`，`minAppVersion: "0.3.0"`，`hooks.events` 增 `onCancel`。
- **判定分层**（`detectListing`；**只认强信号，宁漏勿错** —— 误判的代价是每个单视频页都弹选集框，桌面端提交单条 http(s) 链接时会先做一次只读预览，`items` 非空即弹窗）：
  - Tier-1：页面内出现 m3u8 → 按「质量折叠」分组；**1 组 = 同一视频的多码率**（不清单）；**≥2 组且组间差异位全部像集号**才判剧集。
  - Tier-2：页面内无 m3u8 → 命中播放器标记（`<video>` / `hls.js` / `videojs` …）**直接放弃**（防「上一集/下一集」误判）；否则按链接形态聚类取最大簇，且簇 ≥ `manifestMinItems`。
- **条目 id 编码**：`u:<url>` 内联（URL ≤190 且不含 `@`）；否则 `k:<fnv1a32>` 落 `itemMap`（单键、≤400 条）。★ 含 `@` 必须走 token —— 引擎按 `<id>@<variantId>` 解析 `resolver_item`。
- **二段**：`resolve()` 首行判 `ctx.resolverItem` 非空 → 复用 `parseMaster` / `pickVariant` / `audioSourceFor`，只走 `finalize()`（单直链）；**不返回** `manifest` / `variants` / `fileName`（引擎 `validate_resolve_output` 对互斥关系 fail-closed）。
- **`inScope()`**：`resolverItem` 非空一律放行 —— 否则未配 `targetHosts` 时，子任务会被「放行」成按原 URL 下载（下到 HTML）。
- **条目名**：过 `safeFileName()`（在 `sanitizeAssetName` 之外补清 `..` 与控制字符）+ `uniqueName()` 去重；一律以 `.mp4` 结尾。
- **回归基线**：`extractMaster()` 逐字未动；新增的 `extractAllMasters()` 保证 `[0] === extractMaster(...)`，因此单视频分支输出与 1.4.x 逐字相同。

### 7.4 v1.6.0 实现要点（`auth` + `subscriptions` 落地）

**声明**：`permissions` 追加 `"auth"`，`auth:{entry:"auth.js",timeoutMs:25000}`，
`subscriptions:[{providerId:"m3u8play",entry:"subscribe.js",timeoutMs:25000}]`，`minAppVersion: "0.4.8"`。

**★ 最关键的一条事实（决定整个 auth 实现的形状）**：
宿主只在 **`flux.fetch`** 内注入认证档案 —— `plugin/bridge.rs::http_request` 在
`auth_allowed && site_key(req.url) == profile.site` 时才调 `AuthProfile::apply_to_headers`；
全仓库搜 `apply_to_headers` 只有这一处调用点（另一处在 `auth.rs` 单测里）。
**下载链路（playlist / 分片 / `#EXT-X-KEY`）没有调用点。**
⇒ 插件必须自建 `authHeadersAsync(ctx, targetUrl)`，把凭据并进返回值的 `extraHeaders`，
否则表现是「解析成功但 403」。为此 `finalize()` 由同步改为 **async**（6 个调用点同步加 `await`）。

**登录（`auth.js`）**
- 入口 `globalThis.authenticate(ctx)`，返回**对象**（不是 JSON 字符串）—— 宿主 wrapper
  对 resolve / authenticate / subscribe 三个入口统一 `JSON.stringify(__r)` 后再解析
  （`plugin/quickjs.rs::build_entry_wrapper`）。返回字符串会被二次编码而解析失败。
- 五个 action：`status`（读回档案 + 过期判断，未登录用 `error` 表达，因为状态位只有 pending/success/error）、
  `begin`/`poll`（输入优先、设置项 `authCookie` 次之；都没有则 `pending` + `challengeType:"text"`）、
  `cancel`（`error "已取消"`）、`logout`（`flux.auth.remove`；宿主在插件被禁用时也会放行 `logout` 并自行清理，插件这次调用是幂等兜底）。
- 输入映射：`bearer:`/`token ` → `kind:"bearer"`；`basic:` → `kind:"basic"`；多行 `键: 值` → `kind:"headers"`；其余 → `kind:"cookie"`。
- 站点取自 `ctx.authRef` 的 `::` 之后（`插件ID::站点`，站点含 scheme）；`ctx.site` 兜底。宿主在
  `manager.rs::authenticate` 里会用 `normalize_site` 把裸 host 补成 https。

**订阅（`subscribe.js`）**
- 入口 `globalThis.subscribe(ctx)`，同样返回**对象**。`ctx = {providerId, sourceId, url, providerConfig, cookies, userAgent}`。
- 复用与 §7.3 平行的「同站 + 链接形态聚类」规则（**两套实现有意不共享代码** —— 四个脚本是独立 QuickJS 上下文，不能 require）；命中 `PLAYER_MARK_RE` 直接返回空 feed。
- `guid = "m3u8-" + fnv1a32(host + pathname)`，**丢 query**（签名抖动会让同一条目每次 guid 不同 → 重复建任务）；feed 内碰撞时并入 query 的 FNV 值。
- 条目 `resolverItem = "u:" + link`，`link` 为分集页 URL ⇒ 引擎建任务后走 §7.3 的二段解析取直链。
- `providerConfig`（JSON）为用户逃生舱：`minItems`（默认 **2**，比 `manifestMinItems=3` 宽松，因为订阅地址是用户主动配置的）/ `maxItems` / `linkPattern` / `include` / `exclude`。

**未知/易错点**
- `subscriptions` **未进公开文档**（`auth` 已进 `zh/plugins/manifest.md` + `api-reference.md`）⇒ 订阅依赖引擎实现的稳定性，风险更高，必须绑实机版本复验。
- 沙箱无 `btoa`：Basic 头的 base64 由插件手写（`b64encode`）。`Date` / `JSON` / `RegExp` / `Math` / `Promise` 均可正常使用（已用真实 QuickJS 探测）。
- 凭据注入加**同源闸门**（`scheme://host[:port]` 完全一致），避免把站点 Cookie 发给 CDN 主机；用户手写在 `extraHeadersRaw` 里的头不做该检查（显式声明优先）。
