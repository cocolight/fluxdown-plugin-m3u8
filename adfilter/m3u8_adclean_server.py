#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
m3u8_adclean_server.py —— FluxDown 插件「源头去广告」的本地清洗服务（外置）。

原理（配合本仓库 src/resolver.js 使用）：
  FluxDown 插件 resolver 把引擎要抓的 media/master 地址改写为
      http://127.0.0.1:8787/clean?src=<原始 m3u8>&ref=<referer>
  本服务收到后：
      1) 抓取原始 playlist（带 Referer 等头，绕过防盗链）
      2) 剔掉广告段（标准 CUE/DATERANGE/GAP 标记 + ad_patterns.txt 里的规则）
      3) 剩余段 / 变体 URI 全部绝对化（指向真实源站）
      4) 返回干净 playlist（plain http，Content-Type=application/vnd.apple.mpegurl）
  引擎据此只下正片 —— 广告段根本不出现在它看到的 playlist 里，
  因此这是「源头跳过」，不是下载后处理（方案 B）。

为什么走 127.0.0.1 而不是 file://：
  FluxDown 的 resolver 只能返回「引擎要下的 URL」，而引擎（reqwest 客户端）
  只认网络直链，且 flux.fs 不暴露绝对路径，故 file:// 构造不出合法 URL。
  但引擎能正常抓取 http://127.0.0.1（其 reqwest 无 loopback 拦截），
  于是用本地 http 服务把「干净 playlist」以普通 URL 形式交回引擎。

广告规则：见同目录 ad_patterns.txt（纯文本，可随意编辑，改完重启本服务生效）。
依赖：仅 Python 3 标准库。

用法：
  python3 m3u8_adclean_server.py                       # 默认监听 127.0.0.1:8787
  m3u8_adclean_server.exe                              # Nuitka 打包后，双击或命令行运行
  m3u8_adclean_server.exe --port 9000 --quiet
  m3u8_adclean_server.exe --rules D:\\my_rules.txt      # 指定其它规则文件
  m3u8_adclean_server.exe --proxy http://127.0.0.1:7890   # 上游走代理（访问被墙/境外源站）
  m3u8_adclean_server.exe --list-rules                 # 只打印已加载规则后退出（排查用）
  python3 _build_exe.py                                # 重新编译 exe（需 Nuitka + MSVC/MinGW）

测试：
  curl "http://127.0.0.1:8787/clean?src=<你的 m3u8>"   # 看返回是否已去广告
  curl "http://127.0.0.1:8787/health"                  # 健康检查
"""

import argparse
import gzip
import os
import re
import sys
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

APP = "m3u8_adclean"
RULES_FILENAME = "ad_patterns.txt"

# ---------------------------------------------------------------------------
# 规则文件模板：首次运行若找不到 ad_patterns.txt，会按此内容自动生成一份。
# 同时它也是「文件缺失 / 读取失败」时使用的内置兜底规则。
# ---------------------------------------------------------------------------
RULES_FILE_TEMPLATE = """# m3u8_adclean 广告识别规则
#
# 语法（每行一条，大小写不敏感）：
#   空行 / 以 # 开头   → 忽略
#   re:<正则>          → 按正则匹配（Python 正则，已忽略大小写）
#   其它文本           → 按子串匹配（出现在分片 URI 任意位置即命中）
#
# 命中即判定为广告：整个分片（#EXTINF + 分片 URI）连同包裹它的
# #EXT-X-DISCONTINUITY 一起剔除。命中的规则名会打印在日志里。
#
# 修改本文件后重启服务生效（无需重新编译 exe）。
#
# 注意：标准广告标记无需在此配置，服务已内置识别
#   #EXT-X-CUE-OUT / #EXT-X-CUE-IN      → 广告块边界
#   #EXT-X-DATERANGE（含 SCTE-35/CUE）  → 广告区间
#   #EXT-X-GAP                          → 空缺占位段

# ---- 路径与关键词（子串匹配）----
/video/adjump/
/adjump/
/ad/
/ads/
/adsv/
/preroll/
/midroll/
/postroll/
/spot/
/skip
/companion
/vast/
preroll
midroll
advert
doubleclick
googlesyndication

