// FluxDown M3U8 resolver（v1.3）
// 目标：发现正确 URL + 选对 variant + 带对鉴权头 + 音视频分离/纯音频提取 + 伪链接检测
//
// 可切换增强（见插件设置）：
//   - useYtdlp       : 复杂站交给 yt-dlp 抽直链（增强 B）
//   - remuxToMp4     : 下载后由 hooks.js 用 ffmpeg 无损转封装为 MP4（增强 A）
//   - adClean        : 本地源头去广告（增强 C）—— ★ 已停用，代码整体注释保留（见下方同名小节）
//   - separateAudio  : 解析 #EXT-X-MEDIA / 纯音频变体，返回 audioUrl，由核心自动合并（增强 D）
// 命名（对应 #568/#301）：播放页取 <title>，直链 m3u8 用 URL 推导；可用 nameTemplate 自定义。
// 安装：设置 → 扩展 → 插件 → 从目录安装本插件的 src/ 目录（开发模式热读 .js，改完存盘即生效）
//
// ⚠️ 能力边界（已对照官方 API 参考核实，勿再当作"待补"）：
//   - 字幕（#EXT-X-MEDIA:TYPE=SUBTITLES / WebVTT）：resolver 返回值无字幕字段；且 ffmpeg
//     沙箱只认「产物目录内的相对名」，而 flux.fs 是另一个独立工作区，抓到的字幕送不进去
//     → 单层不可行。本文件只记录字幕轨（subtitleRenditions），不下载。
//   - 任务分组：官方明确「插件不能创建任务」，且无 group 接口 → 不可行。
//   - SAMPLE-AES / SAMPLE-AES-CTR / FairPlay / Widevine、LL-HLS(#EXT-X-PART)、真直播无限录制：
//     核心层能力，插件天花板。插件侧只在 noteEncryption() 里把加密方式说清楚，不尝试绕过。
//   - #EXT-X-KEY:METHOD=NONE：引擎依赖的 m3u8-rs 6.0.1 有 IV 校验写反的上游缺陷，会把这行
//     降级为未知标签，使明文段被误用上一段的 AES-128 密钥解密（PKCS7 Unpad Error）。
//     属上游问题，插件无法规避 —— 见 docs/upstream-m3u8-rs-method-none.md。
//   - onMetaProbed：带 resolver 的插件该钩子永不触发（官方明确），故 manifest 不订阅。

// ================= 设置读取（容错：布尔 / 字符串两种运行时取值） =================
function settingBool(key, def) {
  const v = flux.settings ? flux.settings[key] : undefined;
  if (v === undefined || v === null || v === "") return !!def;
  if (typeof v === "boolean") return v;
  const s = String(v).trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes" || s === "on";
}
function settingStr(key, def) {
  const v = flux.settings ? flux.settings[key] : undefined;
  if (v === undefined || v === null) return def || "";
  return String(v);
}

// ================= 任务标记（供 hooks.js 判断「这是本插件经手的任务」） =================
// 原因见 hooks.js 文件头：hooks.match 只能按原始 URL 过滤，播放页入口 URL 里不含
// m3u8，导致 remux/兜底对这类任务静默失效。改用 taskId 标记，hooks 侧不设 match。
// 只用 1 个存储键（避免 100 键上限），带 TTL 与条数上限；任何异常都吞掉，绝不影响解析。
const HANDLE_KEY = "handledTasks";
const HANDLE_TTL_MS = 6 * 3600 * 1000;
const HANDLE_MAX = 60;

async function readHandled() {
  try {
    if (!flux.storage) return {};
    const s = await flux.storage.get(HANDLE_KEY);
    if (!s) return {};
    const o = JSON.parse(s);
    return o && typeof o === "object" ? o : {};
  } catch (e) {
    return {};
  }
}
async function markHandled(taskId) {
  if (!taskId || !flux.storage) return;
  try {
    const now = Date.now();
    const map = await readHandled();
    map[taskId] = now;
    const ids = Object.keys(map);
    for (let i = 0; i < ids.length; i++) {
      if (now - map[ids[i]] > HANDLE_TTL_MS) delete map[ids[i]];
    }
    const left = Object.keys(map);
    if (left.length > HANDLE_MAX) {
      left.sort(function (a, b) { return map[a] - map[b]; });
      const drop = left.length - HANDLE_MAX;
      for (let i = 0; i < drop; i++) delete map[left[i]];
    }
    await flux.storage.set(HANDLE_KEY, JSON.stringify(map));
  } catch (e) {
    /* 标记失败不影响解析：最坏情况只是 hooks 不做后处理 */
  }
}
// 成功返回时统一打标
async function marked(ctx, obj) {
  if (obj) await markHandled(ctx && ctx.taskId);
  return obj;
}

// ================= 增强 C：本地源头去广告（★ 已停用，2026-10-01） =================
// 停用说明：与之配套的 adfilter/ 本地清洗服务不再更新与维护，故插件侧整体退出该能力。
//   影响面：① 这里整块注释保留（便于日后恢复）；② 所有返回点改为直接用原始 URL
//   （不再存在"改写为 127.0.0.1 清洗地址"的路径）；③ manifest 移除 adClean / adCleanServer
//   两个设置项 —— 插件从此**不读** flux.settings.adClean，即使旧版本残留该键也无效。
// 为什么 manifest 是"移除"而不是"注释"：引擎 plugin/manifest.rs 的 PluginManifest 带
//   deny_unknown_fields，且用 serde_json 解析 —— JSON 既不能写注释，也不能塞自定义说明键，
//   否则整份 manifest 校验失败、插件被跳过。详见本文件头「能力边界」的同类约定。
/*
// 原实现：把引擎要抓的 playlist 地址改写为指向本地 adfilter 服务的 URL；
// 该服务抓源 playlist → 剔广告段 → 段地址绝对化 → 返回干净 playlist。需先启动本地服务。
function stripAdsEnabled() {
  const on = flux.settings ? flux.settings.adClean : undefined;
  const isOn = on === true || String(on).toLowerCase() === "true";
  return isOn && !!settingStr("adCleanServer", "http://127.0.0.1:8787").trim();
}
function cleanUrl(ctx, u) {
  const srv = settingStr("adCleanServer", "http://127.0.0.1:8787").trim().replace(/\/+$/, "");
  let q = "src=" + encodeURIComponent(u);
  const ref = refererValue(ctx);
  if (ref) q += "&ref=" + encodeURIComponent(ref);
  return srv + "/clean?" + q;
}
// 统一出口：需要时改写，否则原样
function maybeClean(ctx, u) {
  if (!u) return u;
  return stripAdsEnabled() ? cleanUrl(ctx, u) : u;
}
*/

