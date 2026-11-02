/**
 * 站点清单：`targetHosts` 的解析与命中判断。
 *
 * 为什么单独成文件：`targetHosts` 现在被两件事共用 —— resolver 的「处理哪些页面」，
 * 以及凭据 `authCookie` 没写 `@站点` 时的**缺省站点约束**。两处各写一遍 `split(",")`
 * 迟早漂移，而漂移的那一天就是凭据按错误清单放行。收成一个函数，语义只有一份。
 *
 * 写法：逗号分隔（顺带接受中文逗号与空白），主机名大小写不敏感，父域覆盖所有子域
 * （`a.com` 命中 `x.a.com`）。不写协议 —— 协议区分是凭据 `@站点` 行才有的语义。
 */

/** `targetHosts` 原文 → 小写主机名数组。空文本得空数组（= 对所有站点生效）。 */
export function parseHostList(raw: string | null | undefined): string[] {
  const s = String(raw == null ? "" : raw).trim();
  if (!s) return [];
  const out: string[] = [];
  const items = s.split(/[,，\s]+/);
  for (let i = 0; i < items.length; i++) {
    const it = items[i].trim().toLowerCase().replace(/\/+$/, "");
    if (it && out.indexOf(it) < 0) out.push(it);
  }
  return out;
}

/**
 * 主机名是否命中清单。清单为空 → `false`（调用方自行决定「空清单」是什么语义：
 * resolver 视为不处理页面，凭据视为不限站点）。
 *
 * 传 hostname（不带端口、不带协议）。
 */
export function hostInList(hosts: string[], hostname: string): boolean {
  const h = String(hostname || "").trim().toLowerCase();
  if (!h) return false;
  for (let i = 0; i < hosts.length; i++) {
    const x = hosts[i];
    if (h === x || h.endsWith("." + x)) return true;
  }
  return false;
}
