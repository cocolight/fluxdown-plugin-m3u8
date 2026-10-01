// FluxDown 插件订阅 provider（1.6.0）
// 入口固定为 globalThis.subscribe(ctx)，返回值交给核心的统一订阅状态机（插件不碰订阅表、
// 不建任务）。ctx = { providerId, sourceId, url, providerConfig, cookies, userAgent }。
//
// ⚠️ 本文件与 resolver.js / hooks.js / auth.js 是**彼此独立的 QuickJS 上下文** —— 不能
//    import/require，也不共享作用域。下面这套「同站 + 链接形态聚类」的规则与
//    resolver.js 的 collectEpisodeLinks 是**有意保持平行的两套实现**（规则同源、代码不共享）；
//    改其中一套时请同步另一套。
//
// ⚠️ 返回值是**对象**，不是 JSON 字符串：宿主 wrapper 会 JSON.stringify 后再按
//    SubscriptionOutput 反序列化（native/engine/src/plugin/quickjs.rs）。
//
// 契约（已核实 native/engine/src/plugin/manager.rs::validate_subscription_item）：
//   · items ≤ 1000；guid 非空 ≤2048；title ≤1024；resolverItem ≤2048
//   · link / enclosureUrl 至少一个非空，且都要过 check_output_url（scheme 白名单）
//   · 含 resolverItem 时 link 必须非空；enclosureLength 非负
//   · 单条非法 → 跳过并记日志；**全部**非法 → 整批报错
//
// providerConfig（JSON 字符串）为用户逃生舱，全部可选：
//   { "minItems": 2, "maxItems": 200, "linkPattern": "\\/vodplay\\/\\d+-\\d+-(\\d+)",
//     "include": "vodplay", "exclude": "preview" }
//   minItems 默认 2（**比 resolver 的 manifestMinItems=3 宽松**）：订阅地址是用户主动配置的，
//   不该像「自动识别任意提交链接」那样保守；但 1 条构成不了「追更」，故不默认 1。
//
// ⚠️ 预告/花絮的剔除只按 **URL** 判断（MEDIA_NOISE_RE），不看链接文字 —— 与 resolver.js
//    的 isMediaNoise 保持一致。站点若把预告做成 `/vodplay/...-99.html` 这类正常路径，
//    需要用 providerConfig 的 exclude 手工排除。
//
// ★ guid 稳定性决定了「追更去重」是否正确：这里用 host + pathname 的 FNV-1a 32 位，
//   **刻意丢掉 query**（CDN 签名/追踪参数会让同一条目每次 guid 都不同，导致重复建任务）。

// ---------- 极简工具（不依赖 URL / btoa —— 沙箱里都不存在） ----------
function splitUrl(u) {
  const m = /^([a-zA-Z][a-zA-Z0-9+.\-]*):\/\/([^/?#]*)([^?#]*)(\?[^#]*)?/.exec(String(u == null ? "" : u));
  if (!m) return null;
  const scheme = m[1].toLowerCase();
  const authority = m[2];
  const at = authority.lastIndexOf("@");
  const host = (at >= 0 ? authority.slice(at + 1) : authority).toLowerCase();
  return {
    scheme: scheme,
    host: host,
    hostname: host.replace(/:\d+$/, ""),
    pathname: m[3] || "/",
    search: m[4] || "",
  };
}
function hostOf(u) {
  const p = splitUrl(u);
  return p ? p.host : "";
}
function absUrl(u, base) {
  const s = String(u == null ? "" : u).trim();
  if (!s) return "";
  if (/^[a-zA-Z][a-zA-Z0-9+.\-]*:\/\//.test(s)) return s;
  const b = splitUrl(base);
  if (!b) return s;
  const root = b.scheme + "://" + b.host;
  if (s.indexOf("//") === 0) return b.scheme + ":" + s;
  if (s.charAt(0) === "/") return root + s;
  if (s.charAt(0) === "#") return "";
  const dir = b.pathname.replace(/[^/]*$/, "");
  const parts = (dir + s).split("/");
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i];
    if (seg === "." || seg === "") { if (i === 0) out.push(""); continue; }
    if (seg === "..") { if (out.length > 1) out.pop(); continue; }
    out.push(seg);
  }
  return root + out.join("/");
}
function decodeEntities(s) {
  return String(s == null ? "" : s)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&amp;/g, "&");
}
function fnv1a32(s) {
  let h = 0x811c9dc5;
  const str = String(s);
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
  }
  return (h >>> 0).toString(16);
}

