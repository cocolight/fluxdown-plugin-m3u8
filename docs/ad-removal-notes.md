# FluxDown m3u8 插件去广告 —— 调研定论与技术方案

> 用途：记录对「FluxDown 插件能否 / 如何去除 m3u8 中的广告」的完整调研结论，
> 供后续研究复用。所有架构性结论均来自一手源码/文档核对（已标注来源），非推测。
> 最后更新：2026-09-30

---

## 0. 一句话结论

FluxDown 插件**没有 segment（分片）级钩子**，无法在下载/合并时逐个拦截广告段。
但可以在 **resolver 阶段**让引擎拿到的 playlist 里「根本没有广告段」——
具体用 **`http://127.0.0.1` 本地清洗服务**把干净 playlist 以普通 http URL 交回引擎
（绕开 `file://` 死穴）。已对真实样本端到端验证：9/9 广告段被跳过。

---

## 1. 问题背景

- 目标：某些 m3u8 在播放列表里**服务端插入（SSAI）**广告段，希望下载时自动跳过。
- 典型样本（本次实测）：`https://bfeng11.com/video/zhanshenzhifanchenshenyu_0862ce/298d923ea9c3/index.m3u8`
  - 单级 VOD media playlist，244 行，`#EXT-X-PLAYLIST-TYPE:VOD`。
  - 广告段 9 个，路径为**同 host 绝对路径** `/video/adjump/time/1787320001790xxxxxx.ts`，
    前后各一个 `#EXT-X-DISCONTINUITY` 包裹；正片为相对路径 `0000000.ts` 等。
  - 广告识别**极简单且 100% 可靠**（靠路径前缀 + DISCONTINUITY 即可），难点从来不在「识别」。

---

## 2. FluxDown 插件系统架构（已核源码/文档）

| 维度 | 事实 | 来源 |
|---|---|---|
| 插件两层模型 | `resolver`（下载前返回「要下的 URL + 头」）+ `hooks`（任务开始/完成/出错通知） | manifest.md |
| Hook 事件 | 仅 `onStart` / `onDone` / `onError` / `onMetaProbed`，fire-and-forget，**无 segment 钩子** | api-reference.md（zh） |
| `resolve()` 返回 | `ResolveResult{ url, fileName, extraHeaders, rangeSupported, ephemeral, variants… }`；引擎据此下载 | api-reference.md |
| `flux.fetch` | 仅公网 http/https，SSRF 防护**拦截 loopback / 内网**（故插件无法 POST 给本地服务） | api-reference.md |
| `flux.fs` | 仅 `writeFile/readFile/remove/list`，文件名须扁平安全名，**不暴露工作区绝对路径** | api-reference.md |
| `flux.ffmpeg` | 仅在 `onDone` 可用，沙箱锁定产物目录，参数禁 `file:` / 绝对路径 / `..` | ytdlp 示例、api-reference.md |
| `resolve()` 失败语义 | **fail-closed**：抛异常/超时/返回不合法 → 任务直接进错误态，绝不偷偷下原 URL | api-reference.md |

### 2.1 HLS 引擎本体（关键，读源码确认）

- 文件 `native/engine/src/hls_downloader.rs`（约 2625 行）。
- **自闭环**：自己抓 playlist → 自己下全部 `#EXTINF` 段 → 自己合并，**全程零插件介入**。
  grep 全文无 `plugin` / `resolve` / `hook` / `filter` / `callback`。
- **不认 `#EXT-X-GAP`**（标准「空缺段跳过」标签）：grep `gap` 零命中；`discontinuity` 仅作序号记账 bool，不触发跳过。
- 网络层用 `reqwest::Client`，**无 loopback / SSRF 拦截**（与 `flux.fetch` 不同）。
- 引擎具备完整代理系统：`proxy_config.rs`（2721 行）+ `auto_proxy.rs`，支持 None/System/Manual、HTTP/HTTPS/SOCKS4/4a/5，任务级决策粒度。

> 推论：插件想「在分片层标记某段不下载」没有 API 落点；唯一能影响引擎行为的，是
> 让它去抓的那个 playlist 的内容本身。

---

## 3. 走过的死路（避免重蹈）

### 方案 A：resolver 改写 media playlist，写本地 `file://` 交回引擎
- **死因**：
  1. `resolve()` 的 `url` 按文档只认网络直链（HLS / magnet / FTP），全文未提 `file://` 或本地路径；
  2. `flux.fs` 不暴露绝对路径 → 即使写出干净 playlist 也**构造不出合法的 `file://` URL**。
- 结论：在当前 API 下基本不可行。

