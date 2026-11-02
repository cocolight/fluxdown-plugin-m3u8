import type { FluxFetchResponse } from "fluxdown-plugin-sdk";
import type { Settings } from "./settings";
import type { Env } from "./env";
import { RESOLVE_FETCH_CAP } from "./env";
import { absUrl, hostKey, safeOrigin } from "./url";
import { parseCredential } from "./credential";
import { extractDash, extractMaster } from "./discovery";
import { IFRAME_SRC_RE, PLAYER_LINK_RE } from "./patterns";

/**
 * 请求面：请求头体系、防抓页挑战、内嵌播放器跟随、带计数闸的抓取入口。
 *
 * 两类「本会失败、直接下成 HTML」的反爬形态，都是纯 HTTP GET + 正则，不需要 JS 引擎：
 *   Part A 防抓页 Cookie 挑战：先返回极小的「安全检查」页，用内联脚本种下 document.cookie
 *          后 location.replace 重载 → 解出该 Cookie，对同一地址重取一次。
 *   Part B 内嵌播放器跟随：页面里没有字面 m3u8，播放器放在 <iframe> 里（maccms 常见）→ 跟进再解析。
 * 两者都严格 fail-closed：解不出 / 跟不到 → 退回原有行为，绝不比现状更差。
 * ★ 天花板：真正的 JS 指纹 / captcha 型挑战无解（无 DOM、无 JS 执行）→ 仍走浏览器扩展。
 */

// ---------------------------------------------------------------------------
// 请求头体系（Referer / Origin / UA / 自定义头）
// ---------------------------------------------------------------------------

/** Referer 精确化：优先任务携带的 referrer（通常是播放页完整 URL），回落站点 origin。 */
export function refererValue(env: Env): string {
  const r = env.ctx.referrer ? String(env.ctx.referrer).trim() : "";
  if (r) return r;
  return safeOrigin(env.ctx.url) || "";
}

/** 用户自定义请求头：userAgent 单列，其余走 extraHeadersRaw（多行 `Key: Value`，`#` 注释）。 */
export function customHeaders(s: Settings): Record<string, string> {
  const h: Record<string, string> = {};
  const ua = s.userAgent.trim();
  if (ua) h["User-Agent"] = ua;
  const raw = s.extraHeadersRaw;
  if (raw) {
    const rawLines = String(raw).split(/\r\n|\r|\n/);
    for (let i = 0; i < rawLines.length; i++) {
      const line = rawLines[i].replace(/[\u0000-\u001F\u007F]/g, "").trim();
      if (!line || line.charAt(0) === "#") continue;
      const p = line.indexOf(":");
      if (p <= 0) continue;
      const k = line.slice(0, p).trim();
      const v = line.slice(p + 1).trim();
      if (k && v) h[k] = v;
    }
  }
  return h;
}

/**
 * 给 flux.fetch 用：Referer + UA + 自定义头 + 登录凭据。
 * manifest / 分片 URL 的抓取也必须带头，否则站方返回的是登录页而非 playlist。
 *
 * 凭据来自设置项 `authCookie`，且**只发给与任务 URL 同源的地址** —— 与下载补丁的
 * `originHeaders` 同一条闸（见 `lib/request.ts`）。清单在站内、分片在 CDN 时，
 * 抓 CDN 的那次不会带上 Cookie。
 */
export function fetchHeaders(env: Env, referer: string, targetUrl?: string): Record<string, string> {
  const h = customHeaders(env.s);
  if (referer) h["Referer"] = referer;
  if (targetUrl) {
    const ck = env.rc.cookies[hostKey(targetUrl)];
    if (ck) h["Cookie"] = mergeCookie(h["Cookie"], ck);

    const cred = credentialFor(env, targetUrl);
    if (cred) {
      for (const k in cred) {
        if (Object.prototype.hasOwnProperty.call(cred, k) && !hasHeaderCI(h, k)) h[k] = cred[k];
      }
    }
  }
  return h;
}

