import type { ResolveCtx } from "../types";
import type { Settings } from "./settings";

/** 单次 resolve 的内存上下文（防抓页 Cookie / 抓取计数），不落 flux.storage —— 维持隐私承诺。 */
export interface FetchCtx {
  cookies: Record<string, string>;
  fetches: number;
}

/** resolver 主流程的上下文包：一次解析内不变的 (ctx, settings) + 本次解析的内存状态。 */
export interface Env {
  readonly ctx: ResolveCtx;
  readonly s: Settings;
  readonly rc: FetchCtx;
}

/** 单次 resolve 的 flux.fetch 硬上限，防重定向 / 嵌套放大。 */
export const RESOLVE_FETCH_CAP = 12;

export function newEnv(ctx: ResolveCtx, s: Settings): Env {
  return { ctx, s, rc: { cookies: {}, fetches: 0 } };
}
