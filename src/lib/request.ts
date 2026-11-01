import type { ResolveResult } from "fluxdown-plugin-sdk";
import type { Env } from "./env";
import { customHeaders, refererValue } from "./http";
import { parseUrl, safeOrigin } from "./url";

/**
 * 交给引擎下载的地址与请求头。
 *
 * ★ 本文件整体是 **M2 的退役目标**：v0.5.8 起 `resolve()` 返回值有 `request: RequestPatch`
 *   （cookies / originHeaders / referrer / userAgent / setHeaders），由引擎「每次运行重放、
 *   不落库」。届时 `authHeadersAsync` 与 `b64encode` 一起删除。
 *
 * 保留原因（v1.8.0 已核实 native/engine/src/plugin/bridge.rs）：宿主**只在 `flux.fetch` 内**
 * 调用 `AuthProfile::apply_to_headers`，下载链路（playlist / 分片 / KEY）拿不到插件的认证
 * 档案 —— 所以 M1 仍必须由插件把凭据并进 extraHeaders，否则表现为「解析成功却 403」。
 */

const B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** 沙箱无 btoa（QuickJS 全局对象实测），Basic 的 base64 只能手写。TODO(M2)：实测 btoa 后删除。 */
function b64encode(s: string): string {
  const str = String(s == null ? "" : s);
  const bytes: number[] = [];
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c < 0x80) bytes.push(c);
    else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      const cp = 0x10000 + ((c - 0xd800) << 10) + (str.charCodeAt(++i) - 0xdc00);
      bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    } else bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : -1;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : -1;
    out += B64_CHARS[b0 >> 2];
    out += B64_CHARS[((b0 & 3) << 4) | (b1 < 0 ? 0 : b1 >> 4)];
    out += b1 < 0 ? "=" : B64_CHARS[((b1 & 15) << 2) | (b2 < 0 ? 0 : b2 >> 6)];
    out += b2 < 0 ? "=" : B64_CHARS[b2 & 63];
  }
  return out;
}

function hasHeaderCI(h: Record<string, string>, name: string): boolean {
  const want = String(name).toLowerCase();
  for (const k in h) {
    if (Object.prototype.hasOwnProperty.call(h, k) && k.toLowerCase() === want) return true;
  }
  return false;
}

/**
 * 档案 → 请求头（与宿主 `AuthProfile::apply_to_headers` 同序：Cookie / Bearer / Basic 只取其一，
 * 档案自带的 headers 最后覆盖同名）。返回 null 表示本次不注入。
 *
 * 站点键与宿主 `auth::site_key` 同口径（`{scheme}://{host}[:port]`）。这里必须自己补上同源闸，
 * 否则 Cookie 会跟着 CDN 主机一起发出去 —— 宿主在 `flux.fetch` 里本就做同源检查，
 * 而插件把凭据复制进 extraHeaders 绕开了那道检查。
 */
async function authProfileHeaders(env: Env, targetUrl: string): Promise<Record<string, string> | null> {
  const authRef = env.ctx.authRef ? String(env.ctx.authRef) : "";
  if (!authRef) return null;
  if (!flux.auth || typeof flux.auth.get !== "function") return null; // 未授予 auth 权限
  let p: Record<string, unknown> | null = null;
  try {
    p = (await flux.auth.get(authRef)) as Record<string, unknown> | null;
  } catch (e) {
    flux.logger.warn("[m3u8-resolver] 读取认证凭据失败，本次不带凭据:", String(e));
    return null;
  }
  if (!p || typeof p !== "object") return null;

  const site = String(p.site || "");
  const target = parseUrl(targetUrl);
  const key = target ? target.origin : "";
  if (!site || !key || site !== key) {
    // 跨站点不注入（含 CDN 主机）。确需跨主机带凭据者用 extraHeadersRaw 手工指定 ——
    // 那条路径是用户显式声明，不参与这道同源检查。
    flux.logger.info(
      "[m3u8-resolver] 认证凭据站点 " + (site || "(空)") + " 与下载目标 " + (key || targetUrl) + " 不同源，未注入",
    );
    return null;
  }

  const ph: Record<string, string> = {};
  if (p.cookies) ph["Cookie"] = String(p.cookies);
  if (p.accessToken) ph["Authorization"] = "Bearer " + String(p.accessToken);
  if (String(p.kind || "").toLowerCase() === "basic" && (p.username || p.password)) {
    ph["Authorization"] = "Basic " + b64encode(String(p.username || "") + ":" + String(p.password || ""));
  }
  if (p.headers && typeof p.headers === "object") {
    const extra = p.headers as Record<string, unknown>;
    for (const k in extra) {
      if (Object.prototype.hasOwnProperty.call(extra, k)) ph[k] = String(extra[k]);
    }
  }
  return ph;
}

