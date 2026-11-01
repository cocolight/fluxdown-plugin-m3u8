import type { ResolveContext, ResolveResult, ResolveVariant } from "fluxdown-plugin-sdk";
import type { ResolveCtx } from "../types";
import type { Env } from "../lib/env";
import type { Listing } from "../lib/discovery";
import type { Variant } from "../lib/hls";
import type { Settings } from "../lib/settings";
import type { AudioOptions } from "../lib/audio";
import { newEnv } from "../lib/env";
import { readSettings } from "../lib/settings";
import { install } from "../lib/install";
import { markHandled } from "../lib/handled";
import { assertOutputUrl, buildOutput, requestPatch } from "../lib/request";
import { followIframe, refererValue, smartFetch } from "../lib/http";
import { audioSourceFor } from "../lib/audio";
import {
  applyNameTemplate,
  GENERIC_NAME_RE,
  nameFor,
  nameFromUrl,
  partsFor,
  safeFileName,
  sanitizeAssetName,
  uniqueName,
} from "../lib/naming";
import { decodeItem, encodeItem } from "../lib/items";
import { detectListing, extractDash, extractMaster, extractTitle, warnNoTitle } from "../lib/discovery";
import { parseUrl } from "../lib/url";
import { sanitize } from "../lib/text";
import {
  isAudioOnlyVariant,
  isDashUrl,
  isManifestUrl,
  isMediaPlaylist,
  isPlaylistBody,
  isPlaylistUrl,
  looksLikeHtml,
  noteEncryption,
  parseMaster,
  pickVariant,
} from "../lib/hls";

/**
 * resolver 入口 —— 决定「下什么」。
 *
 * 迁移自 v1.8.0 `resolver.js`（1768 行单文件）。本文件只保留**主流程编排**，其余拆到 `lib/*`。
 * 行为与 1.8.0 **逐字等价**：`npm run parity` 会用同一批 fixture 跑旧实现（tests/legacy/）与新
 * 构建产物（dist/），逐条比对返回值与日志。
 *
 * ⚠️ 能力边界（已对照官方 API 参考核实，勿再当作"待补"）：
 *   - 字幕：resolver 返回值无字幕字段，且 ffmpeg 沙箱只认产物目录内的相对名、flux.fs 是另一个
 *     独立工作区 → 单层不可行。这里只记录字幕轨（subtitleRenditions），不下载。
 *   - 任务分组：插件不创建任务；返回多文件清单（resolvers[0].multi=true），由**引擎**裂变建组。
 *   - SAMPLE-AES / FairPlay / Widevine、LL-HLS(#EXT-X-PART)、真直播无限录制：核心层能力。
 *   - onMetaProbed：带 resolver 的插件该钩子永不触发（官方明确），故 manifest 不订阅。
 *   - 认证凭据：M2 起经 `request.originHeaders` 交给引擎，按 origin 白名单附加到下载请求
 *     （插件自己抓取时仍由宿主在 `flux.fetch` 内注入），不再写进 `extraHeaders`。
 */

async function marked(env: Env, obj: ResolveResult | null): Promise<ResolveResult | null> {
  if (obj) await markHandled(env.ctx.taskId);
  return obj;
}

// ================= 主流程 =================

