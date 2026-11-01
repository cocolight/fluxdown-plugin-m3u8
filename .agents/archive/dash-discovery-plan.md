# v1.8.0 开发计划：DASH 发现层

> 定位：本计划覆盖 **v1.8.0** —— 主体是**插件侧 DASH「发现层」**（唯一值得投入的 DASH 增量）；另附「遗留真机验证收口」与「v1.8.0 自身发版流程」。
> 版本状态（核对 2026-10-04）：**v1.6.0 已发**（tag `v1.6.0` → `f7b270c`）；**v1.7.0 独立发版已发**（tag `v1.7.0`）；
> **v1.8.0 = 本计划，代码已实现并跑通回归（16 套件 / 521 项全绿），待用户发版**。
> 范围边界：DASH 下载引擎在核心 `native/engine/src/dash_downloader.rs`（按 `.mpd` 扩展名路由）；插件**只做发现层**。**直播 / MSS / DRM 不在范围。**
> 说明：文件名为历史沿用（`dash-discovery-plan.md`），内容已升级为 **v1.8.0 计划**。
> 协议依据：`E:\Users\yun_9\下载\streaming-protocol-spec.md`（HLS/DASH 协议笔记，忽略 MSS）—— 该文件在**仓库之外**，不随本仓库分发，故此处不提供仓库内链接。

---

## 0. 现状与路线图定位

| 版本 | 状态 | 关键内容 |
| --- | --- | --- |
| v1.6.0 | 已发（tag `v1.6.0` → `f7b270c`） | 登录凭据注入（`auth`）+ 订阅 provider（`subscriptions`） |
| **v1.7.0** | **已发（独立发版，未并入 v1.8.0）** | 防抓页 Cookie 挑战自动通过 + 内嵌播放器（iframe）跟随 |
| v1.8.0 | **代码已实现，待发版** | DASH 发现层 + 遗留验证收口 + 自身发版 |

**规则**：v1.7.0 走**它自己的发版**，其产物与时点与本计划无关 —— v1.8.0 **不替 v1.7.0 收尾、不替它发版、不与它合并**。

### 实施进度（2026-10-04）

§2 六点改动**已全部落地**并通过回归：

| 改动 | 落点 | 状态 |
| --- | --- | --- |
| 1 `extractDash()` + `looksLikeMpdBody()` | `src/resolver.js`（紧邻 `extractMaster`） | ✅ |
| 2 情况 B DASH 分支 | `resolve()` 情况 B | ✅ |
| 3 返回体豁免 | DASH 分支走 `finalize`，**不进** `isPlaylistBody` | ✅ |
| 4 复用 `smartFetch` / `followIframe` | `followIframe` 内层新增 `.mpd` 分支 | ✅ |
| 5 直链 `.mpd` 识别 | `isDashUrl` / `isManifestUrl`；`resolve` 情况 A、`resolveSecondStage`、`inScope` 同步 | ✅ |
| 6 设置项 + 测试 | manifest `detectDash`；`test_dash_discovery.js`(45) + `qjs_dash_smoke.js`(17) | ✅ |

---

## 1. v1.8.0 范围

**主体 = DASH 发现层**（§2 六点）。

- **目标**：页面出现 `.mpd` 时，插件把它作为**单一直链**返回，由核心 `dash_downloader` 接手；并**复用已有的反爬（Cookie 挑战）、内嵌播放器跟随、鉴权头**机制。
- **非目标**：不解析 MPD 内容、不做表征（Representation）选择、不翻译 `SegmentBase`、不碰直播与 DRM、不改核心引擎。

### 增益边界

| 输入 | 现状 | 插件增益 |
| --- | --- | --- |
| **直链 `.mpd`** | 插件放行（`isPlaylistUrl` 不认 `.mpd`）→ 核心 DASH 引擎全包 | **零**（不需要插件） |
| **页面里的 `.mpd`**（MPD 藏在 HTML/JS） | `extractMaster`/`extractAllMasters` **只匹配 `.m3u8`** → 抠不到 → 放行成下 HTML | **← 唯一可补点** |

### 插件补不了的四类（明确不做）

1. `SegmentBase` / `indexRange`（单文件点播）—— 核心只实现 Template/List；
2. DASH 直播 `type="dynamic"` / LL-DASH —— 核心显式拒绝；
3. CENC / Widevine / PlayReady —— 需 CDM + 许可证，任何工具无解；
4. **表征（Representation）选择** —— 插件返回契约里没有"选哪条 representation"的字段。

