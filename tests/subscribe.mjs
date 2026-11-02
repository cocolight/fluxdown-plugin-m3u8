/**
 * 订阅 provider 契约测试 —— 断言 `subscribe(ctx)` 的形状与两个硬纪律。
 *
 * 为什么不能靠 parity：`subscribe` 是 M3 之后新增的入口，v1.8.0 基线里没有它。
 *
 * 本文件只钉三件事，都是「错了会静默坑用户」的那种：
 *
 *   1. **防抓页解锁只重取一次**。订阅站与下载站是同一批站点，同样会返回「安全检查」页。
 *      不解的话解析结果是个空 feed，用户完全看不出是被拦了；解的时候绝不能循环 —— 解出
 *      Cookie 后仍被拦就必须放弃，否则一个恶意/异常站点能让插件无限请求（并发池只有 8，
 *      全应用共享）。
 *   2. **订阅源自带的 Cookie / UA 必须原样带上**，且重取时**不得丢失**。这两项来自引擎按
 *      订阅设置喂进来的 `ctx.cookies` / `ctx.userAgent`，与 resolver 那套「任务 URL 同源
 *      凭据」是两套语义，混了就是把订阅 A 的 Cookie 发给订阅 B。
 *   3. **挑战 Cookie 与已有 Cookie 合并而非覆盖**。直接用解出的 Cookie 顶掉用户配的，
 *      会让需要登录的订阅页变成未登录。
 *
 * 用法：npm run subscribe        （需先 npm run build）
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runEntry, show } from "./parity/harness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const DIST = process.env.SUBSCRIBE_DIST || join(ROOT, "dist");

const FEED_URL = "https://site.test/list/42";

/** 造一个「同构条目足够多」的列表页，让 minItems 判定通过。 */
function listPage(n) {
  const rows = [];
  for (let i = 1; i <= n; i++) rows.push(`<a href="/watch/100${i}">第${i}集</a>`);
  return "<html><head><title>测试剧集</title></head><body>" + rows.join("") + "</body></html>";
}

/**
 * 造一个与真实站点同形的 XOR 防抓页。
 * 判据（http.ts）：体积极小、不含 #EXTM3U、含 eval([…].map(...String.fromCharCode(c^K)))
 * 且解出的 JS 里有 document.cookie="name=value"。
 */
function challengePage(cookiePair) {
  const js = `document.cookie="${cookiePair};path=/";location.reload();`;
  const k = 13;
  const codes = [];
  for (let i = 0; i < js.length; i++) codes.push(js.charCodeAt(i) ^ k);
  return (
    "<html><body><script>eval([" +
    codes.join(",") +
    "].map(function(c){return String.fromCharCode(c^" +
    k +
    ");}).join(\"\"))</script></body></html>"
  );
}

async function runSubscribe(sc) {
  const r = await runEntry(DIST, {
    entry: "subscribe",
    routes: sc.routes,
    invoke: (e) =>
      e.subscribe({
        providerId: "m3u8-subscribe",
        sourceId: "s1",
        url: sc.url || FEED_URL,
        providerConfig: sc.providerConfig || "{}",
        cookies: sc.cookies || "",
        userAgent: sc.userAgent || "",
      }),
  });
  if (r.loadError) throw new Error(r.loadError);
  return r;
}

const fetchCalls = (r) => r.calls.filter((c) => c[0] === "fetch");
/** fetch 调的 headers 在 calls[2]（canon 过的对象），取某个 header（大小写不敏感）。 */
const headerOf = (call, name) => {
  const h = call[2] || {};
  const want = name.toLowerCase();
  for (const k of Object.keys(h)) if (k.toLowerCase() === want) return h[k];
  return undefined;
};

let pass = 0;
let fail = 0;
const ck = async (name, fn) => {
  try {
    const v = await fn();
    if (v === true) {
      pass++;
      console.log(`  ok   ${name}`);
    } else {
      fail++;
      console.log(`  FAIL ${name}`);
      console.log(`         ${show(v)}`);
    }
  } catch (e) {
    fail++;
    console.log(`  FAIL ${name}`);
    console.log(`         ${e && e.message ? e.message : e}`);
  }
};
const eq = (a, b) => (JSON.stringify(a) === JSON.stringify(b) ? true : { got: a, want: b });
const anyLog = (r, needle) =>
  r.logs.some((l) => l.slice(1).some((x) => String(typeof x === "string" ? x : JSON.stringify(x)).includes(needle)));