async function resolve(rawCtx: ResolveContext): Promise<ResolveResult | null> {
  const ctx = rawCtx as ResolveCtx;
  const s = readSettings();
  const env = newEnv(ctx, s);

  // 二段（引擎按清单条目回调）：resolverItem 非空 → 只解析这一条，收敛为**单直链**。
  // 必须排在 inScope 之前 —— 二段目标由插件自己产出，可能指向任意主机，不受 targetHosts 约束。
  if (ctx.resolverItem) return resolveSecondStage(env);

  if (!inScope(s, ctx)) return null; // 不在作用域 → 放行，按原 URL 下载

  flux.logger.info("[m3u8-resolver] 进入:", ctx.url);

  // ---- 增强 B：开启 yt-dlp 委派时，直接交给 yt-dlp 抽直链 ----
  if (s.useYtdlp && flux.ytdlp) {
    try {
      return await resolveViaYtdlp(env);
    } catch (e) {
      flux.logger.warn("[m3u8-resolver] yt-dlp 委派失败，回退原生解析:", String(e));
      // fallthrough 到下方原生解析
    }
  }

  let playlistUrl: string;
  let body: string;
  let pageTitle: string | null = null; // 改善默认命名（#568/#301）

  if (isManifestUrl(ctx.url)) {
    // 情况 A：直接给的就是清单地址 —— .mpd 直链交给核心 DASH 引擎，插件不抓取；
    //         .m3u8（最常见）照常抓取解析。
    if (isDashUrl(ctx.url)) {
      flux.logger.info("[m3u8-resolver] 直接收到 DASH 清单，交给核心 DASH 引擎:", ctx.url);
      return await marked(env, await buildOutput(env, ctx.url, nameFor(s, ctx, null, null, null), null));
    }
    playlistUrl = ctx.url;
    pageTitle = nameFromUrl(ctx.url); // 直链模式：URL 推导基础名（剔除 index 类）
    const r = await smartFetch(env, ctx.url, refererValue(env));
    if (r.status !== 200) throw new Error("fetch playlist " + r.status);
    body = r.body;
  } else {
    // 情况 B：给的是播放页 → 抓页面，抠出 master.m3u8
    const page = await smartFetch(env, ctx.url, refererValue(env));
    if (page.status !== 200) throw new Error("fetch page " + page.status);
    pageTitle = extractTitle(page.body); // 按网页标题命名
    if (!pageTitle) warnNoTitle();

    // ---- 剧集页识别：命中则返回清单，由引擎自动裂变成 N 个子任务 ----
    // 必须放在 extractMaster 之前判定；只有「强信号」才会命中。判错的代价是每个单视频页
    // 都弹出无意义的选集框，因此宁可漏判、不可错判。
    if (s.detectSeries) {
      const listing = detectListing(page.body, ctx.url, s);
      if (listing && listing.items && listing.items.length) {
        const mf = await buildManifestResult(pageTitle, listing);
        if (mf) {
          flux.logger.info("[m3u8-resolver] 识别为剧集页，" + listing.items.length + " 条，提交清单");
          return mf;
        }
      }
    }

    let found = extractMaster(page.body, ctx.url);
    let masterReferer = ctx.url; // 抓 master 时的 Referer
    let viaMpd: string | null = null; // 内嵌播放页里发现的 .mpd（DASH 发现层）
    if (!found && s.followIframe) {
      // 页面里没有字面 m3u8：播放器可能被放在内嵌框架里（maccms 常见）
      const via = await followIframe(env, page.body, ctx.url, 0);
      if (via) {
        found = via.m3u8 || null;
        viaMpd = via.mpd || null;
        masterReferer = via.referer;
      }
    }
    // ---- DASH 发现层：HLS 未命中时兜底找 .mpd ----
    // 优先级固定：先 .m3u8（现行为），后 .mpd —— 页面同时含两者时不改变 HLS 结果。
    // 命中则**直接返回该 .mpd 直链**，不抓取、不读内容、不走 isPlaylistBody 校验（.mpd 是 XML）。
    if (!found) {
      const mpd = viaMpd || (s.detectDash ? extractDash(page.body, ctx.url) : null);
      if (mpd) {
        flux.logger.info("[m3u8-resolver] 页面未找到 m3u8，发现 DASH 清单，交给核心 DASH 引擎:", mpd);
        return await marked(env, await buildOutput(env, mpd, nameFor(s, ctx, pageTitle, null, null), null));
      }
      flux.logger.info("[m3u8-resolver] 页面未找到 m3u8，放行");
      return null; // 不归我管
    }
    playlistUrl = found;
    // 抓 master 时 Referer 用播放页本身，比 origin 更贴近浏览器行为
    const r = await smartFetch(env, found, masterReferer);
    if (r.status !== 200) throw new Error("fetch master " + r.status);
    body = r.body;
  }

  // ---- 伪 m3u8 检测：抓回的可能根本不是 playlist ----
  if (!isPlaylistBody(body)) {
    const html = looksLikeHtml(body);
    flux.logger.warn(
      "[m3u8-resolver] 返回内容不是 m3u8" +
        (html ? "（疑似 HTML 页面/登录页）" : "（缺 #EXTM3U）") +
        "，长度 " +
        String(body ? body.length : 0),
    );
    if (html && s.htmlFallbackYtdlp && flux.ytdlp) {
      try {
        flux.logger.warn("[m3u8-resolver] 尝试改用 yt-dlp 兜底");
        return await resolveViaYtdlp(env);
      } catch (e2) {
        flux.logger.warn("[m3u8-resolver] yt-dlp 兜底同样失败:", String(e2));
      }
    }
    throw new Error(
      "返回内容不是合法 m3u8" +
        (html ? "（疑似 HTML/登录页，可能需登录或 Cookie 失效）" : "（缺 #EXTM3U 标记）"),
    );
  }

  // 加密方式体检（纯日志，不改写 playlist、不影响返回值）
  noteEncryption(body);

  const parsed = parseMaster(body, playlistUrl);
  if (parsed.subtitleRenditions.length) {
    // 仅记录：核心无字幕返回字段，插件也无法把字幕送进 ffmpeg 沙箱
    flux.logger.info(
      "[m3u8-resolver] 检测到 " +
        parsed.subtitleRenditions.length +
        " 条字幕轨（核心暂无字幕接口，已跳过）: " +
        parsed.subtitleRenditions.map((r) => r.lang || r.name || "?").join(","),
    );
  }

  // 已经是 media playlist（直接列 .ts 分片）→ 无需选码率，带好头直接返回
  if (!parsed.variants.length && isMediaPlaylist(body)) {
    flux.logger.info("[m3u8-resolver] 已是 media playlist，直接返回");
    return await marked(env, await buildOutput(env, playlistUrl, nameFor(s, ctx, pageTitle, null, null), null));
  }
  if (!parsed.variants.length) throw new Error("master 中未解析到变体");
  flux.logger.info("[m3u8-resolver] 解析到 " + parsed.variants.length + " 个变体");

  // 把「纯音频变体」从画质候选里摘出来（它不能当视频流）
  const audioVariants: Variant[] = [];
  const videoVariants: Variant[] = [];
  for (let i = 0; i < parsed.variants.length; i++) {
    if (isAudioOnlyVariant(parsed.variants[i])) audioVariants.push(parsed.variants[i]);
    else videoVariants.push(parsed.variants[i]);
  }
  const list = videoVariants.length ? videoVariants : parsed.variants;

  const codecPref = s.preferCodec.toLowerCase();
  const prefRes = s.preferResolution;
  const idx = pickVariant(list, prefRes, codecPref);
  const chosen = list[idx];

  const opt: AudioOptions = {
    mode: s.separateAudio.toLowerCase(),
    lang: s.audioLang.trim(),
    renditions: parsed.audioRenditions,
    audioVariants,
  };

  // ---- 纯音频提取：源必须有独立音轨，否则明确的 fail-closed ----
  if (s.audioOnly) {
    const a = audioSourceFor(chosen, opt, true);
    if (!a || !a.url) {
      throw new Error(
        "纯音频提取：该源未提供独立音轨（无 #EXT-X-MEDIA:TYPE=AUDIO、也无纯音频变体），" +
          "无法在下载层分离。请关闭「纯音频提取」，或改用提供独立音轨的源。",
      );
    }
    flux.logger.info("[m3u8-resolver] 纯音频提取 →", a.label || "audio");
    return await marked(env, await buildOutput(env, a.url, nameFor(s, ctx, pageTitle, chosen, a), null));
  }

  if (s.autoPick) {
    // 自动选：只返回选中直链，不弹框
    const a = audioSourceFor(chosen, opt, false);
    return await marked(
      env,
      await buildOutput(env, chosen.url, nameFor(s, ctx, pageTitle, chosen, a), a && a.url ? a.url : null),
    );
  }

  // 手动选：返回 variants，FluxDown 弹出画质选择框。
  // 注：variants 非空时顶层 url 允许为空。每一项都可带自己的 audioUrl（核心按轨对任务自动合并）。
  const variants: ResolveVariant[] = list.map((v) => {
    const a = audioSourceFor(v, opt, false);
    const o: ResolveVariant = { label: v.label, url: assertOutputUrl(v.url, "变体 url") };
    if (v.width) o.width = v.width;
    if (v.height) o.height = v.height;
    if (v.bandwidth) o.bandwidth = v.bandwidth;
    if (a && a.url) o.audioUrl = assertOutputUrl(a.url, "变体 audioUrl");
    return o;
  });
  const defAudio = audioSourceFor(chosen, opt, false);
  const out: ResolveResult = {
    variants,
    defaultVariantIndex: idx,
    rangeSupported: true,
    ephemeral: s.ephemeral,
  };
  const nm = nameFor(s, ctx, pageTitle, chosen, defAudio);
  if (nm) out.fileName = nm;
  // 补丁作用域是「本次运行」，与用户最终选中哪条变体无关 —— 引擎在选完变体后仍按它下发请求。
  const patch = await requestPatch(env, chosen.url);
  if (patch) out.request = patch;
  return await marked(env, out);
}

