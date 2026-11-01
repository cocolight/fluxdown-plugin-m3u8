/**
 * 分片级去广告规则 —— 纯函数，无 IO、无 fetch、无正则回溯风险面。
 *
 * 为什么要这个文件：v1.4.3 之前去广告靠 `adfilter/` 那个本地 Python 服务（把整条 playlist
 * 交给外部进程清洗）。插件系统 v0.5.8 开放 `interceptors.segments` 后，引擎会先把 playlist
 * 解析成 `SegmentItem[]` 交给插件，插件只需返回要丢弃的 **id 列表** —— 不再需要外部进程、
 * 不需要自己绝对化分片地址、也不会因为服务没起就把下载搞挂。
 *
 * 三条工程纪律（违反其一就会造出「能下但播不了」的产物）：
 *
 *   1. **成对丢弃**：只有 `#EXT-X-CUE-OUT` 与 `#EXT-X-CUE-IN` 之间的整块才丢（含两端标记段）。
 *      只见 OUT 不见 IN（流结束仍在广告里）一律不动 —— 那更可能是打包器写坏了标记。
 *   2. **禁止跨 `map` / `key` 边界丢弃**：若丢弃块前后两段（保留下来的相邻段）的初始化段或
 *      密钥不同，说明块边界与密钥边界错位，丢下去会让后续段解密/初始化失败。
 *   3. **禁止丢空**：官方明确「清空全部分片的丢弃视为错误」。这里再加一条更严的：丢弃数超过
 *      八成也整体放弃 —— 那几乎一定是规则错配，而不是整条流都是广告。阈值取八成而不是一半，
 *      是因为短片段的测试流里一个 30 秒广告块就能占去一半以上，那是正常场景。
 *
 * 所有判定都是纯本地计算：`segments` 阶段对每条轨道各调用一次，200 集剧集 = 数百次调用，
 * 规则里不能有 `flux.fetch`，否则会吃满 5 秒预算并触发熔断（连带把 resolver 一起停用）。
 */

import type { SegmentItem } from "fluxdown-plugin-sdk";

export type AdMode = "off" | "marker" | "heuristic";

export interface AdRuleSet {
  mode: AdMode;
  /** 用户白名单：命中即豁免，任何规则都不丢。 */
  keepPath: RegExp[];
  /** 用户黑名单：命中即丢（不受模式与边界约束，仅受「不丢空」约束）。 */
  dropPath: RegExp[];
  /** 用户黑名单（按主机）：分片 URI 的主机名精确相等即丢。 */
  dropHosts: string[];
  /** 规则文本解析失败的原因，供调用方记一条 warn（只记一次）。 */
  error: string | null;
}

export interface AdPick {
  /**
   * 要丢弃的分片 id（HLS 为绝对 media sequence，**不是**数组下标）。
   * 空数组表示「规则有意放弃本次丢弃」，`reason` 里带原因 —— 调用方此时应按 fail-closed 返回 null。
   */
  drop: number[];
  /** 给人看的判定摘要，进日志。 */
  reason: string;
}

// ---------------------------------------------------------------------------
// 规则解析（带进程内 memo：同一次运行时里设置不会变，无需反复 JSON.parse）
// ---------------------------------------------------------------------------

const MODES: AdMode[] = ["off", "marker", "heuristic"];
const MAX_REGEX = 20;
const MAX_REGEX_LEN = 200;
/** 用户正则只在截断后的 URI 上跑 —— 灾难性回溯的代价与输入长度强相关。 */
const REGEX_INPUT_LIMIT = 512;

const EMPTY_RULES: AdRuleSet = { mode: "off", keepPath: [], dropPath: [], dropHosts: [], error: null };

let memoKey = "";
let memoVal: AdRuleSet = EMPTY_RULES;

export function parseAdRuleSet(mode: string, extra: string): AdRuleSet {
  const m = String(mode || "off").trim().toLowerCase();
  const raw = String(extra || "");
  const modeOk: AdMode = MODES.indexOf(m as AdMode) >= 0 ? (m as AdMode) : "off";
  const key = modeOk + "\u0000" + raw;
  if (key === memoKey) return memoVal;

  const rules: AdRuleSet = { mode: modeOk, keepPath: [], dropPath: [], dropHosts: [], error: null };
  if (modeOk !== "off" && raw.trim()) {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      rules.error = "自定义规则不是合法 JSON（" + String((e && (e as Error).message) || e) + "），已忽略";
    }
    if (parsed && typeof parsed === "object") {
      const o = parsed as Record<string, unknown>;
      rules.keepPath = compileList(o.keepPath, "keepPath", rules);
      rules.dropPath = compileList(o.dropPath, "dropPath", rules);
      rules.dropHosts = hostList(o.dropHosts, rules);
    } else if (parsed !== null && rules.error === null) {
      rules.error = "自定义规则须为 JSON 对象，例如 {\"dropPath\":[\"/ads/\"]}，已忽略";
    }
  }

  memoKey = key;
  memoVal = rules;
  return rules;
}

