/**
 * `refresh` 阶段 —— 401/403/410 时重新取一次凭据并下发。
 *
 * 为什么值得做：视频站的清单地址常常带签名（`?token=…&expires=…`），下载到一半过期，
 * 引擎收到 401/403 后整个任务失败。resolver 是**下载前**跑一次的，那时签名还有效；等到
 * 过期时已经没有 resolver 的机会了。`refresh` 是唯一能在这个时刻补一次的钩子。
 *
 * ## 能做到什么，做不到什么
 *
 * SDK 对 `RefreshPatch` 的约束（`types/flux.d.ts`）：
 *
 *   > `url` is only allowed for HTTP tasks (same host, same protocol class).
 *
 * 我们的任务是 HLS / DASH，**不是** HTTP 任务，所以**改不了地址** —— 「换一条带新签名的
 * 清单 URL」这条路在契约层面就被封死了。能下发的只有 `cookies` / `setHeaders` /
 * `referrer` / `userAgent`。
 *
 * 因此本模块只做一件有实际意义的事：**重新访问任务原始地址，把这一次响应里新种下的
 * Cookie 取出来下发**。典型场景是站点在拒绝时顺手刷新了会话（`Set-Cookie`），或者原地址
 * 重定向后换了鉴权 cookie。做不到的事（重新签名、重新登录）明确不做，也不假装做了。
 *
 * ## 三条纪律
 *
 *   1. **只重取一次**。`refreshCount` 由引擎给，> 0 就不再动作 —— 否则「取凭据 → 又被拒 →
 *      再取凭据」会变成一个延迟很长的死循环，用户看到的是任务卡住（不报错也不动）。
 *   2. **不降级凭据**。新 Cookie 与旧 Cookie 合并（按 name 覆盖），不整串替换；取不到就
 *      返回 null，绝不返回空补丁把引擎原有的凭据抹掉。
 *   3. **失败即放手**。重新访问抛错、返回非 2xx、没取到新 Cookie，一律返回 null。
 *      refresh 是补救，不能变成新的失败点。
 */

import type { FluxFetchResponse, RefreshPatch } from "fluxdown-plugin-sdk";
import { newEnv, type Env } from "./env";
import { fetchHeaders, mergeCookie, retryWithChallenge } from "./http";
import { readSettings } from "./settings";
import type { InterceptTaskLike } from "./task";

/**
 * 用拦截器的 `task` 拼一个最小 `Env`。
 *
 * `ctx.url` 在 resolver 里是**任务原始地址**，凭据同源闸按它的 origin 判断归属；
 * 拦截器侧的等价物是 `task.sourceUrl`（任务持久化的原始地址），不是 `task.url`
 * （后者是 resolver 改写后的下载地址，可能已经是 CDN 主机 —— 用它判断同源会让
 * 凭据该发的地方判成不同源）。
 */
export function envFromTask(task: InterceptTaskLike): Env {
  const settings = readSettings();
  return newEnv(
    {
      taskId: task && task.id ? String(task.id) : "",
      url: task && task.sourceUrl ? String(task.sourceUrl) : "",
      authRef: "",
      cookies: "",
      referrer: "",
      userAgent: "",
      extraHeaders: {},
      resolverItem: "",
    },
    settings,
  );
}

/**
 * 从响应头里取全部 `Set-Cookie`。
 *
 * `flux.fetch` 的 `headers` 是普通对象，同名的多条 `Set-Cookie` 合并策略由宿主决定 ——
 * 可能是逗号拼接，也可能只留最后一条。两种都得能处理：按逗号切分时只在「后面像一个新的
 * name=value」时才切，避免把 `Expires=Wed, 21 Oct 2026 07:28:00 GMT` 里的逗号也当分隔符。
 */
