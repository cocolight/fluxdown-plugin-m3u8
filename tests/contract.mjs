/**
 * M2 契约测试 —— 断言「请求面」的具体形状，而不是与 v1.8.0 比等价。
 *
 * 为什么不能靠 parity：M2 有几处**有意**改变的行为（凭据不再写进 `extraHeaders`、跨站凭据
 * 连补丁都不生成），逐字比对必然报红。这些改变的正确性要由本文件直接断言：
 *
 *   1. 凭据只经 `originHeaders` 下发，且只针对登记 origin —— 不再有「跟着分片发给 CDN」的面。
 *   2. 跨站凭据整条不注入，并留一条可诊断的日志。
 *   3. Basic 的 Authorization 对非 ASCII 用户名正确（v1.8.0 手写编码器的回归保护）。
 *   4. Referer 三级优先级与 v1.8.0 一致，且落在 `referrer` 字段而非同名头。
 *   5. User-Agent 落在 `userAgent` 字段，不在 `setHeaders`。
 *   6. 用户显式写的同名凭据头优先。
 *   7. **凭据不落库**：`flux.storage.set` 的载荷里不出现任何凭据片段。
 *   8. `ephemeral` / `rangeSupported` 照旧透传。
 *   9. （M4）`maxRangeBytes` 只在合法区间下发：0 或低于 64 KiB 一律不发，避免整条补丁被宿主拒。
 *
 * 用法：npm run contract        （需先 npm run build）
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { credentialScope } from "./parity/face.mjs";
import { runEntry, show } from "./parity/harness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const DIST = process.env.CONTRACT_DIST || join(ROOT, "dist");

const SITE = "https://site.test";
const CDN = "https://cdn.site.test";
const OAUTH_REF = "m3u8-resolver@cocolight::https://site.test";

const MASTER = [
  "#EXTM3U",
  '#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080,CODECS="avc1.640028"',
  "1080p/index.m3u8",
  '#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,CODECS="avc1.640028"',
  "720p/index.m3u8",
  "",
].join("\n");

const ctxOf = (url, extra = {}) => ({
  taskId: "t1",
  url,
  authRef: "",
  cookies: "",
  referrer: "",
  userAgent: "",
  extraHeaders: {},
  resolverItem: "",
  ...extra,
});

let pass = 0;
let fail = 0;
const failures = [];

function check(name, fn) {
  try {
    const r = fn();
    if (r === true) {
      pass++;
      console.log(`  ok   ${name}`);
    } else {
      fail++;
      failures.push({ name, detail: r });
      console.log(`  FAIL ${name}`);
      console.log(`         ${r}`);
    }
  } catch (e) {
    fail++;
    failures.push({ name, detail: String((e && e.message) || e) });
    console.log(`  FAIL ${name}`);
    console.log(`         ${String((e && e.message) || e)}`);
  }
}

const eq = (actual, expected, label) =>
  JSON.stringify(actual) === JSON.stringify(expected)
    ? true
    : `${label || "值"}不符：期望 ${show(expected)}，实际 ${show(actual)}`;

async function resolveOnce(sc) {
  const r = await runEntry(DIST, {
    entry: "resolver",
    settings: sc.settings || {},
    routes: sc.routes || { [`${CDN}/hls/master.m3u8`]: { body: MASTER } },
    profiles: sc.profiles,
    ...sc,
  });
  if (r.error) throw new Error(`resolve 抛错：${r.error}`);
  if (r.loadError) throw new Error(r.loadError);
  return r;
}

// ---------------------------------------------------------------------------
// 1. 同源凭据 → originHeaders，且不再有 extraHeaders
// ---------------------------------------------------------------------------
{
  const r = await resolveOnce({
    profiles: { [OAUTH_REF]: { site: CDN, kind: "cookie", cookies: "sid=abc; uid=9" } },
    invoke: (e) => e.resolve(ctxOf(`${CDN}/hls/master.m3u8`, { authRef: OAUTH_REF })),
  });
  const out = r.result;

  check("凭据：结果里没有 extraHeaders（单一来源）", () =>
    out.extraHeaders === undefined ? true : `仍返回 extraHeaders: ${show(out.extraHeaders)}`);

  check("凭据：originHeaders 只有一个 origin，且等于登记站点", () =>
    eq(out.request && out.request.originHeaders && out.request.originHeaders.map((o) => o.origin), [CDN]));

  check("凭据：Cookie 值原样进入该 origin 的头表", () =>
    eq(out.request.originHeaders[0].headers.Cookie, "sid=abc; uid=9"));

  check("凭据：作用域不是「全部主机」", () => {
    const scope = credentialScope(out);
    return scope.length === 1 && scope[0] === CDN ? true : `作用域 ${show(scope)}`;
  });
}

// ---------------------------------------------------------------------------
// 2. 跨站凭据 → 整条不注入 + 可诊断日志
// ---------------------------------------------------------------------------
{
  const r = await resolveOnce({
    profiles: { [OAUTH_REF]: { site: SITE, kind: "cookie", cookies: "sid=abc" } },
    invoke: (e) => e.resolve(ctxOf(`${CDN}/hls/master.m3u8`, { authRef: OAUTH_REF })),
  });
  const out = r.result;
  const logs = r.logs.map((l) => l.join(" ")).join("\n");

  check("跨站凭据：不生成 originHeaders", () =>
    out.request && out.request.originHeaders === undefined ? true : `仍生成 ${show(out.request && out.request.originHeaders)}`);

  check("跨站凭据：日志说明「不同源」", () =>
    /不同源，未注入/.test(logs) ? true : `日志里没有该提示：${show(logs.slice(0, 200))}`);

  check("跨站凭据：Cookie 不出现在任何下发头里", () => {
    const dump = JSON.stringify(out);
    return dump.indexOf("sid=abc") === -1 ? true : "凭据泄漏进了返回值";
  });
}

// ---------------------------------------------------------------------------
// 3. Basic + 非 ASCII 用户名
// ---------------------------------------------------------------------------
{
  const r = await resolveOnce({
    profiles: { [OAUTH_REF]: { site: CDN, kind: "basic", username: "用户", password: "p@ss" } },
    invoke: (e) => e.resolve(ctxOf(`${CDN}/hls/master.m3u8`, { authRef: OAUTH_REF })),
  });
  const oh = (r.result.request && r.result.request.originHeaders) || [];
  const h = (oh[0] && oh[0].headers) || {};
  const auth = h.Authorization || "";

  check("Basic：生成了 originHeaders", () => (oh.length === 1 ? true : `实际 ${show(oh)}`));

  check("Basic：Authorization 前缀为 Basic", () =>
    auth.indexOf("Basic ") === 0 ? true : `实际 ${show(auth)}`);

  check("Basic：base64 解码回「用户:p@ss」（UTF-8 编码正确）", () => {
    const decoded = Buffer.from(auth.slice(6), "base64").toString("utf8");
    return decoded === "用户:p@ss" ? true : `解码得 ${show(decoded)}`;
  });
}

// ---------------------------------------------------------------------------
// 4/5. Referer 与 User-Agent 的落点
// ---------------------------------------------------------------------------
{
  const r = await resolveOnce({
    settings: { extraHeadersRaw: "# 注释\nX-A: 1\nReferer: https://raw.test/p", userAgent: "UA/1.0" },
    invoke: (e) =>
      e.resolve(
        ctxOf(`${CDN}/hls/master.m3u8`, {
          referrer: `${SITE}/watch/1`,
          extraHeaders: { "X-Task": "t", Referer: `${SITE}/override` },
        }),
      ),
  });
  const p = r.result.request;

  check("Referer：任务 extraHeaders 优先于 extraHeadersRaw 与自动值", () => eq(p.referrer, `${SITE}/override`));
  check("User-Agent：落在 userAgent 字段", () => eq(p.userAgent, "UA/1.0"));
  check("User-Agent：不在 setHeaders 里重复出现", () => {
    for (const k of Object.keys(p.setHeaders || {})) {
      if (k.toLowerCase() === "user-agent") return "setHeaders 里仍有 User-Agent";
    }
    return true;
  });
  check("Referer：不在 setHeaders 里重复出现", () => {
    for (const k of Object.keys(p.setHeaders || {})) {
      if (k.toLowerCase() === "referer") return "setHeaders 里仍有 Referer";
    }
    return true;
  });
  check("Origin：取页面来源（不是下载目标的 origin）", () => eq(p.setHeaders.Origin, SITE));
  check("自定义头：extraHeadersRaw 与任务头都并入 setHeaders", () =>
    eq([p.setHeaders["X-A"], p.setHeaders["X-Task"]], ["1", "t"]));
}

// ---------------------------------------------------------------------------
// 6. 用户显式写的同名凭据头优先
// ---------------------------------------------------------------------------
{
  const r = await resolveOnce({
    settings: { extraHeadersRaw: "Cookie: manual=1" },
    profiles: { [OAUTH_REF]: { site: CDN, kind: "cookie", cookies: "sid=abc" } },
    invoke: (e) => e.resolve(ctxOf(`${CDN}/hls/master.m3u8`, { authRef: OAUTH_REF })),
  });
  const p = r.result.request;

  check("优先级：用户手写的 Cookie 进 setHeaders", () => eq(p.setHeaders.Cookie, "manual=1"));
  check("优先级：档案里的 Cookie 不再覆盖用户值", () =>
    p.originHeaders === undefined ? true : `仍注入 ${show(p.originHeaders)}`);
}

// ---------------------------------------------------------------------------
// 7. 凭据不落库
// ---------------------------------------------------------------------------
{
  const r = await resolveOnce({
    profiles: { [OAUTH_REF]: { site: CDN, kind: "basic", username: "用户", password: "p@ss" } },
    invoke: (e) => e.resolve(ctxOf(`${CDN}/hls/master.m3u8`, { authRef: OAUTH_REF })),
  });
  const writes = r.calls.filter((c) => c[0] === "storage.set");

  check("隐私：storage.set 的载荷不含凭据", () => {
    const dump = JSON.stringify(writes);
    for (const needle of ["sid=abc", "p%40ss", "p@ss", "用户", "Basic "]) {
      if (dump.indexOf(needle) !== -1) return `载荷里出现 ${show(needle)}: ${show(dump.slice(0, 200))}`;
    }
    return true;
  });
}

// ---------------------------------------------------------------------------
// 8. ephemeral / rangeSupported 透传
// ---------------------------------------------------------------------------
{
  const r = await resolveOnce({
    settings: { ephemeral: true },
    routes: { [`${CDN}/hls/master.m3u8?sign=once`]: { body: MASTER } },
    invoke: (e) => e.resolve(ctxOf(`${CDN}/hls/master.m3u8?sign=once`, {})),
  });
  check("透传：ephemeral=true 与 rangeSupported=true 仍然返回", () =>
    eq([r.result.ephemeral, r.result.rangeSupported], [true, true]));
}

// ---------------------------------------------------------------------------
// 9. 无凭据时补丁依然完整（防盗链站不依赖 auth）
// ---------------------------------------------------------------------------
{
  const r = await resolveOnce({
    invoke: (e) => e.resolve(ctxOf(`${CDN}/hls/master.m3u8`)),
  });
  const p = r.result.request;
  check("防盗链：无 authRef 时仍给出 Referer 与 Origin", () =>
    eq([typeof p.referrer === "string" && p.referrer.length > 0, p.setHeaders && p.setHeaders.Origin], [true, CDN]));
  check("防盗链：无凭据时时不生成 originHeaders", () =>
    p.originHeaders === undefined ? true : `出现了 ${show(p.originHeaders)}`);
}

// ---------------------------------------------------------------------------
// 10. Range 上限（M4）：只在合法区间内下发，0 表示不干预
// ---------------------------------------------------------------------------
{
  const off = await resolveOnce({ settings: { rangeCapKb: 0 }, invoke: (e) => e.resolve(ctxOf(`${CDN}/hls/master.m3u8`)) });
  check("Range 上限：0 表示不限制，补丁里不出现 maxRangeBytes", () =>
    off.result.request.maxRangeBytes === undefined ? true : `出现了 ${show(off.result.request.maxRangeBytes)}`);

  const tiny = await resolveOnce({ settings: { rangeCapKb: 32 }, invoke: (e) => e.resolve(ctxOf(`${CDN}/hls/master.m3u8`)) });
  check("Range 上限：低于宿主下限（64 KiB）时按关闭处理，避免整条补丁被拒", () =>
    tiny.result.request.maxRangeBytes === undefined ? true : `出现了 ${show(tiny.result.request.maxRangeBytes)}`);

  const on = await resolveOnce({ settings: { rangeCapKb: 4096 }, invoke: (e) => e.resolve(ctxOf(`${CDN}/hls/master.m3u8`)) });
  check("Range 上限：4096 KiB 换算成 4194304 字节", () => eq(on.result.request.maxRangeBytes, 4194304));
}

console.log(`\n${pass}/${pass + fail} 项契约通过`);
if (fail) {
  console.error(`\n${fail} 项契约未通过 —— 请求面行为不符合预期。`);
  process.exit(1);
}
