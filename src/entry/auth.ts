import type { AuthContext, AuthResult } from "fluxdown-plugin-sdk";
import { install } from "../lib/install";

/**
 * 登录入口 —— 入口固定为 `globalThis.authenticate(ctx)`，由宿主以
 * begin / poll / cancel / logout / status 五个 action 驱动。
 *
 * 返回值是**对象**（不是 JSON 字符串）：宿主 wrapper 会 JSON.stringify 后再解析
 * （native/engine/src/plugin/quickjs.rs::build_entry_wrapper，resolve/authenticate/subscribe
 * 三个入口共用该分支）。返回字符串会被二次编码而解析失败。
 *
 * 设计取舍：插件**不实现任何站点特有的登录协议**（不做二维码轮询 / OAuth 跳转），只提供一条
 * 站点无关的通用通道 —— 用户把自己已拿到的凭据粘进来，插件规范化后交给宿主的 flux.auth 持久化。
 * 好处是零站点硬编码，且凭据能被 flux.fetch 自动复用。
 *
 * 凭据输入格式（ctx.input，或设置项 authCookie 作为回退）：
 *   bearer:xxx / token xxx       → kind=bearer  （Authorization: Bearer）
 *   basic:用户名:密码             → kind=basic   （Authorization: Basic）
 *   多行 `Key: Value`（单行亦可）  → kind=headers （逐条注入）
 *   其余一切                     → kind=cookie  （Cookie）
 *
 * ★ 与下载链路的关系：宿主只在 flux.fetch 里注入认证档案，下载分片走任务请求面 ——
 *   自 v2.0.0 起由 resolver 返回的 `request.originHeaders` 承载（按 origin 白名单附加）。
 */

const HEADER_LINE_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}\s*:\s*\S/;

function settingStr(key: string, def: string): string {
  const v = flux.settings ? flux.settings[key] : undefined;
  if (v === undefined || v === null) return def || "";
  return String(v);
}

/**
 * 站点：优先用 ctx.site，其次从 `ctx.authRef` 里的规范化站点取值。
 * authRef 格式为 `插件ID::站点`；插件 ID（`m3u8-resolver@cocolight`）本身不含 "::"，
 * 站点形如 `https://host[:port]`（含 ":" 但不含连续两个 ":"），故首个 "::" 即分隔点。
 */
function siteFromCtx(ctx: AuthContext): string {
  const s = String(ctx.site || "").trim();
  if (s) return s;
  const ref = String(ctx.authRef || "");
  const i = ref.indexOf("::");
  return i >= 0 ? ref.slice(i + 2) : "";
}

/** 把用户粘进来的原始文本映射成认证档案；认不出来时一律按 Cookie 处理（最常见，且不静默丢数据）。 */
function parseProfileInput(raw: string | null | undefined, site: string): Record<string, unknown> | null {
  const s = String(raw == null ? "" : raw).trim();
  if (!s) return null;

  // ① Bearer / token：`bearer:xxx`、`bearer xxx`、`token:xxx`、`token xxx`
  const bm = /^(?:bearer|token)\s*[:\s]\s*([\s\S]+)$/i.exec(s);
  if (bm) {
    const t = bm[1].trim();
    if (!t) return null;
    return { site, kind: "bearer", accessToken: t };
  }

  // ② HTTP Basic：`basic:用户名:密码`
  const bsm = /^basic\s*:\s*([\s\S]+)$/i.exec(s);
  if (bsm) {
    const up = bsm[1].trim();
    const i = up.indexOf(":");
    if (i > 0) return { site, kind: "basic", username: up.slice(0, i), password: up.slice(i + 1) };
  }

  // ③ 多行（或单行）`Key: Value` → headers
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
    return { site, kind: "headers", headers };
  }

  // ④ 兜底：Cookie（`a=1; b=2`）
  return { site, kind: "cookie", cookies: s };
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/** 读回档案；读不到或已过期都返回 null（过期不再当作已登录 —— 让宿主显示「登录」）。 */
async function currentProfile(authRef: string): Promise<Record<string, unknown> | null> {
  if (!authRef || !flux.auth || typeof flux.auth.get !== "function") return null;
  let p: unknown;
  try {
    p = await flux.auth.get(authRef);
  } catch {
    return null;
  }
  if (!p || typeof p !== "object") return null;
  const prof = p as Record<string, unknown>;
  const exp = prof.expiresAt;
  if (typeof exp === "number" && exp > 0 && exp <= nowSec()) return null;
  return prof;
}

