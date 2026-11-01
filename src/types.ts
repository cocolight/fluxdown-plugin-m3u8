import type { ResolveContext } from "fluxdown-plugin-sdk";

/**
 * 引擎真实下发的 ctx 比 SDK 的 `ResolveContext` 多一个 `fileName`：
 * v1.8.0 的命名决策链第二层（resolver.js:842）读的就是它。SDK 类型未声明，
 * 这里补成可选字段 —— 删掉它就等于删掉命名链的一环。
 */
export type ResolveCtx = ResolveContext & { fileName?: string };
