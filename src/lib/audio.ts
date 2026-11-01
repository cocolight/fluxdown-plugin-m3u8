import type { AudioPick } from "./naming";
import type { Rendition, Variant } from "./hls";
import { RE_AUDIO_CODEC, RE_VIDEO_CODEC } from "./hls";

/**
 * 音轨（轨道对）解析 —— `separateAudio` 三态：
 *   auto（默认）—— 只在「CODECS 明确为 video-only」或「源已把音轨单列为纯音频变体」时分离，
 *                 避免音视频合一的流被拆出第二条音轨（双音轨）。
 *   on         —— 只要有音轨来源就分离（用户明确要求时）。
 *   off        —— 从不分离。
 */
export function shouldSeparate(mode: string, variant: Variant | null, audioVariants: Variant[]): boolean {
  if (mode === "off" || mode === "false" || mode === "0") return false;
  if (mode === "on" || mode === "true" || mode === "1" || mode === "always") return true;
  const c = variant && variant.codecs ? String(variant.codecs) : "";
  if (c && RE_AUDIO_CODEC.test(c)) return false; // 明确含音轨 → 不拆
  if (c && RE_VIDEO_CODEC.test(c)) return true; // 明确 video-only → 必须配音频
  if (audioVariants && audioVariants.length) return true; // 源已单列音轨，本变体无 CODECS 信息
  return false;
}

export interface AudioOptions {
  mode: string;
  lang: string;
  renditions: Rendition[];
  audioVariants: Variant[];
}

/** 找该变体对应的音轨来源：① #EXT-X-MEDIA 音频组 → ② 纯音频 STREAM-INF 变体。 */
export function audioSourceFor(
  variant: Variant | null,
  opt: AudioOptions,
  forced: boolean,
): AudioPick | null {
  if (!forced && !shouldSeparate(opt.mode, variant, opt.audioVariants)) return null;
  const r = pickRendition(opt.renditions, variant ? variant.audioGroup : "", opt.lang);
  if (r && r.url) return { url: r.url, label: r.name || r.lang || "audio" };
  if (opt.audioVariants && opt.audioVariants.length) {
    const a = pickAudioVariant(opt.audioVariants, opt.lang);
    if (a) return { url: a.url, label: a.label };
  }
  return null;
}

/** 从 #EXT-X-MEDIA 音频轨里选：按 AUDIO 组收敛 → 语言偏好 → DEFAULT → AUTOSELECT → 第一条。 */
export function pickRendition(rends: Rendition[], groupId: string, langPref: string): Rendition | null {
  let list = (rends || []).filter((r) => !!r.url);
  if (!list.length) return null;
  if (groupId) {
    const g = list.filter((r) => r.groupId === groupId);
    if (g.length) list = g;
  }
  const lp = String(langPref || "").toLowerCase();
  if (lp) {
    const hit =
      list.filter((r) => String(r.lang || "").toLowerCase() === lp)[0] ||
      list.filter((r) => String(r.lang || "").toLowerCase().split("-")[0] === lp)[0] ||
      list.filter((r) => String(r.lang || "").toLowerCase().indexOf(lp) === 0)[0];
    if (hit) return hit;
    flux.logger.warn("[m3u8-resolver] 未找到语言为「" + langPref + "」的音轨，回退默认轨");
  }
  return list.filter((r) => r.isDefault)[0] || list.filter((r) => r.autoSelect)[0] || list[0];
}

export function pickAudioVariant(list: Variant[], langPref: string): Variant | null {
  if (!list || !list.length) return null;
  const lp = String(langPref || "").toLowerCase();
  if (lp) {
    const hit = list.filter((v) => String(v.lang || "").toLowerCase().indexOf(lp) === 0)[0];
    if (hit) return hit;
  }
  return list[0]; // 已按带宽降序
}