// ================= 请求头体系（Referer / Origin / UA / 自定义头） =================
// Referer 精确化：优先任务携带的 referrer（通常是播放页完整 URL），回落站点 origin。
// 这是实际修复 —— 旧版忽略了 ctx.referrer，只塞 origin，很多站校验的是具体页面 URL。
function refererValue(ctx) {
  const r = ctx && ctx.referrer ? String(ctx.referrer).trim() : "";
  if (r) return r;
  return safeOrigin(ctx && ctx.url) || "";
}
// 用户自定义请求头：userAgent 单列，其余走 extraHeadersRaw（多行 "Key: Value"，# 注释）
function customHeaders() {
  const h = {};
  const ua = settingStr("userAgent", "").trim();
  if (ua) h["User-Agent"] = ua;
  const raw = settingStr("extraHeadersRaw", "");
  if (raw) {
    const rawLines = String(raw).split(/\r\n|\r|\n/);
    for (let i = 0; i < rawLines.length; i++) {
      const s = rawLines[i].replace(/[\u0000-\u001F\u007F]/g, "").trim();
      if (!s || s.charAt(0) === "#") continue;
      const p = s.indexOf(":");
      if (p <= 0) continue;
      const k = s.slice(0, p).trim();
      const v = s.slice(p + 1).trim();
      if (k && v) h[k] = v;
    }
  }
  return h;
}
// 给 flux.fetch 用：Referer + UA + 自定义头
// （注意：manifest/分片 URL 的抓取也必须带头，否则站方返回的是登录页而非 playlist）
function fetchHeaders(ctx, referer) {
  const h = customHeaders();
  if (referer) h["Referer"] = referer;
  return h;
}
// 给下载引擎用：下载解析后直链时附带的请求头
function authHeaders(ctx) {
  const ref = refererValue(ctx);
  const extra = {};
  if (ref) extra["Referer"] = ref;
  // Origin 取「页面」的来源（浏览器语义），而非 CDN 的来源
  const org = safeOrigin(ref) || safeOrigin(ctx && ctx.url);
  if (org) extra["Origin"] = org;
  const ch = customHeaders();
  for (const k in ch) if (Object.prototype.hasOwnProperty.call(ch, k)) extra[k] = ch[k];
  // 任务自带的 extraHeaders 优先级最高
  if (ctx && ctx.extraHeaders) {
    for (const k in ctx.extraHeaders) if (Object.prototype.hasOwnProperty.call(ctx.extraHeaders, k)) extra[k] = ctx.extraHeaders[k];
  }
  return { extraHeaders: extra };
}

