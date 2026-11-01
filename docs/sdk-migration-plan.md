# 用 SDK 改造 fluxdown-plugin-m3u8（对齐 v0.5.8+ 插件体系）

> **结论先行**：FluxDown 的插件系统在 **v0.5.8（2026-10-19）** 换了一代地基 —— 新增**拦截平面（interceptors）**、
> 可移植界面（`main` + 视图/命令）、授权与审计、以及 **`fluxdown-plugin-sdk`**。本项目 1.8.0 的能力边界文档
> （`docs/plugin-capability-matrix.md`，核对于 2026-10-01 / 引擎 0.4.8）有 **6 处结论已失效**，其中两处直接
> 打开了过去判定为"不可能"的能力：**分片级去广告**与**插件建任务**。
>
> 因此建议 **v2.0.0**：TypeScript + SDK 工程化迁移，同时把去广告从"外部清洗服务"改为**引擎内分片过滤**。
>
> **核对日期**：2026-11-01 ｜ 官方文档 `website-v2`（`/docs/zh/plugins/*`）｜ 客户端最新稳定版 `v0.6.5`（`v0.6.6-rc.1` 在测）
> ｜ SDK `fluxdown-plugin-sdk@0.5.0`（npm，2026-10-31 发布）

---

## 一、能力更新：项目文档 vs 现状

下表逐条对照本仓库现有结论与当前官方文档/发布说明。**失效项**是本轮改造的直接动因。