# ---- 正则示例（去掉行首 # 即可启用）----
# re:^/video/adjump/
# re:(?:^|/)(?:ad|ads|adv|adjump)\\d*\\.ts(?:\\?|$)
# re:_ad\\.ts
"""

# 内置兜底规则（仅当规则文件不可用时使用）
FALLBACK_RULES = [
    "/video/adjump/", "/adjump/", "/ad/", "/ads/", "/adsv/", "/preroll/",
    "/midroll/", "/postroll/", "/spot/", "/skip", "/companion", "/vast/",
    "preroll", "midroll", "advert", "doubleclick", "googlesyndication",
]

QUIET = False
PROXY = None  # 全局代理（--proxy 或环境变量 HTTP_PROXY/HTTPS_PROXY），用于访问被墙/境外的上游


def log(msg):
    """统一日志出口：写 stdout 并立即 flush（双击 exe 时能实时看到）。"""
    sys.stdout.write(msg + "\n")
    sys.stdout.flush()


# ---------------------------------------------------------------------------
# 规则文件定位与加载
# ---------------------------------------------------------------------------
def base_dirs():
    """按优先级返回「程序所在目录」候选。

    打包成 exe 后 __file__ 指向临时解包目录，不能直接用；此时以 exe 自身
    所在目录（sys.argv[0]）为准，保证 ad_patterns.txt 能与 exe 放在一起。
    """
    dirs = []
    if "__compiled__" in globals() or getattr(sys, "frozen", False):
        for cand in (sys.argv[0], sys.executable):
            if cand:
                d = os.path.dirname(os.path.abspath(cand))
                if os.path.isdir(d):
                    dirs.append(d)
    try:
        d = os.path.dirname(os.path.abspath(__file__))
        if os.path.isdir(d):
            dirs.append(d)
    except NameError:
        pass
    dirs.append(os.getcwd())

    seen, out = set(), []
    for d in dirs:
        k = os.path.normcase(d)
        if k not in seen:
            seen.add(k)
            out.append(d)
    return out


def resolve_rules_path(explicit=None):
    """定位规则文件：--rules 指定 > 程序同目录 > 当前工作目录；都不存在则给出首选路径。"""
    if explicit:
        return os.path.abspath(explicit)
    for d in base_dirs():
        p = os.path.join(d, RULES_FILENAME)
        if os.path.isfile(p):
            return p
    return os.path.join(base_dirs()[0], RULES_FILENAME)


def ensure_rules_file(path):
    """规则文件不存在则按模板生成。失败不致命（回退内置规则）。"""
    if os.path.isfile(path):
        return False
    try:
        with open(path, "w", encoding="utf-8", newline="\n") as f:
            f.write(RULES_FILE_TEMPLATE)
        return True
    except OSError as e:
        log(f"WARN  无法创建规则文件 {path}: {e}（改用内置默认规则）")
        return False


class RuleSet:
    """广告规则集合：子串 + 正则。支持逐条给出命中原因，便于日志打印。"""

    def __init__(self, subs, regexes, source=""):
        # subs: [(显示文本, 小写文本)]；regexes: [(显示文本, 已编译正则)]
        self.subs = subs
        self.regexes = regexes
        self.source = source

    def match(self, seg):
        """返回命中的规则原文；未命中返回 None。"""
        if not seg:
            return None
        low = seg.lower()
        for display, lowered in self.subs:
            if lowered in low:
                return display
        for display, rx in self.regexes:
            if rx.search(seg):
                return display
        return None

    @property
    def size(self):
        return len(self.subs), len(self.regexes)


def parse_rules(text):
    """解析规则文本 → (subs, regexes, errors)。"""
    subs, regexes, errors = [], [], []
    for lineno, raw in enumerate(text.splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        low = line.lower()
        if low.startswith("re:") or low.startswith("regex:"):
            body = line.split(":", 1)[1].strip()
            if not body:
                errors.append((lineno, line, "正则为空"))
                continue
            try:
                regexes.append((body, re.compile(body, re.IGNORECASE)))
            except re.error as e:
                errors.append((lineno, line, f"正则无效：{e}"))
        else:
            subs.append((line, low))
    return subs, regexes, errors


def load_rules(path):
    """读取规则文件；不可用时回退内置默认规则。"""
    if not os.path.isfile(path):
        log(f"WARN  规则文件不存在：{path}（改用内置默认规则）")
        subs = [(p, p.lower()) for p in FALLBACK_RULES]
        return RuleSet(subs, [], source="内置默认（文件缺失）")

    try:
        with open(path, "r", encoding="utf-8-sig", errors="replace") as f:
            text = f.read()
    except OSError as e:
        log(f"WARN  规则文件读取失败：{path} → {e}（改用内置默认规则）")
        subs = [(p, p.lower()) for p in FALLBACK_RULES]
        return RuleSet(subs, [], source="内置默认（读取失败）")

    subs, regexes, errors = parse_rules(text)
    for lineno, line, why in errors:
        log(f"WARN  规则第 {lineno} 行已忽略（{why}）：{line}")

    if not subs and not regexes:
        log(f"WARN  规则文件为空：{path}（改用内置默认规则）")
        subs = [(p, p.lower()) for p in FALLBACK_RULES]
        return RuleSet(subs, [], source="内置默认（文件为空）")

    return RuleSet(subs, regexes, source=path)


RULES = RuleSet([(p, p.lower()) for p in FALLBACK_RULES], [], source="内置默认")


# ---------------------------------------------------------------------------
# URL 工具
# ---------------------------------------------------------------------------
def absolutize(uri, base):
    """把相对/绝对路径 URI 解析为基于 base 的绝对 URL。"""
    if not uri:
        return uri
    if re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*://", uri):
        return uri
    return urllib.parse.urljoin(base, uri)


def absolutize_attr_uri(line, base):
    """把标签行内 URI="..." 属性里的相对地址绝对化（#EXT-X-KEY / #EXT-X-MAP /
    #EXT-X-SESSION-KEY）。已是绝对地址（带 scheme://）的保持不动。

    关键：这些标签是一整行带属性的（以 # 开头），不会被『独立 URI 行』分支捕获，
    若原样透传，引擎会把相对 enc.key 解析到 127.0.0.1:8787 → 取不到密钥，AES-128 直接废掉。
    """
    def repl(m):
        uri = m.group(1)
        if re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*://", uri):
            return m.group(0)
        return 'URI="' + absolutize(uri, base) + '"'
    return re.sub(r'URI="([^"]*)"', repl, line, flags=re.IGNORECASE)


def clean_endpoint(server_base, abs_url, ref):
    """构造指向本服务的 clean URL（把某个 playlist 交给本服务清洗）。"""
    q = "src=" + urllib.parse.quote(abs_url, safe="")
    if ref:
        q += "&ref=" + urllib.parse.quote(ref, safe="")
    return server_base.rstrip("/") + "/clean?" + q


def rewrite_media_uri(line, base, server_base, ref):
    """把 #EXT-X-MEDIA 标签里的 URI="..." 改写为指向本服务的 clean URL。"""
    def repl(m):
        uri = m.group(1)
        absu = absolutize(uri, base)
        return 'URI="' + clean_endpoint(server_base, absu, ref) + '"'

    return re.sub(r'URI="([^"]*)"', repl, line, flags=re.IGNORECASE)


