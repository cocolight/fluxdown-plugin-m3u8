import type { Settings } from "./settings";
import { absUrl, hostKey, parseUrl } from "./url";
import { decodeEntities, sanitize } from "./text";
import { nameFromUrl } from "./naming";
import { EXCLUDE_LINK_RE, LINK_ATTR_RE, MEDIA_NOISE_RE, PLAYER_MARK_RE, STATIC_EXT_RE } from "./patterns";

/**
 * 发现层：从 HTML 里抠 m3u8 / mpd 地址、识别剧集页。
 *
 * 这一层与 v1.8.0 resolver.js:884-1177 逐字等价。**只做发现**：
 * 拿到 .mpd 就交给核心 DASH 引擎，插件不读内容、不解析 MPD。
 */

// ---------------------------------------------------------------------------
// 单个清单地址
// ---------------------------------------------------------------------------

/** 从页面抠第一个 m3u8 绝对地址（绝对地址优先，其次相对地址绝对化）。 */
export function extractMaster(html: string | null, base: string): string | null {
  if (!html) return null;
  const norm = String(html).replace(/\\\//g, "/"); // JS/JSON 里的 \/ 转义
  // ① 直接是绝对地址
  let m = norm.match(/(https?:\/\/[^"'\\\s<>]+?\.m3u8(?:\?[^"'\\\s<>]*)?)/i);
  if (m) return m[1];
  // ② 相对地址（/hls/index.m3u8、hls/index.m3u8?x=1）→ 用页面 URL 转绝对
  m = norm.match(/["']([^"'<>\s]+?\.m3u8(?:\?[^"'<>\s]*)?)["']/i);
  if (m) {
    const abs = absUrl(m[1], base);
    if (/^https?:\/\//i.test(abs)) return abs;
  }
  return null;
}

/** 从页面抠第一个 .mpd 绝对地址。★ fail-closed：抠不到返回 null，行为与 1.7.0 逐字一致。 */
export function extractDash(html: string | null, base: string): string | null {
  if (!html) return null;
  const norm = String(html).replace(/\\\//g, "/");
  let m = norm.match(/(https?:\/\/[^"'\\\s<>]+?\.mpd(?:\?[^"'\\\s<>]*)?)/i);
  if (m) return m[1];
  m = norm.match(/["']([^"'<>\s]+?\.mpd(?:\?[^"'<>\s]*)?)["']/i);
  if (m) {
    const abs = absUrl(m[1], base);
    if (/^https?:\/\//i.test(abs)) return abs;
  }
  return null;
}

/** 内容形态判据（仅供日志）。不做内容校验 —— 是否合法由核心 DASH 引擎在下载阶段判定。 */
export function looksLikeMpdBody(body: string | null): boolean {
  if (!body) return false;
  const head = String(body).slice(0, 2048);
  return /<MPD[\s>]/i.test(head) || /application\/dash\+xml/i.test(head);
}

/** 页面标题 → 基础名。去掉常见的「标题 - 站点名」后缀。 */
export function extractTitle(html: string | null): string | null {
  const m = String(html || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return null;
  const base = m[1].replace(/\s*[-|·–—|｜]\s*[^|]*$/i, "").trim();
  return sanitize(base) || null;
}

/** 站点没有 <title> 的定向提示：这类站后续会被引擎按「无名」处理（默认 video）。 */
export function warnNoTitle(): void {
  flux.logger.warn(
    "[m3u8-resolver] 页面无 <title>，无法取出片名；改用 URL 推导。" +
      "若成品名仍不理想，请在设置里用「命名模板」加 {host}，或手动改名。",
  );
}

// ---------------------------------------------------------------------------
// 页面里出现的全部 m3u8（供剧集识别）
// ---------------------------------------------------------------------------

// 与 extractMaster 内的字面量正则同源，只多了 g 标志（用于一次取全部匹配）
const ABS_MASTER_RE_G = /(https?:\/\/[^"'\\\s<>]+?\.m3u8(?:\?[^"'\\\s<>]*)?)/gi;
const REL_MASTER_RE_G = /["']([^"'<>\s]+?\.m3u8(?:\?[^"'<>\s]*)?)["']/gi;

/**
 * ★ 关键不变量：返回值 [0] 与 `extractMaster(html, base)` 完全一致 —— 两者用同一套正则、
 *   同一优先级（先全部绝对、再全部相对），只是这里收集而不提前返回。所以「单视频分支」的
 *   输出与 1.4.x 逐字相同，历史回归断言不受影响。
 */
export function extractAllMasters(html: string | null, base: string): string[] {
  if (!html) return [];
  const norm = String(html).replace(/\\\//g, "/");
  const out: string[] = [];
  const seen: Record<string, number> = {};
  const push = (u: string) => {
    if (!u || seen[u]) return;
    seen[u] = 1;
    out.push(u);
  };
  let m: RegExpExecArray | null;
  ABS_MASTER_RE_G.lastIndex = 0;
  while ((m = ABS_MASTER_RE_G.exec(norm))) push(m[1]);
  REL_MASTER_RE_G.lastIndex = 0;
  while ((m = REL_MASTER_RE_G.exec(norm))) {
    const abs = absUrl(m[1], base);
    if (/^https?:\/\//i.test(abs)) push(abs);
  }
  return out.slice(0, 500); // 上限：避免畸形页面把内存打满
}

// ---------------------------------------------------------------------------
// 剧集形态判定
// ---------------------------------------------------------------------------

const QUALITY_SEG_RE =
  /^(?:\d{2,4}p?|[248]k|4k|8k|uhd|fhd|qhd|hd|sd|hq|lq|high|low|medium|mid|auto|source\d*|master|main|index|playlist|media|manifest|default|original|orig|muxed|dash|hls)$/i;
const QUALITY_SUFFIX_RE =
  /(?:[._-](?:\d{3,4}p|[248]k|uhd|fhd|hd|sd|hq|lq|high|low|auto|source|master|index|playlist|media|manifest))+$/i;
const EPISODE_TOKEN_RE = /^(?:ep|episode|e|chapter|ch|part|pt|p|vol|volume|s\d+)?[-_]?(?:\d{1,4})$/i;
const HEX_ID_SEG_RE = /^[0-9a-f]{6,}$/i;
const MEDIA_EXT_TAIL_RE = /\.(?:m3u8|m3u|ts|mp4)$/i;

/**
 * 质量折叠后的分组键：把「同一视频的不同码率」折成同一个键。
 * ① 末段先剥容器扩展名（720p.m3u8 → 720p）；② 整段命中 QUALITY_SEG_RE 或尾部命中
 * QUALITY_SUFFIX_RE 的折成 `*`；③ **丢弃 query/hash**（多为 CDN 签名，会让同一条目被拆成多组）。
 * 保留 host：不同站点的同名路径不该并组。
 */
export function canonicalGroupKey(u: string): string {
  const p = parseUrl(u);
  if (!p) return String(u);
  const segs = String(p.pathname).split("/");
  const out: string[] = [];
  for (let i = 0; i < segs.length; i++) {
    let s = segs[i];
    if (i === segs.length - 1) s = s.replace(MEDIA_EXT_TAIL_RE, "");
    s = s.replace(QUALITY_SUFFIX_RE, "");
    if (s && QUALITY_SEG_RE.test(s)) s = "*";
    out.push(s);
  }
  return p.host + out.join("/");
}

/** 预告 / 花絮 / 广告段（resolver 口径：只看 pathname）。 */
export function isMediaNoise(u: string): boolean {
  const p = parseUrl(u);
  const s = p ? String(p.pathname) : String(u);
  return MEDIA_NOISE_RE.test(s);
}

/** 单个段是否「像集号」：ep12 / E03 / 第 5 集 / part2 / s01e02 的 e02 段 / 6 位以上十六进制 ID。 */
export function isEpisodeToken(s: string | null | undefined): boolean {
  const t = String(s == null ? "" : s);
  return EPISODE_TOKEN_RE.test(t) || HEX_ID_SEG_RE.test(t);
}

/**
 * 组键之间是否只差「集号」。要求**每一个**差异位都像集号 —— 这样「不同 CDN」「不同清晰度
 * 目录」这类差异不会被误判成剧集。
 */
export function groupsDifferByEpisode(keys: string[]): boolean {
  if (!keys || keys.length < 2) return false;
  const parts = keys.map((k) => String(k).split("/"));
  const n = parts[0].length;
  for (let i = 1; i < parts.length; i++) if (parts[i].length !== n) return false; // 结构不同 → 保守放弃
  let diff = 0;
  for (let i = 0; i < n; i++) {
    const vals: string[] = [];
    for (let j = 0; j < parts.length; j++) if (vals.indexOf(parts[j][i]) < 0) vals.push(parts[j][i]);
    if (vals.length < 2) continue; // 这一位所有键都相同
    for (let j = 0; j < vals.length; j++) if (!isEpisodeToken(vals[j])) return false;
    diff++;
  }
  return diff > 0;
}

// ---------------------------------------------------------------------------
// 链接聚合（resolver 与 subscribe 共用）
// ---------------------------------------------------------------------------

/** 链接形态模板：抹掉数字，让 /ep1/x.html 与 /ep2/x.html 归为同一形态。 */
export function linkTemplate(u: string): string {
  const p = parseUrl(u);
  if (!p) return "";
  return String(p.pathname).replace(/\d+/g, "#");
}

/** 取 pathname 里**最后一个**数字串当序号：集号通常靠后，避免被 /2024/ 这类年份带偏。 */
export function lastOrdinal(u: string): number {
  const p = parseUrl(u);
  const s = p ? String(p.pathname) : String(u);
  const ms = s.match(/\d{1,6}/g);
  return ms && ms.length ? +ms[ms.length - 1] : 0;
}

export function sortByOrdinal(urls: string[]): string[] {
  return urls.slice().sort((a, b) => {
    const x = lastOrdinal(a);
    const y = lastOrdinal(b);
    if (x !== y) return x - y;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

/**
 * 从页面里挑出「一批同构的链接」的**公共实现**。
 *
 * v1.8.0 有两个刻意的平行实现（resolver::collectEpisodeLinks / subscribe::collectItems），
 * 差别仅在于：① 同站判定用哪套 host 口径；② 噪声判定看 pathname 还是整条 URL；
 * ③ 是否支持 include/exclude/linkPattern 三个 providerConfig 过滤器。
 * 这里把差异**参数化**而不是抹平 —— 抹平等于悄悄改变行为，M3 再决定是否统一。
 */
export interface CollectOptions {
  /** 同站判定用的 host 取值（resolver: hostKey；subscribe: hostWithPort）。 */
  host: (u: string) => string;
  /** 噪声判定（resolver: 只看 pathname；subscribe: 看整条 URL）。 */
  isNoise: (u: string) => boolean;
  include?: RegExp | null;
  exclude?: RegExp | null;
  linkPattern?: RegExp | null;
}

/** 收集同站、非静态、非导航、非同构噪声的候选链接（去重，保持出现顺序）。 */
export function collectLinks(html: string, base: string, o: CollectOptions): string[] {
  const pageHost = o.host(base);
  if (!pageHost) return [];
  const out: string[] = [];
  const seen: Record<string, number> = {};
  LINK_ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LINK_ATTR_RE.exec(html))) {
    const raw = m[1];
    if (!raw || raw.charAt(0) === "#") continue;
    if (/^(?:javascript:|mailto:|data:|tel:)/i.test(raw)) continue;
    const abs = absUrl(decodeEntities(raw), base);
    if (!abs || !/^https?:\/\//i.test(abs)) continue;
    if (o.host(abs) !== pageHost) continue; // 只认同站，挡掉外链噪声
    if (STATIC_EXT_RE.test(abs)) continue;
    if (EXCLUDE_LINK_RE.test(abs)) continue;
    if (o.isNoise(abs)) continue;
    if (o.include && !o.include.test(abs)) continue;
    if (o.exclude && o.exclude.test(abs)) continue;
    if (o.linkPattern && !o.linkPattern.test(abs)) continue;
    if (seen[abs]) continue;
    seen[abs] = 1;
    out.push(abs);
  }
  return out;
}

/** 按形态聚类，取最大簇，按末位序号排序。空输入返回 []。 */
export function clusterByShape(urls: string[]): string[] {
  if (!urls.length) return [];
  const order: string[] = [];
  const clusters: Record<string, string[]> = {};
  for (let i = 0; i < urls.length; i++) {
    const t = linkTemplate(urls[i]);
    if (!clusters[t]) {
      clusters[t] = [];
      order.push(t);
    }
    clusters[t].push(urls[i]);
  }
  let best: string[] | null = null;
  for (let i = 0; i < order.length; i++) {
    const c = clusters[order[i]];
    if (!best || c.length > best.length) best = c;
  }
  return best ? sortByOrdinal(best) : [];
}

export function safeRe(pat: unknown): RegExp | null {
  if (!pat) return null;
  try {
    return new RegExp(String(pat), "i");
  } catch {
    return null;
  }
}

/** 用户自定义的剧集链接正则（高级逃生舱）；非法正则只告警不抛错。 */
export function buildUserPattern(s: Settings): RegExp | null {
  const raw = s.episodeLinkPattern.trim();
  if (!raw) return null;
  try {
    return new RegExp(raw, "i");
  } catch {
    flux.logger.warn("[m3u8-resolver] episodeLinkPattern 不是合法正则，已忽略:", raw);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Tier-0/1/2 分层判定
// ---------------------------------------------------------------------------

export interface ListingItem {
  url: string;
  name: string;
}

export interface Listing {
  items: ListingItem[];
}

/**
 * 分层判定。返回 `{ items }` 或 null（= 不是剧集，放行走单视频链路）。
 *
 * 最大风险是**误判**：一旦把单视频页判成剧集，用户每次提交链接都会弹出无意义的选集框。
 * 因此只认**强信号**，任何不确定一律返回 null。
 *
 *   Tier-0  提交的是 .m3u8 直链 → 不做清单（resolve 里已分流）
 *   Tier-1  页面内出现 m3u8：质量折叠后只剩 1 组 = 多码率；≥2 组且差异位**全部**像集号 = 剧集
 *   Tier-2  页面内没有 m3u8：命中播放器标记 → 单集页放弃（防「上一集/下一集」误判）；
 *           否则按链接形态聚类，取最大簇，簇大小 ≥ manifestMinItems → 剧集
 */
export function detectListing(pageHtml: string | null, pageUrl: string, s: Settings): Listing | null {
  if (!pageHtml) return null;
  const minItems = s.manifestMinItems;
  const maxItems = Math.max(1, s.manifestMaxItems);

  // ---- Tier-1：页面里直接有 m3u8 ----
  const all = extractAllMasters(pageHtml, pageUrl).filter((u) => !isMediaNoise(u));
  if (all.length) {
    const groups: { key: string; url: string }[] = [];
    const idx: Record<string, number> = {};
    for (let i = 0; i < all.length; i++) {
      const k = canonicalGroupKey(all[i]);
      if (idx[k] === undefined) {
        idx[k] = groups.length;
        groups.push({ key: k, url: all[i] });
      }
    }
    if (groups.length < 2) return null; // 只有一组 = 同一视频的多码率
    if (!groupsDifferByEpisode(groups.map((g) => g.key))) return null;
    return {
    items: groups.slice(0, maxItems).map((g) => ({ url: g.url, name: nameFromUrl(g.url) })),
  };
  }

  // ---- Tier-2：页面里没有 m3u8 ----
  if (PLAYER_MARK_RE.test(pageHtml)) return null; // 单集播放页 → 放弃
  const links = collectEpisodeLinks(pageHtml, pageUrl, minItems, s);
  if (!links) return null;
  return { items: links.slice(0, maxItems).map((u) => ({ url: u, name: nameFromUrl(u) })) };
}

/** Tier-2：页面里没有 m3u8 时，退而求其次找「一批同构的剧集链接」。 */
export function collectEpisodeLinks(html: string, base: string, minItems: number, s: Settings): string[] | null {
  const found = collectLinks(html, base, {
    host: hostKey,
    isNoise: isMediaNoise,
    linkPattern: buildUserPattern(s),
  });
  if (found.length < minItems) return null;
  const best = clusterByShape(found);
  if (!best.length || best.length < minItems) return null;
  return best;
}
