/**
 * M1 回归场景集 —— 与 tests/parity.mjs 配套。
 *
 * 每个场景都是「一份宿主伪造 + 一次或多次入口调用」。旧实现（tests/legacy/）与新构建产物
 * （dist/）跑同一份场景，返回值 / 抛错 / 日志 / 宿主调用必须逐字一致。
 *
 * 覆盖面按 manifest 的三类入口与 resolver 的全部分支编排：
 *   直链(HLS/DASH) · 媒体清单 · 播放页(绝对/相对/iframe/挑战) · 剧集页(Tier-1/Tier-2)
 *   · 二段解析 · yt-dlp 两种介入 · 音轨分离/纯音频 · 命名模板 · 加密体检 · 作用域
 *   · 订阅 provider · 登录五个 action · hooks 三个事件
 */

const SITE = "https://site.test";
const CDN = "https://cdn.site.test";

// ---------------------------------------------------------------------------
// fixture：HLS
// ---------------------------------------------------------------------------

const MASTER_FULL = [
  "#EXTM3U",
  "#EXT-X-VERSION:3",
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="中文",LANGUAGE="zh",DEFAULT=YES,AUTOSELECT=YES,URI="audio/zh.m3u8"',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",DEFAULT=NO,AUTOSELECT=YES,URI="audio/en.m3u8"',
  '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="sub",NAME="中文",LANGUAGE="zh",URI="subs/zh.m3u8"',
  '#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,CODECS="avc1.640028",AUDIO="aud"',
  "1080p/index.m3u8",
  '#EXT-X-STREAM-INF:BANDWIDTH=2800000,RESOLUTION=1280x720,CODECS="avc1.4d401f",AUDIO="aud"',
  "720p/index.m3u8",
  '#EXT-X-STREAM-INF:BANDWIDTH=1400000,RESOLUTION=854x480,CODECS="avc1.4d401e",AUDIO="aud"',
  "480p/index.m3u8",
  '#EXT-X-STREAM-INF:BANDWIDTH=128000,CODECS="mp4a.40.2"',
  "audio/only.m3u8",
  "",
].join("\r\n"); // CRLF：顺带验证行尾归一

const MASTER_MIXED = [
  "#EXTM3U",
  '#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=3840x2160,CODECS="hvc1.2.4.L153.B0"',
  "2160p/index.m3u8",
  '#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080,CODECS="avc1.640028"',
  "1080p/index.m3u8",
  '#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,CODECS="hvc1.1.6.L93.B0"',
  "720p/index.m3u8",
  '#EXT-X-STREAM-INF:BANDWIDTH=1200000,RESOLUTION=854x480,CODECS="avc1.4d401e"',
  "480p/index.m3u8",
  "",
].join("\n");

const MASTER_NO_AUDIO = [
  "#EXTM3U",
  '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720,CODECS="avc1.4d401f"',
  "720p/index.m3u8",
  "",
].join("\n");

const MEDIA_PLAIN = [
  "#EXTM3U",
  "#EXT-X-VERSION:3",
  "#EXT-X-TARGETDURATION:4",
  "#EXTINF:4.000,",
  "seg-1.ts",
  "#EXTINF:4.000,",
  "seg-2.ts",
  "#EXT-X-ENDLIST",
  "",
].join("\n");

// AES-128 → NONE → 引擎不支持的方法 + DRM KEYFORMAT：一次触发 noteEncryption 的四条分支
const MEDIA_ENCRYPTED = [
  "#EXTM3U",
  '#EXT-X-KEY:METHOD=AES-128,URI="k1.key"',
  "#EXTINF:4.000,",
  "s1.ts",
  "#EXT-X-KEY:METHOD=NONE",
  "#EXTINF:4.000,",
  "s2.ts",
  '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://x",KEYFORMAT="com.apple.streamingkeydelivery"',
  "#EXTINF:4.000,",
  "s3.ts",
  "#EXT-X-ENDLIST",
  "",
].join("\n");

// ---------------------------------------------------------------------------
// fixture：页面
// ---------------------------------------------------------------------------

const pageWithAbsMaster = `<!doctype html>
<html><head><title>测试影片 - 某站</title></head>
<body><div id="app"></div>
<script>var player={"url":"${CDN}/hls/master.m3u8?sign=abc&t=1"};</script>
</body></html>`;

