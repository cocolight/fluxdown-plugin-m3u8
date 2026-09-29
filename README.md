# M3U8 发现与变体解析器（FluxDown 插件）

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

一个 [FluxDown](https://github.com/zerx-lab/FluxDown) 下载器插件：输入播放页或 `master.m3u8`，自动发现正确的播放列表、解析多码率变体，并带上 `Referer`/`Origin` 鉴权头，交给 FluxDown 内置 HLS 引擎下载合并。可选启用 yt-dlp 委派（复杂站点抽直链）与下载后 remux 为 MP4 保险。

> 适用场景：HLS（`.m3u8`）流媒体下载。需要 FluxDown 桌面端/服务端，推荐 **v0.4.8 及以上**（支持 `.fxplug` 一键安装）。

## 功能特性

- **自动发现 master**：直接粘贴 `.m3u8` 直链时直接处理；粘贴播放页时自动从页面源码抠出 `master.m3u8`（兜底正则，复杂站点可自定义 `extractMaster`）。
- **多码率变体解析**：解析 `#EXT-X-STREAM-INF`，按带宽降序列出画质，支持手动选画质或自动选最高/指定画质。
- **鉴权头自动注入**：自动带上 `Referer`/`Origin` 及任务的 `extraHeaders`，解决常见防盗链；Cookie 由 FluxDown 引擎自动携带。
- **相对地址修正**：兼容 QuickJS 沙箱下 `new URL(u, base)` 对相对路径的兼容问题，确保永远输出绝对地址，避免「url scheme 不允许」。
- **默认命名更友好**：播放页取 `<title>`，直链 m3u8 用 URL 推导基础名，避免裸 `index.m3u8`。
- **增强 B（可选）：yt-dlp 委派** —— 复杂站点（m3u8 藏在 JS/JSON 里）交给 yt-dlp 抽直链。
- **增强 A（可选，默认开）：下载后 remux** —— 产物不是 `.mp4` 时（如仍是 `.ts` 容器），用 ffmpeg 无损转封装为 `.mp4`。

## 安装

### 方式一：从 Release 安装 `.fxplug`（推荐）

1. 到本仓库 [Releases](../../releases) 下载 `m3u8-resolver-1.1.0.fxplug`。
2. 打开 FluxDown → **设置 → 扩展 → 插件 → 从文件安装**，选择下载的 `.fxplug`。
   - 新版桌面端也支持直接把 `.fxplug` 当作 `.zip` 选择。
3. 在插件列表启用，并按需修改设置。

### 方式二：从源码目录安装（开发模式）

1. 把本仓库 `git clone` 到本地。
2. FluxDown → **设置 → 扩展 → 插件 → 从目录安装**，选择仓库根目录。
3. 开发模式下修改 `.js` 存盘即热生效，方便调试。

> 相同 `identity`（`m3u8-resolver@you`）再次安装会替换旧版本。

## 配置项（插件设置）

| 设置 | 说明 | 默认 |
| --- | --- | --- |
| 目标站点主机 | 仅处理这些主机的「页面 URL」；直链 `.m3u8` 不受限。留空则插件不处理任何页面。逗号分隔。 | 空 |
| 偏好画质 | 选码率时优先：`best` / `1080` / `720` / `480`。自动选时生效。 | best |
| 自动选择 | 开启后不弹画质框，按偏好直接下载。 | 关 |
| 防盗链/签名直链 | 跳过元数据探测，避免一次性/签名直链被用掉；恢复下载会重新解析。 | 关 |
| 启用 yt-dlp 委派 | 链接交给 yt-dlp 抽直链，适合原生抠不出的站点。需先装 yt-dlp 组件。 | 关 |
| 下载后 remux 为 MP4 | 产物非 `.mp4` 时用 ffmpeg 无损转封装。需装 ffmpeg 组件。 | 开 |

## 使用说明

- **直链**：直接把 `https://.../xxx.m3u8` 丢给 FluxDown 即可，插件自动判断 master / media 并带好鉴权头。
- **播放页**：先在插件设置里填好「目标站点主机」，再把播放页 URL 交给 FluxDown；插件会从页面抠出 m3u8。
  - 复杂站点若兜底正则抠不出，请按站点结构自定义 `resolver.js` 里的 `extractMaster()`。
- **画质**：未开「自动选择」时会弹出画质选择框；默认选中按「偏好画质」算出的变体。

## 工作原理（简述）

1. `resolver.js` 的 `resolve(ctx)` 判断作用域：
   - 直链 `.m3u8` → 直接拉取。
   - 播放页 → 抓页源码，正则抠 `master.m3u8`。
2. 拉到 master 后解析 `#EXT-X-STREAM-INF` 变体，按带宽排序，依「偏好画质」选变体（或列出供手选）。
3. 返回结果带上 `Referer`/`Origin`/`extraHeaders`，标记 `rangeSupported` 以启用多线程分段。
4. 下载完成后 `hooks.js` 的 `onDone` 在开启 remux 时把非 `.mp4` 容器无损转封装为 `.mp4`。

## 安全与隐私

- 插件只在你配置的「目标站点主机」或直链 `.m3u8` 上生效，不会处理无关页面（fail-closed）。
- `onDone` 的 remux 仅对白名单容器（`ts`/`mkv`/`webm`/`flv`/`m4v`/`mov`/`m2ts`/`mpeg`/`mpg`/`ogv`）生效，避免误转 `.zip`/`.pdf`。
- Cookie 由 FluxDown 引擎统一管理，插件不单独存储凭据。
- 本插件不向任何第三方上传数据。

## 限制

- 原生 resolver 不处理：独立音轨的 DASH、ISM、SAMPLE-AES、直播录制等；此类场景请用 yt-dlp 委派或 [N_m3u8DL-RE](https://github.com/nilaoda/N_m3u8DL-RE)。
- 播放页解析依赖兜底正则，复杂前端（m3u8 在加密 JSON / 分段加载）需自定义 `extractMaster`。

## 文件结构

```
.
├── manifest.json   # 插件清单（identity、权限、设置、匹配规则）
├── resolver.js     # 解析入口：发现 master、选变体、带鉴权头
├── hooks.js        # 下载完成钩子：可选 remux 为 MP4
└── LICENSE
```

## 许可证

[MIT](LICENSE) © 2026 aliha