// ================= 主流程 =================
async function resolve(ctx) {
  if (!inScope(ctx)) return null; // 不在作用域 → 放行，按原 URL 下载

  flux.logger.info("[m3u8-resolver] 进入:", ctx.url);

  // ---- 增强 B：开启 yt-dlp 委派时，直接交给 yt-dlp 抽直链 ----
  if (settingBool("useYtdlp", false) && flux.ytdlp) {
    try {
      return await resolveViaYtdlp(ctx);
    } catch (e) {
      flux.logger.warn("[m3u8-resolver] yt-dlp 委派失败，回退原生解析:", String(e));
      // fallthrough 到下方原生解析
    }
  }

  // ---- 原生：master → variant 解析 ----
  let playlistUrl = null;
  let body = null;
  let pageTitle = null; // 改善默认命名（#568/#301）

  if (isPlaylistUrl(ctx.url)) {
    // 情况 A：直接给的就是 .m3u8（最常见，通用处理）
    playlistUrl = ctx.url;
    pageTitle = nameFromUrl(ctx.url); // 直链模式：URL 推导基础名（剔除 index 类，见 nameFromUrl）
    const r = await flux.fetch({ url: ctx.url, headers: fetchHeaders(ctx, refererValue(ctx)) });
    if (r.status !== 200) throw new Error("fetch playlist " + r.status);
    body = r.body;
  } else {
    // 情况 B：给的是播放页 → 抓页面，抠出 master.m3u8（按目标站结构定制）
    const page = await flux.fetch({ url: ctx.url, headers: fetchHeaders(ctx, refererValue(ctx)) });
    if (page.status !== 200) throw new Error("fetch page " + page.status);
    pageTitle = extractTitle(page.body); // 按网页标题命名
    if (!pageTitle) warnNoTitle(ctx);
    const found = extractMaster(page.body, ctx.url);
    if (!found) {
      flux.logger.info("[m3u8-resolver] 页面未找到 m3u8，放行");
      return null; // 不归我管
    }
    playlistUrl = found;
    // 抓 master 时 Referer 用播放页本身，比 origin 更贴近浏览器行为
    const r = await flux.fetch({ url: found, headers: fetchHeaders(ctx, ctx.url) });
    if (r.status !== 200) throw new Error("fetch master " + r.status);
    body = r.body;
  }

  // ---- 伪 m3u8 检测：抓回的可能根本不是 playlist ----
  if (!isPlaylistBody(body)) {
    const html = looksLikeHtml(body);
    flux.logger.warn(
      "[m3u8-resolver] 返回内容不是 m3u8" +
        (html ? "（疑似 HTML 页面/登录页）" : "（缺 #EXTM3U）") +
        "，长度 " + String(body ? body.length : 0)
    );
    if (html && settingBool("htmlFallbackYtdlp", true) && flux.ytdlp) {
      try {
        flux.logger.warn("[m3u8-resolver] 尝试改用 yt-dlp 兜底");
        return await resolveViaYtdlp(ctx);
      } catch (e2) {
        flux.logger.warn("[m3u8-resolver] yt-dlp 兜底同样失败:", String(e2));
      }
    }
    throw new Error(
      "返回内容不是合法 m3u8" +
        (html ? "（疑似 HTML/登录页，可能需登录或 Cookie 失效）" : "（缺 #EXTM3U 标记）")
    );
  }

  // 加密方式体检（纯日志，不改写 playlist、不影响返回值）
  noteEncryption(ctx, body);

  const parsed = parseMaster(body, playlistUrl);
  if (parsed.subtitleRenditions.length) {
    // 仅记录：核心无字幕返回字段，插件也无法把字幕送进 ffmpeg 沙箱（见文件头「能力边界」）
    flux.logger.info(
      "[m3u8-resolver] 检测到 " + parsed.subtitleRenditions.length +
        " 条字幕轨（核心暂无字幕接口，已跳过）: " +
        parsed.subtitleRenditions.map(function (r) { return r.lang || r.name || "?"; }).join(",")
    );
  }

  // 已经是 media playlist（直接列 .ts 分片）→ 无需选码率，带好头直接返回
  if (!parsed.variants.length && isMediaPlaylist(body)) {
    flux.logger.info("[m3u8-resolver] 已是 media playlist，直接返回");
    return await marked(ctx, finalize(ctx, playlistUrl, nameFor(pageTitle, ctx, null, null), null));
  }
  if (!parsed.variants.length) throw new Error("master 中未解析到变体");
  flux.logger.info("[m3u8-resolver] 解析到 " + parsed.variants.length + " 个变体");

  // 把「纯音频变体」从画质候选里摘出来（它不能当视频流）
  const audioVariants = [];
  const videoVariants = [];
  for (let i = 0; i < parsed.variants.length; i++) {
    if (isAudioOnlyVariant(parsed.variants[i])) audioVariants.push(parsed.variants[i]);
    else videoVariants.push(parsed.variants[i]);
  }
  const list = videoVariants.length ? videoVariants : parsed.variants;

  const codecPref = settingStr("preferCodec", "auto").toLowerCase();
  const prefRes = settingStr("preferResolution", "best");
  const idx = pickVariant(list, prefRes, codecPref);
  const chosen = list[idx];

  const opt = {
    mode: settingStr("separateAudio", "auto").toLowerCase(),
    lang: settingStr("audioLang", "").trim(),
    renditions: parsed.audioRenditions,
    audioVariants: audioVariants,
  };

  // ---- 纯音频提取：源必须有独立音轨，否则明确的 fail-closed ----
  if (settingBool("audioOnly", false)) {
    const a = audioSourceFor(ctx, chosen, opt, true);
    if (!a || !a.url) {
      throw new Error(
        "纯音频提取：该源未提供独立音轨（无 #EXT-X-MEDIA:TYPE=AUDIO、也无纯音频变体），" +
          "无法在下载层分离。请关闭「纯音频提取」，或改用提供独立音轨的源。"
      );
    }
    flux.logger.info("[m3u8-resolver] 纯音频提取 →", a.label || "audio");
    return await marked(ctx, finalize(ctx, a.url, nameFor(pageTitle, ctx, chosen, a), null));
  }

  if (settingBool("autoPick", false)) {
    // 自动选：只返回选中直链，不弹框
    const a = audioSourceFor(ctx, chosen, opt, false);
    return await marked(
      ctx,
      finalize(
        ctx,
        chosen.url,
        nameFor(pageTitle, ctx, chosen, a),
        a && a.url ? a.url : null
      )
    );
  }

  // 手动选：返回 variants，FluxDown 弹出画质选择框
  // 注：variants 非空时顶层 url 允许为空。每一项都可带自己的 audioUrl（核心按轨对任务自动合并）。
  const variants = list.map(function (v) {
    const a = audioSourceFor(ctx, v, opt, false);
    // 广告过滤已停用：此处原为 maybeClean(ctx, v.url)
    const o = { label: v.label, url: assertOutputUrl(v.url, "变体 url") };
    if (v.width) o.width = v.width;
    if (v.height) o.height = v.height;
    if (v.bandwidth) o.bandwidth = v.bandwidth;
    // 广告过滤已停用：此处原为 maybeClean(ctx, a.url)
    if (a && a.url) o.audioUrl = assertOutputUrl(a.url, "变体 audioUrl");
    return o;
  });
  const defAudio = audioSourceFor(ctx, chosen, opt, false);
  const out = {
    variants: variants,
    defaultVariantIndex: idx,
    rangeSupported: true, // HLS CDN 通常支持 Range → 多线程分段
    ephemeral: settingBool("ephemeral", false),
  };
  const nm = nameFor(pageTitle, ctx, chosen, defAudio);
  if (nm) out.fileName = nm;
  const ah = authHeaders(ctx);
  out.extraHeaders = ah.extraHeaders;
  return await marked(ctx, out);
}

