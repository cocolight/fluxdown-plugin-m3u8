import { absUrl } from "./url";

/** 一条 `#EXT-X-STREAM-INF` 变体。 */
export interface Variant {
  url: string;
  bandwidth: number;
  width: number;
  height: number;
  codecs: string;
  lang: string;
  audioGroup: string;
  frameRate: string;
  label: string;
}

/** 一条 `#EXT-X-MEDIA`  rendition（AUDIO / SUBTITLES）。 */
export interface Rendition {
  type: string;
  groupId: string;
  name: string;
  lang: string;
  isDefault: boolean;
  autoSelect: boolean;
  forced: boolean;
  channels: string;
  uri: string;
  url: string;
}

export interface Master {
  variants: Variant[];
  audioRenditions: Rendition[];
  subtitleRenditions: Rendition[];
}

export const RE_AUDIO_CODEC = /(mp4a|ac-3|ec-3|ac-4|opus|vorbis|flac|dtsc|dtsh|dtsl|dtse|mp3)/i;
export const RE_VIDEO_CODEC = /(avc1|avc3|hvc1|hev1|av01|vp09|vp9|vp08|vp8|dvh1|dvhe|mp4v)/i;

// ---------------------------------------------------------------------------
// playlist 形态判定
// ---------------------------------------------------------------------------

export function isPlaylistUrl(u: string | null | undefined): boolean {
  return /\.m3u8(\?|$)/i.test(String(u || ""));
}

/**
 * DASH 清单（`.mpd`）判定。与 isPlaylistUrl 并列但**语义不同**：
 * isPlaylistUrl 命中 → 抓取并解析 `#EXTM3U`；isDashUrl 命中 → 直接返回该直链交给核心
 * DASH 引擎，插件**不抓取、不读内容**。两者不能合并。
 */
export function isDashUrl(u: string | null | undefined): boolean {
  return /\.mpd(\?|$)/i.test(String(u || ""));
}

/** 「是否直接给定清单地址」：HLS 或 DASH 直链都算。 */
export function isManifestUrl(u: string | null | undefined): boolean {
  return isPlaylistUrl(u) || isDashUrl(u);
}

/** 合法 playlist 必须有 `#EXTM3U`。 */
export function isPlaylistBody(body: string | null | undefined): boolean {
  return !!body && /#EXTM3U/i.test(body);
}

export function isMediaPlaylist(body: string | null | undefined): boolean {
  if (!body) return false;
  return /#EXTINF/i.test(body) && !/#EXT-X-STREAM-INF/i.test(body);
}

