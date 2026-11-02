/**
 * 登录凭据（`authCookie` 设置项）→ 可注入的请求头。
 *
 * 为什么凭据不走宿主的「登录」对话框：那个对话框是**按站点**登录的（一份凭据绑定一个
 * `scheme://host[:port]`，站点由用户在对话框里填），而本插件的 resolver 匹配的是全通配 URL ——
 * 一个站点无关的通用解析器被塞进按站点的登录模型里，用户看到的是一个既要求填站点、
 * 又说不清填来干什么的按钮；不填站点还会撞上「请填写站点后再登录」这句没有对应设置项的死路。
 * 现在取消对话框，凭据只从设置项读。v3.0.0 早期做法是「归属站点 = 任务自身 URL 的 origin」，
 * 但这在逻辑上是恒真的（`ctx.url` 的 origin 与自己必然相等），等于**没有任何站点约束** ——
 * 任何 URL 走到本插件都能拿到这份凭据。现在改为：
 *
 *   1. 凭据文本可以声明自己的站点（首行 `@站点`，见 `SITE_LINE_RE`）。声明了就以它为准，
 *      任务站点不在范围内时**整条不注入**。
 *   2. 没声明时退回 `targetHosts`（「站点 · 生效范围」）—— 那已是用户在设置页里
 *      认可过的站点清单，再让他到凭据里抄一遍没有意义。`targetHosts` 为空（对所有站点
 *      生效）时才退到「任务自身 origin」，行为与之前的版本一致 —— 不收紧老用户的配置。
 *
 * 继承 `targetHosts` 而不是直接兜底任务 origin，是因为任务 origin 恒等于自己，那条判断
 * 在逻辑上是恒真的，等于没有任何站点约束。`targetHosts` 才是用户真正表达过意图的清单。
 *
 * 两种情形下都保留原有的**同源闸**：清单在站内、分片在 CDN 时，CDN 与任务 URL 不同源 →
 * 不注入，Cookie 不会跟着发给第三方 CDN。
 *
 * 凭据文本的四种写法（与旧实现一致，不要收紧）：bearer/token、basic、多行 `Key: Value`、
 * 兜底 Cookie。站点行是这四种之外的**可选前缀**，不改变任何一类的解析结果。
 */
import { base64Utf8 } from "./base64";
import { parseHostList } from "./site";

/** HTTP 头名（RFC 7230 token）后接冒号与至少一个非空字符，才算一行请求头。 */
const HEADER_LINE_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}\s*:\s*\S/;

/**
 * 站点约束行：`@站点` 单独一行，其后可以是 `host` 或 `scheme://host[:port]`，
 * 允许逗号分隔多个、允许 `*.` 通配前缀。
 *
 * 为什么把站点写进凭据文本、而不是单独加一个设置项：
 *   - 凭据与它的归属站点必须一起复制、一起删除。分成两个设置项时，用户换站只改其中一个，
 *     就会出现「新 Cookie 配旧站点」的错配，比没有约束更危险。
 *   - 插件是站点无关的全通配解析器，凭据只在少数几个站用得着；写成自描述的文本，
 *     用户粘贴时一眼看得见它属于谁。
 */
const SITE_LINE_RE = /^@\s*(\S.*)$/;

export interface Credential {
  /** 归属站点（`scheme://host[:port]`），注入时按它做同源判断。 */
  origin: string;
  /** 将被注入的请求头。Cookie / Authorization / 自定义头三者取实际解析结果。 */
  headers: Record<string, string>;
  /**
   * 凭据文本里声明的站点约束。`null` = 文本没写 `@站点` 行（旧写法，行为不变）。
   * 有值时调用方必须先校验任务站点点命中，再决定是否注入。
   */
  sites: CredentialSites | null;
}

/** 解析后的站点约束：`origins` 精确匹配 `scheme://host[:port]`，`hosts` 按主机名（含子域）。 */
export interface CredentialSites {
  origins: string[];
  hosts: string[];
}