---

## 2. DASH 发现层六点改动（逐条）

### 改动 1 —— 新增 `extractDash(html, base)`

- **做什么**：与 `extractMaster` 并列的零依赖正则提取，抠出页面里的 `.mpd` 绝对地址。
- **实现要点**：先剥 `\/` 转义（`String(html).replace(/\\\//g, "/")`），再
  ① 绝对：`/(https?:\/\/[^"'\\\s<>]+?\.mpd(?:\?[^"'\\\s<>]*)?)/i`
  ② 相对（引号内）：`/["']([^"'<>\s]+?\.mpd(?:\?[^"'<>\s]*)?)["']/i` → `absUrl(rel, base)` 绝对化。
- **注意**：**禁止 `new URL`**（QuickJS 无 `URL`），一律用现有 `parseUrl`/`absUrl`。

### 改动 2 —— `resolve()` 情况 B 增加 DASH 分支

- **落点**：`情况 B` 现有 `extractMaster`（`src/resolver.js` 中 `const found = extractMaster(page.body, ctx.url);` 处；行号可能随版本漂移，以**符号名**为准）。
- **做什么**：`.m3u8` 未命中时，若 `detectDash` 开 → `extractDash(page.body, ctx.url)`；命中则**直接返回该 `.mpd` 直链**（不抓取、不解析，核心自会解析）。
- **优先级**：**先 `.m3u8`、后 `.mpd`**（保持现有行为为默认，DASH 仅兜底）。
- **返回形态**：单直链（与现有 `finalize()` 同构），`assertOutputUrl()` 校验通过即可（`http/https` 在白名单内）。

### 改动 3 —— DASH 返回体豁免（`isPlaylistBody` / `looksLikeHtml`）

- **问题**：现有守卫用 `isPlaylistBody(body)` 判 `#EXTM3U`；`.mpd` 是 XML，会被判成"非 playlist"而抛错。
- **做什么**：走改动 2 的 `.mpd` 分支时**跳过** `isPlaylistBody` 校验（插件不读 `.mpd` 内容，交给核心）；必要时加一条"看起来像 MPD"的判据（`<MPD` 或 `application/dash+xml`）供日志用。
- **注意**：不要改动 `.m3u8` 路径的校验逻辑（零回归）。

### 改动 4 —— 复用 `smartFetch` / `followIframe`

- **做什么**：DASH 发现不新增抓取逻辑。页面抓取已走 `smartFetch`（自动解防抓页 Cookie 挑战）+ `followIframe`（内嵌播放器跟随）→ **天然复用，几乎零额外工作**。
- **延伸**：`followIframe` 内层的 `extractMaster` 命中即可；若播放页里是 `.mpd`，同一分支再试 `extractDash`（改动 2 的同一处逻辑下沉为可复用函数）。

### 改动 5 —— 直接 `.mpd` 直链识别

- **做什么**：让 `isPlaylistUrl`（或等价的"直链判定"）也认 `.mpd`；直链 `.mpd` 走"情况 A"式直返，避免被当成"页面"额外抓一次。
- **注意**：二段解析（`resolveSecondStage`）里对条目的 `.mpd` 判定同步放宽。

### 改动 6 —— 设置项 + 测试

- 新增设置项（严格 JSON、仅标准字段、`default` 字符串化）：

| key | type/widget | default | 描述（面向用户） |
| --- | --- | --- | --- |
| `detectDash` | boolean（省略 widget） | `"true"` | 页面里没有 m3u8、但有 DASH 清单（`.mpd`）时，自动取出该地址交给核心的 DASH 引擎下载。关闭则只解析 HLS。 |

- 新增/更新测试（见 §6）。

---

## 3. 遗留真机验证收口（**非 v1.8.0 专属**）

以下为 v1.6.0 / v1.7.0 遗留、**代码层无法断言**的项，本计划顺手收口；**不阻塞 v1.8.0 发版**（各能力 fail-closed 独立生效），但需记录结论。