# ---------------------------------------------------------------------------
# 核心：清洗 playlist
# ---------------------------------------------------------------------------
def rewrite(text, base_url, server_base, ref, drops=None):
    """剔除广告段 / 改写变体。

    drops: 传入列表则记录每条被剔除的分片 [(绝对URI, 原因)]，供调用方打印。
    """
    is_master = ("#EXT-X-STREAM-INF" in text
                 or "#EXT-X-I-FRAME-STREAM-INF" in text)

    lines = text.split("\n")
    out = []
    in_ad = False                 # SCTE CUE-OUT/IN / DATERANGE 维护的广告块状态
    ad_reason = ""                # 处于广告块时的判定原因
    drop_next_reason = None       # #EXT-X-GAP 标记的下一个占位段
    pending_variant = False
    i, n = 0, len(lines)

    while i < n:
        line = lines[i]
        s = line.strip()
        low = s.lower()

        # ---- 广告块边界标记（仅 media 场景用到；master 无这些）----
        if low.startswith("#ext-x-cue-out"):
            in_ad, ad_reason = True, "EXT-X-CUE-OUT 广告块"
            i += 1
            continue
        if low.startswith("#ext-x-cue-in"):
            in_ad, ad_reason = False, ""
            i += 1
            continue
        if low.startswith("#ext-x-daterange"):
            # SCTE-35 / CUE 标记的广告区间
            if "scte" in low or "cue-out" in low:
                in_ad, ad_reason = True, "EXT-X-DATERANGE(SCTE-35) 广告区间"
            elif "cue-in" in low or "scte-in" in low:
                in_ad = False
            i += 1
            continue
        if low.startswith("#ext-x-gap"):
            drop_next_reason = "EXT-X-GAP 占位段"
            i += 1
            continue
        # 移除不连续标记：广告块被整段删掉后，剩余正片是连续的
        if low.startswith("#ext-x-discontinuity"):
            i += 1
            continue
        # 加密密钥 / init 片段：把 URI="..." 里的相对地址绝对化到真实源站。
        # 否则经本服务清洗后，引擎会把相对 enc.key 解析到 127.0.0.1:8787 而取不到密钥，
        # 导致 AES-128 整段无法解密（典型表现：开启去广告后下载为空/几 KB）。
        if (low.startswith("#ext-x-key")
                or low.startswith("#ext-x-map")
                or low.startswith("#ext-x-session-key")):
            out.append(absolutize_attr_uri(line, base_url))
            i += 1
            continue

        # ---- master 播放列表：重写变体 / 媒体轨道 URI ----
        if low.startswith("#ext-x-media"):
            out.append(rewrite_media_uri(line, base_url, server_base, ref))
            i += 1
            continue
        if low.startswith("#ext-x-stream-inf") or low.startswith("#ext-x-i-frame-stream-inf"):
            out.append(line)  # 属性行保留，下一行是变体 URI
            pending_variant = True
            i += 1
            continue
        if pending_variant and s and not s.startswith("#"):
            absu = absolutize(s, base_url)
            out.append(clean_endpoint(server_base, absu, ref))  # 变体也交给本服务清洗
            pending_variant = False
            i += 1
            continue

        # ---- media 播放列表：按 #EXTINF 处理分片 ----
        if low.startswith("#extinf"):
            seg = lines[i + 1].strip() if i + 1 < n else ""
            reason = None
            if in_ad:
                reason = ad_reason
            elif drop_next_reason:
                reason = drop_next_reason
            else:
                hit = RULES.match(seg)
                if hit:
                    reason = f"规则「{hit}」"
            drop_next_reason = None
            if reason:
                if drops is not None:
                    drops.append((absolutize(seg, base_url), reason))
                i += 2  # 跳过 EXTINF + 段 URI
                continue
            out.append(line)
            out.append(absolutize(seg, base_url))  # 段绝对化，指向真实源站
            i += 2
            continue

        # ---- 其它独立 URI 行（#EXT-X-KEY / #EXT-X-MAP / init 等）----
        if s and not s.startswith("#") and not pending_variant:
            out.append(absolutize(s, base_url))
            i += 1
            continue

        out.append(line)
        i += 1

    cleaned = "\n".join(out)
    # 若清洗后一个广告段都没识别到，原样透传（避免误伤导致空 playlist）
    if is_master:
        return cleaned
    if "#EXTINF" not in cleaned:
        return text
    return cleaned


