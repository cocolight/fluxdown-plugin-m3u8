/**
 * 把入口函数挂到宿主约定的全局名上。
 *
 * 等价于 `fluxdown-plugin-sdk/runtime` 的 `defineResolver` / `defineHooks` / `defineAuth` /
 * `defineSubscription`，但**不引入 SDK 运行时代码**：SDK 是 AGPL-3.0-or-later，本项目是 MIT，
 * 而 esbuild 会把 import 进来的辅助函数内联进 `dist/*.js`。只用 `import type` + 这两行，
 * 产物里除自己的代码与 esbuild 运行时代之外无第三方内容，授权链保持干净。
 * 代价：自己写阶段分发（hooks 的 onDone/onError/onCancel 各挂一个全局名，引擎逐个读取）。
 */
export function install(name: string, fn: unknown): void {
  Reflect.set(globalThis, name, fn);
}
