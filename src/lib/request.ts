import type { OriginHeaders, RequestPatch, ResolveResult } from "fluxdown-plugin-sdk";
import type { Env } from "./env";
import { customHeaders, refererValue } from "./http";
import { parseUrl, safeOrigin } from "./url";
import { parseCredential } from "./credential";

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
 * 凭据 → 请求头。
 *
 * 来源只有一处：设置项 `authCookie`（解析见 `lib/credential.ts`）。v2.x 早期这条链路是
 * `ctx.authRef → flux.auth.get()`，靠宿主的按站点登录对话框写入档案；那个模型与
 * 「站点无关的全通配解析器」不匹配，已随登录入口一并去掉。
 *
 * 归属站点取**任务自身 URL** 的 origin —— 用户粘贴的就是要下载的地址，它的 origin 天然是
 * 凭据该去的地方。目标与它不同源时**整条不注入**并记日志：清单在站内、分片在 CDN 的常见
 * 形态下，Cookie 不会跟着发给 CDN。
 *
 * 「哪些站点能用这份凭据」另由 `parseCredential` 判断：凭据首行写了 `@站点` 就用它，
 * 没写则继承 `targetHosts`。`targetHosts` 必须从这里传下去 —— 下载补丁这条链路拿不到
 * 设置上下文。
 *
 * `siteUrl` 显式传入而不是从 `env.ctx` 取，是因为 `refresh` 阶段也要复用这套逻辑，而那时
 * 手上只有 `task.sourceUrl`（任务原始地址）、没有 resolver 的 `ctx`。两处语义相同，共用
 * 一份实现才能保证「同一站点算出的凭据一定一样」。
 */
export function credentialOrigin(
  raw: string,
  siteUrl: string,
  targetUrl: string,
  targetHosts?: string,
  quiet?: boolean,
): OriginHeaders | null {
  const text = raw === null || raw === undefined ? "" : String(raw).trim();
  if (!text) return null;

  const site = safeOrigin(siteUrl);
  const target = parseUrl(targetUrl);
  const key = target ? target.origin : "";
  if (!site || !key || site !== key) {
    if (!quiet) {
      flux.logger.info(
        "[m3u8-resolver] 登录凭据归属站点 " +
          (site || "(任务地址无 origin)") +
          " 与下载目标 " +
          (key || targetUrl) +
          " 不同源，未注入",
      );
    }
    return null;
  }

  // 站点约束由 `parseCredential` 统一执行（三条注入链路共用一处判断），这里只取结果。
  // 注意 `parseCredential` 返回 null 有两种原因：格式不可解析，或站点约束不命中。
  // 同源闸已经通过的前提下基本只剩后者，所以日志按「被站点约束挡下」记。
  const cred = parseCredential(text, site, targetHosts);
  if (!cred && !quiet) {
    flux.logger.info(
      "[m3u8-resolver] 登录凭据未能用于 " + site + "（已限定站点或内容为空），未注入",
    );
  }
  return cred ? { origin: cred.origin, headers: cred.headers } : null;
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
  const cred = credentialOrigin(s.authCookie, ctx.url, targetUrl, s.targetHosts);
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
