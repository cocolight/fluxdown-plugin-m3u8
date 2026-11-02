/**
 * 拦截器入口 —— 订阅 `segments`（分片级去广告）、`refresh`（换发凭据）与 `failed`（失败归因）。
 *
 * 为什么单独一个文件而不是塞进 resolver：插件系统的两个平面是分开的。
 * resolver 决定「下什么」（发现层 + 鉴权层），interceptor 决定「怎么下」（下载运行时层）。
 * 引擎把解析好的 playlist 交给拦截器，拦截器只需回答「哪些分片不要」。
 *
 * 三个阶段的纪律不同，不要混：
 *
 *   - `segments` **必须是纯本地计算**。它对每条轨道调用一次，200 集剧集 = 数百次调用，
 *     而熔断规则是「连续 3 次超时或超内存 → 插件自动禁用」—— 一次 `flux.fetch` 就可能
 *     把 resolver 一起拖停。规则表在模块顶层编译一次，运行期只做字符串/数组操作。
 *   - `failed` 只允许读一次存储（归属判定），不发请求。
 *   - `refresh` 才允许发请求，且有「只换发一次」的硬上限。
 *
 * 三个必须守住的边界：
 *
 *   1. **只碰自己经手的任务**。`interceptors.match.urls` 只能写成「任意协议 + 任意路径」的
 *      全量通配（播放页 URL 里不含 .m3u8，若把规则写成只匹配 .m3u8 会让整类任务漏掉），
 *      所以本函数会被**所有**下载任务调用。归属靠 resolver 写入的 taskId 标记判断，
 *      读不到就不动。
 *   2. **fail-closed**。任何不确定（设置没开、规则有误、命中过半、没有标记）一律返回 `null`，
 *      引擎会完全按原样处理。去广告失效是可接受的；把用户的正片丢了不是。失败归因与凭据
 *      换发同理：认不出、取不到，一律放手。
 *   3. **不改变引擎默认语义**。`failed` 阶段对「重试无效」的失败（认证 / 404 / 磁盘 / 解密 /
 *      用户取消）返回 null 而不是返回「不重试」—— 引擎对 null 的处理是它自己的默认策略，
 *      我们无权替它收窄。
 */

import type { InterceptTask, RefreshPatch, SegmentItem } from "fluxdown-plugin-sdk";
import { parseAdRuleSet, pickAdSegments, type AdRuleSet } from "../lib/adrules";
import { classifyFailure } from "../lib/failure";
import { isHandled } from "../lib/handled";
import { install } from "../lib/install";
import { envFromTask, refreshCredentials } from "../lib/refresh";

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

/**
 * `failed` 阶段的入参。同样手写：`task` 之外只有三个标量，比 `Extract` 的类型体操好读。
 */
interface FailedCtx {
  stage: "failed";
  task: InterceptTask;
  errorMessage: string;
  httpStatus: number | null;
  autoRetryCount: number;
}

/** `refresh` 阶段的入参（401/403/410 时触发）。 */
interface RefreshCtx {
  stage: "refresh";
  task: InterceptTask;
  request: { url: string; method: string };
  status: number;
  refreshCount: number;
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

async function interceptSegments(ctx: SegmentsCtx): Promise<{ drop: number[] } | null> {
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

/**
 * 失败归因与定向重试。
 *
 * 这个阶段每失败一次调用一次，**没有「关闭开关」也能用**：它只在「重试真的可能改变结果」
 * 时返回 `{ retry }`，其余情况返回 null 让引擎按原语义走 —— 也就是说，本阶段默认什么都不做。
 * 所以不需要单独的设置项：没有一条路径会让用户「本来能好的任务」变得更差。
 *
 * 归属判定与 `segments` 同一个口径（taskId 标记）。
 */
async function interceptFailed(ctx: FailedCtx): Promise<{ retry: { delayMs?: number } } | null> {
  if (!ctx || ctx.stage !== "failed") return null;
  if (!(await isHandled(ctx.task && ctx.task.id))) return null;

  const v = classifyFailure(ctx.errorMessage, ctx.httpStatus, ctx.autoRetryCount);
  if (!v) return null;

  // classifyFailure 只对 network / server / interrupted 三类返回非 null，此处必有 delayMs。
  const delayMs = v.delayMs === undefined ? 2000 : v.delayMs;
  flux.logger.warn(
    `[m3u8-resolver] 任务失败，${delayMs}ms 后重试（第 ${ctx.autoRetryCount + 1} 次）：${v.reason}`,
  );
  return { retry: { delayMs } };
}

/**
 * 凭据换发：401/403/410 时重新访问任务原始地址，把新 Cookie 下发。
 *
 * 边界在 `lib/refresh.ts` 的文件头写死了：HLS/DASH 任务改不了 URL（SDK 限定 `url` 仅
 * HTTP 任务可用），所以这里只换凭据，不换地址。只处理本插件经手的任务。
 */
async function interceptRefresh(ctx: RefreshCtx): Promise<RefreshPatch | null> {
  if (!ctx || ctx.stage !== "refresh") return null;
  if (!(await isHandled(ctx.task && ctx.task.id))) return null;

  const status = typeof ctx.status === "number" ? ctx.status : 0;
  // 只处理鉴权类拒绝。其余状态码（比如 404）换凭据没有意义。
  if (status !== 401 && status !== 403 && status !== 410) return null;

  const env = envFromTask(ctx.task);
  if (!env.ctx.url) return null;

  const refused = ctx.request && ctx.request.url ? String(ctx.request.url) : "";
  return await refreshCredentials(env, refused, status, ctx.refreshCount);
}

/**
 * 阶段分发。引擎按 manifest 的 `interceptors.stages` 逐个调用本函数，未知阶段一律不干预。
 *
 * 为什么要显式分派而不是把几个阶段写在一个大函数里：`segments` 必须**纯本地计算**
 * （每条轨道调一次，一次 fetch 就可能触发熔断连带停掉 resolver），而 `failed` 只读一次
 * 存储、`refresh` 才允许发请求。混在一处会让「这个阶段能不能做 IO」这条约束靠记忆维持。
 */
async function intercept(ctx: SegmentsCtx | FailedCtx | RefreshCtx): Promise<unknown> {
  if (!ctx) return null;
  if (ctx.stage === "segments") return interceptSegments(ctx as SegmentsCtx);
  if (ctx.stage === "failed") return interceptFailed(ctx as FailedCtx);
  if (ctx.stage === "refresh") return interceptRefresh(ctx as RefreshCtx);
  return null;
}

install("intercept", intercept);