/** 凭据头：仅当目标与任务 URL 同源时返回，否则 null。 */
export function credentialFor(env: Env, targetUrl: string): Record<string, string> | null {
  const raw = env.s.authCookie.trim();
  if (!raw) return null;
  const site = safeOrigin(env.ctx.url);
  const target = safeOrigin(targetUrl);
  if (!site || !target || site !== target) return null;
  const cred = parseCredential(raw, site);
  return cred ? cred.headers : null;
}

function hasHeaderCI(h: Record<string, string>, name: string): boolean {
  const want = name.toLowerCase();
  for (const k in h) {
    if (Object.prototype.hasOwnProperty.call(h, k) && k.toLowerCase() === want) return true;
  }
  return false;
}

/** 合并两个 Cookie 串：按 name 去重（后者覆盖），分号拼接。任一为空则返回另一个。 */
export function mergeCookie(existing: string | null | undefined, add: string | null | undefined): string {
  const a = String(existing == null ? "" : existing).trim();
  const b = String(add == null ? "" : add).trim();
  if (!a) return b;
  if (!b) return a;
  const out: string[] = [];
  const at: Record<string, number> = {};
  const put = (s: string) => {
    const parts = String(s).split(";");
    for (let i = 0; i < parts.length; i++) {
      const seg = parts[i].trim();
      if (!seg) continue;
      const eq = seg.indexOf("=");
      const k = (eq > 0 ? seg.slice(0, eq) : seg).trim().toLowerCase();
      if (!k) continue;
      if (Object.prototype.hasOwnProperty.call(at, k)) out[at[k]] = seg;
      else {
        at[k] = out.length;
        out.push(seg);
      }
    }
  };
  put(a);
  put(b);
  return out.join("; ");
}

// ---------------------------------------------------------------------------
// Part A：防抓页 Cookie 挑战
// ---------------------------------------------------------------------------