/**
 * 逐项判定任务站点是否命中约束。**任一命中即放行**（大小写不敏感）。
 *
 * 两种写法的区别有两层：
 *   - 裸主机名（`a.com`）= **精确匹配** `a.com`，**不含子域**。
 *   - `*.a.com` = 只匹配真子域，不匹配裸 `a.com`。
 *
 * 为什么裸域不覆盖子域（与 `targetHosts` 相反）：`targetHosts` 是**准入白名单**，
 * 写 `a.com` 想一并覆盖 `www.a.com` / `m.a.com` 是合理的，用户漏填子域只会「少处理」。
 * 凭据是**限制**，用户写 `@a.com` 是在说「这份 Cookie 属于 a.com」；把它一并发给
 * `evil.a.com` 就是泄漏，而用户被诱导点到恶意子域是这个通用解析器的常见场景。
 * 两种语义方向相反，所以实现也必须反向 —— 覆盖子域请显式写 `@*.a.com`。
 *
 * `scheme://host[:port]` 形式的写法仍精确到 origin，带协议与端口一起卡：
 * 写 `https://a.com` 说明用户明确知道自己在哪个协议下登录，`http://a.com` 不该拿到。
 */
export function siteAllowed(sites: CredentialSites | null, url: string): boolean {
  if (!sites) return true; // 没写约束 = 不额外限制
  const origin = safeOriginLite(url);
  const host = hostOf(url);
  if (!origin && !host) return false;
  if (origin) {
    for (let i = 0; i < sites.origins.length; i++) {
      if (sites.origins[i].toLowerCase() === origin.toLowerCase()) return true;
    }
  }
  if (host) {
    const h = host.toLowerCase();
    for (let i = 0; i < sites.hosts.length; i++) {
      const want = sites.hosts[i].toLowerCase();
      if (want.charAt(0) === "*") {
        // `*.a.com` 只匹配真子域，不匹配裸 `a.com` —— 与浏览器 Cookie 的域匹配一致。
        const base = want.slice(1); // ".a.com"
        if (h.endsWith(base) && h.length > base.length) return true;
      } else if (h === want) {
        return true; // 裸主机名：精确匹配，不外扩到子域
      }
    }
  }
  return false;
}

/** 这里不 import `url.ts`，是为了让 credential 保持零依赖（它被 ytdlp/probe 等层复用）。 */
function hostOf(u: string | null | undefined): string {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(String(u == null ? "" : u).trim());
  if (!m) return "";
  const authority = m[1];
  const at = authority.lastIndexOf("@");
  const hp = at >= 0 ? authority.slice(at + 1) : authority;
  if (hp.charAt(0) === "[") {
    const end = hp.indexOf("]");
    return end > 0 ? hp.slice(0, end + 1).toLowerCase() : "";
  }
  const colon = hp.indexOf(":");
  return (colon >= 0 ? hp.slice(0, colon) : hp).toLowerCase();
}

function safeOriginLite(u: string | null | undefined): string {
  const s = String(u == null ? "" : u).trim();
  const m = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]+)/i.exec(s);
  if (!m) return "";
  const scheme = m[1].toLowerCase();
  if (scheme !== "http" && scheme !== "https") return "";
  const hp = m[2];
  const at = hp.lastIndexOf("@");
  return scheme + "://" + (at >= 0 ? hp.slice(at + 1) : hp);
}

/** 从凭据文本里摘掉 `@站点` 行，返回剩余正文与解析出的约束。 */
function splitSiteLine(s: string): { body: string; sites: CredentialSites | null } {
  const lines = s.split(/\r\n|\r|\n/);
  const origins: string[] = [];
  const hosts: string[] = [];
  const body: string[] = [];
  let seen = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const m = SITE_LINE_RE.exec(line);
    if (!m) {
      body.push(lines[i]);
      continue;
    }
    seen = true;
    const items = m[1].split(/[,，\s]+/);
    for (let j = 0; j < items.length; j++) {
      const it = items[j].trim();
      if (!it) continue;
      // 带协议 → 精确到 origin；裸主机 → 按主机名匹配（含子域）
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(it)) {
        const o = safeOriginLite(it);
        if (o) origins.push(o);
      } else {
        hosts.push(it.replace(/\/+$/, ""));
      }
    }
  }
  if (!seen) return { body: s, sites: null };
  const sites: CredentialSites | null = origins.length || hosts.length ? { origins, hosts } : null;
  return { body: body.join("\n").trim(), sites };
}