const pageWithRelMaster = `<!doctype html>
<html><head><title>相对路径片｜某站</title></head>
<body><video id="v" src="/hls/master.m3u8?x=1"></video></body></html>`;

const pageIframe = `<!doctype html>
<html><head><title>内嵌播放</title></head>
<body>
<iframe src="https://ad.other.test/banner.html"></iframe>
<iframe src="/player/embed/9"></iframe>
</body></html>`;

const pagePlayer = `<!doctype html>
<html><body><script>var p="/v/9/index.m3u8";</script></body></html>`;

const pageMaccmsLink = `<!doctype html>
<html><head><title>maccms 站</title></head>
<body><script>var player_data={"link":"\\/vod-play\\/11076-1-1\\/"};</script></body></html>`;

const pageSeries = `<!doctype html>
<html><head><title>某剧 第一季</title></head>
<body><script>
var list=[
 {"name":"第1集","url":"${CDN}/vod/ep1/index.m3u8"},
 {"name":"第2集","url":"${CDN}/vod/ep2/index.m3u8"},
 {"name":"第3集","url":"${CDN}/vod/ep3/index.m3u8"}
];
</script></body></html>`;

const pageSeriesHuge = `<!doctype html>
<html><head><title>长剧</title></head>
<body><script>
var list=[${Array.from({ length: 8 }, (_, i) => `{"url":"${CDN}/vod/s01/ep${i + 1}/index.m3u8"}`).join(",")}];
</script></body></html>`;

const pageLinks = `<!doctype html>
<html><head><title>列表页</title></head>
<body>
<a href="/vodplay/11076-1-1.html">第 1 集</a>
<a href="/vodplay/11076-1-2.html">第 2 集</a>
<a href="/vodplay/11076-1-3.html">第 3 集</a>
<a href="/vodplay/11076-1-4.html">第 4 集</a>
<a href="/top.html">排行榜</a>
<a href="/logo.png">logo</a>
<a href="https://other.test/vodplay/9-1-1.html">外链</a>
</body></html>`;

const pageLinksTooFew = `<!doctype html>
<html><head><title>两集页</title></head>
<body>
<a href="/vodplay/11076-2-1.html">上一集</a>
<a href="/vodplay/11076-2-2.html">下一集</a>
</body></html>`;

const pageSingleWithPlayer = `<!doctype html>
<html><head><title>单片</title></head>
<body><video src="x.mp4"></video>
<a href="/vodplay/1-1-1.html">上一集</a><a href="/vodplay/1-1-2.html">下一集</a>
</body></html>`;

const pageOnlyMpd = `<!doctype html>
<html><head><title>DASH 片</title></head>
<body><script>var m="/dash/manifest.mpd?x=1";</script></body></html>`;

const pageNoTitle = `<!doctype html>
<html><body><script>var u="/hls/master.m3u8";</script></body></html>`;

/** 防抓页挑战：把目标 JS 用 XOR 编码后塞进 eval(array.map(...)) —— 与真实挑战页同形。 */
function challengePage(js, key = 13) {
  const codes = [...js].map((ch) => ch.charCodeAt(0) ^ key);
  return `<html><body><script>eval([${codes.join(",")}].map(function(c){return String.fromCharCode(c^${key});}).join(""))</script></body></html>`;
}

const CHALLENGE = challengePage('document.cookie="chk=1;path=/";location.reload();');

// ---------------------------------------------------------------------------
// 公共 ctx 片段
// ---------------------------------------------------------------------------

const ctxOf = (url, extra = {}) => ({
  taskId: "t1",
  url,
  authRef: "",
  cookies: "",
  referrer: "",
  userAgent: "",
  extraHeaders: {},
  resolverItem: "",
  ...extra,
});

const OAUTH_REF = "m3u8-resolver@cocolight::https://site.test";
const future = Math.floor(Date.now() / 1000) + 86400;
const past = Math.floor(Date.now() / 1000) - 86400;

// ---------------------------------------------------------------------------
// 场景
// ---------------------------------------------------------------------------