# ---------------------------------------------------------------------------
# 上游抓取
# ---------------------------------------------------------------------------
def fetch_upstream(url, ref):
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                          "AppleWebKit/537.36 (KHTML, like Gecko) "
                          "Chrome/124.0 Safari/537.36",
            "Accept": "*/*",
        },
    )
    if ref:
        req.add_header("Referer", ref)
        try:
            p = urllib.parse.urlparse(ref)
            req.add_header("Origin", f"{p.scheme}://{p.netloc}")
        except Exception:
            pass
    # 代理：显式 --proxy 优先；否则 urllib 默认 opener 会读取 HTTP_PROXY/HTTPS_PROXY 环境变量。
    # 不走代理时这些境外/被墙源站会直接 RST（WSAECONNRESET），表现为「上游抓取失败」。
    if PROXY:
        opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({"http": PROXY, "https": PROXY})
        )
        fp = opener.open(req, timeout=30)
    else:
        fp = urllib.request.urlopen(req, timeout=30)
    with fp as r:
        raw = r.read()
        if r.headers.get("Content-Encoding") == "gzip":
            raw = gzip.decompress(raw)
        charset = r.headers.get_content_charset() or "utf-8"
        return raw.decode(charset, errors="replace")


# ---------------------------------------------------------------------------
# HTTP 服务
# ---------------------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    server_base = "http://127.0.0.1:8787"

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/health":
            self._send(200, "text/plain", b"ok")
            return
        if parsed.path == "/clean":
            qs = urllib.parse.parse_qs(parsed.query)
            src = qs.get("src", [""])[0]
            ref = qs.get("ref", [""])[0]
            if not src:
                self._send(400, "text/plain", b"missing src parameter")
                return
            try:
                body = fetch_upstream(src, ref)
            except Exception as e:
                msg = f"upstream error: {e}"
                log(f"ERROR 上游抓取失败 {src} → {msg}")
                self._send(502, "text/plain", msg.encode("utf-8", "replace"))
                return

            drops = []
            cleaned = rewrite(body, src, self.server_base, ref, drops)
            kept = cleaned.count("#EXTINF")
            data = cleaned.encode("utf-8")
            self._send(
                200,
                "application/vnd.apple.mpegurl; charset=utf-8",
                data,
                extra={"Access-Control-Allow-Origin": "*", "Cache-Control": "no-store"},
            )
            self._report(src, drops, kept, body, cleaned)

    def _report(self, src, drops, kept, body, cleaned):
        """打印本次清洗结果：被剔除的每条分片都逐条列出（含判定原因）。"""
        if drops:
            log(f"[clean] 命中广告 {len(drops)} 条  ←  {src}")
            if not QUIET:
                width = len(str(len(drops)))
                for idx, (uri, reason) in enumerate(drops, 1):
                    log(f"  - 剔除[{str(idx).rjust(width)}/{len(drops)}] ({reason}) {uri}")
            log(f"  - 正片段保留 {kept} 条，返回 {len(cleaned)} 字节")
        elif not QUIET:
            if "#EXT-X-STREAM-INF" in body or "#EXT-X-I-FRAME-STREAM-INF" in body:
                log(f"[clean] 无广告（master，变体已改写）  ←  {src}")
            else:
                log(f"[clean] 无广告命中，原样透传  ←  {src}")

    def _send(self, code, ctype, data, extra=None):
        try:
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
            pass  # 客户端提前断开（如引擎取消任务），不是错误

    def log_message(self, *args):
        pass  # 静默，日志统一走 log()


