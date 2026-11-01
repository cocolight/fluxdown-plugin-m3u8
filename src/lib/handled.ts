/**
 * 任务标记 —— 让 hooks 判断「这个任务是不是本插件经手的」。
 *
 * 为什么需要：manifest 的 `hooks.match` 只能拿**任务的原始 URL** 过滤。播放页场景下原始 URL
 * 里不含 m3u8（例：https://site.com/watch/123），旧配置 `match:["*://*m3u8*"]` 会让 remux /
 * 兜底合并对这类任务永远不触发 —— 一个静默失效。现改为不设 match（对所有任务都收到事件），
 * 再用 resolver 写入的 taskId 标记判断归属。
 *
 * 只用 1 个存储键（避免 100 键上限），带 TTL 与条数上限；任何异常都吞掉，绝不影响解析。
 */

const HANDLE_KEY = "handledTasks";
const HANDLE_TTL_MS = 6 * 3600 * 1000;
const HANDLE_MAX = 60;

async function readHandled(): Promise<Record<string, number>> {
  try {
    if (!flux.storage) return {};
    const s = await flux.storage.get(HANDLE_KEY);
    if (!s) return {};
    const o = JSON.parse(s);
    return o && typeof o === "object" ? (o as Record<string, number>) : {};
  } catch {
    return {};
  }
}

export async function markHandled(taskId: string | undefined): Promise<void> {
  if (!taskId || !flux.storage) return;
  try {
    const now = Date.now();
    const map = await readHandled();
    map[taskId] = now;
    const ids = Object.keys(map);
    for (let i = 0; i < ids.length; i++) {
      if (now - map[ids[i]] > HANDLE_TTL_MS) delete map[ids[i]];
    }
    const left = Object.keys(map);
    if (left.length > HANDLE_MAX) {
      left.sort((a, b) => map[a] - map[b]);
      const drop = left.length - HANDLE_MAX;
      for (let i = 0; i < drop; i++) delete map[left[i]];
    }
    await flux.storage.set(HANDLE_KEY, JSON.stringify(map));
  } catch {
    /* 标记失败不影响解析：最坏情况只是 hooks 不做后处理 */
  }
}

export async function isHandled(taskId: string | undefined): Promise<boolean> {
  if (!taskId) return false;
  const map = await readHandled();
  return !!map[taskId];
}

export async function unmarkHandled(taskId: string | undefined): Promise<void> {
  if (!taskId || !flux.storage) return;
  try {
    const map = await readHandled();
    if (map[taskId] !== undefined) {
      delete map[taskId];
      await flux.storage.set(HANDLE_KEY, JSON.stringify(map));
    }
  } catch {
    /* 清理失败不影响主流程 */
  }
}
