import type { ResolveCtx } from "../types";
import type { Settings } from "./settings";
import type { Variant } from "./hls";
import { hostKey, parseUrl } from "./url";

/**
 * 命名决策链（v1.4.0 起，对应上游 #568/#301）。
 *
 * 「下载下来都是 video」的根因：源在 /a/b/index.m3u8 时旧逻辑取末段 `index`；播放页虽能从
 * `<title>` 拿到好名字，但**只有开了「自动选择」的任务才带 fileName**，浏览器「下载时才解析」
 * 的时序拿不到，名字落到引擎默认策略（取 title，站点无 title 时回落 "video"）。
 * 修复三件事：① index/playlist/master 这类无信息量基础名不再采用，向上找目录名；
 * ② 默认模板 {title} {host}，两个源都叫 index 时靠域名区分；③ 站点无 title 时改用 URL 推导。
 *
 * ⚠️ 已知限制：若该任务下载时**不会**调用插件 resolver（用户选「忽略插件」或引擎缓存复用），
 *    插件无论如何给不出文件名 —— 只能靠用户手改，或关掉自动选择后重下。
 */

const BASE_SUFFIX_RE = /(\.m3u8)+$/i;
const GENERIC_BASE_RE =
  /^(index|playlist|play|manifest|master|main|media|media_\d+|output|out|hls|video|stream|chunklist|default|segment\d*|file\d*|seg\d*|v\d+)$/i;
export const GENERIC_NAME_RE =
  /^(index|playlist|play|manifest|master|main|output|out|hls|video|videos|stream|media|default|download|downloads|video_\d+|video\d+|m3u8|media_\d+)$/i;
const LEDGE_SEG_RE =
  /^(default|index|view|page|play|watch|video|videos|detail|info|show|vod|hls|player|playlist|source|movie|tv|drama|anime|episode|ep)$/i;
/** 明显的 ID/哈希段（十六进制、含数字的长串）—— 当作剧集标识，可用于命名。 */
const ID_SEG_RE = /^(?=.*[0-9])[0-9a-f_-]{12,}$/i;
const HEX_ONLY_RE = /^[0-9a-f]+$/i;

/** 与 sanitize 同规则，但空白转 `_`、上限 80 字符，且**不返回兜底词**（无信息量时返回 ""）。 */
export function sanitizeAssetName(s: string | null | undefined): string {
  return String(s == null ? "" : s)
    .replace(/[\\/:*?"<>|\n\r\t]+/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

/** 从 URL 推导文件名；实在没有有意义的名字时才返回 "video"。 */
export function nameFromUrl(u: string | null | undefined): string {
  const p = parseUrl(u);
  if (!p) return "video";
  const seg = p.pathname.split("/").filter(Boolean);
  if (!seg.length) return "video";
  const last = seg[seg.length - 1];
  const base = sanitizeAssetName(last.replace(BASE_SUFFIX_RE, ""));
  if (base && !GENERIC_BASE_RE.test(base)) return base; // ① 文件名本身有信息量
  // ② 向上找第一个「ID 段」—— 优先（hex 用原样小写，非 hex 的纯数字段带 _id 后缀）
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

// 局部取参：避免 naming → url 之外再引一圈（parseUrl 本身是纯函数，直接复用）
export interface NameParts {
  res: string;
  lang: string;
  host: string;
  date: string;
}

export function partsFor(ctx: ResolveCtx, variant: Variant | null, audio: AudioPick | null): NameParts {
  return {
    res: variant && variant.width && variant.height ? variant.width + "x" + variant.height : "",
    lang: audio && audio.label ? String(audio.label) : "",
    host: hostKey(ctx.referrer || ctx.url),
    date: today(),
  };
}

export interface AudioPick {
  url: string;
  label?: string;
}

/** 四层取值链：页面标题 → ctx.fileName → URL 推导 → 模板套用。 */
export function nameFor(
  s: Settings,
  ctx: ResolveCtx,
  pageTitle: string | null,
  variant: Variant | null,
  audio: AudioPick | null,
): string {
  let base = sanitizeAssetName(pageTitle || "");
  if (base && GENERIC_NAME_RE.test(base)) base = ""; // 标题就是 "视频"/"video" → 视为无信息量
  if (!base) {
    const f = ctx.fileName ? sanitizeAssetName(String(ctx.fileName)) : "";
    if (f && !GENERIC_NAME_RE.test(f)) base = f;
  }
  if (!base) base = nameFromUrl(ctx.url); // 站点无可用标题 → URL 推导，避免引擎回落 video
  const parts = partsFor(ctx, variant, audio);
  return applyNameTemplate(s, base, parts, ctx);
}

export function applyNameTemplate(s: Settings, base: string, parts: NameParts, ctx: ResolveCtx): string {
  const tpl = s.nameTemplate.trim();
  if (!tpl || tpl === "{title}") return base; // 显式 {title} = 不加站点后缀
  const host = parts.host || hostKey(ctx.url) || "";
  let out = tpl
    .replace(/\{title\}/gi, base || "")
    .replace(/\{res\}/gi, parts.res || "")
    .replace(/\{lang\}/gi, parts.lang || "")
    .replace(/\{host\}/gi, host)
    .replace(/\{date\}/gi, parts.date || "");
  out = out.replace(/\{[a-z]+\}/gi, "").replace(/\s{2,}/g, " ").trim(); // 清掉未知占位造成的空隙
  return sanitizeAssetName(out) || base;
}

export function today(): string {
  try {
    const d = new Date();
    const p = (n: number) => (n < 10 ? "0" : "") + n;
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate());
  } catch {
    return "";
  }
}

/** 引擎 `check_file_name` 会拒收含 `..`、`/`、`\`、控制字符的名字；sanitizeAssetName 之外再补这三类。 */
export function safeFileName(s: string | null | undefined): string {
  let t = String(s == null ? "" : s).replace(/[\u0000-\u001F\u007F]/g, "");
  t = sanitizeAssetName(t);
  t = t.replace(/\.{2,}/g, "_");
  t = t.replace(/^\.+/, "");
  return t.slice(0, 100);
}

/** 同层重名追加 `_2` / `_3`（清单条目名即子任务文件名，重名会互相覆盖）。 */
export function uniqueName(base: string, used: Record<string, number>): string {
  let nm = base || "video";
  if (!/\.(?:mp4|ts|mkv|webm|m4a)$/i.test(nm)) nm += ".mp4"; // HLS 产物最终是 mp4，先给对扩展名
  const dot = nm.lastIndexOf(".");
  const stem = dot > 0 ? nm.slice(0, dot) : nm;
  const ext = dot > 0 ? nm.slice(dot) : "";
  if (used[stem] === undefined) {
    used[stem] = 1;
    return nm;
  }
  used[stem]++;
  return stem + "_" + used[stem] + ext;
}
