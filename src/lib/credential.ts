/**
 * 登录凭据（`authCookie` 设置项）→ 可注入的请求头。
 *
 * 为什么凭据不走宿主的「登录」对话框：那个对话框是**按站点**登录的（一份凭据绑定一个
 * `scheme://host[:port]`，站点由用户在对话框里填），而本插件的 resolver 匹配的是全通配 URL ——
 * 一个站点无关的通用解析器被塞进按站点的登录模型里，用户看到的是一个既要求填站点、
 * 又说不清填来干什么的按钮；不填站点还会撞上「请填写站点后再登录」这句没有对应设置项的死路。
 * 现在取消对话框，凭据只从设置项读，归属站点取**任务自身 URL**（`ctx.url`）的 origin：
 *
 *   - 用户粘贴的就是要下载的那个地址，它的 origin 天然就是凭据该去的站点；
 *   - 清单在站内、分片在 CDN 时，CDN 与任务 URL 不同源 → 不注入，泄漏面与 v1.8.0 一致。
 *
 * 凭据文本的四种写法（与旧实现一致，不要收紧）：bearer/token、basic、多行 `Key: Value`、
 * 兜底 Cookie。
 */
import { base64Utf8 } from "./base64";

/** HTTP 头名（RFC 7230 token）后接冒号与至少一个非空字符，才算一行请求头。 */
const HEADER_LINE_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}\s*:\s*\S/;

export interface Credential {
  /** 归属站点（`scheme://host[:port]`），注入时按它做同源判断。 */
  origin: string;
  /** 将被注入的请求头。Cookie / Authorization / 自定义头三者取实际解析结果。 */
  headers: Record<string, string>;
}

/**
 * 解析凭据文本。认不出来的一律按 Cookie 处理 —— 这是最常见的形态，
 * 且比「拒绝保存」更不容易让用户丢掉刚复制的东西。
 *
 * @param raw 设置项原文
 * @param origin 归属站点；调用方应传入任务 URL 的 origin
 * @returns 空文本或只有空白时返回 null
 */
export function parseCredential(raw: string | null | undefined, origin: string): Credential | null {
  const s = String(raw == null ? "" : raw).trim();
  if (!s) return null;

  // ① Bearer / token：`bearer:xxx`、`bearer xxx`、`token:xxx`、`token xxx`
  const bm = /^(?:bearer|token)\s*[:\s]\s*([\s\S]+)$/i.exec(s);
  if (bm) {
    const t = bm[1].trim();
    if (t) return { origin, headers: { Authorization: "Bearer " + t } };
    return null;
  }

  // ② HTTP Basic：`basic:用户名:密码`（用户名可含非 ASCII，编码走 UTF-8）
  const bsm = /^basic\s*:\s*([\s\S]+)$/i.exec(s);
  if (bsm) {
    const up = bsm[1].trim();
    const i = up.indexOf(":");
    if (i > 0) {
      const token = base64Utf8(up.slice(0, i) + ":" + up.slice(i + 1));
      return { origin, headers: { Authorization: "Basic " + token } };
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
    return { origin, headers };
  }

  // ④ 兜底：Cookie（`a=1; b=2`）
  return { origin, headers: { Cookie: s } };
}