// ================= 二段解析 =================
// 引擎拿着条目 id 再调一次 resolve，要求**单直链**。约束（引擎 validate_resolve_output 同口径）：
//   · 不得再返回 manifest（防递归裂变）；
//   · url 与 variants/audioUrl 语义互斥，这里只走单直链分支；
//   · 不传 fileName —— 子任务沿用清单条目名；
//   · 画质/音轨设置照常生效，但**不再弹框**（N 个子任务弹 N 个框不可接受）。
async function resolveSecondStage(env: Env): Promise<ResolveResult | null> {
  const { ctx, s } = env;
  const target = await decodeItem(ctx.resolverItem);
  if (!target) {
    flux.logger.warn("[m3u8-resolver] 二段：条目已失效（多为插件重装后令牌丢失），放行");
    return null;
  }
  flux.logger.info("[m3u8-resolver] 二段解析:", target);

  const playlistUrl = target;
  let body: string;
  if (isPlaylistUrl(target)) {
    const r = await smartFetch(env, target, refererValue(env));
    if (r.status !== 200) throw new Error("fetch playlist " + r.status);
    body = r.body;
  } else if (isDashUrl(target)) {
    // 条目本身就是 .mpd 直链（DASH 发现层的清单条目）→ 直接返回，不抓取、不解析
    return await marked(env, await buildOutput(env, target, null, null));
  } else {
    // 条目本身是剧集页：再抓一次页面，取其中第一个 m3u8
    const page = await smartFetch(env, target, refererValue(env));
    if (page.status !== 200) throw new Error("fetch page " + page.status);
    let found = extractMaster(page.body, target);
    let masterReferer = target;
    let viaMpd: string | null = null;
    if (!found && s.followIframe) {
      // 播放器在内嵌框架里时跟进一层（二段同样只返回单直链）
      const via = await followIframe(env, page.body, target, 0);
      if (via) {
        found = via.m3u8 || null;
        viaMpd = via.mpd || null;
        masterReferer = via.referer;
      }
    }
    if (!found) {
      // DASH 发现层：条目页里没有 m3u8 但有 .mpd → 直接返回该直链
      const mpd = viaMpd || (s.detectDash ? extractDash(page.body, target) : null);
      if (mpd) {
        flux.logger.info("[m3u8-resolver] 二段：条目页发现 DASH 清单，交给核心 DASH 引擎:", mpd);
        return await marked(env, await buildOutput(env, mpd, null, null));
      }
      flux.logger.warn("[m3u8-resolver] 二段：条目页未找到 m3u8，放行");
      return null;
    }
    const r = await smartFetch(env, found, masterReferer);
    if (r.status !== 200) throw new Error("fetch master " + r.status);
    body = r.body;
  }

  if (!isPlaylistBody(body)) {
    throw new Error("清单条目返回内容不是合法 m3u8（可能需登录或链接已失效）");
  }
  noteEncryption(body);

  const parsed = parseMaster(body, playlistUrl);
  if (!parsed.variants.length) {
    if (isMediaPlaylist(body)) return await marked(env, await buildOutput(env, playlistUrl, null, null));
    throw new Error("master 中未解析到变体");
  }

  const audioVariants: Variant[] = [];
  const videoVariants: Variant[] = [];
  for (let i = 0; i < parsed.variants.length; i++) {
    if (isAudioOnlyVariant(parsed.variants[i])) audioVariants.push(parsed.variants[i]);
    else videoVariants.push(parsed.variants[i]);
  }
  const list = videoVariants.length ? videoVariants : parsed.variants;
  const chosen = list[pickVariant(list, s.preferResolution, s.preferCodec.toLowerCase())];

  const opt: AudioOptions = {
    mode: s.separateAudio.toLowerCase(),
    lang: s.audioLang.trim(),
    renditions: parsed.audioRenditions,
    audioVariants,
  };

  if (s.audioOnly) {
    const a = audioSourceFor(chosen, opt, true);
    if (!a || !a.url) {
      throw new Error("纯音频提取：该条目未提供独立音轨，无法在下载层分离。请关闭「纯音频提取」后重试。");
    }
    return await marked(env, await buildOutput(env, a.url, null, null));
  }

  const a = audioSourceFor(chosen, opt, false);
  return await marked(env, await buildOutput(env, chosen.url, null, a && a.url ? a.url : null));
}

