// FluxDown M3U8 resolver 模板（v1.2）
// 目标：发现正确 URL + 选对 variant + 带对鉴权头
// 另含两个可切换增强（见插件设置）：
//   - useYtdlp      : 复杂站交给 yt-dlp 抽直链（增强 B）
//   - remuxToMp4    : 下载后由 hooks.js 用 ffmpeg 无损转封装为 MP4（增强 A）
// 命名改进（对应 #568/#301）：播放页取 <title>，直链 m3u8 用 URL 推导，避免裸 index.m3u8。
// 安装：设置 → 扩展 → 插件 → 从目录安装本文件夹（开发模式会热读 .js，改完存盘即生效）

async function resolve(ctx) {
  if (!inScope(ctx)) return null; // 不在作用域 → 放行，按原 URL 下载

  flux.logger.info("[m3u8-resolver] 进入:", ctx.url);

  // ---- 增强 B：开启 yt-dlp 委派时，直接交给 yt-dlp 抽直链 ----
  if (flux.settings.useYtdlp && flux.ytdlp) {
    try {
      return await resolveViaYtdlp(ctx);
    } catch (e) {
      flux.logger.warn("[m3u8-resolver] yt-dlp 委派失败，回退原生解析:", String(e));
      // fallthrough 到下方原生解析
    }
  }

  // ---- 原生：master → variant 解析 ----
  let masterUrl = null;
  let masterBody = null;
  let pageTitle = null; // 改善默认命名（#568/#301）

  if (isPlaylistUrl(ctx.url)) {
    // 情况 A：直接给的就是 .m3u8（最常见，通用处理）
    masterUrl = ctx.url;
    pageTitle = dirNameFromUrl(ctx.url); // 直链模式：用 URL 推导基础名，避免 index.m3u8
    const r = await flux.fetch({ url: ctx.url, headers: refererHeaders(ctx) });
    if (r.status !== 200) throw new Error("fetch playlist " + r.status);
    masterBody = r.body;
  } else {
    // 情况 B：给的是播放页 → 抓页面，抠出 master.m3u8（按目标站结构定制）
    const page = await flux.fetch({ url: ctx.url, headers: refererHeaders(ctx) });
    if (page.status !== 200) throw new Error("fetch page " + page.status);
    pageTitle = extractTitle(page.body); // 按网页标题命名（#568/#301）
    const found = extractMaster(page.body, ctx.url);
    if (!found) {
      flux.logger.info("[m3u8-resolver] 页面未找到 m3u8，放行");
      return null; // 不归我管
    }
    masterUrl = found;
    const r = await flux.fetch({ url: found, headers: refererHeaders(ctx) });
    if (r.status !== 200) throw new Error("fetch master " + r.status);
    masterBody = r.body;
  }

  // 已经是 media playlist（直接列 .ts 分片）→ 无需选码率，带好头直接返回
  if (isMediaPlaylist(masterBody)) {
    flux.logger.info("[m3u8-resolver] 已是 media playlist，直接返回");
    return finalize(ctx, masterUrl, pageTitle);
  }

  // 解析 master 的多码率变体
  const variants = parseVariants(masterBody, masterUrl);
  if (variants.length === 0) throw new Error("master 中未解析到变体");
  flux.logger.info("[m3u8-resolver] 解析到", variants.length, "个变体");

  const idx = pickVariant(variants);

  if (flux.settings.autoPick) {
    // 自动选：只返回选中直链，不弹框
    return finalize(ctx, variants[idx].url, pageTitle);
  }

  // 手动选：返回 variants，FluxDown 弹出画质选择框
  // 注：variants 非空时顶层 url 允许为空
  return {
    variants: variants.map((v) => ({ label: v.label, url: v.url })),
    defaultVariantIndex: idx,
    ...(pageTitle ? { fileName: pageTitle } : {}),
    ...authHeaders(ctx),
    rangeSupported: true, // HLS CDN 通常支持 Range → 多线程分段
    ephemeral: !!flux.settings.ephemeral,
  };
}

// 增强 B：yt-dlp 抽直链
async function resolveViaYtdlp(ctx) {
  flux.logger.info("[m3u8-resolver] 走 yt-dlp 委派:", ctx.url);
  const r = await flux.ytdlp.run({ args: ["-J", "--no-warnings", ctx.url] });
  if (r.code !== 0) throw new Error("yt-dlp 失败: " + (r.stderr || "").slice(-400));
  const info = JSON.parse(r.stdout);
  const direct = info.url || info.formats?.[info.formats.length - 1]?.url;
  if (!direct) throw new Error("yt-dlp 未返回直链");
  flux.logger.info("[m3u8-resolver] yt-dlp 直链:", direct.slice(0, 80));
  // yt-dlp 自带标题，优先级高于其他命名来源
  const name = info.title ? sanitize(info.title) : dirNameFromUrl(ctx.url);
  return {
    url: direct,
    fileName: name,
    ...authHeaders(ctx),
    rangeSupported: true,
    ephemeral: !!flux.settings.ephemeral,
  };
}

// ---------- 鉴权头：Referer/Origin + 任务自带 extraHeaders ----------
// 任务的 Cookie 由 FluxDown 引擎在解析后的下载里自动携带，这里一般无需重复设 Cookie。
function refererHeaders(ctx) {
  const h = {};
  if (ctx.referrer) h["Referer"] = ctx.referrer;
  return h;
}
function authHeaders(ctx) {
  const origin = safeOrigin(ctx.url);
  const extra = {};
  if (origin) {
    extra["Referer"] = origin;
    extra["Origin"] = origin;
  }
  if (ctx.extraHeaders) Object.assign(extra, ctx.extraHeaders);
  return { extraHeaders: extra };
}
function finalize(ctx, url, fileName) {
  return {
    url,
    ...(fileName ? { fileName } : {}),
    ...authHeaders(ctx),
    rangeSupported: true,
    ephemeral: !!flux.settings.ephemeral,
  };
}

