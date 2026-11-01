import { fnv1a32 } from "./hash";

/**
 * 清单条目 id 编解码。
 *
 * 引擎对条目 id 的唯一要求是「非空、≤200 字符、不透明」，回调时**原样**放回
 * `ResolveRequest.resolverItem`。于是短 URL 直接内嵌，超长的落 storage 换 token。
 * ★ 含 `@` 的 URL 必须走 token 分支：引擎把 resolverItem 当 `<id>@<variantId>` 解析。
 */

const ITEM_KEY = "itemMap"; // 单键存储（规避键数上限），值是 {token: url}
const ITEM_MAX = 400;

export async function encodeItem(url: string): Promise<string> {
  const u = String(url || "");
  if (!u) return "";
  if (u.length <= 190 && u.indexOf("@") < 0) return "u:" + u;
  const token = "k" + fnv1a32(u);
  try {
    if (flux.storage) {
      const raw = await flux.storage.get(ITEM_KEY);
      let map: Record<string, string> = {};
      try {
        map = raw ? JSON.parse(raw) : {};
      } catch {
        map = {};
      }
      if (!map || typeof map !== "object") map = {};
      map[token] = u;
      const keys = Object.keys(map);
      if (keys.length > ITEM_MAX) {
        for (let i = 0; i < keys.length - ITEM_MAX; i++) delete map[keys[i]];
      }
      await flux.storage.set(ITEM_KEY, JSON.stringify(map));
    }
  } catch {
    /* 落库失败仍返回 token：二段解码失败会放行，不会误下 */
  }
  return "k:" + token;
}

export async function decodeItem(v: string | null | undefined): Promise<string | null> {
  const s = String(v == null ? "" : v);
  if (s.indexOf("u:") === 0) return s.slice(2);
  if (s.indexOf("k:") !== 0) return null;
  const token = s.slice(2);
  try {
    if (!flux.storage) return null;
    const raw = await flux.storage.get(ITEM_KEY);
    const map = raw ? (JSON.parse(raw) as Record<string, string>) : {};
    return map && map[token] ? String(map[token]) : null;
  } catch {
    return null;
  }
}