// ================= 音轨（轨道对）解析 =================
// separateAudio 三态：
//   auto（默认）—— 只在「CODECS 明确为 video-only」或「源已把音轨单列为纯音频变体」时分离，
//                  避免音视频合一的流被拆出第二条音轨（双音轨）。
//   on         —— 只要有音轨来源就分离（用户明确要求时）。
//   off        —— 从不分离。
function shouldSeparate(mode, variant, audioVariants) {
  if (mode === "off" || mode === "false" || mode === "0") return false;
  if (mode === "on" || mode === "true" || mode === "1" || mode === "always") return true;
  const c = variant && variant.codecs ? String(variant.codecs) : "";
  if (c && RE_AUDIO_CODEC.test(c)) return false; // 明确含音轨 → 不拆
  if (c && RE_VIDEO_CODEC.test(c)) return true;  // 明确 video-only → 必须配音频
  if (audioVariants && audioVariants.length) return true; // 源已单列音轨，本变体无 CODECS 信息
  return false;
}
// 找该变体对应的音轨来源：① #EXT-X-MEDIA 音频组 → ② 纯音频 STREAM-INF 变体
function audioSourceFor(ctx, variant, opt, forced) {
  if (!forced && !shouldSeparate(opt.mode, variant, opt.audioVariants)) return null;
  const r = pickRendition(opt.renditions, variant ? variant.audioGroup : "", opt.lang);
  if (r && r.url) return { url: r.url, label: r.name || r.lang || "audio" };
  if (opt.audioVariants && opt.audioVariants.length) {
    const a = pickAudioVariant(opt.audioVariants, opt.lang);
    if (a) return { url: a.url, label: a.label };
  }
  return null;
}
// 从 #EXT-X-MEDIA 音频轨里选：按 AUDIO 组收敛 → 语言偏好 → DEFAULT → AUTOSELECT → 第一条
function pickRendition(rends, groupId, langPref) {
  let list = (rends || []).filter(function (r) { return !!r.url; });
  if (!list.length) return null;
  if (groupId) {
    const g = list.filter(function (r) { return r.groupId === groupId; });
    if (g.length) list = g;
  }
  const lp = String(langPref || "").toLowerCase();
  if (lp) {
    const hit =
      list.filter(function (r) { return String(r.lang || "").toLowerCase() === lp; })[0] ||
      list.filter(function (r) { return String(r.lang || "").toLowerCase().split("-")[0] === lp; })[0] ||
      list.filter(function (r) { return String(r.lang || "").toLowerCase().indexOf(lp) === 0; })[0];
    if (hit) return hit;
    flux.logger.warn("[m3u8-resolver] 未找到语言为「" + langPref + "」的音轨，回退默认轨");
  }
  return (
    list.filter(function (r) { return r.isDefault; })[0] ||
    list.filter(function (r) { return r.autoSelect; })[0] ||
    list[0]
  );
}
function pickAudioVariant(list, langPref) {
  if (!list || !list.length) return null;
  const lp = String(langPref || "").toLowerCase();
  if (lp) {
    const hit = list.filter(function (v) { return String(v.lang || "").toLowerCase().indexOf(lp) === 0; })[0];
    if (hit) return hit;
  }
  return list[0]; // 已按带宽降序
}

// ================= 增强 B：yt-dlp 抽直链 =================
async function resolveViaYtdlp(ctx) {
  flux.logger.info("[m3u8-resolver] 走 yt-dlp 委派:", ctx.url);
  const r = await flux.ytdlp.run({ args: ["-J", "--no-warnings", ctx.url] });
  if (r.code !== 0) throw new Error("yt-dlp 失败: " + (r.stderr || "").slice(-400));
  const info = JSON.parse(r.stdout);
  const direct = info.url || info.formats?.[info.formats.length - 1]?.url;
  if (!direct) throw new Error("yt-dlp 未返回直链");
  flux.logger.info("[m3u8-resolver] yt-dlp 直链:", direct.slice(0, 80));
  // yt-dlp 自带标题，优先级高于其他命名来源
  const base = info.title && !GENERIC_NAME_RE.test(sanitizeAssetName(info.title))
    ? sanitize(info.title)
    : nameFromUrl(ctx.url);
  const name = applyNameTemplate(base, partsFor(ctx, null, null));
  // yt-dlp 直链原样返回（广告过滤已停用，不再有任何 URL 改写环节）
  const out = {
    url: assertOutputUrl(direct, "yt-dlp 直链"),
    fileName: name,
    rangeSupported: true,
    ephemeral: settingBool("ephemeral", false),
  };
  const ah = authHeaders(ctx);
  out.extraHeaders = ah.extraHeaders;
  await markHandled(ctx.taskId);
  return out;
}

// ================= 返回构造 =================
// assertOutputUrl：把「无 scheme 的地址」在插件边界就拦下来。
// 引擎侧校验（manager.rs::check_output_url）是 `url.split(':').next()` 取 scheme，
// 不在 {http,https,ftp,magnet,ed2k} 白名单即整体拒绝本次 resolve。
// 我们宁可在此给出**可读的**错误，也不要让引擎抛「url scheme 不允许: video/avc1/6/media.m3u8」
// 这种难以定位的报错 —— 后者正是本插件历史上的故障表现。
const OUTPUT_SCHEMES = { http: 1, https: 1, ftp: 1, magnet: 1, ed2k: 1 };
function assertOutputUrl(u, what) {
  if (!u) return u;
  const s = String(u);
  // 与引擎同口径地取 scheme（第一个 ':' 之前），再比对白名单。
  // 注意：不能只认 `scheme://`——magnet:/ed2k: 没有 `//` 但合法。
  const ci = s.indexOf(":");
  const scheme = ci > 0 ? s.slice(0, ci).toLowerCase() : "";
  if (OUTPUT_SCHEMES[scheme]) return u;
  throw new Error(
    (what || "URL") + " 不是合法绝对地址（scheme=" + (scheme || "空") + "）: " + s.slice(0, 200) +
      " —— 通常意味着 playlist 里的相对路径未被成功绝对化，请附上该源地址反馈。"
  );
}
function finalize(ctx, url, fileName, audioUrl) {
  // 广告过滤已停用：顶层 url 不再经 maybeClean 改写，直接用解析得到的原始地址
  const out = { url: assertOutputUrl(url, "顶层 url") };
  if (fileName) out.fileName = fileName;
  if (audioUrl) out.audioUrl = assertOutputUrl(audioUrl, "audioUrl");
  const ah = authHeaders(ctx);
  out.extraHeaders = ah.extraHeaders;
  out.rangeSupported = true;
  out.ephemeral = settingBool("ephemeral", false);
  return out;
}
// ---- 命名 ----
// 「下载下来都是 video」的根因与修复（v1.4.0）：
//   该 m3u8 源在 /a/b/index.m3u8，旧逻辑 dirNameFromUrl 取末段 → 剥扩展名 → "index"；
//   播放页虽能从 <title> 拿到好名字，但**打开「自动选择」时命名的任务才带 fileName，
//   浏览器/下载器「下载时才解析」的时序下拿不到**，文件名交给 FluxDown 的默认策略
//   （取 <title>，站点没有 title 时回落 "video"）。hhuus 播放页确实无 <title>，故为 video。
//   修复三件事：
//     ① index/playlist/master/out 这类「无信息量」基础名不再采用，改为向上找上层目录名；
//     ② 默认模板改为 {title} {host}，把域名加进文件名（两个源都叫 index 时用于区分）；
//     ③ 站点无 <title> 时改用 URL 推导，而不是让核心回落 video。
//   ⚠️ 已知限制：若该任务在下载时**不会**调用插件 resolver（用户选「忽略插件」或链接
//   被核心缓存复用），插件无论如何都给不出文件名 —— 只能靠用户手改或关掉自动选择后重下。
const BASE_SUFFIX_RE = /(\.m3u8)+$/i;
const GENERIC_BASE_RE = /^(index|playlist|play|manifest|master|main|media|media_\d+|output|out|hls|video|stream|chunklist|default|segment\d*|file\d*|seg\d*|v\d+)$/i;
const GENERIC_NAME_RE = /^(index|playlist|play|manifest|master|main|output|out|hls|video|videos|stream|media|default|download|downloads|video_\d+|video\d+|m3u8|media_\d+)$/i;
const LEDGE_SEG_RE = /^(default|index|view|page|play|watch|video|videos|detail|info|show|vod|hls|player|playlist|source|movie|tv|drama|anime|episode|ep)$/i;
// 明显的 ID/哈希段（十六进制、含数字的长串）——当作剧集标识，可用于命名
const ID_SEG_RE = /^(?=.*[0-9])[0-9a-f_-]{12,}$/i;

