# 源码迁移到 TypeScript + 插件 SDK 构建链

- 状态：已接受
- 日期：2026-11-01
- 决策者：fluxdown-plugin-m3u8 维护者

## 背景

v1.8.0 及更早的插件本体是四个手工维护的 `.js` 文件，`src/` 即安装目录。四个文件各自复制了
同一套 `parseUrl` / `absUrl` / `hostOf` 与剧集链接收集逻辑；`new URL` 被误用替代自实现函数时，
四个函数同时静默失效，是一次真实事故。FluxDown v0.5.8 引入插件 SDK 与构建工具链，提供类型与
`validate` / `pack` 能力。

## 决策

源码迁到 TypeScript，用 `fluxdown-plugin build` 构建：`src/entry/*.ts` 为五个入口，
`src/lib/*.ts` 为共享纯函数，构建期打包进各入口，产物落在 `dist/`。插件本体自此是 `dist/`，
根目录 `manifest.json` 为清单源文件。

验收口径不用人工比对下载结果，而是把行为拆成四个观测面（返回值、抛错信息、日志序列、宿主调用序列），
同一批 fixture 分别喂给冻结的 v1.8.0 基线与 `dist/`，要求逐字段一致（`npm run parity`）。

## 后果

- 正面：共享逻辑只有一份实现；`tsconfig` 的 `lib` 不含 `DOM`，`URL` / `btoa` 在编译期即失败，
  同类事故不可能再进产物；`validate` / `pack` 把装机前的检查前移到本地与 CI。
- 负面：「从目录安装」的路径从 `src/` 变为 `dist/`，对使用者是 breaking；同一模块会在多个产物里
  各存一份，产物体积增大；构建步骤让「改一行即可生效」消失。

## 备选方案

- 维持单文件 JS：无构建开销，但共享逻辑复制、类型缺失、事故重现成本都保留。
- 自建打包脚本（esbuild 直出）：可控，但要自己实现 manifest 拷贝、校验、打包，与官方工具链并行维护两套。

## 关联

- 落地记录与四层测试分层见 `.agents/sdk-migration.md` 第八节。
- 冻结基线的处理约定见 `.agents/definition-of-done.md`「本项目特有约束」。