| 来源 | 项 | 验收信号 |
| --- | --- | --- |
| v1.6.0 | ① 0.4.8 真机加载 | 插件正常加载，非 `FailedPlugin` |
| v1.6.0 | ② 登录流程 5 个 action | 均可用、凭据落库 |
| v1.6.0 | ③ ★ 分片鉴权 | 配好凭据后下载需鉴权分片站，**分片请求也带凭据**（不带→403；`authHeadersAsync` 的存在理由） |
| v1.6.0 | ④ 订阅幂等 | 连续刷新订阅两次 → 不重复建任务 |
| v1.7.0 | ① ★ `Cookie` 头采纳 | 显式 `Cookie` 头是否被 `flux.fetch` 采纳（不采纳则 Part A 不生效但仍 fail-closed，Part B 独立有效） |
| v1.7.0 | ② `ttdm10.me` 端到端 | 挑战 → 详情页 → iframe → m3u8 全链路成功 |
| v1.7.0 | ③ 误判回归 | 无 `dPlayer` 同构页，`detectListing` 仍返回 null |

---

## 4. 契约与硬约束（必须遵守）

- **scheme 白名单**：`resolve` 返回值经引擎 `check_output_url` 校验，仅允许 `{http, https, ftp, magnet, ed2k}`，**没有 `data:` / 本地文件** → 插件**无法回传改写后的清单内容**，因此 SegmentBase 翻译、直播清单改写都不可能。
- **表征选择不可表达**：插件返回契约里每个 `variants[]` 项必须是"一个可下载 URL"，而 DASH 的一条 representation 是**模板不是单文件** → 选表征只能由核心做，插件插不了手。
- **不能用 `manifest` 拼 DASH**：用多文件清单把分片当条目返回，只会产出 **N 个独立分片文件**、不会合并成可播放单文件 → 明确不用。
- **manifest 严格 JSON**（`deny_unknown_fields`）：新增设置项安全；不得加注释/自定义键。
- **QuickJS 沙箱**：无 `URL`/`btoa`/`atob` → 一律 `parseUrl`/`absUrl`。
- **fail-closed**：`extractDash` 未命中 → 退回现有行为（`return null`），绝不比现状更差。

---

## 5. 风险

| 风险 | 缓解 |
| --- | --- |
| 页面同时有 `.m3u8` 与 `.mpd`（CMAF 双协议同源） | 优先级固定：**先 `.m3u8`（现行为）后 `.mpd`**，不改变 HLS 结果 |
| 直接 `.mpd` 被 `targetHosts` 命中 → 被当"页面"多抓一次 | 由改动 5 消除（直链判定认 `.mpd`） |
| 误报（`.mpd` 出现在脚本/注释里的无关字符串） | 与 `.m3u8` 同等约束：必须是合法 `http(s)` 绝对地址或引号内相对地址 |
| 剧集页里有多个 `.mpd`（多集各一个） | **本计划不做**（`detectListing` Tier-1 仍只看 m3u8）；如需支持列为**可选扩展**，单独立项 |
| 段/密钥请求的鉴权头是否随插件 `extraHeaders` 覆盖到 | 核心 `dash_downloader` 已把捕获的额外头应用于跨主机段（已核源码）；插件返回头的覆盖范围需**真机验证**（见 §3） |
| 遗留验证未通过是否阻塞发版 | **不阻塞** —— 各能力 fail-closed 独立生效；结论记入 §3 |
| 文档状态漂移（曾误记 v1.7.0 未发） | 以 §0 版本表为准；改动版本状态时同步本节 |

---

## 6. 测试计划

**回归门槛（现有套件全绿）**：`test_resolver_v13` / `test_naming_v14` / `test_encryption_v142` / `test_listing_v15` / `test_secondstage_v15` / `test_hooks_cancel_v15` / `test_auth_v16` / `test_subscribe_v16` / `test_challenge_iframe_v17` + `qjs_unit_url` / `qjs_e2e_scheme` / `qjs_listing_smoke` / `qjs_auth_subscribe_smoke` / `qjs_challenge_iframe_smoke`（现共 **14 套件 / 459 项**）。
**v1.8.0 落地后实测**：新增 `test_dash_discovery.js`（45 项）与 `qjs_dash_smoke.js`（17 项），
连同 `check_manifest_v18.js`，共 **16 套件 / 521 项全绿**。