// ---------------------------------------------------------------------------
// 1. 无挑战：只发一次请求，条目正常产出
// ---------------------------------------------------------------------------
{
  const r = await runSubscribe({ routes: { [FEED_URL]: { body: listPage(3) } } });
  await ck("基线：正常列表页只抓一次", () => eq(fetchCalls(r).length, 1));
  await ck("基线：产出条目", () => (r.result && r.result.items && r.result.items.length >= 2 ? true : r.result));
  await ck("基线：条目走二段解析（resolverItem = u:<link>）", () => {
    const it = r.result.items[0];
    return it.resolverItem === "u:" + it.link ? true : `resolverItem=${it.resolverItem} link=${it.link}`;
  });
}

// ---------------------------------------------------------------------------
// 2. 命中挑战：解 Cookie 后重取一次，拿到真列表
// ---------------------------------------------------------------------------
{
  let n = 0;
  const r = await runSubscribe({
    routes: {
      [FEED_URL]: () => (n++ === 0 ? { body: challengePage("chl=ok") } : { body: listPage(3) }),
    },
  });
  await ck("挑战：确实重取了一次（共 2 次请求）", () => eq(fetchCalls(r).length, 2));
  await ck("挑战：重取时带上解出的 Cookie", () => {
    const v = headerOf(fetchCalls(r)[1], "Cookie");
    return v && String(v).includes("chl=ok") ? true : `Cookie=${v}`;
  });
  await ck("挑战：解锁后能解析出条目（不是空 feed）", () =>
    r.result && r.result.items.length >= 2 ? true : r.result,
  );
  await ck("挑战：日志有提示，用户能看出被拦过", () => anyLog(r, "防抓页校验") || "没有防抓页日志");
}

// ---------------------------------------------------------------------------
// 3. 重取后仍是挑战：必须放弃，绝不循环
// ---------------------------------------------------------------------------
{
  const r = await runSubscribe({
    routes: { [FEED_URL]: () => ({ body: challengePage("chl=loop") }) },
  });
  await ck("循环防护：连续挑战时最多 2 次请求（不无限重试）", () => eq(fetchCalls(r).length, 2));
  await ck("循环防护：解不出内容时返回空 feed 而不是抛错", () =>
    r.result && Array.isArray(r.result.items) && r.result.items.length === 0
      ? true
      : `result=${show(r.result)} error=${r.error}`,
  );
}

// ---------------------------------------------------------------------------
// 4. 订阅源自带的 Cookie / UA 必须原样带上，且重取时不丢
// ---------------------------------------------------------------------------
{
  let n = 0;
  const r = await runSubscribe({
    cookies: "sid=user1",
    userAgent: "MyUA/1.0",
    routes: {
      [FEED_URL]: () => (n++ === 0 ? { body: challengePage("chl=ok") } : { body: listPage(3) }),
    },
  });
  await ck("凭据：首次请求带订阅源的 UA", () => headerOf(fetchCalls(r)[0], "User-Agent") === "MyUA/1.0");
  await ck("凭据：首次请求带订阅源的 Cookie", () => headerOf(fetchCalls(r)[0], "Cookie") === "sid=user1");
  await ck("凭据：重取时 UA 不丢", () => headerOf(fetchCalls(r)[1], "User-Agent") === "MyUA/1.0");
  await ck("凭据：重取时原有 Cookie 与挑战 Cookie 合并（不覆盖）", () => {
    const v = String(headerOf(fetchCalls(r)[1], "Cookie") || "");
    return v.includes("sid=user1") && v.includes("chl=ok") ? true : `Cookie=${v}`;
  });
}

// ---------------------------------------------------------------------------
// 5. 挑战页里的 Cookie 不能在本进程内「记住」—— 订阅每次调用都是新上下文
// ---------------------------------------------------------------------------
{
  const r = await runSubscribe({ routes: { [FEED_URL]: { body: listPage(3) } } });
  await ck("无状态：不使用挑战路径时不发多余请求", () => eq(fetchCalls(r).length, 1));
}

console.log(`\n${pass}/${pass + fail} 项订阅契约通过`);
if (fail) {
  console.error(`\n${fail} 项契约未通过 —— subscribe 的防抓页行为不符合预期。`);
  process.exit(1);
}