function compileList(v: unknown, field: string, rules: AdRuleSet): RegExp[] {
  const out: RegExp[] = [];
  if (v === undefined || v === null) return out;
  if (!Array.isArray(v)) {
    rules.error = (rules.error ? rules.error + "；" : "") + `${field} 须为字符串数组，已忽略`;
    return out;
  }
  for (let i = 0; i < v.length && out.length < MAX_REGEX; i++) {
    const s = v[i];
    if (typeof s !== "string" || !s) {
      rules.error = (rules.error ? rules.error + "；" : "") + `${field}[${i}] 不是非空字符串，已跳过`;
      continue;
    }
    if (s.length > MAX_REGEX_LEN) {
      rules.error = (rules.error ? rules.error + "；" : "") + `${field}[${i}] 超过 ${MAX_REGEX_LEN} 字符，已跳过`;
      continue;
    }
    try {
      out.push(new RegExp(s, "i"));
    } catch (e) {
      rules.error = (rules.error ? rules.error + "；" : "") + `${field}[${i}] 正则非法（${String((e as Error).message || e)}），已跳过`;
    }
  }
  if (v.length > MAX_REGEX) {
    rules.error = (rules.error ? rules.error + "；" : "") + `${field} 超过 ${MAX_REGEX} 条，其余忽略`;
  }
  return out;
}

