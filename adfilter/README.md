# adfilter —— 源头去广告本地清洗服务

FluxDown 插件「增强 C：本地源头去广告」的**外置**组件。它是一个独立常驻的服务进程
（仅 Python 3 标准库，无第三方依赖），与插件本体解耦：插件只负责把引擎要抓的
playlist 地址改写为指向本服务，**清洗逻辑全部在这里**。

> 详细方案与一手结论见 [`../docs/ad-removal-notes.md`](../docs/ad-removal-notes.md)。

## 它做什么

```
插件 resolver 返回  http://127.0.0.1:8787/clean?src=<原始 m3u8>&ref=<referer>
        │
        ▼  本服务：抓原始 playlist（带 Referer 防盗链）
        │         剔广告段（CUE/DATERANGE/GAP 标记 + ad_patterns.txt 规则）
        │         剩余段与变体 URI 全部绝对化为「真实源站」地址
        ▼
   返回干净 playlist（plain http）  →  引擎只下正片
```

分片是绝对地址，引擎**直接连源站**下载，本服务只处理 `.m3u8`，不承担分片流量。

## 运行

### 方式一：exe（Windows，推荐）

编译好的 `m3u8_adclean_server.exe` 与 `ad_patterns.txt` 放在**同一目录**，双击或命令行运行：

```bat
m3u8_adclean_server.exe
m3u8_adclean_server.exe --port 9000
```

首次运行若目录下没有 `ad_patterns.txt`，会自动生成一份带注释的模板。

### 方式二：源码

```bash
python3 m3u8_adclean_server.py            # 默认 127.0.0.1:8787
```

### 命令行参数

| 参数 | 说明 | 默认 |
| --- | --- | --- |
| `--host` | 监听地址 | `127.0.0.1` |
| `--port` | 监听端口 | `8787` |
| `--base` | 对插件公布的服务基址（与服务实际地址一致） | `http://<host>:<port>` |
| `--rules` | 规则文件路径 | 程序同目录的 `ad_patterns.txt` |
| `--quiet` | 不逐条打印被剔除的分片，只输出汇总行 | 关 |
| `--list-rules` | 打印已加载规则后退出（排查规则不生效） | — |

健康检查（应返回 `ok`）：

```bash
curl http://127.0.0.1:8787/health
```

## 广告识别规则（`ad_patterns.txt`）

规则外置为纯文本文件，**改完重启服务即生效，无需重新编译 exe**。

语法（每行一条，大小写不敏感）：

| 写法 | 含义 |
| --- | --- |
| 空行 / `#` 开头 | 忽略（注释） |
| `re:<正则>` | 按正则匹配（Python 正则语法，已忽略大小写） |
| 其它文本 | 按**子串**匹配（出现在分片 URI 任意位置即命中） |

> 为什么不用 `/正则/` 包裹？因为默认规则里全是 `/ad/`、`/adjump/` 这类**以斜杠开头结尾的子串**，
> 用斜杠做正则定界符会把它们误当正则（例如 `/ad/` 退化成正则 `ad`，会误杀 `download.ts`）。
> 故采用无歧义的 `re:` 前缀。

命中即判定为广告：整个分片（`#EXTINF` + 分片 URI）连同包裹它的 `#EXT-X-DISCONTINUITY`
一起剔除。**命中的规则名会打印在日志里**，便于反查是哪条规则杀的。

标准广告标记**无需配置**，服务内置识别：

| 标记 | 含义 |
| --- | --- |
| `#EXT-X-CUE-OUT` / `#EXT-X-CUE-IN` | SCTE-35 广告块边界 |
| `#EXT-X-DATERANGE`（含 `SCTE-35` / `CUE-*`） | 广告区间 |
| `#EXT-X-GAP` | 空缺占位段 |

默认规则内容见 [`ad_patterns.txt`](ad_patterns.txt)。

## 日志输出

每次清洗都会打印**被剔除的每一条分片**及其判定原因，例如：

```
[m3u8_adclean] 规则文件：E:\...\adfilter\ad_patterns.txt
[m3u8_adclean] 载入规则：子串 17 条 / 正则 0 条
[m3u8_adclean] listening on http://127.0.0.1:8787  (Ctrl+C to stop)
[clean] 命中广告 3 条  ←  https://bfeng11.com/.../index.m3u8
  - 剔除[1/3] (规则「/video/adjump/」) https://bfeng11.com/video/adjump/time/1787320001790.ts
  - 剔除[2/3] (EXT-X-CUE-OUT 广告块) https://bfeng11.com/.../cue_ad.ts
  - 剔除[3/3] (EXT-X-GAP 占位段) https://bfeng11.com/.../gap.ts
  - 正片段保留 109 条，返回 18234 字节
```

未命中广告时输出 `[clean] 无广告命中，原样透传  ←  <src>`，加 `--quiet` 可只保留汇总行。

## 与插件对接

在 FluxDown 插件设置里：

| 设置 | 值 |
| --- | --- |
| 尝试去广告（源头跳过广告段） | 开 |
| 去广告服务地址 | `http://127.0.0.1:8787`（须与服务启动参数一致） |

## 重新编译 exe（Nuitka）

前置：Python 3.9+、`pip install nuitka zstandard`、一个 C 编译器
（MSVC 的 C++ 工作负载，或 `--mingw64` 让 Nuitka 自动下载）。

```bat
python _build_exe.py               :: 单文件 exe → dist\m3u8_adclean_server.exe
python _build_exe.py --standalone  :: 目录版（启动更快、杀软误报更少）
```

等价的原生命令（便于自行调整）：

```bat
python -m nuitka --onefile --assume-yes-for-downloads ^
  --windows-console-mode=force --output-dir=dist ^
  --output-filename=m3u8_adclean_server.exe ^
  --nofollow-import-to=tkinter,unittest,doctest,test ^
  m3u8_adclean_server.py
```

> `_build_exe.py` 是本地构建工具，已被 `.gitignore` 的 `_build*.py` 忽略，不入库。

## 注意

- **仅适用于 VOD**：直播（LIVE/EVENT）playlist 持续刷新，静态清洗跟不上。
- **必须先启动服务**：插件开启去广告后，若服务未运行，引擎抓本地 URL 会失败 →
  任务直接报错（resolver 为 fail-closed 语义）。**插件无法自检本地服务是否在线**
  （`flux.fetch` 有 SSRF 防护，会拦截 loopback 地址），因此请确保服务常驻。
- **走代理时排除本地**：若系统/引擎启用了代理，确保 `localhost` / `127.0.0.1`
  在 `no_proxy` 内，否则本地请求可能被发往代理而失败。
- **未识别到广告时原样透传**，避免误伤导致空 playlist。
- **改规则后要重启服务**：规则只在启动时读取一次，没有热重载。
