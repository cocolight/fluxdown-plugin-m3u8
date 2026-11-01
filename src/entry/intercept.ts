/**
 * 拦截器入口 —— 目前只订阅 `segments` 阶段，做 HLS 分片级去广告。
 *
 * 为什么单独一个文件而不是塞进 resolver：插件系统的两个平面是分开的。
 * resolver 决定「下什么」（发现层 + 鉴权层），interceptor 决定「怎么下」（下载运行时层）。
 * 引擎把解析好的 playlist 交给拦截器，拦截器只需回答「哪些分片不要」。
 *
 * 三个必须守住的边界：
 *
 *   1. **只碰自己经手的任务**。`interceptors.match.urls` 只能写成「任意协议 + 任意路径」的
 *      全量通配（播放页 URL 里不含 .m3u8，若把规则写成只匹配 .m3u8 会让整类任务漏掉），
 *      所以本函数会被**所有**下载任务的 `segments` 阶段调用。归属靠 resolver 写入的
 *      taskId 标记判断，读不到就不动。
 *   2. **fail-closed**。任何不确定（设置没开、规则有误、命中过半、没有标记）一律返回 `null`，
 *      引擎会完全按原样下载。去广告失效是可接受的；把用户的正片丢了不是。
 *   3. **纯本地计算**。`segments` 对每条轨道调用一次，200 集剧集 = 数百次调用，且熔断规则是
 *      「连续 3 次超时或超内存 → 插件自动禁用」—— 一次 `flux.fetch` 就可能把 resolver 一起拖停。
 *      所以规则表在模块顶层编译一次，运行期只做字符串/数组操作。
 */

import type { InterceptTask, SegmentItem } from "fluxdown-plugin-sdk";
import { parseAdRuleSet, pickAdSegments, type AdRuleSet } from "../lib/adrules";
import { isHandled } from "../lib/handled";
import { install } from "../lib/install";

/**
 * SDK 的 `InterceptCtx<"segments">` 用 `Extract` 取不出来（`segments` 与 `liveSegments` 是
 * 同一个成员的字面量联合，Extract 会得到 never），这里按类型定义手写一份。
 */
interface SegmentsCtx {
  stage: "segments" | "liveSegments";
  task: InterceptTask;
  format: "hls" | "dash";
  track: "video" | "audio";
  playlistUrl: string;
  manifestText: string;
  manifestTextOmitted: boolean;
  mediaSequence: number | null;
  targetDuration: number | null;
  periodIndex: number | null;
  representationId: string | null;
  segments: SegmentItem[];
}

/** 规则解析错误只告警一次：设置不变时每次调用都刷一遍会把日志淹掉。 */
let warnedError = "";

function readRules(): AdRuleSet {
  const s = flux.settings || {};
  const mode = s.adRulesMode === undefined || s.adRulesMode === null ? "off" : String(s.adRulesMode);
  const extra = s.adRulesExtra === undefined || s.adRulesExtra === null ? "" : String(s.adRulesExtra);
  const rules = parseAdRuleSet(mode, extra);
  if (rules.error && rules.error !== warnedError) {
    warnedError = rules.error;
    flux.logger.warn("[m3u8-ad] 自定义规则未生效：" + rules.error);
  }
  return rules;
}

async function intercept(ctx: SegmentsCtx): Promise<{ drop: number[] } | null> {
  // 防御性判定：manifest 里只声明了 segments，将来若加 liveSegments 再放开（直播的分片
  // 编号会随刷新滑动，丢错了没法回滚，需要单独设计）。
  if (!ctx || ctx.stage !== "segments") return null;

  // 先做零成本的开关判断，再谈归属 —— 关闭时不应该为每次下载多付一次存储读。
  const rules = readRules();
  if (rules.mode === "off") return null;

  // 只做 HLS：DASH 的分片编号是轨道内 0 基下标，语义与 HLS 的绝对 media sequence 不同，
  // 且 DASH 里没有 CUE-OUT 这类标记，规则要另写一套。观察一段时间再说。
  if (ctx.format !== "hls") return null;

  const segs = ctx.segments;
  if (!segs || !segs.length) return null;

  // 归属：resolver 成功解析时写入的 taskId 标记。读不到 = 不是本插件经手的任务。
  // 标记过期/被挤掉只会导致「这次不去广告」，不会误伤 —— 这个失败方向是对的。
  if (!(await isHandled(ctx.task && ctx.task.id))) return null;

  const pick = pickAdSegments(segs, rules, ctx.targetDuration);
  if (!pick) return null;

  if (!pick.drop.length) {
    // 规则命中了但决定放弃（会丢空 / 丢过半）。记一条便于用户排查规则，然后按原样下。
    flux.logger.warn(`[m3u8-ad] 已跳过（${pick.reason}）：${ctx.playlistUrl || ""}`);
    return null;
  }

  flux.logger.info(
    `[m3u8-ad] 丢弃 ${pick.drop.length}/${segs.length} 段（${pick.reason}）` +
      `${ctx.track === "audio" ? " [音轨]" : ""}`,
  );
  return { drop: pick.drop };
}

install("intercept", intercept);
