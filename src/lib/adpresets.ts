/**
 * 去广告规则的**预设档位** —— 设置页里「一键套用」的那几个按钮。
 *
 * 这里刻意**不内置站点名单**：广告域名与分片命名是逐站长出来的，把一份臆测的域名表写死
 * 进插件，等于让用户相信一个没人维护的白名单。预设给的是**规则形态**（从保守到激进），
 * 具体站点该加什么由用户按实际分片地址补。
 *
 * 档位排序即风险排序：越靠后丢得越多，也越可能误伤正片。
 */

import type { AdMode } from "./adrules";

export interface AdPreset {
  id: string;
  label: string;
  /** 一句话说明这一档会做什么、代价是什么。 */
  note: string;
  mode: AdMode;
  /** 写入 `adRulesExtra` 的文本；空串表示清空自定义规则。 */
  extra: string;
}

const json = (v: unknown): string => JSON.stringify(v, null, 2);

/**
 * 路径段级匹配：要求斜杠在 `ad`/`ads` 之前，所以 `/hls/ads/x.ts` 命中、`/hls/vad1.ts` 不命中
 * （后者斜杠后是 `v`）。别写成 `ad(s)?` 之类不带斜杠的形态，那会把 `loader.ts` 一起丢掉。
 */
const AD_DIR = ["/ads?/", "/preroll/", "/promo/"];

export const AD_PRESETS: AdPreset[] = [
  {
    id: "off",
    label: "关闭",
    note: "完全不动播放列表，分片原样下载。",
    mode: "off",
    extra: "",
  },
  {
    id: "marker",
    label: "仅按广告标记",
    note: "只认 #EXT-X-CUE-OUT/IN 与 DATERANGE 里明确标注的广告区间。最保守，几乎不会误伤。",
    mode: "marker",
    extra: "",
  },
  {
    id: "heuristic",
    label: "标记 + 命名推测",
    note: "在上一条基础上，额外按「0 时长分片」与 ad1.ts / preroll.ts 这类命名判断。",
    mode: "heuristic",
    extra: "",
  },
  {
    id: "dirs",
    label: "标记 + 广告目录过滤",
    note: "在上一条基础上，丢弃路径里带 /ad/、/ads/、/preroll/、/promo/ 的分片。风险中等：正片若也放在这类目录下会被误删。",
    mode: "heuristic",
    extra: json({ dropPath: AD_DIR }),
  },
  {
    id: "guard",
    label: "保护正片目录",
    note: "白名单：路径含 /ep12/ 这类剧集目录的分片永不丢弃，用来兜住上两档的误伤。可与上几条叠加后再套用。",
    mode: "heuristic",
    extra: json({ keepPath: ["/ep\\d+/"] }),
  },
];

/**
 * 预设按 id 取。找不到返回 null —— 设置页里 id 来自按钮 key，理论上不会错，
 * 但不做防御的话一个手滑的 key 会让整个视图报错。
 */
export function findPreset(id: string): AdPreset | null {
  for (let i = 0; i < AD_PRESETS.length; i++) {
    if (AD_PRESETS[i].id === id) return AD_PRESETS[i];
  }
  return null;
}