export const scenarios = [
  // ======================= resolver：清单直链 =======================
  {
    name: "resolver：.m3u8 直链 → 变体清单（含音轨分离与字幕轨）",
    entry: "resolver",
    settings: { targetHosts: "", separateAudio: "auto" },
    routes: { [`${CDN}/hls/master.m3u8`]: { body: MASTER_FULL } },
    invoke: (e) => e.resolve(ctxOf(`${CDN}/hls/master.m3u8`)),
  },
  {
    name: "resolver：直链 + preferResolution=720 + preferCodec=hevc",
    entry: "resolver",
    settings: { preferResolution: "720", preferCodec: "hevc" },
    routes: { [`${CDN}/vod/master.m3u8`]: { body: MASTER_MIXED } },
    invoke: (e) => e.resolve(ctxOf(`${CDN}/vod/master.m3u8`)),
  },
  {
    name: "resolver：直链 + 已是 media playlist（带加密体检四分支）",
    entry: "resolver",
    settings: {},
    routes: { [`${CDN}/hls/media.m3u8`]: { body: MEDIA_ENCRYPTED } },
    invoke: (e) => e.resolve(ctxOf(`${CDN}/hls/media.m3u8`)),
  },
  {
    name: "resolver：直链 + autoPick + 命名模板 {title}-{res}-{host}",
    entry: "resolver",
    settings: { autoPick: true, nameTemplate: "{title}-{res}-{host}", separateAudio: "auto" },
    routes: { [`${CDN}/hls/master.m3u8`]: { body: MASTER_FULL } },
    invoke: (e) => e.resolve(ctxOf(`${CDN}/hls/master.m3u8`)),
  },
  {
    name: "resolver：直链 + separateAudio=off（不应带 audioUrl）",
    entry: "resolver",
    settings: { separateAudio: "off" },
    routes: { [`${CDN}/hls/master.m3u8`]: { body: MASTER_FULL } },
    invoke: (e) => e.resolve(ctxOf(`${CDN}/hls/master.m3u8`)),
  },
  {
    name: "resolver：纯音频提取（有独立音轨）",
    entry: "resolver",
    settings: { audioOnly: true, separateAudio: "auto" },
    routes: { [`${CDN}/hls/master.m3u8`]: { body: MASTER_FULL } },
    invoke: (e) => e.resolve(ctxOf(`${CDN}/hls/master.m3u8`)),
  },
  {
    name: "resolver：纯音频提取但源无独立音轨 → 明确报错",
    entry: "resolver",
    settings: { audioOnly: true },
    routes: { [`${CDN}/hls/master.m3u8`]: { body: MASTER_NO_AUDIO } },
    invoke: (e) => e.resolve(ctxOf(`${CDN}/hls/master.m3u8`)),
  },
  {
    name: "resolver：直链 404 → fetch playlist 报错",
    entry: "resolver",
    settings: {},
    routes: {},
    invoke: (e) => e.resolve(ctxOf(`${CDN}/hls/gone.m3u8`)),
  },
  {
    name: "resolver：抓回 HTML 而非 m3u8，且 yt-dlp 兜底成功",
    entry: "resolver",
    settings: { htmlFallbackYtdlp: true },
    routes: { [`${CDN}/hls/master.m3u8`]: { body: "<!doctype html><html><body>请登录</body></html>" } },
    ytdlp: { stdout: JSON.stringify({ title: "兜底片名", url: `${CDN}/real/index.m3u8` }) },
    invoke: (e) => e.resolve(ctxOf(`${CDN}/hls/master.m3u8`)),
  },
  {
    name: "resolver：抓回 HTML 且无 yt-dlp 组件 → 报错",
    entry: "resolver",
    settings: {},
    routes: { [`${CDN}/hls/master.m3u8`]: { body: "<!doctype html><html><body>请登录</body></html>" } },
    invoke: (e) => e.resolve(ctxOf(`${CDN}/hls/master.m3u8`)),
  },
  {
    name: "resolver：.mpd 直链 → 原样返回，不抓取",
    entry: "resolver",
    settings: {},
    routes: {},
    invoke: (e) => e.resolve(ctxOf(`${CDN}/dash/manifest.mpd`)),
  },

  // ======================= resolver：播放页 =======================
  {
    name: "resolver：播放页 + 绝对 m3u8 + 页面标题命名",
    entry: "resolver",
    settings: { targetHosts: "site.test" },
    routes: {
      [`${SITE}/watch/123`]: { body: pageWithAbsMaster },
      [`${CDN}/hls/master.m3u8?sign=abc&t=1`]: { body: MASTER_FULL },
    },
    invoke: (e) => e.resolve(ctxOf(`${SITE}/watch/123`)),
  },
  {
    name: "resolver：播放页 + 相对 m3u8（<video> 标记存在）",
    entry: "resolver",
    settings: { targetHosts: "site.test" },
    routes: {
      [`${SITE}/watch/456`]: { body: pageWithRelMaster },
      [`${SITE}/hls/master.m3u8?x=1`]: { body: MASTER_MIXED },
    },
    invoke: (e) => e.resolve(ctxOf(`${SITE}/watch/456`)),
  },
  {
    name: "resolver：页面无 m3u8，跟随同站 iframe",
    entry: "resolver",
    settings: { targetHosts: "site.test", iframeMaxFollow: 1 },
    routes: {
      [`${SITE}/watch/iframe`]: { body: pageIframe },
      [`${SITE}/player/embed/9`]: { body: pagePlayer },
      [`${SITE}/v/9/index.m3u8`]: { body: MASTER_MIXED },
    },
    invoke: (e) => e.resolve(ctxOf(`${SITE}/watch/iframe`)),
  },
  {
    name: "resolver：maccms player_data 的 link 兜底",
    entry: "resolver",
    settings: { targetHosts: "site.test" },
    routes: {
      [`${SITE}/vod/1.html`]: { body: pageMaccmsLink },
      [`${SITE}/vod-play/11076-1-1/`]: { body: pagePlayer },
      [`${SITE}/v/9/index.m3u8`]: { body: MASTER_MIXED },
    },
    invoke: (e) => e.resolve(ctxOf(`${SITE}/vod/1.html`)),
  },
  {
    name: "resolver：防抓页挑战 → 解出 Cookie 并重取",
    entry: "resolver",
    settings: { targetHosts: "site.test", solveChallenge: true },
    routes: {
      [`${SITE}/watch/chal`]: (opts) =>
        opts.headers && /(?:^|;\s*)chk=1/.test(opts.headers.Cookie || "")
          ? { body: pageWithAbsMaster }
          : { body: CHALLENGE },
      [`${CDN}/hls/master.m3u8?sign=abc&t=1`]: { body: MASTER_FULL },
    },
    invoke: (e) => e.resolve(ctxOf(`${SITE}/watch/chal`)),
  },
  {
    name: "resolver：页面无 m3u8 但有 .mpd → DASH 发现层",
    entry: "resolver",
    settings: { targetHosts: "site.test", detectDash: true },
    routes: {
      [`${SITE}/watch/dash`]: { body: pageOnlyMpd },
      [`${SITE}/dash/manifest.mpd?x=1`]: { body: "<MPD/>" },
    },
    invoke: (e) => e.resolve(ctxOf(`${SITE}/watch/dash`)),
  },
  {
    name: "resolver：页面无标题 → 走 URL 推导并告警",
    entry: "resolver",
    settings: { targetHosts: "site.test" },
    routes: {
      [`${SITE}/watch/notitle`]: { body: pageNoTitle },
      [`${SITE}/hls/master.m3u8`]: { body: MASTER_MIXED },
    },
    invoke: (e) => e.resolve(ctxOf(`${SITE}/watch/notitle`)),
  },
  {
    name: "resolver：页面既无 m3u8 也无 mpd → 放行（返回 null）",
    entry: "resolver",
    settings: { targetHosts: "site.test" },
    routes: { [`${SITE}/watch/plain`]: { body: "<html><head><title>普通页</title></head><body>hi</body></html>" } },
    invoke: (e) => e.resolve(ctxOf(`${SITE}/watch/plain`)),
  },
  {
    name: "resolver：未配置 targetHosts → 不处理页面",
    entry: "resolver",
    settings: { targetHosts: "" },
    routes: { [`${SITE}/watch/123`]: { body: pageWithAbsMaster } },
    invoke: (e) => e.resolve(ctxOf(`${SITE}/watch/123`)),
  },
  {
    name: "resolver：播放页 404 → fetch page 报错",
    entry: "resolver",
    settings: { targetHosts: "site.test" },
    routes: {},
    invoke: (e) => e.resolve(ctxOf(`${SITE}/watch/missing`)),
  },

  // ======================= resolver：剧集页 =======================
  {
    name: "resolver：剧集页 Tier-1（多组 m3u8，差异位是集号）",
    entry: "resolver",
    settings: { targetHosts: "site.test", detectSeries: true },
    routes: { [`${SITE}/vod/series`]: { body: pageSeries } },
    invoke: (e) => e.resolve(ctxOf(`${SITE}/vod/series`)),
  },
  {
    name: "resolver：剧集页 Tier-1 条目数受 manifestMaxItems 限制",
    entry: "resolver",
    settings: { targetHosts: "site.test", manifestMaxItems: 3 },
    routes: { [`${SITE}/vod/series`]: { body: pageSeriesHuge } },
    invoke: (e) => e.resolve(ctxOf(`${SITE}/vod/series`)),
  },
  {
    name: "resolver：剧集页 Tier-2（链接聚类）",
    entry: "resolver",
    settings: { targetHosts: "site.test", manifestMinItems: 3 },
    routes: { [`${SITE}/list`]: { body: pageLinks } },
    invoke: (e) => e.resolve(ctxOf(`${SITE}/list`)),
  },
  {
    name: "resolver：Tier-2 条目不足 minItems → 不判剧集，继续走单视频链路",
    entry: "resolver",
    settings: { targetHosts: "site.test", manifestMinItems: 3 },
    routes: { [`${SITE}/list2`]: { body: pageLinksTooFew } },
    invoke: (e) => e.resolve(ctxOf(`${SITE}/list2`)),
  },
  {
    name: "resolver：单集播放页（有 <video>）→ 不判剧集",
    entry: "resolver",
    settings: { targetHosts: "site.test" },
    routes: { [`${SITE}/vod/single`]: { body: pageSingleWithPlayer } },
    invoke: (e) => e.resolve(ctxOf(`${SITE}/vod/single`)),
  },
  {
    name: "resolver：episodeLinkPattern 非法正则 → 告警后忽略",
    entry: "resolver",
    settings: { targetHosts: "site.test", episodeLinkPattern: "([a-z" },
    routes: { [`${SITE}/list`]: { body: pageLinks } },
    invoke: (e) => e.resolve(ctxOf(`${SITE}/list`)),
  },
  {
    name: "resolver：detectSeries 关闭 → 不弹选集",
    entry: "resolver",
    settings: { targetHosts: "site.test", detectSeries: false },
    routes: { [`${SITE}/vod/series`]: { body: pageSeries }, [`${CDN}/vod/ep1/index.m3u8`]: { body: MASTER_MIXED } },
    invoke: (e) => e.resolve(ctxOf(`${SITE}/vod/series`)),
  },

  // ======================= resolver：二段与 yt-dlp =======================
  {
    name: "resolver：二段解析（u: 内嵌短链）",
    entry: "resolver",
    settings: { targetHosts: "" },
    routes: { [`${CDN}/hls/master.m3u8`]: { body: MASTER_FULL } },
    invoke: (e) => e.resolve(ctxOf("https://anything.test/x", { resolverItem: `u:${CDN}/hls/master.m3u8` })),
  },
  {
    name: "resolver：二段解析（k: 令牌在存储里）",
    entry: "resolver",
    settings: {},
    store: { itemMap: JSON.stringify({ kabc123: `${CDN}/hls/master.m3u8` }) },
    routes: { [`${CDN}/hls/master.m3u8`]: { body: MASTER_FULL } },
    invoke: (e) => e.resolve(ctxOf("https://anything.test/x", { resolverItem: "k:kabc123" })),
  },
  {
    name: "resolver：二段解析（令牌已失效）→ 放行",
    entry: "resolver",
    settings: {},
    routes: {},
    invoke: (e) => e.resolve(ctxOf("https://anything.test/x", { resolverItem: "k:missing" })),
  },
  {
    name: "resolver：二段解析目标是 .mpd → 原样返回",
    entry: "resolver",
    settings: {},
    routes: {},
    invoke: (e) => e.resolve(ctxOf("https://anything.test/x", { resolverItem: `u:${CDN}/dash/m.mpd` })),
  },
  {
    name: "resolver：yt-dlp 委派（useYtdlp）",
    entry: "resolver",
    settings: { targetHosts: "site.test", useYtdlp: true },
    ytdlp: { stdout: JSON.stringify({ title: "委派片名", url: `${CDN}/dl/index.m3u8` }) },
    invoke: (e) => e.resolve(ctxOf(`${SITE}/watch/yt`)),
  },
  {
    name: "resolver：yt-dlp 委派失败 → 回退原生解析",
    entry: "resolver",
    settings: { targetHosts: "site.test", useYtdlp: true },
    ytdlp: { code: 1, stderr: "ERROR: unsupported url" },
    routes: {
      [`${SITE}/watch/yt`]: { body: pageWithAbsMaster },
      [`${CDN}/hls/master.m3u8?sign=abc&t=1`]: { body: MASTER_FULL },
    },
    invoke: (e) => e.resolve(ctxOf(`${SITE}/watch/yt`)),
  },

  // ======================= resolver：凭据注入 =======================
  {
    name: "resolver：同源凭据（cookie）注入 extraHeaders",
    entry: "resolver",
    settings: {},
    profiles: {
      [OAUTH_REF]: { site: "https://cdn.site.test", kind: "cookie", cookies: "sid=abc; uid=9" },
    },
    routes: { [`${CDN}/hls/master.m3u8`]: { body: MASTER_MIXED } },
    invoke: (e) => e.resolve(ctxOf(`${CDN}/hls/master.m3u8`, { authRef: OAUTH_REF })),
  },
  {
    name: "resolver：跨站凭据（站点不同源）→ 不注入并记日志",
    entry: "resolver",
    settings: {},
    profiles: {
      [OAUTH_REF]: { site: "https://site.test", kind: "cookie", cookies: "sid=abc" },
    },
    routes: { [`${CDN}/hls/master.m3u8`]: { body: MASTER_MIXED } },
    invoke: (e) => e.resolve(ctxOf(`${CDN}/hls/master.m3u8`, { authRef: OAUTH_REF })),
  },
  {
    name: "resolver：basic 凭据 → 手写 base64 的 Authorization",
    entry: "resolver",
    settings: {},
    profiles: {
      [OAUTH_REF]: { site: "https://cdn.site.test", kind: "basic", username: "用户", password: "p@ss" },
    },
    routes: { [`${CDN}/hls/master.m3u8`]: { body: MASTER_MIXED } },
    invoke: (e) => e.resolve(ctxOf(`${CDN}/hls/master.m3u8`, { authRef: OAUTH_REF })),
  },
  {
    name: "resolver：extraHeadersRaw + userAgent + 任务 extraHeaders 的优先级",
    entry: "resolver",
    settings: { extraHeadersRaw: "# 注释\nX-A: 1\nReferer: https://override.test/p", userAgent: "UA/1.0" },
    routes: { [`${CDN}/hls/master.m3u8`]: { body: MASTER_MIXED } },
    invoke: (e) =>
      e.resolve(
        ctxOf(`${CDN}/hls/master.m3u8`, {
          referrer: `${SITE}/watch/1`,
          extraHeaders: { "X-Task": "t", Referer: `${SITE}/override` },
        }),
      ),
  },

  // ======================= subscribe =======================
  {
    name: "subscribe：列表页 → 4 条条目（guid/标题/序号排序）",
    entry: "subscribe",
    settings: {},
    routes: { [`${SITE}/list`]: { body: pageLinks } },
    invoke: (e) =>
      e.subscribe({
        providerId: "m3u8play",
        sourceId: "s1",
        url: `${SITE}/list`,
        providerConfig: "",
        cookies: "c=1",
        userAgent: "UA/2.0",
      }),
  },
  {
    name: "subscribe：播放器页 → 空 feed",
    entry: "subscribe",
    settings: {},
    routes: { [`${SITE}/one`]: { body: pageSingleWithPlayer } },
    invoke: (e) =>
      e.subscribe({ providerId: "m3u8play", sourceId: "s1", url: `${SITE}/one`, providerConfig: "", cookies: "", userAgent: "" }),
  },
  {
    name: "subscribe：providerConfig 过滤（include + linkPattern + minItems）",
    entry: "subscribe",
    settings: {},
    routes: { [`${SITE}/list`]: { body: pageLinks } },
    invoke: (e) =>
      e.subscribe({
        providerId: "m3u8play",
        sourceId: "s1",
        url: `${SITE}/list`,
        providerConfig: JSON.stringify({ minItems: 3, include: "vodplay", linkPattern: "1-([1-9])" }),
        cookies: "",
        userAgent: "",
      }),
  },
  {
    name: "subscribe：providerConfig 非法 JSON → 告警后按默认跑",
    entry: "subscribe",
    settings: {},
    routes: { [`${SITE}/list`]: { body: pageLinks } },
    invoke: (e) =>
      e.subscribe({ providerId: "m3u8play", sourceId: "s1", url: `${SITE}/list`, providerConfig: "{oops", cookies: "", userAgent: "" }),
  },
  {
    name: "subscribe：HTTP 500 → 抛错",
    entry: "subscribe",
    settings: {},
    routes: { [`${SITE}/list`]: { status: 500, body: "boom" } },
    invoke: (e) =>
      e.subscribe({ providerId: "m3u8play", sourceId: "s1", url: `${SITE}/list`, providerConfig: "", cookies: "", userAgent: "" }),
  },

  // ======================= auth =======================
  {
    name: "auth：status 未登录",
    entry: "auth",
    settings: {},
    invoke: (e) => e.authenticate({ action: "status", site: SITE, authRef: OAUTH_REF, sessionId: "", input: "" }),
  },
  {
    name: "auth：status 已登录（未过期）",
    entry: "auth",
    settings: {},
    profiles: { [OAUTH_REF]: { site: SITE, kind: "cookie", cookies: "a=1", expiresAt: future } },
    invoke: (e) => e.authenticate({ action: "status", site: SITE, authRef: OAUTH_REF, sessionId: "", input: "" }),
  },
  {
    name: "auth：status 档案已过期 → 视为未登录",
    entry: "auth",
    settings: {},
    profiles: { [OAUTH_REF]: { site: SITE, kind: "cookie", cookies: "a=1", expiresAt: past } },
    invoke: (e) => e.authenticate({ action: "status", site: SITE, authRef: OAUTH_REF, sessionId: "", input: "" }),
  },
  {
    name: "auth：begin 粘贴 Cookie 原文",
    entry: "auth",
    settings: {},
    invoke: (e) => e.authenticate({ action: "begin", site: SITE, authRef: "", sessionId: "s1", input: "sid=abc; uid=9" }),
  },
  {
    name: "auth：begin 粘贴 bearer 令牌",
    entry: "auth",
    settings: {},
    invoke: (e) => e.authenticate({ action: "begin", site: SITE, authRef: "", sessionId: "s1", input: "bearer:tok_123" }),
  },
  {
    name: "auth：begin 粘贴 basic 用户名密码",
    entry: "auth",
    settings: {},
    invoke: (e) => e.authenticate({ action: "begin", site: SITE, authRef: "", sessionId: "s1", input: "basic:用户名:p@ss" }),
  },
  {
    name: "auth：begin 粘贴多行请求头",
    entry: "auth",
    settings: {},
    invoke: (e) =>
      e.authenticate({
        action: "begin",
        site: SITE,
        authRef: "",
        sessionId: "s1",
        input: "Cookie: a=1; b=2\nX-Token: zzz",
      }),
  },
  {
    name: "auth：begin 无输入 → 进入交互态",
    entry: "auth",
    settings: {},
    invoke: (e) => e.authenticate({ action: "begin", site: SITE, authRef: "", sessionId: "s1", input: "" }),
  },
  {
    name: "auth：begin 无输入且无站点 → 提示缺少站点",
    entry: "auth",
    settings: {},
    invoke: (e) => e.authenticate({ action: "begin", site: "", authRef: "", sessionId: "s1", input: "" }),
  },
  {
    name: "auth：begin 无输入但设置里存了 authCookie → 直接保存",
    entry: "auth",
    settings: { authCookie: "bearer:from_settings" },
    invoke: (e) => e.authenticate({ action: "begin", site: SITE, authRef: "", sessionId: "s1", input: "" }),
  },
  {
    name: "auth：poll 已有档案 → 直接成功",
    entry: "auth",
    settings: {},
    profiles: { [OAUTH_REF]: { site: SITE, kind: "cookie", cookies: "a=1" } },
    invoke: (e) => e.authenticate({ action: "poll", site: SITE, authRef: OAUTH_REF, sessionId: "s1", input: "" }),
  },
  {
    name: "auth：logout → 删除凭据",
    entry: "auth",
    settings: {},
    invoke: (e) => e.authenticate({ action: "logout", site: SITE, authRef: OAUTH_REF, sessionId: "", input: "" }),
  },
  {
    name: "auth：cancel",
    entry: "auth",
    settings: {},
    invoke: (e) => e.authenticate({ action: "cancel", site: SITE, authRef: "", sessionId: "s1", input: "" }),
  },
  {
    name: "auth：未知 action",
    entry: "auth",
    settings: {},
    invoke: (e) => e.authenticate({ action: "weird", site: SITE, authRef: "", sessionId: "", input: "" }),
  },

  // ======================= hooks =======================
  {
    name: "hooks：onDone 单文件 .ts → remux 为 mp4",
    entry: "hooks",
    settings: { remuxToMp4: true },
    store: { handledTasks: '{"t1":1}' },
    ffmpeg: {},
    invoke: (e) => e.onDone({ event: "done", taskId: "t1", url: `${CDN}/a.m3u8`, filePath: "/dl/show.ts", audioPath: null, muxed: true }),
  },
  {
    name: "hooks：onDone 轨对未合并（mp4 + 独立音频）→ 仅告警",
    entry: "hooks",
    settings: { fixMuxFallback: true, remuxToMp4: true },
    store: { handledTasks: '{"t1":1}' },
    ffmpeg: {},
    invoke: (e) => e.onDone({ event: "done", taskId: "t1", url: "", filePath: "/dl/show.mp4", audioPath: "/dl/show.m4a", muxed: false }),
  },
  {
    name: "hooks：onDone 轨对未合并（mkv + 独立音频）→ ffmpeg 兜底合并",
    entry: "hooks",
    settings: { fixMuxFallback: true, remuxToMp4: true },
    store: { handledTasks: '{"t1":1}' },
    ffmpeg: {},
    invoke: (e) => e.onDone({ event: "done", taskId: "t1", url: "", filePath: "/dl/show.mkv", audioPath: "/dl/show.m4a", muxed: false }),
  },
  {
    name: "hooks：onDone 兜底合并失败（code≠0）→ 继续 remux 并记错误",
    entry: "hooks",
    settings: { fixMuxFallback: true, remuxToMp4: true },
    store: { handledTasks: '{"t1":1}' },
    ffmpeg: { code: 1, stderr: "x".repeat(500) },
    invoke: (e) => e.onDone({ event: "done", taskId: "t1", url: "", filePath: "/dl/show.mkv", audioPath: "/dl/show.m4a", muxed: false }),
  },
  {
    name: "hooks：onDone 非媒体扩展名 → 跳过",
    entry: "hooks",
    settings: {},
    store: { handledTasks: '{"t1":1}' },
    ffmpeg: {},
    invoke: (e) => e.onDone({ event: "done", taskId: "t1", url: "", filePath: "/dl/pack.zip", audioPath: null, muxed: true }),
  },
  {
    name: "hooks：onDone remuxToMp4 关闭 → 不调 ffmpeg",
    entry: "hooks",
    settings: { remuxToMp4: false },
    store: { handledTasks: '{"t1":1}' },
    ffmpeg: {},
    invoke: (e) => e.onDone({ event: "done", taskId: "t1", url: "", filePath: "/dl/show.ts", audioPath: null, muxed: true }),
  },
  {
    name: "hooks：onDone 未安装 ffmpeg 组件 → 跳过",
    entry: "hooks",
    settings: { remuxToMp4: true },
    store: { handledTasks: '{"t1":1}' },
    invoke: (e) => e.onDone({ event: "done", taskId: "t1", url: "", filePath: "/dl/show.ts", audioPath: null, muxed: true }),
  },
  {
    name: "hooks：onDone 非本插件任务 → 不动",
    entry: "hooks",
    settings: {},
    store: { handledTasks: "{}" },
    ffmpeg: {},
    invoke: (e) => e.onDone({ event: "done", taskId: "t9", url: "", filePath: "/dl/other.ts", audioPath: null, muxed: true }),
  },
  {
    name: "hooks：onError 本插件任务 → 记日志并清理标记",
    entry: "hooks",
    settings: {},
    store: { handledTasks: '{"t1":1}' },
    invoke: (e) => e.onError({ event: "error", taskId: "t1", url: `${CDN}/a.m3u8`, message: "403 Forbidden" }),
  },
  {
    name: "hooks：onCancel 本插件任务 → 清理标记",
    entry: "hooks",
    settings: {},
    store: { handledTasks: '{"t1":1}' },
    invoke: (e) => e.onCancel({ event: "cancel", taskId: "t1", url: "", reason: "user_cancelled" }),
  },
];