// 从 URL 推导文件名；实在没有有意义的名字时才返回 "video"
function nameFromUrl(u) {
  const p = parseUrl(u);
  if (!p) return "video";
  const seg = p.pathname.split("/").filter(Boolean);
  if (!seg.length) return "video";
  const last = seg[seg.length - 1];
  const base = sanitizeAssetName(last.replace(BASE_SUFFIX_RE, ""));
  if (base && !GENERIC_BASE_RE.test(base)) return base; // ① 文件名本身有信息量
  // ② 向上找第一个「ID 段」——优先（hex 用原样小写，非 hex 的纯数字段带 _id 后缀）
  for (let i = seg.length - 2; i >= 0; i--) {
    const raw = String(seg[i] == null ? "" : seg[i]);
    const s = sanitizeAssetName(raw);
    if (s && ID_SEG_RE.test(s)) return HEX_ONLY_RE.test(raw) ? s.toLowerCase() : s + "_id";
  }
  // ③ 再退一步：取上层非通用目录名
  for (let i = seg.length - 2; i >= 0; i--) {
    const s = sanitizeAssetName(seg[i]);
    if (s && !LEDGE_SEG_RE.test(s) && !GENERIC_BASE_RE.test(s)) return s;
  }
  return "video"; // ③ 全无可用的信息段时才回落兜底词（index/playlist 等不作名字）
}
const HEX_ONLY_RE = /^[0-9a-f]+$/i;
// 与 sanitize 同规则，但空白转 "_"、上限 80 字符，且不返回兜底词（无信息量时返回 ""）
function sanitizeAssetName(s) {
  const t = String(s == null ? "" : s)
    .replace(/[\\/:*?"<>|\n\r\t]+/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  return t;
}
function nameFor(pageTitle, ctx, variant, audio) {
  let base = sanitizeAssetName(pageTitle || "");
  if (base && GENERIC_NAME_RE.test(base)) base = ""; // 标题若就是 "视频"/"video"，视为无信息量
  if (!base) {
    const f = ctx && ctx.fileName ? sanitizeAssetName(String(ctx.fileName)) : "";
    if (f && !GENERIC_NAME_RE.test(f)) base = f;
  }
  if (!base) base = nameFromUrl(ctx && ctx.url); // 站点无可用标题 → URL 推导，避免核心回落 video
  const parts = partsFor(ctx, variant, audio);
  return applyNameTemplate(base, parts, ctx);
}
function partsFor(ctx, variant, audio) {
  return {
    res: variant && variant.width && variant.height ? variant.width + "x" + variant.height : "",
    lang: audio && audio.label ? String(audio.label) : "",
    host: hostOf((ctx && ctx.referrer) || (ctx && ctx.url)),
    date: today(),
  };
}
function applyNameTemplate(base, parts, ctx) {
  const tpl = settingStr("nameTemplate", "{title} {host}").trim();
  if (!tpl || tpl === "{title}") return base; // 显式 {title} = 不加站点后缀
  const host = parts.host || hostOf(ctx && ctx.url) || "";
  let s = tpl
    .replace(/\{title\}/gi, base || "")
    .replace(/\{res\}/gi, parts.res || "")
    .replace(/\{lang\}/gi, parts.lang || "")
    .replace(/\{host\}/gi, host)
    .replace(/\{date\}/gi, parts.date || "");
  s = s.replace(/\{[a-z]+\}/gi, "").replace(/\s{2,}/g, " ").trim(); // 清掉未知占位造成的空隙
  return sanitizeAssetName(s) || base;
}
function today() {
  try {
    const d = new Date();
    const p = function (n) { return (n < 10 ? "0" : "") + n; };
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate());
  } catch (e) {
    return "";
  }
}
function hostOf(u) {
  const p = parseUrl(u);
  return p ? p.hostname.replace(/^www\./i, "") : "";
}

// ================= 站点解析（情况 B 需按目标站定制）=================
function extractMaster(html, base) {
  // TODO: 按你目标站的实际结构，从 html 里抠出 master.m3u8 的绝对地址。
  // 下面是兜底正则，多数简单站点可用，复杂站点请替换为精确解析。
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
// 站点没有 <title> 的定向提示：这类站后续会被 FluxDown 核心按「无名」处理（默认 video）
function warnNoTitle(ctx) {
  flux.logger.warn(
    "[m3u8-resolver] 页面无 <title>，无法取出片名；改用 URL 推导。" +
      "若成品名仍不理想，请在设置里用「命名模板」加 {host}，或手动改名。"
  );
}
function extractTitle(html) {
  const m = String(html || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return null;
  // 去掉常见的「标题 - 站点名」后缀，保留主体
  const base = m[1].replace(/\s*[-|·–—|｜]\s*[^|]*$/i, "").trim();
  return sanitize(base) || null;
}

// ================= 通用解析 =================
const RE_AUDIO_CODEC = /(mp4a|ac-3|ec-3|ac-4|opus|vorbis|flac|dtsc|dtsh|dtsl|dtse|mp3)/i;
const RE_VIDEO_CODEC = /(avc1|avc3|hvc1|hev1|av01|vp09|vp9|vp08|vp8|dvh1|dvhe|mp4v)/i;

function isPlaylistUrl(u) {
  return /\.m3u8(\?|$)/i.test(String(u || ""));
}
// 合法 playlist 必须有 #EXTM3U
function isPlaylistBody(body) {
  return !!body && /#EXTM3U/i.test(body);
}
function isMediaPlaylist(body) {
  if (!body) return false;
  return /#EXTINF/i.test(body) && !/#EXT-X-STREAM-INF/i.test(body);
}
// 伪 m3u8：抓回的是 HTML 页面（登录页 / 防盗链拦截页 / WAF 拦截页）
function looksLikeHtml(body) {
  if (!body) return false;
  const head = String(body).slice(0, 4096).replace(/^\uFEFF/, "").replace(/^\s+/, "").toLowerCase();
  if (head.indexOf("<!doctype html") === 0 || head.indexOf("<html") === 0) return true;
  if (!/#extm3u/i.test(String(body).slice(0, 8192)) && /<html|<head|<body|<script|<div/i.test(head)) return true;
  return false;
}
// HLS 标签属性解析：KEY=VALUE，值可带引号（引号内可含逗号、空格）
function parseAttrs(s) {
  const out = {};
  const re = /([A-Za-z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(String(s || "")))) {
    let v = m[2];
    if (v.length >= 2 && v.charAt(0) === '"' && v.charAt(v.length - 1) === '"') v = v.slice(1, -1);
    out[m[1].toUpperCase()] = v;
  }
  return out;
}
// playlist 行分割：统一处理 LF / CRLF / CR 三种行尾，并剥掉行首 BOM 与
// 行尾残余控制字符（\r、\v、\f、\0）。放这里是因为 m3u8 由各厂 CDN 生成，
// 行尾风格不统一（实测 Bento4 产物为 CRLF，部分 CDN 为纯 CR）。
// 若不剥残余 \r，URI 行会带尾字符 → 正则/拼接结果被污染（历史故障源之一）。
function splitLines(body) {
  const s = String(body == null ? "" : body).replace(/^\uFEFF/, "");
  const rawLines = s.split(/\r\n|\r|\n/);
  const out = [];
  for (let i = 0; i < rawLines.length; i++) out.push(rawLines[i].replace(/[\u0000-\u001F\u007F]+$/g, "").trim());
  return out;
}
// ---------- 加密方式体检（只读、只记日志；不改写 playlist、不改下载行为） ----------
// 引擎（native/engine/src/hls_downloader.rs）只实现 NONE 与 AES-128 两种方法，
// 其余 method 在解析阶段即被拒绝：`unsupported HLS encryption method: Other("…")`。
// 这里只是把「源用的是哪种加密」提前说清楚，便于定位，避免把引擎/上游的问题误判为插件问题。
const ENGINE_SUPPORTED_METHODS = { NONE: 1, "AES-128": 1 };
// 已知 DRM 体系的 KEYFORMAT（urn:uuid:… / com.*）：无 CDM 与许可证时任何工具都无法解密
const DRM_KEYFORMAT_RE = new RegExp(
  "(" + [
    "edef8ba9-79d6-4ace-a3c8-27dcd51d21ed", // Widevine
    "94ce86fb-07ff-4f43-adb8-93d2fa968ca2", // FairPlay
    "9a04f079-9840-4286-ab92-e65be0885f95", // PlayReady
    "com\\.apple\\.streamingkeydelivery",
    "com\\.microsoft\\.playready",
    "com\\.widevine",
  ].join("|") + ")",
  "i"
);
function encryptionProfile(body) {
  const lines = splitLines(body);
  const methods = {};
  const keyformats = {};
  let seenAes = false;
  let noneAfterAes = false;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (ln.toUpperCase().indexOf("#EXT-X-KEY:") !== 0) continue;
    const a = parseAttrs(ln.slice(11));
    const m = String(a.METHOD || "").toUpperCase();
    if (!m) continue;
    methods[m] = (methods[m] || 0) + 1;
    if (a.KEYFORMAT) keyformats[a.KEYFORMAT] = 1;
    if (m === "AES-128") seenAes = true;
    // RFC 8216：NONE 用于把「上一段仍是 AES-128」的分片切回明文。引擎能否正确处理
    // 取决于解析库是否认得这个标签 —— 见下方 noteEncryption 的上游缺陷说明。
    if (m === "NONE" && seenAes) noneAfterAes = true;
  }
  const names = Object.keys(methods);
  const kfs = Object.keys(keyformats);
  return {
    methods: methods,
    keyformats: kfs,
    unsupported: names.filter(function (m) { return !ENGINE_SUPPORTED_METHODS[m]; }),
    drm: kfs.filter(function (k) { return DRM_KEYFORMAT_RE.test(k); }),
    noneAfterAes: noneAfterAes,
  };
}
function noteEncryption(ctx, body) {
  let p;
  try {
    p = encryptionProfile(body);
  } catch (e) {
    return; // 体检本身绝不干扰主流程
  }
  const used = Object.keys(p.methods);
  if (!used.length) return; // 未加密

  flux.logger.info(
    "[m3u8-resolver] 加密方式: " + used.map(function (m) { return m + "×" + p.methods[m]; }).join(", ") +
      (p.keyformats.length ? "；KEYFORMAT=" + p.keyformats.join(",") : "")
  );

  if (p.unsupported.length) {
    flux.logger.warn(
      "[m3u8-resolver] 该流使用引擎不支持的加密方式：" + p.unsupported.join(",") +
        "（引擎仅支持 NONE / AES-128）。下载阶段会报 " +
        '"unsupported HLS encryption method" —— 属引擎能力边界，不是插件问题。'
    );
  }
  if (p.drm.length) {
    flux.logger.warn(
      "[m3u8-resolver] 检测到 DRM 体系： " + p.drm.join(",") +
        "。这是受版权保护的内容，需要 CDM + 许可证服务器才能解密，任何下载工具都无法绕过。"
    );
  }
  if (p.noneAfterAes) {
    flux.logger.warn(
      "[m3u8-resolver] 该流在 AES-128 段之后出现 #EXT-X-KEY:METHOD=NONE（切回明文段）。" +
        "已知上游缺陷：m3u8-rs 6.0.1 的 Key::from_hashmap 把 IV 校验写反了" +
        "（method==None && iv.is_none() 时反而报错），导致 METHOD=NONE 标签被降级为未知标签、" +
        "引擎的粘性密钥不重置，明文段被错误地用上一段的 AES-128 密钥解密 → " +
        "引擎报 decrypt_segment: … PKCS7 decrypt error (Unpad Error)。" +
        "插件不改写 playlist 内容，无法规避；需上游修复（详见 docs/upstream-m3u8-rs-method-none.md）。"
    );
  }
}

function parseMaster(body, base) {
  const lines = splitLines(body);
  const variants = [];
  const renditions = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw) continue;
    const colon = raw.indexOf(":");

    if (raw.indexOf("#EXT-X-MEDIA:") === 0) {
      const a = parseAttrs(raw.slice(colon + 1));
      const type = String(a.TYPE || "").toUpperCase();
      const rec = {
        type: type,
        groupId: a["GROUP-ID"] || "",
        name: a.NAME || "",
        lang: a.LANGUAGE || "",
        isDefault: String(a.DEFAULT || "").toUpperCase() === "YES",
        autoSelect: String(a.AUTOSELECT || "").toUpperCase() === "YES",
        forced: String(a.FORCED || "").toUpperCase() === "YES",
        channels: a.CHANNELS || "",
        uri: a.URI || "",
      };
      rec.url = rec.uri ? absUrl(rec.uri, base) : ""; // 无 URI = 音轨已在视频流内（in-band），不可分离
      renditions.push(rec);
      continue;
    }

    if (raw.indexOf("#EXT-X-STREAM-INF:") === 0) {
      const a = parseAttrs(raw.slice(colon + 1));
      let u = "";
      for (let j = i + 1; j < lines.length; j++) {
        const t = lines[j];
        if (!t) continue;
        if (t.charAt(0) === "#") break;
        u = t;
        break;
      }
      if (!u) continue;
      const rm = String(a.RESOLUTION || "").match(/(\d+)\s*x\s*(\d+)/i);
      const bw = a.BANDWIDTH || a["AVERAGE-BANDWIDTH"] || "";
      const v = {
        url: absUrl(u, base),
        bandwidth: bw ? +bw : 0,
        width: rm ? +rm[1] : 0,
        height: rm ? +rm[2] : 0,
        codecs: a.CODECS || "",
        lang: a.LANGUAGE || a.NAME || "",
        audioGroup: a.AUDIO || "",
        frameRate: a["FRAME-RATE"] || "",
      };
      v.label = variantLabel(v);
      variants.push(v);
      continue;
    }
  }
  variants.sort(function (x, y) { return y.bandwidth - x.bandwidth; }); // 降序，便于 "best" 取最高
  return {
    variants: variants,
    audioRenditions: renditions.filter(function (r) { return r.type === "AUDIO"; }),
    subtitleRenditions: renditions.filter(function (r) { return r.type === "SUBTITLES"; }),
  };
}
function isAudioOnlyVariant(v) {
  const c = v && v.codecs ? String(v.codecs) : "";
  if (!c) return false;
  return RE_AUDIO_CODEC.test(c) && !RE_VIDEO_CODEC.test(c);
}
function codecShort(c) {
  if (!c) return "";
  const s = String(c).toLowerCase();
  const out = [];
  if (/avc1|avc3/.test(s)) out.push("H.264");
  else if (/hvc1|hev1|dvh/.test(s)) out.push("H.265");
  else if (/av01/.test(s)) out.push("AV1");
  else if (/vp0?9|vp8/.test(s)) out.push("VP9");
  else if (/mp4v/.test(s)) out.push("MP4V");
  if (/mp4a/.test(s)) out.push("AAC");
  else if (/ec-3|ac-3|ac-4/.test(s)) out.push("AC3");
  else if (/opus/.test(s)) out.push("Opus");
  else if (/flac/.test(s)) out.push("FLAC");
  return out.join("+");
}
function variantLabel(v) {
  const parts = [];
  if (v.width && v.height) parts.push(v.width + "x" + v.height);
  if (v.bandwidth) parts.push(fmtBw(v.bandwidth));
  const cs = codecShort(v.codecs);
  if (cs) parts.push(cs);
  const head = isAudioOnlyVariant(v) ? "音频" + (v.lang ? " " + v.lang : "") : "";
  if (head) return parts.length ? head + " (" + parts.join(" ") + ")" : head;
  return parts.length ? parts.join(" ") : "variant";
}
// 选默认变体：先按编码偏好收敛候选（不改动返回数组，用户仍可在画质框里选其他），
// 再按画质偏好。修复点：旧版拿「宽度」与偏好比较（1920 <= 1080 为假），
// 导致选 1080p 时跳过 1080 与 720、错落到 480p —— 现改用高度比较。
function pickVariant(variants, pref, codecPref) {
  let pool = variants.map(function (v, i) { return { v: v, i: i }; });
  if (codecPref && codecPref !== "auto") {
    const f = pool.filter(function (x) { return codecMatches(x.v.codecs, codecPref); });
    if (f.length) pool = f;
  }
  if (!pool.length) return 0;
  if (!pref || pref === "best") return pool[0].i;
  const want = +pref || 0;
  if (!want) return pool[0].i;
  let pick = pool[0];
  for (let k = 0; k < pool.length; k++) {
    pick = pool[k];
    const h = pool[k].v.height || 0;
    if (h <= want) break; // 降序数组里第一个不高于偏好的（无 RESOLUTION 时 h=0 → 取最高，与旧行为一致）
  }
  return pick.i;
}
function codecMatches(codecs, pref) {
  const c = String(codecs || "").toLowerCase();
  if (!c) return false;
  if (pref === "avc" || pref === "h264") return /avc1|avc3/.test(c);
  if (pref === "hevc" || pref === "h265") return /hvc1|hev1|dvh/.test(c);
  if (pref === "av01" || pref === "av1") return /av01/.test(c);
  if (pref === "vp9" || pref === "vp09") return /vp09|vp9/.test(c);
  return false;
}
function fmtBw(bw) {
  const n = +bw || 0;
  return n >= 1000 ? n / 1000 + "k" : "" + n;
}
function safeOrigin(u) {
  const p = parseUrl(u);
  return p ? p.origin : "";
}
// ================= 零依赖 URL 工具层（★ 最重要的一层，勿改为 new URL） =================
// 背景（2026-09-30 在**真实 QuickJS** 沙箱中实测确认）：
//   FluxDown 的插件沙箱里 **`URL` 这个全局对象根本不存在**（`typeof URL === "undefined"`）。
//   因此任何 `new URL(...)` 都会抛 ReferenceError：
//     - 若在 try/catch 里 → 被静默吞掉，函数退化为「返回入参」或「返回空串」；
//     - 若在 try/catch 外 → 直接把 resolve 打挂。
//   旧版 absUrl() 的「手动兜底」正是在第二段 try 里又调了 new URL(base)，
//   于是永远走 catch 返回原始相对串 → 引擎报 `url scheme 不允许: <相对路径>`。
//   同一个坑还静默打瘫了 nameFromUrl / hostOf / safeOrigin / inScope。
//   ⇒ 本文件自此**禁止**使用 `new URL`，一律走下列自实现解析。
//
// 解析结果形状与 URL 对象保持兼容（origin/host/hostname/pathname/protocol 等），
// 便于调用点语义不变。解析失败返回 null，由调用方决定兜底。
function parseUrl(u) {
  const s = String(u == null ? "" : u).trim();
  // scheme://authority/path?query#fragment   （agent 部分一并归入 authority，够用）
  const m = /^([a-zA-Z][a-zA-Z0-9+.\-]*):\/\/([^/?#]*)([^?#]*)(\?[^#]*)?(#[\s\S]*)?$/.exec(s);
  if (!m) return null;
  const protocol = m[1].toLowerCase() + ":";
  const authority = m[2];
  const pathname = m[3] || "/";
  const search = m[4] || "";
  const hash = m[5] || "";
  const at = authority.lastIndexOf("@");
  const userinfo = at >= 0 ? authority.slice(0, at) : "";
  let hostport = at >= 0 ? authority.slice(at + 1) : authority;
  let username = "";
  let password = "";
  if (userinfo) {
    const ci = userinfo.indexOf(":");
    username = ci >= 0 ? userinfo.slice(0, ci) : userinfo;
    password = ci >= 0 ? userinfo.slice(ci + 1) : "";
  }
  // IPv6 字面量 [::1]:8080
  let hostname = "";
  let port = "";
  if (hostport.charAt(0) === "[") {
    const close = hostport.indexOf("]");
    if (close >= 0) {
      hostname = hostport.slice(0, close + 1);
      const rest = hostport.slice(close + 1);
      if (rest.charAt(0) === ":") port = rest.slice(1);
    } else hostname = hostport;
  } else {
    const ci = hostport.indexOf(":");
    hostname = ci >= 0 ? hostport.slice(0, ci) : hostport;
    port = ci >= 0 ? hostport.slice(ci + 1) : "";
  }
  const host = hostname + (port ? ":" + port : "");
  return {
    protocol: protocol,
    hostname: hostname.toLowerCase(),
    port: port,
    host: host.toLowerCase(),
    origin: protocol + "//" + host,
    pathname: pathname,
    search: search,
    hash: hash,
    username: username,
    password: password,
    href: protocol + "//" + authority + pathname + search + hash,
  };
}
// 绝对地址判定（与 Rust 侧引擎的语义对齐：必须带 `scheme://`）
const ABS_URL_RE = /^[a-zA-Z][a-zA-Z0-9+.\-]*:\/\//;
function isAbsUrl(u) {
  return ABS_URL_RE.test(String(u == null ? "" : u));
}
// 把 m3u8 里的相对地址解析成绝对地址。
// 关键：**完全不依赖 URL 全局对象**（沙箱里不存在，见上）。纯字符串运算。
//   支持：① 已是绝对地址；② 协议相对 `//host/path`；③ 站点根绝对 `/a/b`；
//         ④ 相对路径 `a/b`、`./a`、`../a`；⑤ 带 query/hash。
function absUrl(u, base) {
  if (!u) return u;
  if (isAbsUrl(u)) return u;                       // 已是绝对地址
  if (!isAbsUrl(base)) return u;                   // base 非法 → 无法合成（调用方需保证）
  const b = parseUrl(base);
  if (!b) return u;
  const rel = String(u).trim();
  if (rel.indexOf("//") === 0) return b.protocol + rel;   // 协议相对
  // 拆出 path / query / hash，逐段规范化
  let path = rel;
  let tail = "";
  const hashAt = path.indexOf("#");
  if (hashAt >= 0) { tail = path.slice(hashAt) + tail; path = path.slice(0, hashAt); }
  const qAt = path.indexOf("?");
  if (qAt >= 0) { tail = path.slice(qAt) + tail; path = path.slice(0, qAt); }
  if (path.charAt(0) !== "/") path = b.pathname.replace(/[^/]*$/, "") + path; // 相对当前目录
  const norm = [];
  const segs = path.split("/");
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (s === "" || s === ".") continue;
    if (s === "..") norm.pop();
    else norm.push(s);
  }
  const last = segs[segs.length - 1];
  const trailingSlash = last === "" || last === "." || last === "..";
  return b.origin + "/" + norm.join("/") + (trailingSlash && norm.length ? "/" : "") + tail;
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
  const raw = settingStr("targetHosts", "").trim();
  if (!raw) return false; // 未配置目标站 → 不处理页面
  const hosts = raw.split(",").map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean);
  const p = parseUrl(ctx.url);
  if (!p) return false;
  const h = p.hostname;
  return hosts.some(function (x) { return h === x || h.endsWith("." + x); });
}
