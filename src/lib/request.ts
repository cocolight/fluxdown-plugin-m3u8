import type { OriginHeaders, RequestPatch, ResolveResult } from "fluxdown-plugin-sdk";
import type { Env } from "./env";
import { customHeaders, refererValue } from "./http";
import { parseUrl, safeOrigin } from "./url";
import { base64Utf8 } from "./base64";

/**
 * 请求面：把「抓取清单/分片时要带什么」表达成 `ResolveResult.request`（`RequestPatch`）。
 *
 * ★ M2 变更（2026-11-01）：不再把请求头塞进 `extraHeaders`。三个结构性差别：
 *   1. `extraHeaders` 会**替换**任务请求头表并作用于该任务的全部请求，包括 CDN 主机 ——
 *      凭据因此有跟着分片请求发给第三方 CDN 的风险（v1.8.0 靠手写同源比较挡住「整条
 *      不注入」，挡不住「清单在站内、分片在 CDN」的半泄漏）。
 *      `originHeaders` 是**白名单**语义：只有 origin 精确相等的请求才附加。
 *   2. `referrer` / `userAgent` 由引擎锁定，不会被引擎自身的自适应覆盖，也不会与同名头
 *      互相踩踏。
 *   3. 补丁**每次运行重放、绝不落库**（官方明确），一次性签名链接与临时 Cookie 不进任务记录。
 *
 * 头名的合并优先级与 v1.8.0 完全一致，逐项见 `requestPatch()` 注释。
 */

// ---------------------------------------------------------------------------
// 小而必要的头表工具：HTTP 头名不区分大小写，但保留最后一次写入的拼写
// ---------------------------------------------------------------------------

function pickCI(h: Record<string, string>, name: string): string | undefined {
  const want = name.toLowerCase();
  for (const k in h) {
    if (Object.prototype.hasOwnProperty.call(h, k) && k.toLowerCase() === want) return h[k];
  }
  return undefined;
}

function setCI(h: Record<string, string>, name: string, value: string): void {
  const want = name.toLowerCase();
  for (const k in h) {
    if (Object.prototype.hasOwnProperty.call(h, k) && k.toLowerCase() === want) delete h[k];
  }
  h[name] = value;
}

function takeCI(h: Record<string, string>, name: string): string | undefined {
  const v = pickCI(h, name);
  if (v !== undefined) {
    const want = name.toLowerCase();
    for (const k in h) {
      if (Object.prototype.hasOwnProperty.call(h, k) && k.toLowerCase() === want) delete h[k];
    }
  }
  return v;
}

// ---------------------------------------------------------------------------
// 凭据 → originHeaders
// ---------------------------------------------------------------------------

/**
 * 档案 → 请求头（与宿主 `AuthProfile::apply_to_headers` 同序：Cookie / Bearer / Basic 只取其一，
 * 档案自带的 headers 最后覆盖同名）。
 *
 * 站点键与宿主 `auth::site_key` 同口径（`{scheme}://{host}[:port]`）。这里保留 v1.8.0 的同源闸：
 * 目标与登记站点不同源时**整条不注入**并记日志 —— `originHeaders` 由引擎再兜一层，但显式拒绝
 * 比交给引擎更早给出可诊断的线索（用户看到日志就知道「不是插件没实现，是站点对不上」）。
 */
async function credentialOrigin(env: Env, targetUrl: string): Promise<OriginHeaders | null> {
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

  const headers: Record<string, string> = {};
  if (p.cookies) headers["Cookie"] = String(p.cookies);
  if (p.accessToken) headers["Authorization"] = "Bearer " + String(p.accessToken);
  if (String(p.kind || "").toLowerCase() === "basic" && (p.username || p.password)) {
    headers["Authorization"] = "Basic " + base64Utf8(String(p.username || "") + ":" + String(p.password || ""));
  }
  if (p.headers && typeof p.headers === "object") {
    const extra = p.headers as Record<string, unknown>;
    for (const k in extra) {
      if (Object.prototype.hasOwnProperty.call(extra, k)) headers[k] = String(extra[k]);
    }
  }
  return { origin: site, headers };
}