// 挑战页体积极小（实测 599 字节），且必含 eval([…].map(…String.fromCharCode(c^K)…))。
// 体积极小是重要判据：正常页面不会这么小，而大页面里偶然出现该片段无害（仅多一次重取）。
const CHALLENGE_MAX_BYTES = 8192;
const CHALLENGE_MAX_CODES = 20000; // 解码数组长度上限，防超大脚本
// 宽松匹配：变量名 / 空白 / 箭头函数 / 十六进制 key 均可变
//   eval([105,98,…].map(function(c){return String.fromCharCode(c^13);}).join(""))
const EVAL_XOR_RE =
  /eval\s*\(\s*\[([\d,\s]+)\]\s*\.\s*map\s*\(\s*(?:function\s*\(\s*\w+\s*\)\s*\{\s*return\s+|\w+\s*=>\s*(?:\{\s*return\s+)?)String\.fromCharCode\s*\(\s*\w+\s*\^\s*(0[xX][0-9a-fA-F]+|\d+)\s*\)/i;

function looksLikeChallenge(body: string | null): boolean {
  if (!body) return false;
  const s = String(body);
  if (s.length > CHALLENGE_MAX_BYTES) return false;
  if (/#EXTM3U/i.test(s)) return false; // 已经是 playlist，不是挑战页
  const m = s.match(EVAL_XOR_RE);
  if (!m) return false;
  return m[1].split(",").length <= CHALLENGE_MAX_CODES;
}

function decodeEvalXor(html: string | null): string | null {
  if (!html) return null;
  const m = String(html).match(EVAL_XOR_RE);
  if (!m) return null;
  const parts = m[1].split(",");
  if (!parts.length || parts.length > CHALLENGE_MAX_CODES) return null;
  const kv = m[2];
  const k = kv.charAt(0) === "0" && (kv.charAt(1) === "x" || kv.charAt(1) === "X") ? parseInt(kv, 16) : parseInt(kv, 10);
  if (!isFinite(k)) return null;
  let out = "";
  for (let i = 0; i < parts.length; i++) {
    const t = parts[i].trim();
    if (!t) continue;
    const n = parseInt(t, 10);
    if (!isFinite(n) || n < 0) return null;
    out += String.fromCharCode(n ^ k);
  }
  return out;
}

// 从解出的 JS 里取 document.cookie="name=value;path=…" 的 name=value
const COOKIE_ASSIGN_RE = /document\s*\.\s*cookie\s*=\s*["'`]([^"'`]+)["'`]/i;

function extractCookieAssignment(js: string | null): string | null {
  if (!js) return null;
  const m = String(js).match(COOKIE_ASSIGN_RE);
  if (!m) return null;
  const pair = String(m[1]).split(";")[0].trim(); // 剥掉 ;path / ;max-age 等属性
  const eq = pair.indexOf("=");
  if (eq <= 0 || eq >= pair.length - 1) return null; // name / value 均须非空
  return pair;
}

/** 一站式：挑战页 → `{ cookie }`，解不出返回 null。 */
export function solveChallenge(body: string | null): { cookie: string } | null {
  if (!looksLikeChallenge(body)) return null;
  const js = decodeEvalXor(body);
  if (!js) return null;
  const cookie = extractCookieAssignment(js);
  if (!cookie) return null;
  return { cookie };
}

// ---------------------------------------------------------------------------
// Part B：内嵌播放器（iframe / maccms player_data）跟随
// ---------------------------------------------------------------------------

function isFollowableUrl(u: string | null | undefined): boolean {
  const s = String(u == null ? "" : u).trim();
  if (!s) return false;
  if (/^(?:javascript|about|data|blob|mailto|tel):/i.test(s)) return false;
  if (s.charAt(0) === "#") return false;
  return /^https?:\/\//i.test(s);
}

/** 页面内的播放器地址：① `<iframe src>`（同站优先） ② maccms player_data 的 `"link"` 兜底。 */
export function findPlayTarget(html: string | null, base: string): string | null {
  if (html) {
    const s = String(html);
    const cands: string[] = [];
    IFRAME_SRC_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = IFRAME_SRC_RE.exec(s))) {
      const raw = String(m[1]).replace(/\\\//g, "/").trim();
      // ★ 必须在绝对化**之前**排除伪协议：否则 absUrl 会把 javascript:void(0) 当成相对路径，
      //   拼成 https://host/javascript:void(0) 这类垃圾地址（且它反过来能通过 isFollowableUrl）。
      if (!raw || raw.charAt(0) === "#" || /^(?:javascript|about|data|blob|mailto|tel):/i.test(raw)) continue;
      const abs = absUrl(raw, base);
      if (isFollowableUrl(abs)) cands.push(abs);
    }
    if (cands.length) {
      const bh = hostKey(base); // 跨站 iframe 多为广告 / 统计，同站的才是播放器
      for (let i = 0; i < cands.length; i++) if (hostKey(cands[i]) === bh) return cands[i];
      return cands[0];
    }
  }
  if (!html) return null;
  const m = String(html).match(PLAYER_LINK_RE);
  if (!m) return null;
  const abs = absUrl(String(m[1]).replace(/\\\//g, "/"), base);
  return isFollowableUrl(abs) ? abs : null;
}

export interface FollowHit {
  m3u8?: string;
  mpd?: string;
  referer: string;
}

/** 有界跟随：抓播放页 → extractMaster；未命中则再深一层（受 iframeMaxFollow 限制）。 */
export async function followIframe(
  env: Env,
  pageHtml: string,
  pageUrl: string,
  depth: number,
): Promise<FollowHit | null> {
  const max = Math.max(1, Math.min(3, env.s.iframeMaxFollow));
  if (depth >= max) return null;
  const target = findPlayTarget(pageHtml, pageUrl);
  if (!target || target === pageUrl) return null; // 自指防环
  if (env.rc.fetches >= RESOLVE_FETCH_CAP) return null;
  let r;
  try {
    r = await smartFetch(env, target, pageUrl); // Referer = 嵌入页
  } catch (e) {
    flux.logger.warn("[m3u8-resolver] 跟随内嵌播放器失败:", String(e));
    return null;
  }
  if (!r || r.status !== 200 || !r.body) return null;
  const found = extractMaster(r.body, target);
  if (found) return { m3u8: found, referer: target };
  // DASH 发现层：内嵌播放页里没有 m3u8 但可能有 .mpd → 同一分支一并试
  if (env.s.detectDash) {
    const mpd = extractDash(r.body, target);
    if (mpd) return { mpd, referer: target }; // 由调用方按 .mpd 直接返回（不读内容）
  }
  return await followIframe(env, r.body, target, depth + 1);
}

// ---------------------------------------------------------------------------
// 统一抓取入口
// ---------------------------------------------------------------------------

/**
 * 若 `first` 是防抓页挑战，解出 Cookie 带同一份 headers 对同一 URL 重取一次；否则原样返回。
 *
 * 为什么单独抽出来：订阅 provider（`entry/subscribe.ts`）也被同一批站点挡在防抓页后面，
 * 但它不走 `smartFetch` —— 它的请求头来自**订阅源自己的** `cookies` / `userAgent`（引擎按
 * 订阅设置喂进来），与 `fetchHeaders` 那套「任务 URL 同源凭据」是两套语义，不能混。
 * 所以这里只负责「识别挑战 → 解 Cookie → 带同一份 headers 重取」，headers 由调用方决定。
 *
 * 纪律（与 smartFetch 一致，不许放宽）：
 *   · 只重取**一次**，不循环 —— 解出 Cookie 后仍被拦，就当失败返回，绝不进死循环。
 *   · 解不出 Cookie 时原样返回首个响应：fail-closed，绝不比不处理更差。
 *   · `onSolved` 让调用方把 Cookie 回填到自己那套容器（resolver 用 rc.cookies，订阅不用回填）。
 *
 * 调用方**必须**先自己判定「确实是挑战」再进来（`solveChallenge` 非空），这样它能在
 * 真正要发第二次请求时才消耗自己的预算 / 计数名额。
 */
export async function retryWithChallenge(
  url: string,
  headers: Record<string, string>,
  first: FluxFetchResponse,
  onSolved?: (cookie: string) => void,
): Promise<FluxFetchResponse> {
  const sol = solveChallenge(first && first.body);
  if (!sol || !hostKey(url)) return first;
  if (onSolved) onSolved(sol.cookie);
  flux.logger.info("[m3u8-resolver] 命中防抓页校验，已解出 Cookie 并对同一地址重取");
  return await flux.fetch({ url, headers: mergeIntoHeaders(headers, "Cookie", sol.cookie) });
}

/** 把一段 Cookie 并进 headers 的现有 Cookie 值（其余头原样保留，不修改入参）。 */
function mergeIntoHeaders(headers: Record<string, string>, name: string, value: string): Record<string, string> {
  const out: Record<string, string> = {};
  let merged = false;
  for (const k in headers) {
    if (!Object.prototype.hasOwnProperty.call(headers, k)) continue;
    if (k.toLowerCase() === name.toLowerCase()) {
      out[k] = mergeCookie(headers[k], value);
      merged = true;
    } else {
      out[k] = headers[k];
    }
  }
  if (!merged) out[name] = value;
  return out;
}

/** 带请求头 + 计数闸；命中挑战则解 Cookie 并对同一 URL 重取一次（不循环）。 */
export async function smartFetch(env: Env, url: string, referer: string): Promise<FluxFetchResponse> {
  const rc = env.rc;
  if (rc.fetches >= RESOLVE_FETCH_CAP) throw new Error("resolve 抓取次数超上限 " + RESOLVE_FETCH_CAP);
  rc.fetches++;
  const r = await flux.fetch({ url, headers: fetchHeaders(env, referer, url) });
  if (!env.s.solveChallenge) return r;
  if (!r || r.status !== 200 || !r.body) return r;
  if (!solveChallenge(r.body)) return r; // 没有挑战就不扣重取名额
  const host = hostKey(url);
  if (!host) return r;
  if (rc.fetches >= RESOLVE_FETCH_CAP) throw new Error("resolve 抓取次数超上限 " + RESOLVE_FETCH_CAP);
  rc.fetches++;
  return await retryWithChallenge(url, fetchHeaders(env, referer, url), r, (cookie) => {
    rc.cookies[host] = mergeCookie(rc.cookies[host], cookie);
  });
}