// ================= 增强 B：yt-dlp 抽直链 =================
async function resolveViaYtdlp(env: Env): Promise<ResolveResult> {
  const { ctx, s } = env;
  flux.logger.info("[m3u8-resolver] 走 yt-dlp 委派:", ctx.url);
  if (!flux.ytdlp) throw new Error("yt-dlp 组件不可用");
  const r = await flux.ytdlp.run({ args: ["-J", "--no-warnings", ctx.url] });
  if (r.code !== 0) throw new Error("yt-dlp 失败: " + (r.stderr || "").slice(-400));
  const info = JSON.parse(r.stdout) as { url?: string; title?: string; formats?: { url?: string }[] };
  const formats = Array.isArray(info.formats) ? info.formats : [];
  const direct = info.url || (formats.length ? formats[formats.length - 1].url : undefined);
  if (!direct) throw new Error("yt-dlp 未返回直链");
  flux.logger.info("[m3u8-resolver] yt-dlp 直链:", direct.slice(0, 80));

  // yt-dlp 自带标题，优先级高于其他命名来源
  const title = typeof info.title === "string" ? info.title : "";
  const base = title && !GENERIC_NAME_RE.test(sanitizeAssetName(title)) ? sanitize(title) : nameFromUrl(ctx.url);
  const name = applyNameTemplate(s, base, partsFor(ctx, null, null), ctx);

  const out: ResolveResult = {
    url: assertOutputUrl(direct, "yt-dlp 直链"),
    fileName: name,
    rangeSupported: true,
    ephemeral: s.ephemeral,
  };
  const patch = await requestPatch(env, direct);
  if (patch) out.request = patch;
  await markHandled(ctx.taskId);
  return out;
}