// ---------- 站点解析（情况 B 需按目标站定制）----------
function extractMaster(html, base) {
  // TODO: 按你目标站的实际结构，从 html 里抠出 master.m3u8 的绝对地址。
  // 常见线索：
  //   - <source src="https://.../index.m3u8">
  //   - window.__INITIAL_STATE__ = {... "src":"https://...m3u8" ...}
  //   - "m3u8":"https://..." 或 "playlistUrl":"https://..."
  // 下面是兜底正则，多数简单站点可用，复杂站点请替换为精确解析。
  const m = html.match(/(https?:\/\/[^"'\\\s]+?\.m3u8(?:\?[^"'\\\s]*)?)/i);
  return m ? m[1] : null;
}
function extractTitle(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return null;
  // 去掉常见的「标题 - 站点名」后缀，保留主体
  const base = m[1].replace(/\s*[-|·–—|｜]\s*[^|]*$/i, "").trim();
  return sanitize(base) || null;
}
function dirNameFromUrl(u) {
  try {
    const seg = new URL(u).pathname.split("/").filter(Boolean);
    const last = seg[seg.length - 1] || "";
    const name = last.replace(/\.m3u8$/i, "") || (seg[seg.length - 2] || "video");
    return sanitize(name) || "video";
  } catch {
    return "video";
  }
}

// ---------- 通用解析 ----------
function isPlaylistUrl(u) {
  return /\.m3u8(\?|$)/i.test(u);
}
function isMediaPlaylist(body) {
  if (!body) return false;
  return /#EXTINF/i.test(body) && !/#EXT-X-STREAM-INF/i.test(body);
}
function parseVariants(body, base) {
  const lines = body.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l.startsWith("#EXT-X-STREAM-INF")) continue;
    const res = l.match(/RESOLUTION=(\d+)x(\d+)/) || [];
    const w = res[1];
    const h = res[2];
    const bw = (l.match(/BANDWIDTH=(\d+)/) || [])[1];
    let url = (lines[i + 1] || "").trim();
    if (!url || url.startsWith("#")) continue;
    url = absUrl(url, base);
    const label = w && h ? `${w}x${h} (${fmtBw(bw)})` : bw ? `${fmtBw(bw)}` : "variant";
    out.push({ label, url, bandwidth: bw ? +bw : 0, resolution: w ? +w : 0 });
  }
  out.sort((a, b) => b.bandwidth - a.bandwidth); // 降序，便于 "best" 取最高
  return out;
}
function pickVariant(variants) {
  const pref = flux.settings.preferResolution || "best";
  if (pref === "best") return 0;
  const want = +pref;
  let best = 0;
  for (let i = 0; i < variants.length; i++) {
    best = i;
    if (variants[i].resolution <= want) break; // 降序数组里第一个 <= 偏好的
  }
  return best;
}
function fmtBw(bw) {
  const n = +bw || 0;
  return n >= 1000 ? n / 1000 + "k" : "" + n;
}
function safeOrigin(u) {
  try {
    return new URL(u).origin;
  } catch {
    return "";
  }
}
// 把 m3u8 里的相对地址解析成绝对地址。
// 关键：FluxDown 运行时是沙箱化 QuickJS，其 new URL(u, base) 两参形式可能
// 不支持相对解析（会抛错或返回原串），导致输出仍是相对路径 → 触发
// "url scheme 不允许"。这里先尝试原生解析（结果必须有 scheme 才采纳），
// 否则用手动拼接兜底，确保永远返回带 http(s) 的绝对地址。
function absUrl(u, base) {
  if (!u) return u;
  // 已是绝对地址（带 scheme://），直接返回
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(u)) return u;
  if (!base || !/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(base)) return u;
  // 先试原生实现；若沙箱不支持相对解析，结果可能不含 scheme，须丢弃
  try {
    const r = new URL(u, base).href;
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(r)) return r;
  } catch {}
  // 手动兜底：支持 //、/ 开头与相对路径，并处理 . 与 ..
  try {
    const b = new URL(base);
    let path;
    if (u.startsWith("//")) return b.protocol + u; // 协议相对
    if (u.startsWith("/")) path = u;               // 站点根绝对
    else {
      const dir = b.pathname.replace(/[^/]*$/, ""); // 基础 URL 所在目录
      path = dir + u;
    }
    const norm = [];
    for (const seg of path.split("/")) {
      if (seg === "" || seg === ".") continue;
      if (seg === "..") norm.pop();
      else norm.push(seg);
    }
    return b.origin + "/" + norm.join("/");
  } catch {
    return u;
  }
}
function sanitize(s) {
  return String(s)
    .replace(/[\\/:*?"<>|\n\r\t]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200) || "download";
}
// 作用域：直接 .m3u8 一律处理；页面 URL 仅处理配置好的目标站
function inScope(ctx) {
  if (isPlaylistUrl(ctx.url)) return true;
  const raw = (flux.settings.targetHosts || "").trim();
  if (!raw) return false; // 未配置目标站 → 不处理页面
  const hosts = raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  let h = "";
  try {
    h = new URL(ctx.url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return hosts.some((x) => h === x || h.endsWith("." + x));
}

// 进阶（可选）：DASH 常有独立音轨，resolver 还可返回 audioUrl 做音视频分离；
// 多音轨封装、ISM、SAMPLE-AES、直播录制不在插件能力内，需 N_m3u8DL-RE/yt-dlp。