function hostList(v: unknown, rules: AdRuleSet): string[] {
  const out: string[] = [];
  if (v === undefined || v === null) return out;
  if (!Array.isArray(v)) {
    rules.error = (rules.error ? rules.error + "；" : "") + "dropHosts 须为字符串数组，已忽略";
    return out;
  }
  for (const item of v) {
    if (typeof item !== "string") continue;
    const h = item.trim().toLowerCase();
    if (h && out.indexOf(h) < 0) out.push(h);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 分片信号判定
// ---------------------------------------------------------------------------

// 不带 /g：带全局标志的 test() 会保留 lastIndex，跨段判定会随机漏判。
const CUE_START = /#EXT-X-CUE-OUT(?!-CONT)/i;
const CUE_CONT = /#EXT-X-CUE-OUT-CONT/i;
const CUE_END = /#EXT-X-CUE-IN/i;

function hasTag(tags: string[] | undefined | null, re: RegExp): boolean {
  if (!tags || !tags.length) return false;
  for (let i = 0; i < tags.length; i++) {
    if (typeof tags[i] === "string" && re.test(tags[i])) return true;
  }
  return false;
}

/** 广告块起点：`CUE-OUT` 或 `CUE-OUT-CONT`（延续标记也算块内）。 */
function isCueStart(tags: string[] | undefined | null): boolean {
  return hasTag(tags, CUE_START) || hasTag(tags, CUE_CONT);
}

function isCueEnd(tags: string[] | undefined | null): boolean {
  return hasTag(tags, CUE_END);
}

/**
 * 找成对的 CUE 块（闭区间下标）。
 * 只有 OUT 没有 IN 的块不进结果 —— 纪律 1。
 */
function cueBlocks(segs: SegmentItem[]): Array<[number, number]> {
  const blocks: Array<[number, number]> = [];
  let start = -1;
  for (let i = 0; i < segs.length; i++) {
    const tags = segs[i].tags;
    if (start < 0 && isCueStart(tags)) start = i;
    if (start >= 0 && isCueEnd(tags)) {
      blocks.push([start, i]);
      start = -1;
    }
  }
  // start >= 0：流结束仍在广告里，打包器标记不完整 → 按纪律 1 不动
  return blocks;
}

/** `#EXT-X-DATERANGE` 里由 Apple interstitial 或 SCTE-35 标注的广告段。 */
function dateRangeHit(s: SegmentItem): boolean {
  const dr = s.dateRange;
  if (!dr) return false;
  if (/interstitial/i.test(String(dr.class || ""))) return true;
  const attrs = dr.attributes;
  if (attrs) {
    for (const k in attrs) {
      if (Object.prototype.hasOwnProperty.call(attrs, k) && /^SCTE-?35/i.test(k)) return true;
    }
  }
  return false;
}

const AD_WORDS: Record<string, 1> = {
  ad: 1,
  ads: 1,
  adv: 1,
  advert: 1,
  adverts: 1,
  advertisement: 1,
  advertisements: 1,
  preroll: 1,
  midroll: 1,
  postroll: 1,
  bumper: 1,
  promo: 1,
  sponsor: 1,
  sponsored: 1,
  adjump: 1,
  commercial: 1,
};

/** `ad1.ts` / `ad_2` / `promo3` 这类带序号的命名。 */
const AD_STEM = /^(?:ad|ads|adv|advert|advertisement|preroll|midroll|postroll|bumper|promo|sponsor|adjump)[-_]?\d*$/i;
const SEG_EXT = /\.(?:ts|m4s|mp4|m4a|aac|cmfv|cmfa|vtt)$/i;

/** 去掉 scheme / host / query，只留 path（否则 `ad.cdn.com` 这种主机名会被当成片段名）。 */
function pathOf(uri: string): string {
  let p = String(uri || "");
  const q = p.search(/[?#]/);
  if (q >= 0) p = p.slice(0, q);
  const s = p.indexOf("://");
  if (s >= 0) {
    const slash = p.indexOf("/", s + 3);
    p = slash >= 0 ? p.slice(slash) : "";
  }
  return p;
}

function hostOf(uri: string): string {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(String(uri || ""));
  if (!m) return "";
  let h = m[1];
  const at = h.lastIndexOf("@");
  if (at >= 0) h = h.slice(at + 1);
  const colon = h.indexOf(":");
  if (colon >= 0) h = h.slice(0, colon);
  return h.toLowerCase();
}

/** 命名命中返回命中的片段名（进日志），否则 null。 */
function nameHit(uri: string, title: string | null): string | null {
  if (title) {
    const t = title.trim().toLowerCase();
    // 标题只做全等：剧集标题里带 "ad" 之类的子串太常见。
    if (t && AD_WORDS[t] === 1) return `title='${title}'`;
  }
  const parts = pathOf(uri).split("/");
  for (let i = 0; i < parts.length; i++) {
    if (!parts[i]) continue;
    const stem = parts[i].replace(SEG_EXT, "").toLowerCase();
    if (!stem) continue;
    if (AD_WORDS[stem] === 1 || AD_STEM.test(stem)) return `path='${parts[i]}'`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 边界纪律
// ---------------------------------------------------------------------------

function keyOf(s: SegmentItem): string {
  return s.key ? s.key.method + "|" + String(s.key.uri || "") : "";
}

function mapOf(s: SegmentItem): string {
  return s.map ? String(s.map.uri || "") : "";
}

/**
 * 纪律 2：丢弃块 [a..b] 之后，保留下来的相邻两段是否仍在同一密钥/初始化段之下。
 * 块贴着头尾时没有可比对象，视为安全（整条都被丢的情况由纪律 3 拦）。
 */
function boundarySafe(segs: SegmentItem[], a: number, b: number): boolean {
  const prev = a > 0 ? segs[a - 1] : null;
  const next = b + 1 < segs.length ? segs[b + 1] : null;
  if (!prev || !next) return true;
  return keyOf(prev) === keyOf(next) && mapOf(prev) === mapOf(next);
}

// ---------------------------------------------------------------------------
// 主判定
// ---------------------------------------------------------------------------

function anyMatch(list: RegExp[], uri: string): boolean {
  if (!list.length) return false;
  const t = uri.length > REGEX_INPUT_LIMIT ? uri.slice(0, REGEX_INPUT_LIMIT) : uri;
  for (let i = 0; i < list.length; i++) {
    // 用户正则理论上可能抛（万一是被改写过的对象），单条失败不影响其余。
    try {
      if (list[i].test(t)) return true;
    } catch {
      /* 忽略该条 */
    }
  }
  return false;
}

/**
 * 返回该丢的分片 id 列表。`null` 表示「不动」—— 引擎会完全按原样下载。
 *
 * 调用方拿到 `null` 必须原样返回 `null`（fail-closed），不要编一个空 `{drop:[]}`。
 */
export function pickAdSegments(
  segs: SegmentItem[],
  rules: AdRuleSet,
  targetDuration: number | null,
): AdPick | null {
  if (rules.mode === "off" || !segs || !segs.length) return null;

  const n = segs.length;
  const force: boolean[] = new Array(n);
  const hit: boolean[] = new Array(n);
  const keep: boolean[] = new Array(n);
  for (let i = 0; i < n; i++) {
    force[i] = false;
    hit[i] = false;
    keep[i] = false;
  }

  // 1) 用户规则（白名单 > 黑名单 > 内置规则）
  const hasForce = rules.dropPath.length > 0 || rules.dropHosts.length > 0;
  for (let i = 0; i < n; i++) {
    const uri = String(segs[i].uri || "");
    if (rules.keepPath.length && anyMatch(rules.keepPath, uri)) {
      keep[i] = true;
      continue;
    }
    if (!hasForce) continue;
    if (rules.dropPath.length && anyMatch(rules.dropPath, uri)) {
      force[i] = true;
      continue;
    }
    if (rules.dropHosts.length) {
      const h = hostOf(uri);
      if (h && rules.dropHosts.indexOf(h) >= 0) force[i] = true;
    }
  }

  // 2) 广告标记（marker 与 heuristic 都做）
  let cueCount = 0;
  const blocks = cueBlocks(segs);
  for (let i = 0; i < blocks.length; i++) {
    for (let k = blocks[i][0]; k <= blocks[i][1]; k++) {
      if (!hit[k]) {
        hit[k] = true;
        cueCount++;
      }
    }
  }
  let drCount = 0;
  for (let i = 0; i < n; i++) {
    if (!hit[i] && dateRangeHit(segs[i])) {
      hit[i] = true;
      drCount++;
    }
  }

  // 3) 启发式（仅 heuristic 模式）：极短段 + 命名特征
  let shortCount = 0;
  let nameCount = 0;
  if (rules.mode === "heuristic") {
    const td = typeof targetDuration === "number" && targetDuration > 0 ? targetDuration : null;
    for (let i = 0; i < n; i++) {
      if (hit[i] || keep[i] || force[i]) continue;
      const s = segs[i];
      const d = typeof s.duration === "number" ? s.duration : null;
      if (d !== null && (d === 0 || (td !== null && td >= 2 && d < 0.5))) {
        hit[i] = true;
        shortCount++;
        continue;
      }
      if (nameHit(s.uri, s.title)) {
        hit[i] = true;
        nameCount++;
      }
    }
  }

  // 4) 收口：force 单独并入（用户显式声明，不受边界纪律约束）
  const picked: Record<string, 1> = {};
  const drop: number[] = [];
  let forced = 0;
  const add = (id: number) => {
    const k = String(id);
    if (picked[k]) return false;
    picked[k] = 1;
    drop.push(id);
    return true;
  };
  for (let i = 0; i < n; i++) if (force[i] && !keep[i] && add(segs[i].id)) forced++;

  // 5) 规则命中按连续块处理，逐块过边界纪律
  let skipped = 0;
  let i = 0;
  while (i < n) {
    if (!(hit[i] && !keep[i] && !force[i])) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < n && hit[j + 1] && !keep[j + 1] && !force[j + 1]) j++;
    if (boundarySafe(segs, i, j)) {
      for (let k = i; k <= j; k++) add(segs[k].id);
    } else {
      skipped += j - i + 1;
    }
    i = j + 1;
  }

  if (!drop.length) return null;

  // 6) 纪律 3：不丢空、也不丢大半（丢八成以上几乎一定是规则错配）
  if (drop.length >= n) {
    return { drop: [], reason: `规则命中 ${drop.length}/${n} 段（会清空全部分片），已放弃` };
  }
  if (drop.length * 5 > n * 4) {
    return { drop: [], reason: `规则命中 ${drop.length}/${n} 段（超过八成），已放弃` };
  }

  const bits: string[] = [];
  if (cueCount) bits.push(`CUE 标记块 ${cueCount} 段`);
  if (drCount) bits.push(`DATERANGE ${drCount} 段`);
  if (shortCount) bits.push(`极短段 ${shortCount} 段`);
  if (nameCount) bits.push(`命名特征 ${nameCount} 段`);
  if (forced) bits.push(`自定义规则 ${forced} 段`);
  if (skipped) bits.push(`因跨密钥/初始化边界跳过 ${skipped} 段`);

  drop.sort((a, b) => a - b);
  return { drop, reason: bits.join("，") || "规则命中" };
}
