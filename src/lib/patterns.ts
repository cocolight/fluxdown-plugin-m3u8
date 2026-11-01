/**
 * 共享正则表 —— v1.8.0 里这套常量在 resolver.js 与 subscribe.js 各有一份（逐字相同），
 * 属于「改一套要同步另一套」的已知欠债。M1 起只有这一份。
 *
 * ⚠️ 两个文件对 `MEDIA_NOISE_RE` 的**用法**曾不同，故这里只导出正则本身：
 *    resolver 只看 pathname（isMediaNoise），subscribe 看整条 URL。差异在调用点保留。
 */

export const LINK_ATTR_RE = /(?:href|src)\s*=\s*["']([^"'<>\s]+)["']/gi;

export const EXCLUDE_LINK_RE =
  /(?:login|logout|signin|signup|register|about|contact|help|support|terms|privacy|tags?|category|search|comment|share|app|apk|ios|android|cart|user|profile|account|follow|subscribe|rss|sitemap)(?:$|[/?#])/i;

export const STATIC_EXT_RE = /\.(?:png|jpe?g|gif|svg|webp|css|js|woff2?|ico|json|xml|txt|pdf|zip)(?:$|\?)/i;

/**
 * 预告 / 花絮 / 广告段。★ 比原设计**补了边界** —— 否则 `ad` 会命中 `open`、`op` 会命中 `top`，
 * 把正常剧集页整片杀掉。
 */
export const MEDIA_NOISE_RE =
  /(?:^|[._\-\/])(?:trailer|preview|teaser|sample|ad|ads|advert|bumper|intro|outro|pv|promo|behind|making)(?:$|[._\-\/])/i;

export const PLAYER_MARK_RE = /<video[\s>]|<source[\s>]|hls\.js|Hls\.|videojs|jwplayer|dplayer|ckplayer|artplayer/i;

export const IFRAME_SRC_RE = /<iframe\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi;

/**
 * maccms 的 `"link"` 值形如 `"\/vod-play\/11076-1-1\/"`（JSON 转义），故此处不能排除反斜杠，
 * 由 findPlayTarget 统一做 `\/ → /` 还原，再用 isFollowableUrl 过滤伪协议。
 */
export const PLAYER_LINK_RE = /["']link["']\s*:\s*["']([^"']+)["']/i;