export function cookiesFromHeaders(headers: Record<string, string> | null | undefined): string {
  if (!headers || typeof headers !== "object") return "";
  let raw = "";
  for (const k in headers) {
    if (!Object.prototype.hasOwnProperty.call(headers, k)) continue;
    if (k.toLowerCase() === "set-cookie") {
      raw = String(headers[k] || "");
      break;
    }
  }
  if (!raw) return "";

  const pairs: string[] = [];
  // 逗号可能是 Cookie 分隔符，也可能是 Expires 里的日期分隔符。判据：逗号之后紧跟着
  // `token=`（合法 cookie name 不含空格与分号）时才当分隔符。
  const parts = raw.split(/,(?=\s*[A-Za-z0-9_\-.#$%]+\s*=)/);
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i].trim();
    if (!seg) continue;
    const eq = seg.indexOf("=");
    if (eq <= 0) continue;
    const name = seg.slice(0, eq).trim();
    if (!name || /[\s;]/.test(name)) continue;
    // 值只取到第一个分号之前（后面是 Path / Domain / Expires 等属性）
    const rest = seg.slice(eq + 1);
    const semi = rest.indexOf(";");
    const value = (semi >= 0 ? rest.slice(0, semi) : rest).trim();
    if (!value) continue;
    pairs.push(name + "=" + value);
  }
  return pairs.join("; ");
}

/** refresh 的结果：要么一份补丁，要么 null（不干预）。 */
export type RefreshOutcome = RefreshPatch | null;

/**
 * 重新取一次凭据。
 *
 * @param env          最小 Env（`ctx.url` 必须是任务**原始**地址，凭据同源闸靠它）
 * @param refusedUrl   被拒的那次请求地址（仅用于日志，不参与判定）
 * @param status       拒绝状态码（401/403/410）
 * @param refreshCount 本次运行已成功换发过几次
 */
export async function refreshCredentials(
  env: Env,
  refusedUrl: string,
  status: number,
  refreshCount: number,
): Promise<RefreshOutcome> {
  // 纪律 1：只换发一次。
  if (typeof refreshCount === "number" && refreshCount >= 1) return null;

  const site = env.ctx.url;
  if (!site) return null;

  try {
    const headers = fetchHeaders(env, "", site);

    flux.logger.warn(`[m3u8-resolver] 请求被拒（${status}），重新访问任务地址取新凭据`);

    const first = await flux.fetch({ method: "GET", url: site, headers });
    // 防抓页可能也在这时触发：解一次挑战再取，与 resolver 侧同一套逻辑。
    const res: FluxFetchResponse = await retryWithChallenge(site, headers, first);

    // 纪律 3：非 2xx 不算「取到凭据」，放手。
    if (!res || typeof res.status !== "number" || res.status < 200 || res.status >= 300) {
      flux.logger.info(`[m3u8-resolver] 重新访问返回 ${res ? res.status : "无响应"}，不换发凭据`);
      return null;
    }

    const fresh = cookiesFromHeaders(res.headers);
    if (!fresh) {
      flux.logger.info("[m3u8-resolver] 重新访问未取到新 Cookie，不换发凭据");
      return null;
    }

    // 纪律 2：与现有 Cookie 合并，不整串替换。
    const existing = (headers && headers["Cookie"]) || "";
    const merged = mergeCookie(existing, fresh);

    // 只有真的变了才下发 —— 不变的补丁等于没补，徒增一次审计记录。
    if (merged === existing) {
      flux.logger.info("[m3u8-resolver] 新 Cookie 与现有值一致，不换发凭据");
      return null;
    }

    const patch: RefreshPatch = {};
    if (merged) patch.cookies = merged;
    if (headers && headers["Referer"]) patch.referrer = headers["Referer"];
    if (headers && headers["User-Agent"]) patch.userAgent = headers["User-Agent"];

    flux.logger.info(
      `[m3u8-resolver] 已换发凭据（新 Cookie ${fresh.split(";").length} 项），将重试被拒的 ${shortUrl(refusedUrl)}`,
    );
    return Object.keys(patch).length ? patch : null;
  } catch (e) {
    // 纪律 3：refresh 自己出错不得连累任务。
    flux.logger.warn("[m3u8-resolver] 换发凭据失败（不影响任务本身）:", String(e));
    return null;
  }
}

function shortUrl(u: string): string {
  const s = String(u || "");
  return s.length > 80 ? s.slice(0, 77) + "..." : s;
}