class Server(ThreadingHTTPServer):
    """把「客户端中断」这类噪音静音，真实异常仍打一行日志。"""

    def handle_error(self, request, client_address):
        exc = sys.exc_info()[1]
        if isinstance(exc, (ConnectionError, BrokenPipeError, OSError)):
            return
        log(f"ERROR 处理请求出错 ({client_address}): {exc!r}")


def main():
    global RULES, QUIET

    ap = argparse.ArgumentParser(
        description="FluxDown m3u8 去广告本地清洗服务（规则见 ad_patterns.txt）")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8787)
    ap.add_argument("--base", default=None,
                    help="对外公布的本服务基址，默认 http://<host>:<port>")
    ap.add_argument("--rules", default=None,
                    help=f"广告规则文件路径，默认取程序同目录的 {RULES_FILENAME}")
    ap.add_argument("--quiet", action="store_true",
                    help="不逐条打印被剔除的分片，只输出汇总行")
    ap.add_argument("--list-rules", action="store_true",
                    help="打印已加载的规则后退出（排查规则为何未生效）")
    ap.add_argument("--proxy", default=None,
                    help="上游抓取走代理，如 http://127.0.0.1:7890 或 socks5://127.0.0.1:1080；"
                         "不指定时自动读取 HTTP_PROXY/HTTPS_PROXY 环境变量（用于访问被墙/境外源站）")
    args = ap.parse_args()

    QUIET = args.quiet
    global PROXY
    PROXY = args.proxy

    rules_path = resolve_rules_path(args.rules)
    created = ensure_rules_file(rules_path)
    RULES = load_rules(rules_path)

    subs_n, rx_n = RULES.size
    log(f"[{APP}] 规则文件：{rules_path}" + ("（已自动生成模板）" if created else ""))
    log(f"[{APP}] 载入规则：子串 {subs_n} 条 / 正则 {rx_n} 条  来源：{RULES.source}")

    if args.list_rules:
        for display, _ in RULES.subs:
            log(f"  [子串] {display}")
        for display, _ in RULES.regexes:
            log(f"  [正则] {display}")
        return

    base = args.base or f"http://{args.host}:{args.port}"
    Handler.server_base = base.rstrip("/")

    httpd = Server((args.host, args.port), Handler)
    log(f"[{APP}] listening on {base}  (Ctrl+C to stop)")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        log(f"\n[{APP}] stopped")
        httpd.shutdown()


if __name__ == "__main__":
    main()
