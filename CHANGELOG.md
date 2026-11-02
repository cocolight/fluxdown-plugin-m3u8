# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与
[语义化版本](https://semver.org/lang/zh-CN/)。

> 条目一行说清「改了什么」，一条一事，单条不超过 150 字符（CI 断言）。取舍只在非显而易见时
> 在条目末尾用「（理由：…）」附**一句话**，多数条目不带理由；不写破折号插入语与推导叙事。
> 小决策的留痕在此，重大决策走 `.agents/adr/`。
>
> 2.0.0 – 2.2.0 三节无独立 tag（工作随 3.0.0 系列交付），日期标「未发布」。
> 3.0.0-rc1 是 3.0.0 的**预览版**（pre-release）；rc 之后的新改动记入 `[Unreleased]`，正式 3.0.0 发布时并入 `[3.0.0]` 节。
> 预发布标识只在 tag / Release / 版本节标题三处；`manifest.json` 与 `package.json` 的版本保持 `3.0.0`（SDK 的 strict 校验只收三段 MAJOR.MINOR.PATCH，不收预发布后缀）。
> 原计划的 2.3.0（设置页）从未发布，已并入 3.0.0。3.0.0 移除登录入口属 breaking，故一并升大版本。

## [Unreleased]

### Added

- yt-dlp 委派带上登录凭据：Cookie 写 `cookies.txt` 走 `--cookies`，`Authorization` 等头走 `--add-header`
- 新增 `src/lib/ytdlp.ts`：凭据 → yt-dlp 参数的适配（Cookie 与请求头分两路，用完即删临时文件）
- 拦截器新增 `failed` 阶段：按失败类型决定是否重试，只对瞬时网络错误与 5xx 重试，认证 / 404 / 磁盘 / 解密 / 取消一律不接管
- 拦截器新增 `refresh` 阶段：401/403/410 时重新访问任务地址取新 Cookie 并合并下发，最多换发一次
- 新增 `src/lib/failure.ts`（失败归因）与 `src/lib/refresh.ts`（凭据换发）
- 新增 `src/lib/task.ts`：拦截器侧的极简任务形状，让 lib 层不必依赖 SDK 的完整类型
- 订阅 provider 支持防抓页解锁：遇「安全检查」页时解出 Cookie 并对同一地址重取一次（此前只会解析出空 feed，用户看不出是被拦了）
- 新增 `tests/subscribe.mjs`：订阅契约 14 项（解锁只重取一次、不循环、订阅源 Cookie/UA 不丢且合并而非覆盖）
- `authCookie` 支持首行 `@站点` 声明归属：声明后凭据只发给该站点，可写裸域 / `*.子域` / 精确 origin / 逗号分隔多个（理由：同源闸两侧同取任务 URL，恒真等于无约束，见 ADR-0010）

### Changed

- 去广告的 CUE 块边界改用 `CUE-OUT:DURATION` 交叉判定：`CUE-IN` 挂正片首段的流不再误删一个正片分片
- 拦截器契约 72 → 74 项：新增「IN 挂广告末段」「IN 挂正片首段」两条 CUE 边界用例
- 请求面契约 32 → 47 项：新增 yt-dlp 凭据 15 项（7 列格式、secure 位随 scheme、Bearer 走头、无凭据零改动、写失败降级）
- 请求面契约 47 → 58 项：新增凭据站点约束 11 项（四种写法 × 命中/不命中、无 `@` 行兼容、yt-dlp 链路守门）
- 请求面契约 58 → 65 项：新增 `targetHosts` 继承 4 项、`@*.` 正面 1 项、优先级 2 项
- 凭据的 `@a.com` 改为**只匹配 `a.com` 本身**，含子域须显式写 `@*.a.com`（理由：凭据是限制不是白名单，扩到 `evil.a.com` 即泄漏，见 ADR-0011）
- 凭据没写 `@站点` 时改为继承 `targetHosts`，该清单留空才真正不限站点（理由：用户已在同一张表单里表达过站点意图，再抄一遍只会漏抄）
- 新增 `src/lib/site.ts`：`targetHosts` 的解析与命中判断，resolver 与凭据缺省约束共用一份
- `credentialOrigin()` / `ytdlpArgsFromCredential()` / `credentialFor()` 增加 `targetHosts` 参数并透传到 `parseCredential()`
- 设置表单重排：站点两项（生效范围 / 登录凭据）提到最前，去广告两项紧随开关段（理由：站点决定「在哪些站生效、用什么身份」，是配置的第一步）
- 设置表单契约 19 → 21 项：新增「站点两项排最前」「去广告紧随开关段」两条顺序断言
- `credentialOrigin()` 改为显式接收 `raw` / `siteUrl` / `targetUrl`，resolver 与 `refresh` 共用同一份凭据同源闸
- 拦截器按 `ctx.stage` 显式分派：`segments` 纯本地、`failed` 只读存储、`refresh` 才发请求
- 拦截器契约 33 → 72 项：新增 `failed` 23 项、`refresh` 12 项
- 六层测试的断言维度收口到 `CONTRIBUTING.md`：README 与 `AGENTS.md` §2 不再各自复述 `npm run <层>`，只留入口与分层口径
- README「开发约定」并入 `CONTRIBUTING.md`：分支、钩子、ROADMAP/CHANGELOG 要求与文档落点原属重复项，README 只留指路
- README 清理陈旧内容：删除「已停用：本地源头去广告」整节、v1.8.0 源码目录叙事与 2.1.0 升级提示
- README 事实校正：fixture 数 67 → 53，凭据同源口径改为「与任务地址同源」，升级注意事项改为 3.0.0 的两项影响（凭据重填、重新授权）
- 文档去 AI 味改写：README 重排结构、长句拆短，全仓文档破折号插入语清零（40 → 0 处）
- 文档补记 9 项装机实测结论：`recordArtifact` 允许主干后缀、重复登记幂等、`flux.fs` 根非下载目录（理由：均为源码或探针确证，且影响后续设计取舍）
- 凭据站点判断下沉到 `parseCredential()`：抓清单、下载补丁、yt-dlp 委派三条链路共用一个收口点，避免逐点加判断漏掉一条
- 「复制取 Cookie 脚本」按钮改为输出带 `@站点` 行，用户复制即得带约束的凭据
- 建立 `docs/settings.md` 与 `README.md` 的括号嵌套上限，超长表格行外的段落一律拆句

### Fixed

- `errnoOf()` 只认白名单里的错误码，不再取正则第一个匹配（`read error: ECONNRESET` 曾先命中 `ERROR`，导致该重试的失败被判成认不出）
- `AGENTS.md` §8 删掉对已删除文件 `main.tsx` / `rulecheck.ts` / `adpresets.ts` 的引用，改为指向 `manifest.json` 与 ADR-0009
- 测试分层表述统一为六层：补上 `subscribe`（`AGENTS.md`、`architecture.md`、`configuration.md`、`definition-of-done.md`、`releasing.md`、`CONTRIBUTING.md`）
- `README.md` 安装说明的 `.fxplug` 文件名更正为 `m3u8-resolver@cocolight-<版本号>.fxplug`
- `releasing.md` 更正 `npm run pack` 产物名的描述：实际为 `m3u8-resolver@cocolight-<版本>.fxplug`，非 `fluxdown-plugin-m3u8_<版本>.fxplug`
- `hooks` 的 ffmpeg 失败日志区分超时：超时单独提示「默认 5 分钟上限、产物可能是不完整的半成品」，不再只报 `code -1`
- `tests/parity/harness.mjs` 的 `ffmpeg.run` 开始透传 `timedOut`（此前写死 `false`，超时分支从未被覆盖）
- 新增 `tests/postprocess.mjs` 两组用例：超时日志文案、超时不登记产物（36 项）
- `targetHosts` 补上 `"default": ""`：此前缺该键，运行时取到 `null`，`str()` 变字符串 `"null"` 被当成主机名，所有播放页都不处理（理由：宿主表单回显空串，界面看不出异常）

## [3.0.0-rc1] - 2026-11-02

> 3.0.0 的预览版。以下条目即该 rc 的全部改动；正式版 3.0.0 另开节记录 rc 之后的增量。

### Removed

- 移除登录入口：删掉 `auth` 段与 `auth` 权限，产物入口由 6 个降为 5 个（理由：登录对话框按站点登录，与对所有站点生效的定位冲突，见 ADR-0006）
- 删除 `src/entry/auth.ts`；`tests/parity` 中 13 条 `auth` 场景随功能删除，改由 `tests/contract` 断言「已移除」
- 删除 `adfilter/` 目录：v1.4.3 停用的本地去广告清洗服务（Python，独立进程），manifest 无对应设置项、构建无对应入口、测试无引用，规则特征早已迁入 `lib/adrules.ts`
- 移除自定义设置视图（`contributes.views` + `main` 入口 + `src/entry/main.tsx`）：设置面收敛为宿主自动生成的表单（理由：视图与表单并存时宿主自带一层页签，嵌套菜单且同名歧义，见 ADR-0009）
- 删除 `src/lib/rulecheck.ts` 与 `src/lib/adpresets.ts`：只服务旧设置视图，规则 JSON 的格式说明改由字段描述与 `docs/settings.md` 承担

### Added

- 新增 `src/lib/credential.ts`：凭据文本解析（bearer / basic / 多行头 / Cookie），补丁与抓取两处共用
- `adRulesExtra` 字段说明自带 JSON 格式示例（`keepPath` / `dropPath` / `dropHosts`），逐项说明见 `docs/settings.md`
- 新增 `tests/ui.mjs`：设置表单契约（开关成组、主题前缀、默认值锁定、select 选项、产物形态），现 18 项
- `scripts/check-fast.sh` 新增第 6 条：manifest 声明的入口必须在构建配置里有映射
- 新增 ADR-0009（取代 0008、解除 0005 的 JSX 运行时例外）：设置面收敛为宿主表单，产物零 SDK 运行时；ADR-0004～0008 的设置页中间形态随之作废
- 新增 ADR-0008（取代表 0007）：设置页改三个页签，去掉 `expertMode` 开关，页签选择只存视图 state
- 新增 `AGENTS.md`、`.agents/` 工程文档、`ROADMAP.md`、`CONTRIBUTING.md`、`THIRD-PARTY.md`
- 新增 `scripts/check-fast.sh` 快速门禁与 `.githooks/pre-commit`，本地与 CI 共用同一份断言
- 新增 `.github/pull_request_template.md`
- `.agents/extension-points.md` 补「换或加技术栈骨架」一节（理由：模板列六项扩展点，此前只覆盖五项）

### Changed

- 登录凭据改由设置项 `authCookie` 直供：下载补丁走 `originHeaders`、抓取走 `fetchHeaders`，同源闸不变
- 设置面 = 宿主自动生成的单张表单（无页签）：开关 11 项连续排最前并成一张卡片，参数 14 项按主题聚簇（标题「主题 · 项目」），去广告 2 项殿后
- 27 个设置项的标题与描述改写为面向使用者的一句话，总字数从 2767 降到 670
- 测试链路由四层扩为五层，`npm test` 增加 `ui`（设置表单契约）
- CI 由 `ci.yml` 改为 `build.yml`，新增 CHANGELOG 门禁与发版守卫两个 job
- 工程文档从 `docs/` 迁到 `.agents/`，`docs/` 只保留使用者文档（理由：两类读者不该共用一处）
- `.agents/capability-matrix.md` 同步为现状：`METHOD=NONE` 标记为已修复、请求面改用 `request` 补丁
- 发版守卫要求版本节带实际日期，`- 未发布` 占位不再通过（理由：占位与日期在旧正则下不可区分，等于放行）
- `AGENTS.md` §9 同改矩阵的「设置键」一行改指 `manifest.json` + `settings.ts`，仓库配置单列一行
- 使用者文档 `docs/configuration.md` 改名 `docs/settings.md`（理由：与 `.agents/configuration.md` 同名，跨目录引用会指错）
- `.agents/sdk-migration.md` 的 M5 记录设置面的形态迭代（两档 → 三页签 → 宿主表单），待实测项随形态更新
- `THIRD-PARTY.md` 的 SDK 登记改为「仅 `import type`，零运行时随分发」（jsx-runtime 例外已解除）
- `.agents/configuration.md` 补 ruleset 的 `enforcement` 核对步骤与合并策略（squash），分支保护改按 ruleset 描述

### Fixed

- README 的 Releases 链接写成 `../../releases`，会解析到用户级页面，改为仓库绝对地址
- `AGENTS.md` §3 漏掉「保护分支，禁止直接推送」一条，`CONTRIBUTING.md` 同步补回

### Removed

- 删除 `METHOD=NONE` 上游缺陷记录与两份补丁（理由：引擎 v0.5.4 起已修复，记录失效）
- README 移除 `METHOD=NONE` 限制条目与 `subscriptions` 未列入公开文档的免责声明

## [2.2.0] - 未发布

### Added

- 合并与转封装产出的文件用 `flux.task.recordArtifact` 登记，删任务时一并删除
- 新增设置 `rangeCapKb`，换算成 `RequestPatch.maxRangeBytes`（需引擎 0.6.0，默认关闭）

### Changed

- `onDone` 先用 ffprobe 读真实容器再决定是否转封装，扩展名不再作唯一依据
- 容器判定按 MP4 家族（`mov,mp4,m4a,3gp,3g2,mj2`）而非扩展名相等
- `minAppVersion` 0.5.8 → 0.6.0（理由：`maxRangeBytes` 自 0.6.0 提供）

### Fixed

- 视频为 `.mp4` 且音轨未合并时旧版完全静默，现按原意告警

## [2.1.0] - 未发布

### Added

- 新增第五个入口 `intercept`，在 `interceptors.segments` 阶段丢弃广告分片，默认关闭
- 新增设置 `adRulesMode`（关闭 / 仅标记 / 标记 + 推测）与 `adRulesExtra`（自定义 JSON 规则）

### Changed

- 任务标记上限 60 → 300（理由：拦截器靠它判断归属，200 集批量任务会把先建的标记挤掉）
- `permissions` 增加 `intercept`，已装用户升级后需重新授权一次

## [2.0.0] - 未发布

### Added

- 请求面改由 `resolve` 返回值中的 `request` 补丁下发：`referrer`、`userAgent`、`setHeaders`
- 登录凭据改走 `RequestPatch.originHeaders`，只对登记站点同源请求生效

### Changed

- `minAppVersion` 0.4.8 → 0.5.8

### Removed

- resolver 返回值中的 `extraHeaders` 字段，不与 `request` 并存（理由：两个来源会形成「谁生效」的长期歧义）