/** 伪 m3u8：抓回的是 HTML 页面（登录页 / 防盗链拦截页 / WAF 拦截页）。 */
export function looksLikeHtml(body: string | null | undefined): boolean {
  if (!body) return false;
  const head = String(body).slice(0, 4096).replace(/^\uFEFF/, "").replace(/^\s+/, "").toLowerCase();
  if (head.indexOf("<!doctype html") === 0 || head.indexOf("<html") === 0) return true;
  if (!/#extm3u/i.test(String(body).slice(0, 8192)) && /<html|<head|<body|<script|<div/i.test(head)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

/** HLS 标签属性解析：KEY=VALUE，值可带引号（引号内可含逗号、空格）。 */
export function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([A-Za-z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(String(s || "")))) {
    let v = m[2];
    if (v.length >= 2 && v.charAt(0) === '"' && v.charAt(v.length - 1) === '"') v = v.slice(1, -1);
    out[m[1].toUpperCase()] = v;
  }
  return out;
}

/**
 * 统一处理 LF / CRLF / CR 三种行尾，并剥掉行首 BOM 与行尾残余控制字符（\r、\v、\f、\0）。
 * m3u8 由各厂 CDN 生成，行尾风格不统一（实测 Bento4 产物为 CRLF，部分 CDN 为纯 CR）。
 * 不剥残余 `\r`，URI 行会带尾字符 → 拼接结果被污染（历史故障源之一）。
 */
export function splitLines(body: string | null | undefined): string[] {
  const s = String(body == null ? "" : body).replace(/^\uFEFF/, "");
  const rawLines = s.split(/\r\n|\r|\n/);
  const out: string[] = [];
  for (let i = 0; i < rawLines.length; i++) out.push(rawLines[i].replace(/[\u0000-\u001F\u007F]+$/g, "").trim());
  return out;
}

export function parseMaster(body: string, base: string): Master {
  const lines = splitLines(body);
  const variants: Variant[] = [];
  const renditions: Rendition[] = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw) continue;
    const colon = raw.indexOf(":");

    if (raw.indexOf("#EXT-X-MEDIA:") === 0) {
      const a = parseAttrs(raw.slice(colon + 1));
      const rec: Rendition = {
        type: String(a.TYPE || "").toUpperCase(),
        groupId: a["GROUP-ID"] || "",
        name: a.NAME || "",
        lang: a.LANGUAGE || "",
        isDefault: String(a.DEFAULT || "").toUpperCase() === "YES",
        autoSelect: String(a.AUTOSELECT || "").toUpperCase() === "YES",
        forced: String(a.FORCED || "").toUpperCase() === "YES",
        channels: a.CHANNELS || "",
        uri: a.URI || "",
        url: "",
      };
      rec.url = rec.uri ? absUrl(rec.uri, base) : ""; // 无 URI = 音轨已 in-band，不可分离
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
      const v: Variant = {
        url: absUrl(u, base),
        bandwidth: bw ? +bw : 0,
        width: rm ? +rm[1] : 0,
        height: rm ? +rm[2] : 0,
        codecs: a.CODECS || "",
        lang: a.LANGUAGE || a.NAME || "",
        audioGroup: a.AUDIO || "",
        frameRate: a["FRAME-RATE"] || "",
        label: "",
      };
      v.label = variantLabel(v);
      variants.push(v);
      continue;
    }
  }
  variants.sort((x, y) => y.bandwidth - x.bandwidth); // 降序，便于 "best" 取最高
  return {
    variants,
    audioRenditions: renditions.filter((r) => r.type === "AUDIO"),
    subtitleRenditions: renditions.filter((r) => r.type === "SUBTITLES"),
  };
}

export function isAudioOnlyVariant(v: Variant | null | undefined): boolean {
  const c = v && v.codecs ? String(v.codecs) : "";
  if (!c) return false;
  return RE_AUDIO_CODEC.test(c) && !RE_VIDEO_CODEC.test(c);
}