/**
 * 下载引擎用的请求头。顺序（后者不覆盖前者）：
 *   自动 Referer/Origin → extraHeadersRaw/userAgent → 任务 extraHeaders → 认证凭据（同源 + 无同名头）。
 */
export async function authHeadersAsync(env: Env, targetUrl: string): Promise<Record<string, string>> {
  const extra: Record<string, string> = {};
  const ref = refererValue(env);
  if (ref) extra["Referer"] = ref;
  // Origin 取「页面」的来源（浏览器语义），而非 CDN 的来源
  const org = safeOrigin(ref) || safeOrigin(env.ctx.url);
  if (org) extra["Origin"] = org;

  const ch = customHeaders(env.s);
  for (const k in ch) if (Object.prototype.hasOwnProperty.call(ch, k)) extra[k] = ch[k];

  // 任务自带的 extraHeaders 优先级最高
  const raw = env.ctx.extraHeaders;
  if (raw) {
    for (const k in raw) if (Object.prototype.hasOwnProperty.call(raw, k)) extra[k] = raw[k];
  }

  const ph = await authProfileHeaders(env, targetUrl);
  if (ph) {
    for (const k in ph) {
      if (Object.prototype.hasOwnProperty.call(ph, k) && !hasHeaderCI(extra, k)) extra[k] = ph[k];
    }
  }
  return extra;
}

// ---------------------------------------------------------------------------
// 输出边界校验
// ---------------------------------------------------------------------------

/**
 * 引擎侧校验（manager.rs::check_output_url）是 `url.split(':').next()` 取 scheme，不在
 * {http,https,ftp,magnet,ed2k} 白名单即整体拒绝本次 resolve。我们宁可在此给出**可读的**错误，
 * 也不要让引擎抛「url scheme 不允许: video/avc1/6/media.m3u8」这种难以定位的报错 ——
 * 后者正是本插件历史上的故障表现。
 */
const OUTPUT_SCHEMES: Record<string, number> = { http: 1, https: 1, ftp: 1, magnet: 1, ed2k: 1 };

export function assertOutputUrl(u: string | null | undefined, what: string): string {
  if (!u) return u as string;
  const s = String(u);
  // 与引擎同口径地取 scheme（第一个 ':' 之前）再比对白名单。
  // 不能只认 `scheme://` —— magnet:/ed2k: 没有 `//` 但合法。
  const ci = s.indexOf(":");
  const scheme = ci > 0 ? s.slice(0, ci).toLowerCase() : "";
  if (OUTPUT_SCHEMES[scheme]) return u as string;
  throw new Error(
    (what || "URL") +
      " 不是合法绝对地址（scheme=" +
      (scheme || "空") +
      "）: " +
      s.slice(0, 200) +
      " —— 通常意味着 playlist 里的相对路径未被成功绝对化，请附上该源地址反馈。",
  );
}

/** 单直链返回（v1.8.0 的 resolver::finalize）。M2 起改为返回 `request` 补丁。 */
export async function buildOutput(
  env: Env,
  url: string,
  fileName?: string | null,
  audioUrl?: string | null,
): Promise<ResolveResult> {
  const out: ResolveResult = { url: assertOutputUrl(url, "顶层 url") };
  if (fileName) out.fileName = fileName;
  if (audioUrl) out.audioUrl = assertOutputUrl(audioUrl, "audioUrl");
  out.extraHeaders = await authHeadersAsync(env, url);
  out.rangeSupported = true; // HLS CDN 通常支持 Range → 多线程分段
  out.ephemeral = env.s.ephemeral;
  return out;
}
