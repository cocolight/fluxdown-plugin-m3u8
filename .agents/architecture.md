# 架构与代码约定

> 项目：fluxdown-plugin-m3u8。本文件说明「代码怎么组织」；
> 「什么时候算完成」见 [definition-of-done.md](definition-of-done.md)。

## 1. 目录结构

| 路径 | 内容 |
|------|------|
| `manifest.json` | 插件清单源文件：`identity`、权限、设置项、五个入口的指向。构建时原样拷入 `dist/` |
| `fluxdown-plugin.config.json` | 入口映射：`dist/*.js` → `src/entry/*.ts` |
| `src/entry/` | 五个插件入口，每个对应一个独立的 QuickJS 上下文 |
| `src/lib/` | 入口共享的纯函数模块，构建期打包进各入口 |
| `src/types.ts` | 内部共享类型，补 SDK 未声明的宿主字段 |
| `tests/legacy/` | v1.8.0 的四个 `.js` 原文件，冻结基线，不参与构建 |
| `tests/` | 四层测试：parity / contract / intercept / postprocess |
| `dist/` | 构建产物 = 插件本体（「从目录安装」指向此目录），不入库 |
| `adfilter/` | 已归档的本地去广告清洗服务，不参与构建，见根 README「已停用」节 |
| `docs/` | 只放使用者文档 |
| `.agents/` | 工程协作文档，AI 与人共读 |
| `scripts/` | 辅助脚本，含 `check-fast.sh` 快速门禁 |

入口与职责：`resolver.ts`（发现 master、选变体、注入请求面）、`hooks.ts`（`onDone` 容器探测与产物登记、`onError`/`onCancel` 清标记）、`auth.ts`（登录凭据规范化）、`subscribe.ts`（订阅枚举）、`intercept.ts`（`segments` 阶段去广告）。

## 2. 分层与依赖方向

- 依赖方向单向：`src/entry/*` → `src/lib/*` → 无。`lib` 之间允许互相引用，但**不得成环**。
- `lib` 内部分两类：纯函数（`url` / `hls` / `adrules` / `naming` / `text` / `patterns` / `probe` 的解析部分）与宿主调用（`http` / `request` / `install` / `handled` / `items`）。纯函数不得直接调 `flux.*`，宿主调用才碰。
- **运行时五个入口彼此独立**：各自编译成一个 `.js`，同一模块会在多个产物里各存一份。源码侧正常 `import` 即可，不要为「省体积」写跨入口的运行时依赖 —— 那在 QuickJS 里不存在。
- 沙箱没有 `DOM`、`URL`、`setTimeout`、`fetch`。`tsconfig.json` 的 `lib` 不含 `DOM` 是**门禁**而非习惯：`new URL` / `btoa` 在编译期即失败，网络请求只走 `flux.fetch`。

## 3. 错误处理

- resolver 抛出的错误必须让用户能看懂：地址不合法、抓回 HTML 登录页、取不到 playlist 各有独立文案，不用引擎的通用失败兜底。返回值最后过一遍 `assertOutputUrl`（`src/lib/url.ts`）。
- 钩子（`onDone` / `onError` / `onCancel`）**不得让任务失败**：探测、转封装、产物登记任何一步出错只记 warn，文件本身可用即算成功。
- 拦截器 fail-closed：任何不确定（未配置、无标记、非本插件任务、空表、解析异常）一律返回「不丢任何分片」。manifest 的 `onFailure` 为 `continue`，拦截器报错不得影响下载。
- 不吞异常：`catch` 里必须记日志或转成明确返回值，禁止空 `catch {}`。

## 4. 日志

- 统一走 `flux.logger`，级别 `debug` / `info` / `warn` / `error`。禁止 `console.*`（沙箱里也不保证存在）。
- 日志可含 URL 的 host 与路径，但**不得输出 Cookie、`Authorization` 值、Basic 凭据正文**。
- 用户的失败报告靠日志定位，所以失败分支必须留下「为什么走到这里」的一条。

## 5. 依赖引入规则

- 运行时零 npm 依赖：产物是 QuickJS 脚本，没有 `node_modules` 解析。新增能力优先手写或走宿主 API。
- 构建期依赖（`typescript`、`fluxdown-plugin-sdk`）登记在 `package.json` 的 `devDependencies`，并在 `../THIRD-PARTY.md` 登记许可证。
- **SDK 只允许 `import type`**：SDK 是 AGPL-3.0-or-later，本项目 MIT。产物中出现任何 SDK 运行时符号即破坏授权链，见 ADR-0003。

## 6. 密钥管理

- 凭据不落插件存储：登录信息经 `flux.auth` 交给引擎持久化，插件运行时读回即用。
- 请求头凭据只经 `RequestPatch.originHeaders` 下发，由引擎按 origin 白名单强制；不写进 `setHeaders`。
- 仓库内不得出现真实凭据；`tests/` 用假值。

## 7. 测试分层（改动前先确认该测哪一层）

| 层 | 命令 | 回答什么问题 |
|---|---|---|
| parity | `npm run parity` | 与 v1.8.0 **是否等价**。`tests/legacy/` 冻结，有意改变的行为在 `scenarios.mjs` 里用 `diverges: "理由"` 声明；声明了却不再差异会报错 |
| contract | `npm run contract` | 请求面**现在应该是什么样**（凭据作用域、Basic 编码、Range 换算） |
| intercept | `npm run intercept` | 拦截器契约（成对性、密钥边界、不丢空、归属判定、规则解析） |
| postprocess | `npm run postprocess` | 后处理契约（登记时机与名字、探测回退、容器家族、封面图） |

- 四层共用 `tests/parity/harness.mjs` 的假宿主。新增断言先想清楚它属于「等价」还是「契约」，**不要靠改基线抹平差异**。
- 变异自检：新增或修改断言后，故意破坏对应实现，确认断言会红。没红过的断言等于没写。

## 8. 腐化信号与重构触发

出现下列任一信号，先评估重构；确不重构的，记一条 ADR 写明理由。

- `lib` 之间出现循环依赖
- 同一逻辑（URL 解析、分片过滤、设置读取）出现在三处及以上
- 单个入口文件超过 500 行，或需要滚动才能看清它管什么
- parity 里 `diverges` 声明持续增加，说明基线正在失去约束力

重构走正常工作流，不单开流程。