const LINK_ATTR_RE = /(?:href|src)\s*=\s*["']([^"'<>\s]+)["']/gi;
const EXCLUDE_LINK_RE = /(?:login|logout|signin|signup|register|about|contact|help|support|terms|privacy|tags?|category|search|comment|share|app|apk|ios|android|cart|user|profile|account|follow|subscribe|rss|sitemap)(?:$|[/?#])/i;
const STATIC_EXT_RE = /\.(?:png|jpe?g|gif|svg|webp|css|js|woff2?|ico|json|xml|txt|pdf|zip)(?:$|\?)/i;
const MEDIA_NOISE_RE = /(?:^|[._\-\/])(?:trailer|preview|teaser|sample|ad|ads|advert|bumper|intro|outro|pv|promo|behind|making)(?:$|[._\-\/])/i;
const PLAYER_MARK_RE = /<video[\s>]|<source[\s>]|hls\.js|Hls\.|videojs|jwplayer|dplayer|ckplayer|artplayer/i;

function linkTemplate(u) {
  const p = splitUrl(u);
  if (!p) return "";
  return p.pathname.replace(/\d+/g, "#");
}
function lastOrdinal(u) {
  const p = splitUrl(u);
  const ms = String(p ? p.pathname : u).match(/\d{1,6}/g);
  return ms && ms.length ? +ms[ms.length - 1] : 0;
}
function sortByOrdinal(urls) {
  return urls.slice().sort(function (a, b) {
    const x = lastOrdinal(a), y = lastOrdinal(b);
    if (x !== y) return x - y;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}
function safeRe(pat) {
  if (!pat) return null;
  try { return new RegExp(String(pat), "i"); } catch (e) { return null; }
}

// 从页面里挑出「一批同构的剧集链接」。规则与 resolver.js::collectEpisodeLinks 平行：
// 同站 → 排除静态资源/导航/预告 → 形态聚类取最大簇 → 按末位序号排序。
function collectItems(html, base, cfg) {
  const pageHost = hostOf(base);
  if (!pageHost) return [];
  const inc = cfg.include, exc = cfg.exclude, linkPat = cfg.linkPattern;
  const out = [];
  const seen = {};
  LINK_ATTR_RE.lastIndex = 0;
  let m;
  while ((m = LINK_ATTR_RE.exec(html))) {
    const raw = m[1];
    if (!raw || raw.charAt(0) === "#") continue;
    if (/^(?:javascript:|mailto:|data:|tel:)/i.test(raw)) continue;
    const abs = absUrl(decodeEntities(raw), base);
    if (!abs || !/^https?:\/\//i.test(abs)) continue;
    if (hostOf(abs) !== pageHost) continue;
    if (STATIC_EXT_RE.test(abs)) continue;
    if (EXCLUDE_LINK_RE.test(abs)) continue;
    if (MEDIA_NOISE_RE.test(abs)) continue;
    if (inc && !inc.test(abs)) continue;
    if (exc && exc.test(abs)) continue;
    if (linkPat && !linkPat.test(abs)) continue;
    if (seen[abs]) continue;
    seen[abs] = 1;
    out.push(abs);
  }
  if (!out.length) return [];
  const order = [];
  const clusters = {};
  for (let i = 0; i < out.length; i++) {
    const t = linkTemplate(out[i]);
    if (!clusters[t]) { clusters[t] = []; order.push(t); }
    clusters[t].push(out[i]);
  }
  let best = null;
  for (let i = 0; i < order.length; i++) {
    const c = clusters[order[i]];
    if (!best || c.length > best.length) best = c;
  }
  return best ? sortByOrdinal(best) : [];
}

// 去重键：host + pathname（丢 query，见文件头「guid 稳定性」）。
// feed 内碰撞时并入 query 的 FNV 值消解。
function makeGuid(used, url) {
  const p = splitUrl(url);
  const stem = "m3u8-" + (p ? fnv1a32(p.host + p.pathname) : fnv1a32(url));
  if (!used[stem]) { used[stem] = 1; return stem; }
  const alt = stem + "-" + (p ? fnv1a32(p.search) : fnv1a32(url + "#"));
  used[alt] = 1;
  return alt;
}

// 条目标题：优先用链接末段里的序号（更贴近站点的「第 N 集」），否则用 pathname 末段。
function titleFor(url) {
  const p = splitUrl(url);
  const ms = String(p ? p.pathname : url).match(/\d{1,6}/g);
  if (ms && ms.length) return "EP" + ms[ms.length - 1];
  const seg = String(p ? p.pathname : url).split("/").filter(Boolean).pop() || "item";
  return seg;
}

globalThis.subscribe = async (ctx) => {
  const url = String((ctx && ctx.url) || "").trim();
  if (!url) throw new Error("订阅地址为空");

  let cfg = {};
  const rawCfg = String((ctx && ctx.providerConfig) || "").trim();
  if (rawCfg) {
    try {
      const parsed = JSON.parse(rawCfg);
      if (parsed && typeof parsed === "object") cfg = parsed;
    } catch (e) {
      // providerConfig 是自由文本，填错不应让整条订阅失败 —— 记日志后按默认跑。
      flux.logger.warn("[m3u8-subscribe] providerConfig 不是合法 JSON，已忽略:", rawCfg.slice(0, 200));
    }
  }

  const headers = {};
  if (ctx && ctx.userAgent) headers["User-Agent"] = String(ctx.userAgent);
  if (ctx && ctx.cookies) headers["Cookie"] = String(ctx.cookies);

  const res = await flux.fetch({ method: "GET", url: url, headers: headers });
  if (res.status < 200 || res.status >= 300) {
    throw new Error("订阅抓取失败 HTTP " + res.status);
  }
  const html = String(res.body || "");

  // 命中播放器标记 → 这是单集播放页，不是列表页。返回空 feed 而不是把「上一集/下一集」
  // 当成两集推给用户（宁可空，不可错）。
  if (PLAYER_MARK_RE.test(html)) {
    flux.logger.info("[m3u8-subscribe] 页面含播放器标记，判定为单集页，返回空 feed");
    return { title: "", link: url, items: [] };
  }

  const minItems = Math.max(1, parseInt(cfg.minItems, 10) || 2);
  const maxItems = Math.max(1, Math.min(1000, parseInt(cfg.maxItems, 10) || 200));
  let links = collectItems(html, url, {
    include: safeRe(cfg.include),
    exclude: safeRe(cfg.exclude),
    linkPattern: safeRe(cfg.linkPattern),
  });
  if (links.length < minItems) {
    flux.logger.info("[m3u8-subscribe] 同构条目 " + links.length + " 条，低于 minItems=" + minItems + "，返回空 feed");
    links = [];
  }
  if (links.length > maxItems) links = links.slice(0, maxItems);

  const titleM = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleM ? decodeEntities(titleM[1]).replace(/\s+/g, " ").trim().slice(0, 200) : "";

  const used = {};
  const items = [];
  for (let i = 0; i < links.length; i++) {
    const link = links[i];
    items.push({
      guid: makeGuid(used, link),
      title: titleFor(link),
      link: link,
      enclosureUrl: "",
      // 精确规格：引擎建任务时 url=link、resolver_item=该值，走 resolver 的二段解析。
      resolverItem: "u:" + link,
      enclosureLength: 0,
      pubDate: 0,
    });
  }

  flux.logger.info("[m3u8-subscribe] 产出 " + items.length + " 条（源 " + url + "）");
  return { title: title, link: url, items: items };
};