// ================= 剧集清单构造 =================
// 引擎对 `manifest` 与 `url`/`variants`/`audioUrl` 是互斥校验（fail-closed），多带一个字段整次解析就被拒。
async function buildManifestResult(pageTitle: string | null, listing: Listing): Promise<ResolveResult | null> {
  try {
    const prefix = pageTitle ? sanitizeAssetName(pageTitle) : "";
    const used: Record<string, number> = {};
    const items: { id: string; name: string; path: string; kind: "file" }[] = [];
    for (let i = 0; i < listing.items.length; i++) {
      const it = listing.items[i];
      const id = await encodeItem(it.url);
      if (!id) continue;
      const rawName = prefix ? prefix + " " + (it.name || "") : it.name || "";
      const nm = uniqueName(safeFileName(rawName) || "video_" + (i + 1), used);
      items.push({ id, name: nm, path: "", kind: "file" });
    }
    if (!items.length) return null;
    return { manifest: { name: prefix || "", items } };
  } catch (e) {
    flux.logger.warn("[m3u8-resolver] 构造剧集清单失败，回退单视频解析:", String(e));
    return null;
  }
}

// ================= 作用域 =================
/** 直接清单地址（.m3u8 / .mpd）一律处理；页面 URL 仅处理配置好的目标站。 */
function inScope(s: Settings, ctx: ResolveCtx): boolean {
  // 二段 / 订阅条目：地址是插件自己产出的精细目标，一律处理。
  // 少了这行，未配 targetHosts 时清单子任务会被放行成「原样下载」→ 下载到 HTML。
  if (ctx.resolverItem) return true;
  if (isManifestUrl(ctx.url)) return true;
  const raw = s.targetHosts.trim();
  if (!raw) return false; // 未配置目标站 → 不处理页面
  const hosts = raw
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
  const p = parseUrl(ctx.url);
  if (!p) return false;
  const h = p.hostname;
  return hosts.some((x) => h === x || h.endsWith("." + x));
}

install("resolve", resolve);