/**
 * `targetHosts` → 站点约束。清单为空（= 对所有站点生效）时返回 `null`，
 * 即「不额外限制」，与旧版本的不写 `@站点` 行完全等价。
 *
 * `targetHosts` 里写的是主机名而不是 origin —— 继承时按主机名匹配（父域覆盖子域），
 * 不臆测协议。用户想让凭据只在 https 下可用，仍可在凭据首行显式写 `@https://a.com`。
 */
function sitesFromHosts(raw: string | null | undefined): CredentialSites | null {
  const hosts = parseHostList(raw);
  return hosts.length ? { origins: [], hosts } : null;
}


/**
 * 解析凭据文本。认不出来的一律按 Cookie 处理 —— 这是最常见的形态，
 * 且比「拒绝保存」更不容易让用户丢掉刚复制的东西。
 *
 * @param raw 设置项原文
 * @param origin 归属站点；调用方应传入任务 URL 的 origin
 * @param targetHosts 「站点 · 生效范围」原文。凭据没写 `@站点` 行时用它作缺省约束；
 *   留空（对所有站点生效）则不额外限制，行为与旧版本一致。
 * @returns 空文本、只有空白，或站点不命中时返回 null
 */
export function parseCredential(
  raw: string | null | undefined,
  origin: string,
  targetHosts?: string | null,
): Credential | null {
  const all = String(raw == null ? "" : raw).trim();
  if (!all) return null;

  // 先摘 `@站点` 约束行 —— 它不参与「这是哪一类凭据」的判定，
  // 否则 `@a.com\nsid=1` 会因为首行不是头而落到「兜底 Cookie」，把站点行也当 Cookie 发出去。
  const split = splitSiteLine(all);
  const s = split.body;
  const sites = split.sites || sitesFromHosts(targetHosts);
  if (!s) return null; // 只有站点行、没有凭据正文

  // 站点约束在这里统一执行 —— 放在解析层而不是各调用点，是为了不漏：
  // 抓清单（`http.ts`）、下载补丁（`request.ts`）、yt-dlp 委派三条链路都经过本函数，
  // 逐点加判断迟早会漏一条，而漏掉的那条就是泄漏口。
  if (!siteAllowed(sites, origin)) return null;

  // ① Bearer / token：`bearer:xxx`、`bearer xxx`、`token:xxx`、`token xxx`
  const bm = /^(?:bearer|token)\s*[:\s]\s*([\s\S]+)$/i.exec(s);
  if (bm) {
    const t = bm[1].trim();
    if (t) return { origin, headers: { Authorization: "Bearer " + t }, sites };
    return null;
  }

  // ② HTTP Basic：`basic:用户名:密码`（用户名可含非 ASCII，编码走 UTF-8）
  const bsm = /^basic\s*:\s*([\s\S]+)$/i.exec(s);
  if (bsm) {
    const up = bsm[1].trim();
    const i = up.indexOf(":");
    if (i > 0) {
      const token = base64Utf8(up.slice(0, i) + ":" + up.slice(i + 1));
      return { origin, headers: { Authorization: "Basic " + token }, sites };
    }
  }

  // ③ 多行（或单行）`Key: Value` → 逐条注入
  const lines = s
    .split(/\r\n|\r|\n/)
    .map((x) => x.trim())
    .filter((x) => !!x && x.charAt(0) !== "#");
  if (lines.length && lines.every((x) => HEADER_LINE_RE.test(x))) {
    const headers: Record<string, string> = {};
    for (let i = 0; i < lines.length; i++) {
      const p = lines[i].indexOf(":");
      headers[lines[i].slice(0, p).trim()] = lines[i].slice(p + 1).trim();
    }
    return { origin, headers, sites };
  }

  // ④ 兜底：Cookie（`a=1; b=2`）
  return { origin, headers: { Cookie: s }, sites };
}
