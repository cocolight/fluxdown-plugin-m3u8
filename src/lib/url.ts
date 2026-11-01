/**
 * 零依赖 URL 工具层 —— 全插件唯一的地址解析实现。
 *
 * ★★ 绝对禁止使用 `new URL` / `URLSearchParams`。
 *    2026-09-30 在真实 QuickJS 沙箱实测：`typeof URL === "undefined"`。旧版 absUrl 的
 *    「手动兜底」在 catch 里又调了一次 `new URL(base)`，于是永远吞掉异常返回原始相对串，
 *    引擎报 `url scheme 不允许: <相对路径>`；同一个坑还静默打瘫了 nameFromUrl / hostOf /
 *    safeOrigin / inScope。tsconfig 的 `lib` 只到 ES2022 且不含 DOM，同类写法现在会编译失败。
 *
 * ★★ 本文件有两套「主机」语义，**不可合并**：
 *    - `hostKey`       → hostname 去 `www.`、**丢端口**。这是 v1.8.0 resolver.js:879 的口径，
 *                        用于 cookie 归属、同站判定、命名里的 {host}。
 *    - `hostWithPort`  → `host[:port]` 原样小写。这是 v1.8.0 subscribe.js:48 的口径。
 *    两者对 `www.` 前缀和 `:端口` 的表现不同（订阅页与解析页会得出不同结论），
 *    M1 阶段按原样保留，是否统一留到 M3 再决定 —— 现在统一等于悄悄改变行为。
 */

export interface ParsedUrl {
  protocol: string;
  hostname: string;
  port: string;
  host: string;
  origin: string;
  pathname: string;
  search: string;
  hash: string;
  username: string;
  password: string;
  href: string;
}

/** 解析绝对地址；解析失败返回 null，由调用方决定兜底。形状与 URL 对象保持兼容。 */
export function parseUrl(u: string | null | undefined): ParsedUrl | null {
  const s = String(u == null ? "" : u).trim();
  // scheme://authority/path?query#fragment （userinfo 一并归入 authority，够用）
  const m = /^([a-zA-Z][a-zA-Z0-9+.\-]*):\/\/([^/?#]*)([^?#]*)(\?[^#]*)?(#[\s\S]*)?$/.exec(s);
  if (!m) return null;
  const protocol = m[1].toLowerCase() + ":";
  const authority = m[2];
  const pathname = m[3] || "/";
  const search = m[4] || "";
  const hash = m[5] || "";

  const at = authority.lastIndexOf("@");
  const userinfo = at >= 0 ? authority.slice(0, at) : "";
  const hostport = at >= 0 ? authority.slice(at + 1) : authority;
  let username = "";
  let password = "";
  if (userinfo) {
    const ci = userinfo.indexOf(":");
    username = ci >= 0 ? userinfo.slice(0, ci) : userinfo;
    password = ci >= 0 ? userinfo.slice(ci + 1) : "";
  }

  // IPv6 字面量 [::1]:8080
  let hostname = "";
  let port = "";
  if (hostport.charAt(0) === "[") {
    const close = hostport.indexOf("]");
    if (close >= 0) {
      hostname = hostport.slice(0, close + 1);
      const rest = hostport.slice(close + 1);
      if (rest.charAt(0) === ":") port = rest.slice(1);
    } else {
      hostname = hostport;
    }
  } else {
    const ci = hostport.indexOf(":");
    hostname = ci >= 0 ? hostport.slice(0, ci) : hostport;
    port = ci >= 0 ? hostport.slice(ci + 1) : "";
  }

  const host = hostname + (port ? ":" + port : "");
  return {
    protocol,
    hostname: hostname.toLowerCase(),
    port,
    host: host.toLowerCase(),
    origin: protocol + "//" + host,
    pathname,
    search,
    hash,
    username,
    password,
    href: protocol + "//" + authority + pathname + search + hash,
  };
}

const ABS_URL_RE = /^[a-zA-Z][a-zA-Z0-9+.\-]*:\/\//;

/** 绝对地址判定（与 Rust 侧引擎同语义：必须带 `scheme://`）。 */
export function isAbsUrl(u: string | null | undefined): boolean {
  return ABS_URL_RE.test(String(u == null ? "" : u));
}

/**
 * 相对地址 → 绝对地址。纯字符串运算，支持：
 * ① 已是绝对地址；② 协议相对 `//host/path`；③ 站点根绝对 `/a/b`；
 * ④ 相对路径 `a/b`、`./a`、`../a`；⑤ 带 query/hash。
 */
export function absUrl(u: string, base: string): string {
  if (!u) return u;
  if (isAbsUrl(u)) return u; // 已是绝对地址
  if (!isAbsUrl(base)) return u; // base 非法 → 无法合成（调用方需保证）
  const b = parseUrl(base);
  if (!b) return u;
  const rel = String(u).trim();
  if (rel.indexOf("//") === 0) return b.protocol + rel; // 协议相对
  // 拆出 path / query / hash，逐段规范化
  let path = rel;
  let tail = "";
  const hashAt = path.indexOf("#");
  if (hashAt >= 0) {
    tail = path.slice(hashAt) + tail;
    path = path.slice(0, hashAt);
  }
  const qAt = path.indexOf("?");
  if (qAt >= 0) {
    tail = path.slice(qAt) + tail;
    path = path.slice(0, qAt);
  }
  if (path.charAt(0) !== "/") path = b.pathname.replace(/[^/]*$/, "") + path; // 相对当前目录
  const norm: string[] = [];
  const segs = path.split("/");
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (s === "" || s === ".") continue;
    if (s === "..") norm.pop();
    else norm.push(s);
  }
  const last = segs[segs.length - 1];
  const trailingSlash = last === "" || last === "." || last === "..";
  return b.origin + "/" + norm.join("/") + (trailingSlash && norm.length ? "/" : "") + tail;
}

/** `{scheme}://{host}[:port]`，与宿主 auth::site_key 同口径。 */
export function safeOrigin(u: string | null | undefined): string {
  const p = parseUrl(u);
  return p ? p.origin : "";
}

/** resolver 口径：hostname 去 `www.`，丢端口。用于 cookie 归属 / 同站判定 / {host}。 */
export function hostKey(u: string | null | undefined): string {
  const p = parseUrl(u);
  return p ? p.hostname.replace(/^www\./i, "") : "";
}

/** subscribe 口径：`host[:port]`，保留 `www.`。 */
export function hostWithPort(u: string | null | undefined): string {
  const p = parseUrl(u);
  return p ? p.host : "";
}
