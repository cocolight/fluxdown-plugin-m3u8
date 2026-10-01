# FluxDown 插件能力矩阵

> **用途**：把「哪些能力靠插件补、哪些是接口硬限制」钉死，避免按二手资料去实现不存在的字段。
> **依据**：FluxDown 官方插件文档 `website/src/content/docs/zh/plugins/{overview,manifest,api-reference}.md`
> 与引擎源码（`native/engine/src/`，完整克隆在 `E:/Project/FluxDown`）。
> **核对日期**：2026-10-01 ｜ **对应插件版本**：1.7.0。
> 表中 `vX.Y.Z` 表示该能力**由该插件版本引入**。

图例：✅ 已实现 ｜ ⚠️ 部分 / 有条件 ｜ ❌ 未实现（多为接口硬限制）

---

## 1. HLS 下载场景覆盖

| 场景 | 核心是否已实现 | 插件是否已实现 | 是否满足场景要求 |
| --- | --- | --- | --- |
| 公开直链 `.m3u8`（免鉴权） | ✅ 完整（扩展名嗅探 → 分片下载 → remux） | ✅（纯透传） | ✅ 满足 —— 裸核心已足够，插件在此无增益 |
| 播放页 URL（URL 不含 `.m3u8`） | ❌ 引擎无页面解析 | ✅ | ✅ 满足 |
| 防盗链（Referer / Origin / UA / 自定义头） | ❌ 无从得知页面来源 | ✅ | ✅ 满足 |
| 多码率变体解析与手选画质 | ⚠️ 仅「最高带宽」+ 弹框 | ✅ | ✅ 满足 |
| 按分辨率档位偏好 / 免弹框 | ⚠️ 同上 | ✅ | ✅ 满足 |
| 按编码筛画质（H.264 / H.265 / AV1 / VP9） | ❌ | ✅ | ✅ 满足 |
| 独立音轨下载 + 自动合并 | ⚠️ 支持 `audioUrl` 并自动 mux，但**自己选不出音轨** | ✅ | ✅ 满足 |
| 多语言选轨 | ❌ 无选轨概念 | ✅ | ✅ 满足 |
| 纯音频提取 | ❌ 能下指定 URL，但选不出哪条是音轨 | ✅ | ✅ 满足 |
| 伪 m3u8（HTML 登录页 / 拦截页）识别 | ❌ 当视频下载 → 得到 HTML | ✅ | ✅ 满足 |
| 复杂前端（m3u8 藏在 JS / 加密 JSON） | ❌ | ✅（yt-dlp 委派） | ✅ 满足 |
| 下载后 remux 为 MP4 | ✅ 核心内置 | ✅（仅兜底） | ✅ 满足 |
| 文件名 | ⚠️ 仅 `title → video` 兜底链 | ✅ `v1.4.0` | ✅ 满足 |
| 剧集页批量下载 | ❌ | ✅ `v1.5.0` | ⚠️ 部分 —— 仅「分集链接写在静态 HTML 里」的站点 |
| 需登录站点（Cookie / Bearer / Basic / 自定义头） | ❌ | ✅ `v1.6.0` | ⚠️ 部分 —— 插件不做站点专属登录协议，需手动取一次凭据 |
| 订阅追更 | ❌（内置仅 RSS） | ✅ `v1.6.0` | ⚠️ 部分 —— 同上；且 `subscriptions` 未列入公开文档 |
| 防抓页校验（可解码的 Cookie 挑战） | ❌ | ✅ `v1.7.0` | ⚠️ 部分 —— 仅覆盖 XOR-eval 形态，指纹 / 验证码无解 |
| 内嵌播放器跟随（iframe / maccms） | ❌ | ✅ `v1.7.0` | ✅ 满足 |
| 字幕（WebVTT） | ❌ | ❌ | ❌ 不满足 —— 返回值无字幕字段 |
| DRM（SAMPLE-AES / FairPlay / Widevine） | ❌ | ❌ | ❌ 不满足 —— 需 CDM 与许可证，任何工具都无法绕过 |
| LL-HLS（`#EXT-X-PART` 部分段） | ❌ | ❌ | ❌ 不满足 |
| 真直播无限录制 | ❌ | ❌ | ❌ 不满足 —— 滚动窗口的持续追加落盘需引擎配合 |
| `#EXT-X-KEY:METHOD=NONE`（AES-128 后切明文段） | ❌（上游 `m3u8-rs 6.0.1` 缺陷） | ❌ | ❌ 不满足 —— 引擎侧兜底 PR [zerx-lab/FluxDown#715](https://github.com/zerx-lab/FluxDown/pull/715) 已提 |
| ISM / 平滑流式 | ❌ | ❌ | ❌ 不满足 —— 非 m3u8 体系 |

---

## 2. 输入 / 需求：裸核心 vs 插件

| 输入 / 需求 | 裸核心 | 插件 | 依据 |
| --- | --- | --- | --- |
| 公开直链 `.m3u8` | ✅ 完整 | 无增益（纯透传） | `hls_downloader::is_hls_url()` 按扩展名分流，**完全不经过插件** |
| 播放页 URL（不含 `.m3u8`） | ❌ 按普通 HTTP 下载 → 得到 HTML | ✅ 抓页源码抠 `master.m3u8` | 引擎无页面解析；yt-dlp 在核心侧只有组件管理，运行时唯一入口是插件桥 `flux.ytdlp` |
| 防盗链（Referer / Origin / UA / 自定义头） | ❌ 无从得知页面来源 → 403 | ✅ 返回 `extraHeaders` | resolver 专属 |
| 选轨（语言）/ 纯音频 / 按编码筛 | ⚠️ 只有 `select_variant`（最高带宽），无选轨概念 | ✅ `audioUrl` + `audioOnly` + `preferCodec` | |
| 文件名 | ⚠️ 有 `title → video` 兜底链，直链常得到裸名 | ✅ 四层取值链 + 模板 | |
| 复杂前端（m3u8 藏在 JS / JSON） | ❌ | ✅ yt-dlp 委派 | |
| 剧集页批量建任务 | ❌ | ✅ `v1.5.0` 返回清单，**由引擎**裂变建任务组 | `resolvers[0].multi` + `ResolveResult.manifest` |
| 需登录站点 | ❌ | ✅ `v1.6.0` 把凭据并进下载请求头 | 宿主只在 `flux.fetch` 内注入认证档案，下载链路无调用点 |
| 订阅追更 | ❌（内置仅 RSS） | ✅ `v1.6.0` 插件订阅源枚举条目 | `subscriptions[]` + `globalThis.subscribe` |
| 防抓页 / 内嵌播放器 | ❌ | ✅ `v1.7.0` | 纯 `flux.fetch` + 设置项，未引入新引擎字段 |

**判断**：插件不是「下载器」，而是**下载之前的发现层 + 鉴权层 + 预处理层**。它在公开直链上与核心重叠，但在播放页 / 防盗链 / 剧集页 / 登录站场景下核心无法替代。

> ⚠️ **一条会削弱「插件独占」结论的路径**：桌面端另有**浏览器扩展**（`native/agent/`：NMH 中继 `nmh.rs` + 捕获事务 `capture.rs`），可把浏览器里的**真实媒体 URL** 与**浏览器自身请求头**送进下载任务（见 `model.rs` 的 `source_page_url`、`capture.rs` 的「留空则沿用浏览器头 / 已保存站点凭据」）。
> ⇒ 在「装了该扩展 + 用浏览器触发下载」的前提下，**播放页发现 + 防盗链**这两项会被浏览器路径覆盖。

---

## 3. 插件对核心下载器的补足清单

> 判定口径：**独占** = 核心与浏览器扩展都做不到；**增益** = 核心能做但插件更准 / 更省事；**重叠·条件性** = 核心已覆盖，插件只在特定分支上还有价值。

| 能力 | 裸核心的行为 | 插件怎么补 | 开关 | 判定 |
| --- | --- | --- | --- | --- |
| 播放页 URL → 发现 master | 按普通 HTTP 下载 → 得到 HTML 文件 | 抓页面源码 + 正则抠 `master.m3u8`（支持 `\/` JSON 转义与相对地址） | `targetHosts` 限定生效站点 | **独占** |
| 防盗链 `Referer` / `Origin` | 无从得知页面来源，403 | 返回 `extraHeaders`，`Referer` 优先取页面 URL（而非 origin） | 自动 | **独占** |
| 自定义 UA / 任意请求头 | 无入口 | `userAgent` + `extraHeadersRaw`（多行 `Key: Value`），**抓 playlist 与抓分片共用同一套头** | `userAgent`、`extraHeadersRaw` | **独占** |
| 独立音轨（`#EXT-X-MEDIA:TYPE=AUDIO`） | 支持 `audioUrl` 并自动 mux，但**自己选不出音轨** | 解析 AUDIO 组与纯音频 `STREAM-INF` 变体，输出 `audioUrl` | `separateAudio` | **独占（发现层）** |
| 多语言选轨 | 无选轨概念 | `AUDIO` 组收敛 → `LANGUAGE` → `DEFAULT` → `AUTOSELECT` → 首条 | `audioLang` | **独占** |
| 纯音频提取 | 能下指定 URL，但选不出「哪个是音轨」 | 定位独立音轨；源无独立音轨时 **fail-closed 并给明确原因** | `audioOnly` | **独占（发现层）** |
| 按编码筛画质 | `select_variant` 只看 `bandwidth` | 按 `CODECS` 改**默认选中项**，不隐藏其他变体 | `preferCodec` | **独占（增益）** |
| 按分辨率档位偏好 / 免弹框 | 只有「最高带宽」+ 弹框二选一 | `pickVariant` 按**高度**命中 1080/720/…；开启后直接下 | `preferResolution`、`autoPick` | **增益** |
| 文件名 | `title → video` 兜底链，直链常得裸名 | 四层取值链（`ctx.fileName` → `<title>` → 上层 ID 段 → 文件名）+ 模板占位符（`v1.4.0`） | `nameTemplate` | **增益** |
| 伪 m3u8（HTML 登录页 / 拦截页）识别 | 当成视频下载 → 得到一个 HTML | `#EXTM3U` 校验 + HTML 特征识别 → 可自动切 yt-dlp 兜底 | `htmlFallbackYtdlp` | **独占** |
| 复杂前端（m3u8 藏在 JS / 加密 JSON） | 无 | `flux.ytdlp` 委派抽直链 | `useYtdlp` | **独占** |
| **剧集页批量下载** | 无（一页 N 集只能一集一集贴） | 返回 `manifest` 清单，**引擎**自动裂变为任务组；二段以 `resolverItem` 回调取单直链（`v1.5.0`） | `detectSeries`（+ `manifestMinItems` / `manifestMaxItems` / `episodeLinkPattern`） | **独占** |
| **登录凭据** | 无 | `auth` 入口把 Cookie / Bearer / Basic / 自定义头交宿主持久化，并**由插件并进 `extraHeaders`**（宿主只在 `flux.fetch` 内注入，下载链路须插件补齐）（`v1.6.0`） | `authCookie` | **独占** |
| **订阅追更** | 内置仅 RSS，无插件订阅 | `subscribe` provider 枚举列表页 → feed，引擎按 `guid` 去重建任务（`v1.6.0`） | 订阅源（`providerId = m3u8play`） | **独占** |
| **防抓页 Cookie 挑战** | 无 | 解出挑战页种下的 Cookie，对**同一地址重取一次**（`v1.7.0`） | `solveChallenge` | **独占** |
| **内嵌播放器跟随** | 无 | 取 `<iframe src>`（同站优先）或 maccms `player_data.link` 兜底 → 跟进解析（`v1.7.0`） | `followIframe`、`iframeMaxFollow` | **独占** |
| 下载后 remux 为 MP4 | **核心已内置** `remux_ts_to_mp4()`（best-effort，失败保留 `.ts`） | 仅在①核心 remux **失败的降级分支**、②**非 HLS 任务**（yt-dlp 产出的 `.mkv`/`.webm`）上补一次；已是 `.mp4` **直接跳过**，无双重转封装 | `remuxToMp4` | **重叠 / 条件性** |
| 轨对合并失败兜底 | 核心合并失败会**降级**留下独立音频文件 | `onDone` 用 ffmpeg `-c copy` 补做合并 | `fixMuxFallback` | **独占（补核心降级）** |
| 加密方式体检 / 故障归因 | 报 `PKCS7 … Unpad Error` 之类，无归因 | 打印 `METHOD` / `KEYFORMAT`，区分 **DRM 无解 / 引擎能力边界 / 上游缺陷**（`v1.4.2`） | 自动（仅日志） | **增益（可观测性）** |
| 作用域限制 | 无（任何 URL 都尝试处理） | `inScope()`：只处理配置站点与直链 `.m3u8` | `targetHosts` | **独占** |
| 相对地址绝对化 | 核心自己会处理 | **插件必做的自保**：沙箱无 `URL` 全局对象，需自实现 `absUrl()`（`v1.4.1` 修复） | 自动 | **必要条件**（非增益） |

**汇总**：共 21 项 —— 独占 **16 项**（含「按编码筛画质」，兼具增益属性）、增益 **3 项**、重叠·条件性 **1 项**、必要自保 **1 项**。

插件**确定独有的能力**收敛为四类：**播放页发现 + 鉴权、选轨 · 纯音频、剧集页批量枚举、登录 / 订阅 / 反爬站**。
其余在「装了浏览器扩展 + 用浏览器触发下载」的前提下会被核心或扩展覆盖。

> **去广告已下线**：插件曾提供「改写 playlist 指向本地清洗服务」的广告段剔除能力，**自 `v1.4.3` 起整体停用**（`adClean` / `adCleanServer` 设置项已从 manifest 移除）。恢复要点与调研记录见 [ad-removal-notes.md](ad-removal-notes.md)。

---

## 4. 硬限制（接口不存在，别再尝试）

- **字幕（WebVTT）**：`resolve()` 返回字段**穷举**为 `url` / `audioUrl` / `fileName` / `totalBytes` / `extraHeaders` / `ephemeral` / `rangeSupported` / `variants` / `defaultVariantIndex` —— **没有字幕字段**；且 `flux.fs` 与 ffmpeg 沙箱是两个独立工作区，抓到的字幕文件送不进去。插件**只能识别并记录**字幕轨，无法下载 / 封装 / 烧录。
- **插件不能创建任务**：`flux.task` 只有 `requestRetry`（且仅在 `onError` 有效），无分组 CRUD、无任务查询。**但引擎会据插件输出代为建任务** —— 清单（`manifest`）→ 裂变建组，订阅条目 → 建任务。插件自身始终不建任务。
- **`onMetaProbed` 永不触发**：带 resolver 的插件该钩子不生效（官方明确），故 manifest 不订阅它。`onStart` 亦未订阅（仅日志、徒增噪音）。
- **`hooks.match` 只按任务原始 URL 过滤**：播放页 URL 不含 `m3u8` ⇒ 会漏掉所有钩子，故插件改用 `taskId` 存储标记来判断「是不是本插件经手的任务」。
- **DRM / LL-HLS / 真直播**：SAMPLE-AES、SAMPLE-AES-CTR、FairPlay、Widevine 的解密在核心 `hls_downloader`（只实现 `NONE` / `AES-128`，其余在解析阶段直接拒绝）与更底层的 CDM；LL-HLS 的 partial segment 拼接、直播滚动窗口的追加落盘同样在引擎层。插件层够不到。
- **`#EXT-X-KEY:METHOD=NONE`**：**上游 `m3u8-rs 6.0.1` 缺陷**（`Key::from_hashmap` 守卫写反 → 标签降级为未知 → 明文段被上一段密钥解密 → `PKCS7 … Unpad Error`）。插件不能返回 playlist 内容，**插件层无法规避**。证据链与补丁见 [upstream-m3u8-rs-method-none.md](upstream-m3u8-rs-method-none.md)。
- **嵌套 master 递归**（master 里再指 master）：内外层结构完全相同、无可靠信号，只能靠多抓一次子 playlist 才能判断，为省一次 RTT 未实现。
- **按容器（fMP4 vs TS）筛选**：master 层没有容器信息，只能在变体 `label` 里展示编码。
- **key URI（`#EXT-X-KEY`）单独带鉴权头**：密钥请求由核心引擎发出，插件无法按请求区分，只能通过 `extraHeaders` 全局覆盖。
- **合并完整性校验**（段数 vs manifest）：插件拿不到下载进度与段清单。

---

## 5. 版本引入与最低引擎要求

| 插件版本 | 引入能力 | 依赖的引擎能力 | `minAppVersion` |
| --- | --- | --- | --- |
| 1.4.0 | 命名机制重写、`nameTemplate` | — | — |
| 1.4.1 | 自实现 `absUrl()`（沙箱无 `URL` 全局对象） | — | — |
| 1.4.2 | 加密方式体检 / 故障归因 | — | — |
| 1.4.3 | **停用**本地源头去广告（移除 `adClean` / `adCleanServer`） | — | — |
| 1.5.0 | 剧集页批量下载（`multi` 清单）、订阅 `onCancel` | `resolvers[0].multi` + `ResolveResult.manifest`（引擎 **v0.3.0** 起） | `0.3.0` |
| 1.6.0 | 登录认证（`auth`）、订阅追更（`subscriptions`） | `auth` + `subscriptions`（引擎 **v0.4.8** 起） | `0.4.8` |
| 1.7.0 | 防抓页校验、内嵌播放器跟随 | **无新增引擎字段**（仅 `flux.fetch` + 设置项） | `0.4.8`（不可回落） |

★ **`minAppVersion` 救不了旧版**：manifest 为 `deny_unknown_fields` —— 旧版 FluxDown 见到 `multi` / `subscriptions` / `auth` 会**拒绝整份 manifest**（表现为插件被跳过，而非忽略该字段）。`minAppVersion` 是在 **serde 解析成功之后**才检查的，此时旧版早已解析失败。因此：

- 门槛只能**按能力分设并逐版抬高**，且**不可回落** —— v1.7.0 虽然没引入新字段，但 manifest 里仍带着 `auth` / `subscriptions` 段，门槛必须跟着 v1.6.0 留在 `0.4.8`；
- 这些字段属引擎契约、`subscriptions` **未进公开文档**，存在随版本变动的风险，落地时须绑定实际安装版本复验。