async function saveRaw(raw: string, site: string): Promise<string | null> {
  const prof = parseProfileInput(raw, site);
  if (!prof) return null;
  if (!flux.auth || typeof flux.auth.save !== "function") {
    throw new Error('宿主未提供 flux.auth（缺少 permissions:["auth"]？）');
  }
  const ref = await flux.auth.save(prof);
  return ref ? String(ref) : "";
}

/** 提示文案：把支持的四种格式一次说清，避免用户反复试。 */
const HINT =
  "请粘贴该站点的凭据，支持四种写法：\n" +
  "1) Cookie 原文（如 SID=xxx; uid=yyy）\n" +
  "2) bearer:令牌  或  token 令牌\n" +
  "3) basic:用户名:密码\n" +
  "4) 多行请求头（每行 `键: 值`，可写 `Cookie: ...` / `Authorization: ...`）";

async function authenticate(ctx: AuthContext): Promise<AuthResult> {
  const action = String(ctx.action || "");
  const authRef = String(ctx.authRef || "");
  const site = siteFromCtx(ctx);
  const sid = String(ctx.sessionId || "");
  const input = String(ctx.input || "").trim();

  // ---- 退出登录 ----
  // 宿主在插件被禁用时也会放行 logout，并自行清理凭据；这里再删一次是幂等的兜底。
  if (action === "logout") {
    try {
      if (authRef && flux.auth && typeof flux.auth.remove === "function") await flux.auth.remove(authRef);
      flux.logger.info("[m3u8-auth] 已退出登录:", authRef || site || "(无引用)");
      return { status: "success", authRef, message: "已退出登录" };
    } catch (e) {
      return { status: "error", message: "退出登录失败: " + String(e) };
    }
  }

  if (action === "cancel") return { status: "error", message: "已取消" };

  // ---- 探测登录态（无用户交互）----
  if (action === "status") {
    const p = await currentProfile(authRef);
    if (p) return { status: "success", authRef, message: "已登录" };
    // 没有「未登录」这个状态位，用 error + 文案表达（宿主据此显示「登录」按钮）。
    return { status: "error", message: "尚未登录" };
  }

  // ---- 登录：begin / poll ----
  if (action === "begin" || action === "poll") {
    // poll 先看是否已经存好了（用户可能已在别处完成）。
    if (action === "poll") {
      const p = await currentProfile(authRef);
      if (p) return { status: "success", sessionId: sid, authRef, message: "已登录" };
    }

    // 凭据来源：交互输入优先，其次设置项 authCookie（helperScript 逃生舱的落地端）。
    const raw = input || settingStr("authCookie", "").trim();
    if (raw) {
      try {
        const ref = await saveRaw(raw, site);
        if (ref === null) return { status: "error", sessionId: sid, message: "无法识别凭据格式。\n" + HINT };
        flux.logger.info("[m3u8-auth] 凭据已保存:", ref || authRef || site);
        return { status: "success", sessionId: sid, authRef: ref || authRef, message: "登录凭据已保存" };
      } catch (e) {
        return { status: "error", sessionId: sid, message: "保存凭据失败: " + String(e) };
      }
    }

    if (!site) {
      return {
        status: "error",
        sessionId: sid,
        message: "缺少站点信息：请在「设置 → 插件」里填写站点后再登录。",
      };
    }

    // 无输入 → 进入交互态，等用户把凭据粘进来（poll 会带上 input）。
    return { status: "pending", sessionId: sid, challengeType: "text", message: HINT };
  }

  return { status: "error", message: "未知的 auth action: " + (action || "(空)") };
}

install("authenticate", authenticate);
