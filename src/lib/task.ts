/**
 * 拦截器侧的公共形状。
 *
 * 为什么不直接 import SDK 的 `InterceptTask`：本仓库对 SDK 只做 `import type`，但那仍是
 * 一层依赖；而拦截器真正用到的字段只有三个（`id` / `sourceUrl` / `url`）。用一个本地
 * 极简形状，lib 层就能在任何入口里装配，不必关心调用方拿到的是哪一份上下文。
 */
export interface InterceptTaskLike {
  id: string;
  /** 任务持久化的原始地址（播放页 URL 或直链）。凭据同源闸按它判断。 */
  sourceUrl: string;
  /** 本次运行的请求地址（resolver 改写之后）。 */
  url: string;
}