// ---------------------------------------------------------------------------
// 补丁构造
// ---------------------------------------------------------------------------

/**
 * 生成本次运行的请求补丁。头名优先级（后者覆盖前者，与 v1.8.0 的 `extraHeaders` 同序）：
 *
 *   自动 Referer/Origin  →  `userAgent` / `extraHeadersRaw`  →  任务 `ctx.extraHeaders`
 *
 * `Referer` 与 `User-Agent` 从 `setHeaders` 里摘出来单独放进 `referrer` / `userAgent`
 * （引擎对这两个字段有锁定语义；留同名头在 `setHeaders` 里会形成两个来源，谁生效说不清）。
 * 凭据放 `originHeaders`，且**跳过**用户已显式声明的同名头（保持「用户写的优先」）。
 *
 * 返回 undefined 表示无需任何改写（空补丁不该占字段）。
 */
export async function requestPatch(env: Env, targetUrl: string): Promise<RequestPatch | undefined> {
  const { ctx, s } = env;

  // 1) 基线：userAgent + extraHeadersRaw（多行 `Key: Value`），再叠任务自带的 extraHeaders
  const merged: Record<string, string> = {};
  const base = customHeaders(s);
  for (const k in base) if (Object.prototype.hasOwnProperty.call(base, k)) setCI(merged, k, base[k]);
  const task = ctx.extraHeaders;
  if (task && typeof task === "object") {
    for (const k in task) if (Object.prototype.hasOwnProperty.call(task, k)) setCI(merged, k, String(task[k]));
  }

  // 2) Referer：用户显式声明的优先，否则用自动值（任务 referrer → 原 URL 的 origin）
  let referrer = takeCI(merged, "Referer");
  if (!referrer) referrer = refererValue(env);

  // 3) Origin 取「页面」的来源（浏览器语义），而非下载目标（CDN）的来源
  const origin = takeCI(merged, "Origin") || safeOrigin(referrer) || safeOrigin(ctx.url);

  // 4) User-Agent 单列
  const userAgent = takeCI(merged, "User-Agent") || s.userAgent.trim();

  const patch: RequestPatch = {};
  if (referrer) patch.referrer = referrer;
  if (userAgent) patch.userAgent = userAgent;
  if (origin) merged["Origin"] = origin;

  // 5) 凭据：同源才注入，且不覆盖用户显式写的同名头
  const cred = await credentialOrigin(env, targetUrl);
  if (cred) {
    const keep: Record<string, string> = {};
    for (const k in cred.headers) {
      if (!Object.prototype.hasOwnProperty.call(cred.headers, k)) continue;
      if (pickCI(merged, k) === undefined) keep[k] = cred.headers[k];
    }
    if (Object.keys(keep).length) patch.originHeaders = [{ origin: cred.origin, headers: keep }];
  }

  if (Object.keys(merged).length) patch.setHeaders = merged;

  // 6) Range 上限（M4）：只在下限以上才发。宿主硬性要求 ≥ 64 KiB，低于此值整条补丁会被拒，
  //    所以宁可不发 —— 0 表示关闭，其他过小的值也按关闭处理。
  if (s.rangeCapKb >= 64) patch.maxRangeBytes = s.rangeCapKb * 1024;

  return Object.keys(patch).length ? patch : undefined;
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

/** 单直链返回。请求面一律走 `request` 补丁，不再返回 `extraHeaders`。 */
export async function buildOutput(
  env: Env,
  url: string,
  fileName?: string | null,
  audioUrl?: string | null,
): Promise<ResolveResult> {
  const out: ResolveResult = { url: assertOutputUrl(url, "顶层 url") };
  if (fileName) out.fileName = fileName;
  if (audioUrl) out.audioUrl = assertOutputUrl(audioUrl, "audioUrl");
  const patch = await requestPatch(env, url);
  if (patch) out.request = patch;
  out.rangeSupported = true; // HLS CDN 通常支持 Range → 多线程分段
  out.ephemeral = env.s.ephemeral;
  return out;
}
