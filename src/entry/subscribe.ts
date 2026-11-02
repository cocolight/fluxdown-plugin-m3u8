import type { SubscribeContext, SubscribeItem, SubscribeResult } from "fluxdown-plugin-sdk";
import { install } from "../lib/install";
import { decodeEntities } from "../lib/text";
import { fnv1a32 } from "../lib/hash";
import { hostWithPort, parseUrl } from "../lib/url";
import { MEDIA_NOISE_RE, PLAYER_MARK_RE } from "../lib/patterns";
import { clusterByShape, collectLinks, safeRe } from "../lib/discovery";
import { retryWithChallenge } from "../lib/http";

/**
 * 订阅 provider —— 入口固定为 `globalThis.subscribe(ctx)`，返回值交给核心的统一订阅状态机
 * （插件不碰订阅表、不建任务）。ctx = { providerId, sourceId, url, providerConfig, cookies, userAgent }。
 *
 * 返回值是**对象**，不是 JSON 字符串：宿主 wrapper 会 JSON.stringify 后按 SubscriptionOutput
 * 反序列化（native/engine/src/plugin/quickjs.rs）。
 *
 * 契约（已核实 native/engine/src/plugin/manager.rs::validate_subscription_item）：
 *   · items ≤ 1000；guid 非空 ≤2048；title ≤1024；resolverItem ≤2048
 *   · link / enclosureUrl 至少一个非空，且都要过 check_output_url（scheme 白名单）
 *   · 含 resolverItem 时 link 必须非空；enclosureLength 非负
 *   · 单条非法 → 跳过并记日志；**全部**非法 → 整批报错
 *
 * providerConfig（JSON 字符串）为用户逃生舱，全部可选：
 *   { "minItems": 2, "maxItems": 200, "linkPattern": "\\/vodplay\\/\\d+-\\d+-(\\d+)",
 *     "include": "vodplay", "exclude": "preview" }
 *   minItems 默认 2（**比 resolver 的 manifestMinItems=3 宽松**）：订阅地址是用户主动配置的，
 *   不该像「自动识别任意提交链接」那样保守；但 1 条构成不了「追更」，故不默认 1。
 *
 * ⚠️ 预告/花絮的剔除在订阅侧按**整条 URL** 判断（看链接文字会误伤），与 resolver 侧只看
 *    pathname 的口径不同 —— 这是 v1.8.0 的既有差异，M1 原样保留（见 discovery.ts::collectLinks）。
 *
 * ★ guid 稳定性决定了「追更去重」是否正确：host + pathname 的 FNV-1a 32 位，**刻意丢掉 query**
 *   （CDN 签名/追踪参数会让同一条目每次 guid 都不同，导致重复建任务）。
 */

function linkTitleFor(url: string): string {
  const p = parseUrl(url);
  const path = String(p ? p.pathname : url);
  const ms = path.match(/\d{1,6}/g);
  if (ms && ms.length) return "EP" + ms[ms.length - 1];
  const seg = path.split("/").filter(Boolean).pop() || "item";
  return seg;
}

/** 去重键：host + pathname（丢 query）。feed 内碰撞时并入 query 的 FNV 值消解。 */
function makeGuid(used: Record<string, number>, url: string): string {
  const p = parseUrl(url);
  const stem = "m3u8-" + (p ? fnv1a32(p.host + p.pathname) : fnv1a32(url));
  if (!used[stem]) {
    used[stem] = 1;
    return stem;
  }
  const alt = stem + "-" + (p ? fnv1a32(p.search) : fnv1a32(url + "#"));
  used[alt] = 1;
  return alt;
}

interface ProviderConfig {
  minItems?: unknown;
  maxItems?: unknown;
  include?: unknown;
  exclude?: unknown;
  linkPattern?: unknown;
}

async function subscribe(ctx: SubscribeContext): Promise<SubscribeResult> {
  const url = String(ctx.url || "").trim();
  if (!url) throw new Error("订阅地址为空");

  let cfg: ProviderConfig = {};
  const rawCfg = String(ctx.providerConfig || "").trim();
  if (rawCfg) {
    try {
      const parsed = JSON.parse(rawCfg);
      if (parsed && typeof parsed === "object") cfg = parsed as ProviderConfig;
    } catch {
      // providerConfig 是自由文本，填错不应让整条订阅失败 —— 记日志后按默认跑。
      flux.logger.warn("[m3u8-subscribe] providerConfig 不是合法 JSON，已忽略:", rawCfg.slice(0, 200));
    }
  }

  const headers: Record<string, string> = {};
  if (ctx.userAgent) headers["User-Agent"] = String(ctx.userAgent);
  if (ctx.cookies) headers["Cookie"] = String(ctx.cookies);

  const res0 = await flux.fetch({ method: "GET", url, headers });
  // 防抓页：订阅站与下载站是同一批站点，一样会被「安全检查」页挡下 —— 不解的话这里只会
  // 解析出一个空 feed，而且用户完全看不出是被拦了。只重取一次，解不出就按原样走。
  // 注意 `retryWithChallenge` 命中时会自己记一条日志，这里不重复记。
  const res = await retryWithChallenge(url, headers, res0);
  if (res.status < 200 || res.status >= 300) throw new Error("订阅抓取失败 HTTP " + res.status);
  const html = String(res.body || "");

  // 命中播放器标记 → 这是单集播放页，不是列表页。返回空 feed 而不是把「上一集/下一集」
  // 当成两集推给用户（宁可空，不可错）。
  if (PLAYER_MARK_RE.test(html)) {
    flux.logger.info("[m3u8-subscribe] 页面含播放器标记，判定为单集页，返回空 feed");
    return { title: "", link: url, items: [] };
  }

  const minItems = Math.max(1, parseInt(String(cfg.minItems), 10) || 2);
  const maxItems = Math.max(1, Math.min(1000, parseInt(String(cfg.maxItems), 10) || 200));

  let links = clusterByShape(
    collectLinks(html, url, {
      host: hostWithPort,
      isNoise: (u) => MEDIA_NOISE_RE.test(u),
      include: safeRe(cfg.include),
      exclude: safeRe(cfg.exclude),
      linkPattern: safeRe(cfg.linkPattern),
    }),
  );
  if (links.length < minItems) {
    flux.logger.info(
      "[m3u8-subscribe] 同构条目 " + links.length + " 条，低于 minItems=" + minItems + "，返回空 feed",
    );
    links = [];
  }
  if (links.length > maxItems) links = links.slice(0, maxItems);

  const titleM = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleM ? decodeEntities(titleM[1]).replace(/\s+/g, " ").trim().slice(0, 200) : "";

  const used: Record<string, number> = {};
  const items: SubscribeItem[] = [];
  for (let i = 0; i < links.length; i++) {
    const link = links[i];
    items.push({
      guid: makeGuid(used, link),
      title: linkTitleFor(link),
      link,
      enclosureUrl: "",
      // 精确规格：引擎建任务时 url=link、resolver_item=该值，走 resolver 的二段解析。
      resolverItem: "u:" + link,
      enclosureLength: 0,
      pubDate: 0,
    });
  }

  flux.logger.info("[m3u8-subscribe] 产出 " + items.length + " 条（源 " + url + "）");
  return { title, link: url, items };
}

install("subscribe", subscribe);