### 方案 B：下载后 `onDone` + `flux.ffmpeg` 按时间轴切除广告
- **可行**，但用户明确**不用**（属于「下载后处理」，非源头跳过）。
- 要点：resolver 把 media playlist 存 `flux.storage`；`onDone` 读回 → 按 `CUE-OUT/IN`、
  `DISCONTINUITY`、`GAP` 累计广告区间 → `filter_complex` 的 `trim/atrim/concat` **重编码**切除
  （非无损 copy；无损切需 `-ss/-to -c copy`，仅能切在关键帧、边缘差几秒）。
- 局限：现代 SSAI（IMA/DAI、MediaTailor）常不向客户端暴露 cue 边界 → 拿不到切除点。

---

## 4. 可行的源头方案：本地 127.0.0.1 清洗服务（已验证）

### 4.1 为什么能绕过方案 A 死穴
- resolver 返回的是「引擎要下的 URL」；引擎的 reqwest 客户端**能正常抓取 `http://127.0.0.1`**
  （无 loopback 拦截）。因此把干净 playlist 挂在一个本地 http 服务上，返回该 http URL 即可。

### 4.2 数据流
```
FluxDown 插件 resolver（改造版）
  └─ adClean 开启时，返回
     http://127.0.0.1:8787/clean?src=<原始 m3u8>&ref=<referer>
                        │
            m3u8_adclean_server.py（独立常驻进程）
                        │ 抓原始 playlist（带 Referer 防盗链）
                        │ 剔广告段（/video/adjump/、CUE-OUT/IN、DATERANGE(SCTE-35)、GAP）
                        │ 内容段改绝对地址（指向真实源站）
                        ▼
                返回干净 .m3u8（plain http）
                        │
            FluxDown HLS 引擎（读干净 playlist）
                        │ 只下正片段（绝对地址 → 源站直连，不经本地服务）
                        ▼
                    无广告成品
```
> 分片是绝对地址，引擎直接连源站下载，**本地服务只处理 .m3u8**，无额外开销。

### 4.3 插件侧改动（极轻）
仅把 3 个返回点（media 直返 / autoPick / 手动 variants）的 URL 用 `cleanUrl()` 包裹：
```js
function stripAdsEnabled() {
  return !!(flux.settings.adClean && (flux.settings.adCleanServer || "").trim());
}
function cleanUrl(ctx, u) {
  const srv = (flux.settings.adCleanServer || "http://127.0.0.1:8787").trim().replace(/\/+$/, "");
  let q = "src=" + encodeURIComponent(u);
  let ref = "";
  try { ref = (ctx && ctx.referrer) || new URL(u).origin; } catch {}
  if (ref) q += "&ref=" + encodeURIComponent(ref);
  return srv + "/clean?" + q;
}
```
（插件**不需要**自己 fetch/post 数据；它只是把「原始 URL」作为 `src` 参数传指针，本地服务自行抓取。）

### 4.4 本地服务核心逻辑
- 仅 Python 3 标准库（`http.server` + `urllib`）。
- 广告识别（按可靠度）：
  1. `#EXT-X-CUE-OUT` / `#EXT-X-CUE-IN`（SCTE-35 广告块边界）
  2. `#EXT-X-DATERANGE` 含 `SCTE-35` / `CUE`
  3. `#EXT-X-GAP`（空缺段，跳过）
  4. 段 URI 命中广告路径/关键词（如 `/video/adjump/`、`/ad/`、`preroll`…）——规则**外置**在
     `adfilter/ad_patterns.txt`（纯文本，`re:` 前缀写正则，其余为子串），改完重启服务生效
- 删除包裹用的 `#EXT-X-DISCONTINUITY`（广告整块删掉后正片连续）。
- 剩余段 / 变体 URI **全部绝对化**为指向真实源站的 URL（关键：否则相对地址会解析到 127.0.0.1 而失败）。
- master 多码率也支持：变体 URI 改写为同样经本服务清洗的地址。
- 未识别到任何广告时**原样透传**，避免误伤导致空 playlist。

### 4.5 实测结果（bfeng11 真实样本）
- `adjump` 段 0 残留、`DISCONTINUITY` 0 残留；
- 9 个广告段全部移除，剩余 109 个正片段全部绝对化为 `https://bfeng11.com/...`；
- playlist 合法，`#EXT-X-ENDLIST` 收尾 → 引擎只会下正片。

---

## 5. 局限与注意（务必知悉）

| 项 | 说明 |
|---|---|
| 直播（LIVE/EVENT） | 无效：playlist 持续刷新，静态清洗跟不上；**仅 VOD 适用** |
| 隐藏式 SSAI | 若广告段做得与正片一致、不暴露 CUE/DATERANGE/GAP，只能靠域名/关键词猜，可能漏杀或误伤 |
| 服务必须先启动 | `adClean` 开启但服务没跑 → 引擎 fetch 本地失败 → 任务报错（resolver fail-closed） |
| 插件无法自检本地服务 | `flux.fetch` 的 SSRF 防护拦截 loopback，插件不能探测 `/health` → 无法自动回退 |
| 127.0.0.1 别走代理 | 若在用代理，确保 `localhost/127.0.0.1` 在 no_proxy，否则引擎可能把本地请求也发往代理 |
| 防盗链 | 本地服务抓取上游需带正确 `Referer`/`Origin`（已默认用源 origin，复杂站用 `ref` 参数或改代码） |