| # | 项目现有结论（出处） | 现状（官方文档 / 发布说明） | 判定 |
| --- | --- | --- | --- |
| 1 | 「插件层**没有分片级钩子**，只能整条 playlist 下载」`README.md:105`、`docs/plugin-capability-matrix.md:102` | `interceptors.stages` 提供 `segments` / `liveSegments`，返回 `{ drop, rewrite }`；`v0.5.8`「引擎新增插件拦截平面」 | **失效**，去广告可回到插件内 |
| 2 | 「插件**不能创建任务**，`flux.task` 只有 `requestRetry`」`README.md:96`、matrix `:109` | `permissions:["tasks"]` + `main` 内 `flux.tasks.list/get/create/pause/resume/remove`（限 `main`，20 次/分/插件） | **失效**，但**不建议使用**（见 §6.7） |
| 3 | 「宿主只在 `flux.fetch` 内注入认证档案，下载链路拿不到 → 凭据必须自己塞进 `extraHeaders`」`resolver.js:167-172,246-269` | `resolve()` 返回值新增 `request: RequestPatch`（`cookies` / `setHeaders` / `referrer` / `userAgent` / `originHeaders` / `segments` / `maxRangeBytes`），**每次运行重放、不落库** | **失效**，`authHeadersAsync()` 应退役 |
| 4 | 「`#EXT-X-KEY:METHOD=NONE` 会失败，属上游 `m3u8-rs 6.0.1` 缺陷，插件无法规避」`README.md:100`、`docs/upstream-m3u8-rs-method-none.md` | 引擎侧已修：PR [#715](https://github.com/zerx-lab/FluxDown/pull/715) 于 2026-10-05 合并，随 **v0.5.4（10-06）** 发布（"修复 HLS 流中 `#EXT-X-KEY:METHOD=NONE` 之后的明文分片仍沿用上一段 AES-128 密钥解密"） | **失效**，`docs/*.patch` 两个补丁作废 |
| 5 | 「字幕单层不可行：返回值无字幕字段 + ffmpeg 沙箱送不进文件」`README.md:95` | 有了 `onDone` + `flux.task.recordArtifact()`（登记产物，随任务删除），但**插件仍无写入下载目录的能力**；`recordArtifact` 只接受"已存在"的文件 | **部分失效**：remux 产物可登记；字幕**仍不可落地** |
| 6 | 「沙箱无 `btoa`（QuickJS 全局对象实测）」`resolver.js:172` | API 参考「JavaScript 运行环境 → 可用」列表现含 `atob`/`btoa` | **待实测**（可能是新版本补充），届时 `b64encode()` 可删 |
| 7 | 「`hooks.match` 只按任务原始 URL 过滤 → 用 `taskId` 存储标记判断归属」`hooks.js:8-13` | 未变；但拦截器有 `ctx.task.id`，同样需要标记（且多一处写入点） | **仍成立**，保留标记机制 |
| 8 | 「manifest `deny_unknown_fields`，旧版见到新字段整份拒绝，`minAppVersion` 救不了」matrix `:139` | 未变：`minAppVersion` 在 serde 解析**之后**才检查 | **仍成立**，抬门槛必须当成 breaking |

**版本事实**：`minAppVersion` 现为 `0.4.8`；拦截器与 SDK 需要 **`0.5.8`**，`maxRangeBytes` 需要 **`0.6.0`**，
`memoryLimitMb` 需要 **`0.6.2`**。本项目实际已落后约 10 个版本周期。

---

## 二、为什么这一轮该上 SDK

不是"为了 TS 而 TS"。四条具体动因，按说服力排序：

1. **消除"四份复制粘贴"的维护地雷。** 现在 `resolver.js`、`hooks.js`、`auth.js`、`subscribe.js` 是四个独立
   QuickJS 上下文，不能互相 `require`。于是同一套工具被抄了三遍：
   - `parseUrl` / `absUrl` / `hostOf`（`resolver.js:1647-1746`）↔ `splitUrl` / `absUrl` / `hostOf`（`subscribe.js:33-72`）；
   - `collectEpisodeLinks`（`resolver.js:1103-1142`）↔ `collectItems`（`subscribe.js:119-160`）—— README 自己写着
     "规则同源、代码不共享；改其中一套时请同步另一套"（`subscribe.js:6-8`），这是**已知的、靠人肉保证的不变量**。
   - `fnv1a32`、`decodeEntities`、`MEDIA_NOISE_RE` 等常量各一份。
   SDK 的 `entries` 是"每个入口打包成一个 IIFE"，`import` 在构建期解析 → 共享模块是**真共享**，不是靠注释约束。

2. **类型系统能挡住这个项目历史上最贵的 bug。** `tsconfig` 的 `lib: ["ES2022"]` 明确**不含 DOM** —— 这正是
   `new URL` 在 QuickJS 里抛 `ReferenceError`、静默打瘫 `absUrl/hostOf/nameFromUrl/inScope` 的那次故障
   （`resolver.js:1648-1656`）。同一条 `new URL(...)` 在 TS 下直接编译失败。同样被挡住的还有 `setTimeout`、
   `fetch`、`crypto`、`TextEncoder`。

3. **`fluxdown-plugin validate` 把 manifest 校验前置到 CI。** 现在 manifest 写错（未知字段、widget×type 不匹配、
   `default` 不是字符串）只有装机才暴露，且 `deny_unknown_fields` 一失败就是"插件被跳过"这种无信息量的表现。
   SDK 的校验器与引擎、插件索引用**同一套规则**，`build`/`pack` 时即报中文错误。

4. **拆开 1769 行的单文件。** `resolver.js` 现在是"设置读取 + 请求头 + 反爬 + 剧集识别 + 命名 + HLS 解析 +
   URL 层 + 主流程"八个关注点挤在一个文件里，且注释密度已接近代码密度。模块化之后再谈拦截器这种新增入口才可持续。

### 代价（要认）

| 项 | 影响 |
| --- | --- |
| 构建链 | 需要 Node ≥ 20；改代码要 `npm run build`（或 `dev` 监听） |
| 安装路径变更 | 现在"从目录安装 → 选 `src/`"（README `:38`）必须改为 **选 `dist/`**；`src/` 不再是插件本体 |
| 开发模式热重载语义 | resolver / hooks / auth / 订阅脚本每次调用重读文件（`dist` 重建即生效）；**`manifest.json` 与 `main` 改动必须点"重新加载"** |
| 许可证 | SDK 是 **AGPL-3.0-or-later**，本项目是 MIT。见 §7.3 —— 可规避，但需要一条纪律 |

> 备选路线：**不上 SDK**，继续纯 JS，只手工加 `interceptors`。工作量约为本文方案的 1/3，能拿到去广告与
> RequestPatch 两个最大收益，但四份复制粘贴的欠债继续滚，且 manifest 错误仍要装机才发现。若只打算做一次性
> 功能增强，选这条；若要长期维护，选 SDK。

---

## 三、目标工程结构

```
fluxdown-plugin-m3u8/
├── manifest.json                 # ← 从 src/ 移到根（唯一事实来源，构建时原样复制进 dist/）
├── fluxdown-plugin.config.json   # entries / desktop / assets 映射
├── package.json  tsconfig.json   # SDK 脚手架
├── src/
│   ├── entry/resolver.ts         # globalThis.resolve
│   ├── entry/hooks.ts            # onDone / onError / onCancel
│   ├── entry/auth.ts             # globalThis.authenticate
│   ├── entry/subscribe.ts        # globalThis.subscribe
│   ├── entry/intercept.ts        # globalThis.intercept（新增，intercept 权限）
│   ├── lib/url.ts                # parseUrl / absUrl / origin / host（零依赖，禁用 new URL）
│   ├── lib/settings.ts           # 22 个设置项的强类型读取
│   ├── lib/http.ts               # smartFetch / 挑战解码 / Cookie 合并
│   ├── lib/hls.ts                # parseMaster / parseAttrs / 变体选择 / 编码匹配
│   ├── lib/listing.ts            # 剧集识别（resolver 与 subscribe 共用，消灭平行实现）
│   ├── lib/naming.ts             # 命名决策链 + 模板
│   ├── lib/rules/adrules.ts      # 新增：广告段判定规则（纯函数，无网络）
│   └── types.ts                  # settings 界面契约
├── dist/                         # 构建产物 = 实际被安装的插件本体
└── docs/                         # 文档（现状保留）
```

关键点：**`manifest.json` 的 `entry` 仍写 `resolver.js` / `hooks.js` / …**，`fluxdown-plugin.config.json`
负责 `{"resolver.js": "src/entry/resolver.ts"}` 这类映射；插件身份 `m3u8-resolver@cocolight` 保持不变，
用户既有设置与凭据不丢（`identity` 是设置/存储/授权的键）。

---

## 四、模块映射：现有代码 → 新文件

| 新文件 | 来源（现有位置） | 说明 |
| --- | --- | --- |
| `lib/url.ts` | `resolver.js:1647-1746`、`subscribe.js:33-72` | 合并两套；`new URL` 在 TS 下不可用，天然守规矩 |
| `lib/settings.ts` | `resolver.js:29-48` + `manifest.json` 设置表 | 由 `settingBool/Str/Int` 改为一次性 `readSettings(): Settings`；SDK 已按 `type` 转换（boolean 只在值为 `"true"` 时为真） |
| `lib/http.ts` | `resolver.js:314-456` | 挑战解码、Cookie 合并、`smartFetch`（抓取计数闸 + 挑战重取） |
| `lib/hls.ts` | `resolver.js:1373-1646` | `parseAttrs/splitLines/parseMaster/variantLabel/pickVariant/codecMatches` |
| `lib/listing.ts` | `resolver.js:944-1177` + `subscribe.js:119-160` | **二合一**：`detectListing`（Tier-0/1/2）与订阅枚举共用同一份聚类/噪声/序号排序 |
| `lib/naming.ts` | `resolver.js:786-882` | 四层取值链 + `nameTemplate` |
| `entry/resolver.ts` | `resolver.js:458-666`、`1285-1370` | 主流程 + 二段解析 |
| `entry/hooks.ts` | `hooks.js:64-142` | onDone remux / 兜底合并 / 标记清理 |
| `entry/auth.ts` | `auth.js:127-206` | 不变逻辑，只是换壳 |
| `entry/subscribe.ts` | `subscribe.js:182-249` | 复用 `lib/listing.ts` |
| `entry/intercept.ts` | **新增** | 去广告 / 请求补丁 / 后处理（见 §6） |
| `lib/rules/adrules.ts` | 从 `adfilter/ad_patterns.txt` 与 `docs/ad-removal-notes.md` 提炼 | 纯函数，`segments` 阶段内联执行（5 秒预算内） |

`adfilter/` 目录的去留：服务端方案退役（`README.md:107-111`），但 `ad_patterns.txt` 里的域名/路径特征
可作为**规则种子**迁进 `lib/rules/adrules.ts`。

---

## 五、入口改造：先做"功能等价"，再谈增强

迁移的第一阶段必须**行为等价** —— 除构建方式外，用户感知零变化。这样回归测试的基线才是现成的。

### 5.1 resolver：返回值改用 `request` 补丁

现状（`resolver.js:249-269`）把凭据硬并进 `extraHeaders`，原因是下载链路看不到认证档案。现在：

```ts
// entry/resolver.ts（节选）
import type { ResolveContext, ResolveResult, RequestPatch } from "fluxdown-plugin-sdk";

function buildPatch(ctx: ResolveContext, s: Settings, target: string): RequestPatch {
  const patch: RequestPatch = {
    referrer: ctx.referrer || origin(ctx.url) || "",
    // 凭据只发给"登记站点"，其余主机不注入 —— 由引擎按 origin 精确附加
    originHeaders: credentialsFor(s, target),
  };
  const ua = s.userAgent.trim();
  if (ua) patch.userAgent = ua;
  const extra = parseHeaderLines(s.extraHeadersRaw);
  if (Object.keys(extra).length) patch.setHeaders = extra;
  if (s.segments > 0) patch.segments = s.segments;  // 顺带暴露"分段线程数"
  return patch;
}
```

三个结构性改善：

- **`referrer` / `userAgent` 会被引擎"锁定"** —— 反爬 UA 切换、探测被拒后的自适应都不会再改动它们，
  比现在"塞一个同名头、和引擎自适应互相覆盖"要确定。
- **`originHeaders` 是白名单语义**：只有 `origin` 完全相等的请求才附加，天然解决了"凭据绝不能发给 CDN"
  这条现在靠手写字符串比较（`resolver.js:222-232`）守护的规则。
- **补丁"每次运行重放、绝不落库"**（官方明确），一次性签名链接与临时 Cookie 不会被写进任务记录。

`extraHeaders` 在迁移期可以**同时保留**（引擎会用补丁覆盖），验证一轮后删除。

### 5.2 hooks：产物登记

`onDone` 的 remux 现在产出一个"孤儿文件"（不登记就与任务无关，删任务不删它）。加一行：

```ts
const r = await flux.ffmpeg.run({ args: ["-i", `./${video}`, "-c", "copy", "-movflags", "+faststart", "-y", `./${out}`] });
if (r.code === 0) await flux.task.recordArtifact(out);   // 随任务删除，且在 UI 里可见
```

另外建议先用 `flux.ffprobe`（同一 `ffmpeg` 权限）确认容器再决定是否 remux，替代现在纯按扩展名猜。

### 5.3 删除的代码

| 删除项 | 位置 | 理由 |
| --- | --- | --- |
| `b64encode()` | `resolver.js:173-197` | `btoa` 现列于可用 API（**需实测**；不可用则保留，反正 TS 版本更好读） |
| `authHeadersAsync()` 及 `hasHeaderCI` | `resolver.js:201-269` | 被 `RequestPatch.originHeaders` 取代 |
| `docs/upstream-m3u8-rs-method-none.patch`、`docs/engine-hls-ext-x-key-method-none.patch` | docs | 上游已修（v0.5.4），保留会误导 |
| `docs/ad-removal-notes.md` 的"死路"结论 | docs | 需改写为"已由拦截器实现"，保留历史论证 |

---

## 六、拦截器：本轮真正的能力增量

### 6.1 它在任务流水线里的位置

```
resolver（决定"下什么"）        interceptor（决定"怎么下"）
─────────────────────────       ────────────────────────────────────────────
resolve(ctx)                    prepare   → RequestPatch（URL/头/Cookie/UA/线程数/跳过探测）
  → 播放页发现 / 变体 / 命名       probed    → 探测后：分段数、连接上限
  → 返回 url|variants|manifest    selectVariant → HLS 主清单/DASH representation
                                 refresh   → 401/403/410 时换发凭据
                                 segments  → ★ 逐分片 drop / rewrite（点播）
                                 liveSegments → 直播每轮刷新（≤2s）
                                 finalize  → 完成前 replaceWith / fail
                                 failed    → 是否重试
```

两句话概括边界：**resolver 是"发现层 + 鉴权层"，interceptor 是"下载运行时层"**。同一插件可以两者都有。

### 6.2 去广告：回到插件内，且不需要外部进程

这是 1.4.3 停用 `adClean` 之后的**能力回归**，而且形态更干净：

| 维度 | 旧方案（v1.4.3 前，已停用） | 新方案（拦截器 `segments`） |
| --- | --- | --- |
| 实现位置 | 本地 Python 清洗服务（`adfilter/`） | 插件进程内纯函数 |
| 依赖 | 需另起 HTTP 服务 + 用户配端口 | 零依赖 |
| 失败模式 | 服务没起 → 下载失败或整条走原链 | fail-closed：返回 `null` 则完全按原样下载 |
| 分片地址 | 需自行绝对化后回写 | 引擎已解析好，只需给 `drop` 的 id 列表 |
| 隐私 | 所有 playlist 过一遍本地服务 | 无外发 |
| 可维护性 | 两套代码（插件 + 服务） | 一套规则表 |

实现要点（`entry/intercept.ts`）：

```ts
import type { InterceptHandlers, SegmentItem } from "fluxdown-plugin-sdk";

defineInterceptors({
  segments(ctx) {
    if (ctx.format !== "hls") return null;              // 先只做 HLS，DASH 观察后再放开
    if (!ctx.task.url.includes(SENTINEL)) return null;   // 只处理本插件经手的任务
    const drop = pickAdSegments(ctx.segments, loadAdRules());
    return drop.length ? { drop } : null;                // fail-closed：拿不准就不动
  },
});
```

`SegmentItem` 提供了判定广告所需的全部信号（`SegmentItem` 类型定义，SDK `0.5.8+`）：

| 字段 | 去广告用途 |
| --- | --- |
| `tags` | 引擎未识别的原始标签，典型 `#EXT-X-CUE-OUT:30` / `#EXT-X-CUE-IN`（SCTE-35 广告插入标记）；官方文档的示例就是按此过滤 |
| `dateRange` | `#EXT-X-DATERANGE`，Apple 的 interstitial 广告用 `CLASS="com.apple.hls.interstitial"` 标注 |
| `duration` | 极短段（`0` 或 < 0.5s）多为拼接占位 |
| `discontinuity` | 广告段边界常伴随不连续 |
| `uri` / `title` | 路径或标题里出现 `ad/ads/advert/promo/bumper` 等 |
| `key` / `map` | **危险信号**：跨段密钥或 init 段变化的段不能随意丢，否则后续解密/初始化失败 |

三条工程纪律（否则会造出"能下但播不了"的产物）：

1. **成对丢弃**：`CUE-OUT` 与 `CUE-IN` 之间的一段（含两端标记段）才丢；只有 `CUE-OUT` 没有 `CUE-IN` 时不丢。
2. **禁止跨 `map`/`key` 边界丢弃**：若待丢段之后紧跟的段的 `map` 或 `key.uri` 与当前段不同，跳过本次丢弃。
3. **禁止丢空全部分片**：官方明确"会清空全部分片的丢弃视为错误"；实现上先算"保底段数"，不足即放弃。

代价（必须写进设置项说明）：**丢弃分片会让已有的续传失效**，下载会干净地重来（官方明确）；对已下载
99% 的任务改规则等于重下。

规则来源建议三级：
- `adRulesMode: "off" | "marker" | "heuristic"`（marker 只看 CUE/dateRange，最保守；heuristic 叠加时长/命名特征）；
- `adRulesExtra: string`（多行 JSON，站点级白名单/黑名单，如 `{"dropHosts":["ads.cdn.com"],"keepPath":["/ep\\d+/"]}`）；
- 内置种子表（从 `adfilter/ad_patterns.txt` 提炼，TS 常量，不落盘）。

### 6.3 `prepare` 还是 `request`？

**推荐 `request`（resolver 返回值字段），不订阅 `prepare` 阶段。** 理由：

- `prepare` 每次运行都调用一次（含元数据探测前），对不含本插件任务的无关下载是纯开销，且每任务一条
  `intercept.prepare` 审计记录；
- resolver 本来每次启动/恢复都会重跑（惰性解析），`request` 补丁"每次运行重放"的语义与之天然对齐；
- 例外：如果将来要做"下载中途 401/403 换发凭据"，那必须用 `refresh` 阶段 —— 那是 resolver 做不到的。

`interceptors.stages` 因此从 `["segments"]` 起步；`finalize` 是否加入见 §6.5。

### 6.4 `selectVariant` 明确**不用**

本项目已经用 `variants` + `defaultVariantIndex` 让用户在**任务创建前**选画质（有 UI、可记忆默认）。
`selectVariant` 是引擎侧对**已确定的清单**再选一次，两者叠加会让"用户选了 720p 却下了 1080p"这类
不一致变得难以解释。保持单一决策点。

### 6.5 `finalize` + `replaceWith`：把 remux 挪进来的冲动要压住

看起来很美：`finalize` 在"下载完成、任务标记完成之前"运行，返回 `replaceWith` 会让**旧文件被删、任务指向
新文件**，能顺带修掉现在 onDone remux 之后旧 `.ts`/`.mkv` 残留的问题。但存在一个**未解的约束**：

> API 参考明确写 `flux.ffmpeg.run` **仅在 `onDone` 可用**（其他上下文 `run` reject）；而拦截器指南又说
> "声明 `ffmpeg` / `ytdlp` 权限的插件在 `finalize` 阶段用更长后处理预算"。

两处表述冲突。**默认按保守解释**：remux 留在 `onDone`，只用 `recordArtifact` 补登记；把"finalize 内跑
ffmpeg"列为 §8 待实测项 —— 若实测可用，再迁，收益是"任务记录的文件名/大小与实际产物一致"。

### 6.6 拦截器接入的连带影响（易被忽略）

| 影响 | 说明 |
| --- | --- |
| 权限与授权 | 新增 `intercept` → 风险等级仍是**较高**（已因 `ffmpeg`/`ytdlp`/`auth` 判定为 elevated），但**用户必须重新批准**：已批准集合要求**精确匹配**，新增权限未批准则插件装上但保持停用，显示"需要授权" |
| 熔断 | 拦截器调用计入熔断：**连续 3 次**超时或超内存 → 插件自动禁用。`segments` 对每条轨道调用一次，200 集剧集 = 400 次调用，规则必须是**纯本地计算**（不得 `flux.fetch`） |
| 超时 | `interceptors.timeoutMs` 默认 5s（硬顶 30s），`liveSegments` 上限 2s，`refresh` 上限 5s |
| 审计 | 每次调用记一条 `intercept.<stage>`，目标为任务 id。规则若抛错，`onFailure:"continue"` 下会被记录并跳过 |
| `match.urls` | 拦截器按**原始 URL 或 resolver 改写后 URL** 匹配；播放页 URL 不含 `.m3u8`，故必须用 `*://*/*` + 内部标记 fail-closed，不能依赖 URL 模式 |

### 6.7 `flux.tasks`：能做，但不建议做

现在插件可以在 `main` 里 `flux.tasks.create()`。但：

- 剧集批量下载已经走"resolver 返回 `manifest` → **引擎**裂变建组"的路径（`resolver.js:1258-1277`），
  这条路径负责分组、命名、进度聚合，`create` 全部要自己重做；
- `create` 限 **20 次/分/插件**，200 集剧集会直接触顶；
- 需要 `main` 常驻脚本 + `tasks` 权限，多一份常驻代码与授权成本。

**结论：维持现状**，把 `tasks` 权限排除在 manifest 之外，减少授权面。

### 6.8 顺手可得的增强

| 增强 | 机制 | 价值 |
| --- | --- | --- |
| 分段线程数可调 | `RequestPatch.segments`（覆盖本次运行的用户线程数） | 现在只能全局设；HLS CDN 限流时分站调优有用 |
| 小 `Range` 直链兼容 | `RequestPatch.maxRangeBytes`（≥64KiB，需 `0.6.0`） | 网盘 CDN"单请求 > 5MiB 就 403"这类场景，现在只能整体单线程 |
| yt-dlp 带 Cookie 文件 | `flux.fs.writeFile('cookies.txt', …)` + `--cookies cookies.txt`（白名单内） | 现在只能靠 `--add-header` 传 Cookie，长 Cookie 易被命令行长度限制 |
| 大清单解析 | `resolvers[0].memoryLimitMb`（默认 64MiB，上限 512，需 `0.6.2`） | 剧集页正则扫描 500 条上限已有，不必急 |

---

## 七、门槛、兼容与风险

### 7.1 `minAppVersion` 与版本号

| 阶段 | manifest 新增字段 | `minAppVersion` |
| --- | --- | --- |
| M1（仅 SDK 迁移，功能等价） | 无（字段与 1.8.0 相同） | `0.4.8` 可保留，但建议直接 `0.5.8` 统一 |
| M3（拦截器） | `interceptors` + `permissions:["intercept"]` | **`0.5.8`**（不可回落） |
| M4（`maxRangeBytes`） | 无 | `0.6.0` |
| M4'（`memoryLimitMb`） | 无 | `0.6.2` |

**版本号**：`fluxdown-plugin validate` 与插件索引是**严格模式** —— 只能 `MAJOR.MINOR.PATCH`，纯数字、
无前导零、无 `v` 前缀、无后缀。当前 `1.8.0` 合规。本轮是 breaking（安装路径变 `dist/`、新增权限、抬门槛），
建议 **`2.0.0`**，与 Release 一并说明"旧版客户端需先升级 FluxDown"。

### 7.2 用户侧迁移影响

| 变化 | 用户感知 | 处置 |
| --- | --- | --- |
| 开发模式安装路径 `src/` → `dist/` | 自己 clone 的用户会装错 | README/Release 说明；`src/` 下不再有 `manifest.json`（装了会报"缺少 manifest"） |
| 新增 `intercept` 权限 | 更新后插件显示"需要授权"、保持停用 | Release 说明写清"需在 设置 → 扩展 → 插件 重新授权" |
| `minAppVersion 0.5.8` | `0.4.8`–`0.5.7` 用户无法加载 | 明确"请先升级 FluxDown" |
| 设置项 | 全部沿用（`identity` 不变），新增去广告 2–3 项 | 默认 `adRulesMode: "off"`，升级后行为不变 |
| `METHOD=NONE` | 以前必失败，现在能下 | 从"限制"改到"更新日志" |

### 7.3 许可证：一条必须立下的纪律

SDK 是 **AGPL-3.0-or-later**，本项目是 MIT。`fluxdown-plugin-sdk/runtime` 的 `defineResolver` 等辅助函数
实质是 `Reflect.set(globalThis, "resolve", fn)` 这类几行代码，但 esbuild 打包会**把它内联进 `dist/*.js`**。
是否构成 AGPL 传染是法律判断，我不下结论；但有一条零成本规避路径：

> **只从 SDK 导入类型**（`import type { … }`，构建时擦除），入口函数自己赋给 `globalThis`。

```ts
import type { ResolveContext, ResolveResult } from "fluxdown-plugin-sdk";

async function resolve(ctx: ResolveContext): Promise<ResolveResult | null> { /* … */ }
globalThis.resolve = resolve;   // 等价于 defineResolver(resolve)，但产物零 SDK 代码
```

代价：失去 `defineHooks` / `defineInterceptors` 的阶段分发糖（自己写 `switch (ctx.stage)` 即可）。
收益：`dist/` 里除自己的代码与 esbuild 运行时代之外无第三方内容，MIT 授权链干净。
已发布的 `youtube-down` 示例插件用的是 SDK 辅助函数 —— 值得看一眼它的 `license` 字段怎么写的，作为对照。

### 7.4 其它风险

- **拦截器误伤**：`match.urls: ["*://*/*"]` 意味着你的 `intercept()` 会被**所有**任务的 `segments` 调用。
  第一行必须是廉价 fail-closed（协议判定 + 标记判定），且不得抛异常（`onFailure` 虽兜底，但会污染活动日志）。
- **规则漂移**：站点改广告结构 → 需要"关闭开关"的即时路径。设置项改动对拦截器**立即生效**
  （`flux.settings` 一次性入口是快照，但每次调用都会重建 → 下一任务即生效），无需重载插件。
- **熔断连带**：`segments` 因规则写得烂（如正则灾难性回溯）导致超时，会连带把 resolver 一起熔断停用 —— 
  规则表必须限制输入长度（`tags` 逐条截断 512 字符）并避免嵌套量词。

---

## 八、分阶段实施与验收

| 里程碑 | 内容 | 验收标准 |
| --- | --- | --- |
| **M1 工程化** | 建 SDK 项目骨架、拆 `lib/*`、`manifest.json` 移到根、`npm run build` + `validate` 通过；四个入口行为等价 | 同一批 URL（直链 m3u8 / media playlist / 播放页 / 剧集页 / mpd / 需登录站）下载结果与 1.8.0 逐字一致；`dist` 目录可被"从目录安装"加载 |
| **M2 请求面** | resolver 返回 `request` 补丁，删除 `authHeadersAsync` / `b64encode` | 防盗链站仍能下（Referer/Origin/UA）；登录站凭据生效且**不发给 CDN 主机**；一次性链接不被探测消耗 |
| **M3 拦截器** | 新增 `intercept.ts` + `adRules*` 设置；`segments` 只做 HLS；默认 `off` | 带 CUE-OUT 的测试流丢弃后产物可播、时长正确；`off` 时输出与 M2 完全一致；200 集剧集不触发熔断 |
| **M4 后处理** | `recordArtifact` 登记 remux 产物；`ffprobe` 预判容器；（实测通过后）`finalize.replaceWith` | 删除任务时产物一并删除；不再出现孤立 `.ts`；`maxRangeBytes` 站点可多线程 |
| **M5 界面（可选）** | `main` + `contributes.views`：`settings` 位置做一个"去广告规则编辑 + 站点预设"页签 | 视图在桌面与 Web 均可渲染；不声明 `desktop` 因而不引入"完全风险" |

M5 特别说明：`location: "settings"` **至多一个**视图，它替换插件的默认设置页签；`desktop` 入口会拉高到
**完全风险**等级并需要 `desktop` 权限 —— **不要**为了界面顺手引入，可移植视图（`main` + `flux.ui.h`）
已经够用，且 Web 端同样渲染。

---

## 九、待实测验证清单（装机必做，按优先级）

| # | 待验点 | 为什么重要 | 判定方法 |
| --- | --- | --- | --- |
| 1 | `typeof btoa` / `typeof URL` | 决定能否删 `b64encode`，以及类型假设是否成立 | 在 resolver 里 `flux.logger.info(typeof btoa, typeof URL)` |
| 2 | `finalize` 阶段 `flux.ffmpeg.run` 是否可用 | 决定 remux 能否迁出 `onDone` | 造一个 `.ts` 任务，finalize 里试跑 `-version` |
| 3 | `segments` 的 `id` 语义与 `drop` 边界 | 绝对 media sequence；丢错一位会毁掉整条流 | 对同一流分别 `drop:[n]` 与 `drop:[]`，比对产物时长与可播性 |
| 4 | `resolver.request` 与 `variants` 同时返回 | 补丁是否对"用户手选变体"后的下载生效 | 手选 720p 后抓包看 Referer/Cookie 是否仍带上 |
| 5 | `originHeaders` 的 host 归一化 | 决定 CDN 是否真的不收 Cookie | 用两个子域（`a.site.com` / `cdn.site.com`）分别登记，观察注入 |
| 6 | 开发模式 `dist/` 热重载 | 决定 M1 之后的工作流 | 改 `resolver.ts` → build → 不重载是否生效；改 `manifest.json` → 必须重载 |
| 7 | `validate` 严格模式对现有 manifest 的裁决 | 可能立刻暴露既有字段问题（如 `default` 类型） | 根目录跑 `npx fluxdown-plugin validate` |

---

## 十、明确不改的部分

- **命名机制**（四层链 + 模板）与 `nameTemplate` 占位符：与插件体系无关，保持。
- **剧集识别分层（Tier-0/1/2）与"宁可漏判不可错判"原则**：`multi` 清单机制未变，误判代价仍是"每次提交弹
  无意义的选集框"。
- **反爬两件套（XOR-eval 挑战 / iframe 跟随）**：仍是纯 HTTP + 正则，沙箱无 DOM/JS，天花板不变；
  `pageScripts`（浏览器扩展注入页面脚本）**不是**替代品 —— 它只能覆盖装了扩展且走浏览器的路径。
- **订阅 provider**（`providerId: m3u8play`）：`v0.5.8` 起已进公开文档（"订阅支持插件 provider 与专属配置"），
  README 里"未列入公开文档"的免责声明可以删掉。
- **DRM / LL-HLS / 真直播**：仍在引擎层，插件够不到，结论不变。

---

## 附：manifest 骨架（v2.0.0 草案）

```json
{
  "identity": "m3u8-resolver@cocolight",
  "name": "M3U8 发现与变体解析器",
  "version": "2.0.0",
  "minAppVersion": "0.5.8",
  "description": "把播放页或 .m3u8 链接解析成可下载的 HLS 播放列表：自动选清晰度、补齐防盗链请求头，支持剧集批量、登录站点、订阅追更、反爬站处理与分片级去广告。",
  "homepage": "https://github.com/cocolight/fluxdown-plugin-m3u8",
  "permissions": ["ffmpeg", "ytdlp", "auth", "intercept"],
  "resolvers": [
    { "match": { "urls": ["*://*/*"] }, "entry": "resolver.js", "timeoutMs": 25000, "multi": true }
  ],
  "auth": { "entry": "auth.js", "timeoutMs": 25000 },
  "subscriptions": [{ "providerId": "m3u8play", "entry": "subscribe.js", "timeoutMs": 25000 }],
  "hooks": { "entry": "hooks.js", "events": ["onDone", "onError", "onCancel"] },
  "interceptors": {
    "entry": "intercept.js",
    "stages": ["segments"],
    "match": { "urls": ["*://*/*"] },
    "timeoutMs": 4000,
    "onFailure": "continue"
  },
  "settings": [
    { "key": "adRulesMode", "title": "分片级去广告", "type": "string", "widget": "select",
      "options": [
        { "value": "off", "label": "关闭（默认）" },
        { "value": "marker", "label": "仅按 SCTE-35 / DATERANGE 标记" },
        { "value": "heuristic", "label": "标记 + 时长/命名启发式" }
      ],
      "default": "off" },
    { "key": "adRulesExtra", "title": "去广告补充规则（JSON）", "type": "string", "widget": "textarea", "default": "" }
  ]
}
```

（`settings` 其余 22 项原样保留；上表只列出新增项。`interceptors.match.urls` 虽为 `*://*/*`，实际处置
由 `intercept()` 首行的"协议 + 任务标记"双重 fail-closed 决定，理由见 §6.6。）