**新增**
1. `test_dash_discovery.js`（Node/V8）：
   - `extractDash` 正例（绝对 / 相对 / `\/` 转义）与反例（`.m3u8`、非 `.mpd`、`javascript:`）。
   - 情况 B 全链路：页面只有 `.mpd` → 返回该 `.mpd` 直链，且**不**读其内容、**不**触发 `isPlaylistBody` 报错。
   - 优先级：页面同时含 `.m3u8` 与 `.mpd` → 返回 `.m3u8`（与基线一致）。
   - 直接 `.mpd` 直链：**不**触发"页面"分支（抓取次数断言）。
   - `detectDash=false` → 行为回落到基线。
2. `qjs_dash_smoke.js`（真实 QuickJS）：沙箱内跑"页面→`.mpd`"，断言最终 URL 过 scheme 白名单、未引入 `new URL`。

---

## 7. 版本与门槛

- **无新增引擎字段** → `minAppVersion` **不变 = `0.4.8`**（随 v1.6.0 的能力段）。
- 版本号：**`1.8.0`**（minor）。
- 同步 `docs/plugin-capability-matrix.md` §5 版本表加一行：`| 1.8.0 | DASH 发现层 | 无新增引擎字段 | 0.4.8 |`。

---

## 8. v1.8.0 发版流程（内部运维，非面向用户文档）

> 前置：仅当用户明确说「**发版**」才执行；v1.7.0 的发版属其独立流程，与本计划无关。

1. **打包**：`python .workbuddy/tmp/pack_fxplug.py 1.8.0`（`MEMBERS` = `src/{manifest.json,resolver.js,hooks.js,auth.js,subscribe.js}` + 根 `LICENSE`，固定时间戳保 SHA256 可复现）→ `fluxdown-plugin-m3u8_1.8.0.fxplug`（已在 `.gitignore`）。
2. **写 Release notes**：`.workbuddy/tmp/release_notes_v1.8.0.md`（中文，对齐既有结构：变更 / 文档 / 安装 + SHA256）。
3. **打 tag**：`git tag -a v1.8.0 -m "..."` 并推送（Windows 下 git 写操作需 `dangerouslyDisableSandbox`）。
4. **建 Release**：`gh release create v1.8.0 <fxplug> --title "..." --notes-file ... --latest` —— ⚠️ **附件是位置参数，没有 `--attach`**。
   - ⚠️ **幂等竞态注记**：该命令**可能实际成功却报 `already exists`**（v1.7.0 已复现）→ **勿重试、勿重建**，改查 `gh release view v1.8.0 --json assets` 核实附件与 digest（`gh release list` 看 Latest）。
5. **复核**：远程 `master` 与 tag 存在、附件 URL HTTP 200、本地工作区干净；`docs/dash-discovery-plan.md` 由未跟踪 (`??`) 转为已提交。

---

## 9. 关键文件

- 修改：`src/resolver.js`（`extractDash` + 情况 B 分支 + 直链判定 + 二段）
- 修改：`src/manifest.json`（`version` + `detectDash` 设置项）
- 修改：`README.md`（功能特性 / 配置项表 / 工作原理）
- 修改：**`docs/configuration.md`**（配置唯一权威；`detectDash` 为**第 24 个设置项**，补速查表 + 分组）
- 修改：`docs/plugin-capability-matrix.md`（§4 一行 + §5 版本表）
- 新增：`.workbuddy/tmp/test_dash_discovery.js`、`.workbuddy/tmp/qjs_dash_smoke.js`
- 本文件：`docs/dash-discovery-plan.md`（改写；**不新建文件名**）
- **不触碰**：核心引擎、`extractMaster` 的 `.m3u8` 逻辑、`detectListing` 判定

---

## 10. 实施顺序

1. 新增 `extractDash()`（改动 1）。
2. 情况 B 接入 DASH 分支 + 返回体豁免（改动 2、3）。
3. 复用 `smartFetch`/`followIframe` 的抓取路径（改动 4）。
4. 直链 `.mpd` 判定 + 二段同步（改动 5）。
5. `manifest.json` 加 `detectDash`（改动 6）。
6. 写测试并跑全量回归（§6）。
7. 同步 4 份文档（README / configuration.md / 能力矩阵 / 本文件）。
8. （仅用户说「发版」）打包 / tag / Release（§8）。

---

## 附：一句话结论

**插件能补的 DASH 能力只有"发现层"（页面里找 `.mpd`），工程量小（约半天到一天 + 测试）且能完全复用现有反爬 / iframe / 鉴权机制；** 而 SegmentBase、直播、DRM、表征选择这四类插件够不到，需要动核心或本就无解。