function codecShort(c: string): string {
  if (!c) return "";
  const s = String(c).toLowerCase();
  const out: string[] = [];
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

export function variantLabel(v: Variant): string {
  const parts: string[] = [];
  if (v.width && v.height) parts.push(v.width + "x" + v.height);
  if (v.bandwidth) parts.push(fmtBw(v.bandwidth));
  const cs = codecShort(v.codecs);
  if (cs) parts.push(cs);
  const head = isAudioOnlyVariant(v) ? "音频" + (v.lang ? " " + v.lang : "") : "";
  if (head) return parts.length ? head + " (" + parts.join(" ") + ")" : head;
  return parts.length ? parts.join(" ") : "variant";
}

function fmtBw(bw: number): string {
  const n = +bw || 0;
  return n >= 1000 ? n / 1000 + "k" : "" + n;
}

/**
 * 选默认变体：先按编码偏好收敛候选（**不改动返回数组**，用户仍可在画质框里选其他），再按画质偏好。
 * 修复点：旧版拿「宽度」与偏好比较（1920 <= 1080 为假），选 1080p 时会跳过 1080 与 720
 * 错落到 480p —— 现改用高度比较。
 */
export function pickVariant(variants: Variant[], pref: string, codecPref: string): number {
  let pool = variants.map((v, i) => ({ v, i }));
  if (codecPref && codecPref !== "auto") {
    const f = pool.filter((x) => codecMatches(x.v.codecs, codecPref));
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

export function codecMatches(codecs: string, pref: string): boolean {
  const c = String(codecs || "").toLowerCase();
  if (!c) return false;
  if (pref === "avc" || pref === "h264") return /avc1|avc3/.test(c);
  if (pref === "hevc" || pref === "h265") return /hvc1|hev1|dvh/.test(c);
  if (pref === "av01" || pref === "av1") return /av01/.test(c);
  if (pref === "vp9" || pref === "vp09") return /vp09|vp9/.test(c);
  return false;
}

// ---------------------------------------------------------------------------
// 加密方式体检（只读、只记日志；不改写 playlist、不影响下载行为）
// ---------------------------------------------------------------------------

/**
 * 引擎只实现 NONE 与 AES-128，其余 method 在解析阶段即被拒绝
 * （`unsupported HLS encryption method: Other("…")`）。这里只是把「源用的是哪种加密」
 * 提前说清楚，避免把引擎/上游的问题误判成插件问题。
 */
const ENGINE_SUPPORTED_METHODS: Record<string, number> = { NONE: 1, "AES-128": 1 };

/** 已知 DRM 体系的 KEYFORMAT（urn:uuid:… / com.*）：无 CDM 与许可证时任何工具都无法解密。 */
const DRM_KEYFORMAT_RE = new RegExp(
  "(" +
    [
      "edef8ba9-79d6-4ace-a3c8-27dcd51d21ed", // Widevine
      "94ce86fb-07ff-4f43-adb8-93d2fa968ca2", // FairPlay
      "9a04f079-9840-4286-ab92-e65be0885f95", // PlayReady
      "com\\.apple\\.streamingkeydelivery",
      "com\\.microsoft\\.playready",
      "com\\.widevine",
    ].join("|") +
    ")",
  "i",
);

export interface EncryptionProfile {
  methods: Record<string, number>;
  keyformats: string[];
  unsupported: string[];
  drm: string[];
  noneAfterAes: boolean;
}

export function encryptionProfile(body: string): EncryptionProfile {
  const lines = splitLines(body);
  const methods: Record<string, number> = {};
  const keyformats: Record<string, number> = {};
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
    // RFC 8216：NONE 用于把「上一段仍是 AES-128」的分片切回明文。
    if (m === "NONE" && seenAes) noneAfterAes = true;
  }
  const names = Object.keys(methods);
  const kfs = Object.keys(keyformats);
  return {
    methods,
    keyformats: kfs,
    unsupported: names.filter((m) => !ENGINE_SUPPORTED_METHODS[m]),
    drm: kfs.filter((k) => DRM_KEYFORMAT_RE.test(k)),
    noneAfterAes,
  };
}

export function noteEncryption(body: string): void {
  let p: EncryptionProfile;
  try {
    p = encryptionProfile(body);
  } catch {
    return; // 体检本身绝不干扰主流程
  }
  const used = Object.keys(p.methods);
  if (!used.length) return; // 未加密

  flux.logger.info(
    "[m3u8-resolver] 加密方式: " +
      used.map((m) => m + "×" + p.methods[m]).join(", ") +
      (p.keyformats.length ? "；KEYFORMAT=" + p.keyformats.join(",") : ""),
  );

  if (p.unsupported.length) {
    flux.logger.warn(
      "[m3u8-resolver] 该流使用引擎不支持的加密方式：" +
        p.unsupported.join(",") +
        "（引擎仅支持 NONE / AES-128）。下载阶段会报 " +
        '"unsupported HLS encryption method" —— 属引擎能力边界，不是插件问题。',
    );
  }
  if (p.drm.length) {
    flux.logger.warn(
      "[m3u8-resolver] 检测到 DRM 体系： " +
        p.drm.join(",") +
        "。这是受版权保护的内容，需要 CDM + 许可证服务器才能解密，任何下载工具都无法绕过。",
    );
  }
  // TODO(M2)：本条文案在引擎 v0.5.4（上游 PR #715 已修 m3u8-rs 的 IV 校验缺陷）之后已经过时。
  //   M1 阶段刻意保持与 1.8.0 **逐字一致**（回归基线要能逐字比对），改文案统一放到 M2，
  //   与 docs/upstream-m3u8-rs-method-none.md、两个 .patch 的清理一起做。
  if (p.noneAfterAes) {
    flux.logger.warn(
      "[m3u8-resolver] 该流在 AES-128 段之后出现 #EXT-X-KEY:METHOD=NONE（切回明文段）。" +
        "已知上游缺陷：m3u8-rs 6.0.1 的 Key::from_hashmap 把 IV 校验写反了" +
        "（method==None && iv.is_none() 时反而报错），导致 METHOD=NONE 标签被降级为未知标签、" +
        "引擎的粘性密钥不重置，明文段被错误地用上一段的 AES-128 密钥解密 → " +
        "引擎报 decrypt_segment: … PKCS7 decrypt error (Unpad Error)。" +
        "插件不改写 playlist 内容，无法规避；需上游修复（详见 docs/upstream-m3u8-rs-method-none.md）。",
    );
  }
}