---

## 6. yt-dlp 能否辅助去广告？（2026-09-29 检索结论）

**结论：yt-dlp 不能直接剥离通用 m3u8 里的 SSAI 广告段；它的「去广告」能力是特定场景的。**

| 能力 | 适用场景 | 与本项目的关系 |
|---|---|---|
| `--sponsorblock-remove` / `--sponsorblock-mark` | **仅 YouTube**：基于 SponsorBlock 众包时间戳，在**下载后重编码**切除「创作者口播赞助/片头片尾」等 | 与 SSAI 服务端插广告无关；不适用于 bfeng11 这类站点 |
| `--hls-split-discontinuity` | 在 `#EXT-X-DISCONTINUITY`（广告断点）处把输出**拆成多个文件**；默认关闭 | 可变相「分离」广告，但产出多文件而非净版单文件，需人工拣选 |
| 通用 HLS 广告段跳过 | **无此选项** | yt-dlp 对 SSAI 广告段与普通段一视同仁，照单全下 |
| aria2c 作为外部下载器（`-N` 并发） | 加速下载 | 仍下载全部段，不去广告 |

**yt-dlp 在我们流程里的真实价值 = 抽取直链（插件既有「增强 B」）**：
- 复杂站点把 m3u8 藏在 JS/JSON 里时，`yt-dlp -J <url>` 能抽出真正的 media/master URL；
- 抽出的 URL 再交给我们的 **127.0.0.1 清洗服务**做广告剥离。
- 即：**yt-dlp 负责「拿到 URL」，清洗服务负责「去掉广告」**，二者分工，而非 yt-dlp 自己去广告。

若想脱离 FluxDown 纯用 yt-dlp 去广告：现实路径是 `yt-dlp -J` 取 m3u8 → 过清洗服务/自定义处理器 → 下载；
yt-dlp 本身不会替你过滤 playlist 里的广告行。

---

## 7. 备选：纯代理方案（无需改插件）

FluxDown 引擎支持完整代理（`proxy_config.rs`）。可把引擎代理设为**本地重写代理**，对 `.m3u8`
响应做改写。
- 优点：不依赖插件改动。
- 缺点：**HTTPS 目标需 MITM（装 CA 证书）**才能看到并改写加密的 playlist，比 127.0.0.1 方案复杂。
- 故默认推荐 127.0.0.1 清洗服务方案。

---

## 8. 后续研究 TODO

- [ ] 验证 FluxDown 引擎在「系统已设代理」时是否把 `127.0.0.1` 也发往代理（no_proxy 行为）；
      若会，评估纯代理/MITM 方案或直接给引擎设 `no_proxy`。
- [ ] 收集**更多站点**的带广告 playlist，确认 `/video/adjump/` 等规则是否通用，
      还是需按站点另写规则（服务已支持外置规则文件 `adfilter/ad_patterns.txt`，含正则）。
- [ ] 研究 FluxDown 是否支持「resolver 返回 data:/内联 playlist」（若支持，可省去本地服务）；
      当前文档与源码均未显示此能力。
- [ ] 评估隐藏式 SSAI（无 cue）站点的可行对策（换源 / 换下载器如 N_m3u8DL-RE 的 `--skip-ad`）。

---

## 9. 参考来源

- FluxDown 仓库：https://github.com/zerx-lab/FluxDown
  - 插件 API 参考（zh）：`website/src/content/docs/zh/plugins/api-reference.md`
  - manifest 规范：`website/src/content/docs/en/plugins/manifest.md`
  - HLS 引擎：`native/engine/src/hls_downloader.rs`
  - 代理系统：`native/engine/src/proxy_config.rs`、`native/engine/src/auto_proxy.rs`
  - （源码经 jsDelivr CDN 镜像读取，因 raw.githubusercontent 在沙箱 SSL 握手失败）
- 原插件：`cocolight/fluxdown-plugin-m3u8`（`resolver.js` / `hooks.js` / `manifest.json`）
- yt-dlp 文档（2026-09-29 检索）：
  - SponsorBlock 集成：https://mintlify.com/yt-dlp/yt-dlp/guides/sponsorblock
  - Extractor Options（`--hls-split-discontinuity`）：https://www.mintlify.com/yt-dlp/yt-dlp/cli/extractor-options
  - 项目主页：https://github.com/yt-dlp/yt-dlp
- 实测样本：`https://bfeng11.com/video/zhanshenzhifanchenshenyu_0862ce/298d923ea9c3/index.m3u8`
