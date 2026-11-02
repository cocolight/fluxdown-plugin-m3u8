/**
 * M2 契约测试 —— 断言「请求面」的具体形状，而不是与 v1.8.0 比等价。
 *
 * 为什么不能靠 parity：M2 有几处**有意**改变的行为（凭据不再写进 `extraHeaders`、跨站凭据
 * 连补丁都不生成），逐字比对必然报红。这些改变的正确性要由本文件直接断言：
 *
 *   1. 凭据只经 `originHeaders` 下发，且只针对任务 URL 的 origin —— 不再有「跟着分片发给 CDN」的面。
 *   2. 目标与任务 URL 不同源时整条不注入，并留一条可诊断的日志。
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
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { credentialScope } from "./parity/face.mjs";
import { runEntry, show } from "./parity/harness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const DIST = process.env.CONTRACT_DIST || join(ROOT, "dist");

const SITE = "https://site.test";
const CDN = "https://cdn.site.test";

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
// 1. 凭据 → originHeaders，且不再有 extraHeaders
// ---------------------------------------------------------------------------
{
  const r = await resolveOnce({
    settings: { authCookie: "sid=abc; uid=9" },
    invoke: (e) => e.resolve(ctxOf(`${CDN}/hls/master.m3u8`)),
  });
  const out = r.result;

  check("凭据：结果里没有 extraHeaders（单一来源）", () =>
    out.extraHeaders === undefined ? true : `仍返回 extraHeaders: ${show(out.extraHeaders)}`);

  check("凭据：originHeaders 只有一个 origin，且等于任务 URL 的 origin", () =>
    eq(out.request && out.request.originHeaders && out.request.originHeaders.map((o) => o.origin), [CDN]));

  check("凭据：Cookie 值原样进入该 origin 的头表", () =>
    eq(out.request.originHeaders[0].headers.Cookie, "sid=abc; uid=9"));

  check("凭据：作用域不是「全部主机」", () => {
    const scope = credentialScope(out);
    return scope.length === 1 && scope[0] === CDN ? true : `作用域 ${show(scope)}`;
  });
}

// ---------------------------------------------------------------------------
// 2. 目标与任务 URL 不同源 → 整条不注入 + 可诊断日志
//    （清单在站内、实际文件在 CDN：最常见的形态，也是这层闸存在的理由）
// ---------------------------------------------------------------------------
const PAGE = `<!doctype html>
<html><head><title>测试影片 - 某站</title></head>
<body><div id="app"></div>
<script>var player={"url":"${CDN}/hls/master.m3u8?sign=abc&t=1"};</script>
</body></html>`;

{
  const r = await resolveOnce({
    // 播放页解析需要 targetHosts 圈定目标站点（页面路径不靠扩展名判定，见 resolver 的 host 闸）
    settings: { targetHosts: "site.test", authCookie: "sid=abc" },
    routes: {
      [`${SITE}/watch/123`]: { body: PAGE },
      [`${CDN}/hls/master.m3u8?sign=abc&t=1`]: { body: MASTER },
    },
    invoke: (e) => e.resolve(ctxOf(`${SITE}/watch/123`)),
  });
  const out = r.result;
  const logs = r.logs.map((l) => l.join(" ")).join("\n");

  check("跨源凭据：不生成 originHeaders", () =>
    out.request && out.request.originHeaders === undefined ? true : `仍生成 ${show(out.request && out.request.originHeaders)}`);

  check("跨源凭据：日志说明「不同源」", () =>
    /不同源，未注入/.test(logs) ? true : `日志里没有该提示：${show(logs.slice(0, 200))}`);

  check("跨源凭据：Cookie 不出现在任何下发头里", () => {
    const dump = JSON.stringify(out);
    return dump.indexOf("sid=abc") === -1 ? true : "凭据泄漏进了返回值";
  });
}

// ---------------------------------------------------------------------------
// 2b. 凭据的站点约束（`@站点` 行）
//
// 没有这一节，`site !== key` 那条同源闸是恒真的 —— `site` 本身就是任务 URL 的 origin。
// 也就是说「跨源不注入」只挡得住清单↔CDN，挡不住「换一个站也能拿到凭据」。
// ---------------------------------------------------------------------------
{
  // 两个任务地址都要能抓到清单：SITE 用 http（验证协议不符），其余用 https
  const SITE_ROUTES = {
    [`${CDN}/hls/master.m3u8`]: { body: MASTER },
    [`${SITE}/hls/master.m3u8`]: { body: MASTER },
    ["http://site.test/hls/master.m3u8"]: { body: MASTER },
  };
  const withSite = (raw, taskUrl) =>
    resolveOnce({
      settings: { authCookie: raw },
      routes: SITE_ROUTES,
      invoke: (e) => e.resolve(ctxOf(taskUrl)),
    });

  // ① 命中：不改变原有行为
  {
    const r = await withSite("@site.test\nsid=abc", `https://site.test/hls/master.m3u8`);
    const oh = (r.result.request && r.result.request.originHeaders) || [];
    const h = (oh[0] && oh[0].headers) || {};
    check("站点约束：@site.test 命中同站任务，正常注入 Cookie", () =>
      h.Cookie === "sid=abc" ? true : `实际 ${show(h)}`);
  }

  // ② 不命中：整条不注入，且凭据不出现在返回值里。
  //    这里故意用 `other.test` 而不是 `cdn.site.test` —— 后者是 site.test 的子域，
  //    按主机名匹配本来就该命中（见 ③），拿它当反例会把正确行为判成 bug。
  {
    const OTHER = "https://other.test/hls/master.m3u8";
    const r = await resolveOnce({
      settings: { authCookie: "@site.test\nsid=abc" },
      routes: { ...SITE_ROUTES, [OTHER]: { body: MASTER } },
      invoke: (e) => e.resolve(ctxOf(OTHER)),
    });
    const oh = r.result.request && r.result.request.originHeaders;
    check("站点约束：@site.test 遇到无关站点，不生成 originHeaders", () =>
      oh === undefined ? true : `仍生成 ${show(oh)}`);
    check("站点约束：被挡下时凭据不出现在返回值里", () => {
      const dump = JSON.stringify(r.result);
      return dump.indexOf("sid=abc") === -1 ? true : "凭据泄漏进了返回值";
    });
  }

  // ③ 裸域不覆盖子域（与 targetHosts 相反，见 ADR-0010 决策 1）
  //
  // 语义方向：`targetHosts` 是准入白名单，写 `a.com` 一并覆盖子域是便利；
  // 凭据是限制，写 `@a.com` 是在声明归属，扩到 `evil.a.com` 就是泄漏。
  // 覆盖子域必须显式写 `@*.a.com`（见 ⑤）。
  {
    const r = await withSite("@site.test\nsid=abc", `${CDN}/hls/master.m3u8`);
    const oh = r.result.request && r.result.request.originHeaders;
    check("站点约束：@site.test 不覆盖子域 cdn.site.test（裸域即精确匹配）", () =>
      oh === undefined ? true : `仍注入（子域被放行）：${show(oh)}`);
  }

  // ③b 需要子域时显式写通配
  {
    const r = await withSite("@*.site.test\nsid=abc", `${CDN}/hls/master.m3u8`);
    const oh = (r.result.request && r.result.request.originHeaders) || [];
    check("站点约束：@*.site.test 覆盖子域 cdn.site.test", () =>
      oh.length === 1 ? true : `实际 ${show(oh)}`);
  }

  // ④ 带协议的约束卡到 origin：http 任务拿不到 https 的凭据
  {
    const r = await withSite("@https://site.test\nsid=abc", `http://site.test/hls/master.m3u8`);
    const oh = r.result.request && r.result.request.originHeaders;
    check("站点约束：@https://site.test 不覆盖 http 任务（协议不同即不同站点）", () =>
      oh === undefined ? true : `仍生成 ${show(oh)}`);
  }

  // ⑤ 通配只匹配真子域，不匹配裸域
  {
    const r = await withSite("@*.site.test\nsid=abc", `https://site.test/hls/master.m3u8`);
    const oh = r.result.request && r.result.request.originHeaders;
    check("站点约束：@*.site.test 不匹配裸域 site.test", () =>
      oh === undefined ? true : `仍生成 ${show(oh)}`);
  }

  // ⑥ 向后兼容：不写站点行时行为完全不变（旧配置不受影响）
  {
    const r = await withSite("sid=abc", `${CDN}/hls/master.m3u8`);
    const oh = (r.result.request && r.result.request.originHeaders) || [];
    check("站点约束：不写 @站点 时行为不变（旧配置不受影响）", () =>
      oh.length === 1 ? true : `实际 ${show(oh)}`);
  }

  // ⑦ 站点行不会被当成 Cookie 发出去
  {
    const r = await withSite("@site.test\nsid=abc", `https://site.test/hls/master.m3u8`);
    const oh = (r.result.request && r.result.request.originHeaders) || [];
    const h = (oh[0] && oh[0].headers) || {};
    check("站点约束：@站点 行不进 Cookie 值", () =>
      String(h.Cookie || "").indexOf("@") === -1 ? true : `Cookie 里混进了站点行：${show(h.Cookie)}`);
  }

  // ⑧ 缺省继承 `targetHosts` —— 用户已经在「站点 · 生效范围」里表过态的站点清单，
  //    不该要求他再到凭据里抄一遍。下面的用例成对出现，缺一半就说明不了问题。
  {
    const other = "https://other.test/hls/master.m3u8";
    const routes = { ...SITE_ROUTES, [other]: { body: MASTER } };

    const hit = await resolveOnce({
      settings: { authCookie: "sid=abc", targetHosts: "site.test" },
      routes,
      invoke: (e) => e.resolve(ctxOf(`https://site.test/hls/master.m3u8`)),
    });
    const oh1 = (hit.result.request && hit.result.request.originHeaders) || [];
    check("站点约束：凭据没写 @站点 时继承 targetHosts，命中同站", () =>
      oh1.length === 1 ? true : `实际 ${show(oh1)}`);

    const miss = await resolveOnce({
      settings: { authCookie: "sid=abc", targetHosts: "site.test" },
      routes,
      invoke: (e) => e.resolve(ctxOf(other)),
    });
    const oh2 = miss.result.request && miss.result.request.originHeaders;
    check("站点约束：继承来的 targetHosts 同样挡住无关站点", () =>
      oh2 === undefined ? true : `仍生成 ${show(oh2)}`);
    check("站点约束：被 targetHosts 挡下时凭据不出现在返回值里", () => {
      const dump = JSON.stringify(miss.result);
      return dump.indexOf("sid=abc") === -1 ? true : "凭据泄漏进了返回值";
    });

    // 显式 @站点 优先于 targetHosts：两者冲突时以凭据自己写的为准，
    // 否则用户在凭据里做的收窄会被宽泛的 targetHosts 悄悄放大。
    // 这里用 `@*.site.test` 收窄到「只子域」，任务站是裸域 → 必须拦下。
    const narrow = await resolveOnce({
      settings: { authCookie: "@*.site.test\nsid=abc", targetHosts: "site.test,cdn.site.test" },
      routes,
      invoke: (e) => e.resolve(ctxOf(`https://site.test/hls/master.m3u8`)),
    });
    const oh3 = narrow.result.request && narrow.result.request.originHeaders;
    check("站点约束：显式 @站点 优先于 targetHosts（裸域被凭据收窄）", () =>
      oh3 === undefined ? true : `仍注入（targetHosts 把范围放大了）：${show(oh3)}`);

    // 反过来：targetHosts 留空（对所有站点生效）时，凭据的约束仍然生效 ——
    // 「不限站点」是父级开关，不该把凭据自己写的范围抹掉。
    const stillBound = await resolveOnce({
      settings: { authCookie: "@site.test\nsid=abc", targetHosts: "" },
      routes,
      invoke: (e) => e.resolve(ctxOf(other)),
    });
    const oh3b = stillBound.result.request && stillBound.result.request.originHeaders;
    check("站点约束：targetHosts 留空时，@站点 仍然生效", () =>
      oh3b === undefined ? true : `仍注入：${show(oh3b)}`);

    // targetHosts 留空 = 对所有站点生效，此时不额外限制，行为与旧版本一致（见 ⑥）。
    const blank = await resolveOnce({
      settings: { authCookie: "sid=abc", targetHosts: "" },
      routes,
      invoke: (e) => e.resolve(ctxOf(other)),
    });
    const oh4 = (blank.result.request && blank.result.request.originHeaders) || [];
    check("站点约束：targetHosts 留空时不额外限制（旧配置不受影响）", () =>
      oh4.length === 1 ? true : `实际 ${show(oh4)}`);
  }

}

// ---------------------------------------------------------------------------
// 3. Basic + 非 ASCII 用户名
// ---------------------------------------------------------------------------
{
  const r = await resolveOnce({
    settings: { authCookie: "basic:用户:p@ss" },
    invoke: (e) => e.resolve(ctxOf(`${CDN}/hls/master.m3u8`)),
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
    settings: { extraHeadersRaw: "Cookie: manual=1", authCookie: "sid=abc" },
    invoke: (e) => e.resolve(ctxOf(`${CDN}/hls/master.m3u8`)),
  });
  const p = r.result.request;

  check("优先级：用户手写的 Cookie 进 setHeaders", () => eq(p.setHeaders.Cookie, "manual=1"));
  check("优先级：凭据里的 Cookie 不再覆盖用户值", () =>
    p.originHeaders === undefined ? true : `仍注入 ${show(p.originHeaders)}`);
}

// ---------------------------------------------------------------------------
// 6b. 多行请求头形式的凭据：逐条注入，且同样让位给用户显式值
// ---------------------------------------------------------------------------
{
  const r = await resolveOnce({
    settings: { authCookie: "X-Token: from-setting\nX-Play: 1", extraHeadersRaw: "X-Token: manual" },
    invoke: (e) => e.resolve(ctxOf(`${CDN}/hls/master.m3u8`)),
  });
  const oh = (r.result.request.originHeaders || [])[0] || { headers: {} };

  check("多行凭据：只注入用户没写的那个头", () =>
    eq(oh.headers, { "X-Play": "1" }));
}

// ---------------------------------------------------------------------------
// 7. 凭据不落库
// ---------------------------------------------------------------------------
{
  const r = await resolveOnce({
    settings: { authCookie: "basic:用户:p@ss" },
    invoke: (e) => e.resolve(ctxOf(`${CDN}/hls/master.m3u8`)),
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
  check("防盗链：未填凭据时仍给出 Referer 与 Origin", () =>
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

// ---------------------------------------------------------------------------
// 11. 登录入口已移除（凭据只剩「设置项直供」这一条路）
// ---------------------------------------------------------------------------
{
  const m = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));
  check("登录：manifest 不再声明 auth 段", () => (m.auth === undefined ? true : `仍声明 ${show(m.auth)}`));
  check("登录：permissions 不含 auth", () =>
    (m.permissions || []).indexOf("auth") < 0 ? true : `仍要 ${show(m.permissions)}`);
  check("登录：产物里没有 auth.js", () =>
    existsSync(join(DIST, "auth.js")) ? "dist/auth.js 仍在" : true);
}

// ---------------------------------------------------------------------------
// 12. 自定义视图已移除（设置面 = 宿主自动生成的表单，见 ADR-0009）
// ---------------------------------------------------------------------------
{
  const m = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));
  check("设置面：manifest 不再声明 main 入口", () => (m.main === undefined ? true : `仍声明 ${show(m.main)}`));
  check("设置面：manifest 不再声明 contributes.views", () =>
    (m.contributes === undefined ? true : `仍声明 ${show(m.contributes)}`));
  check("设置面：产物里没有 main.js", () =>
    existsSync(join(DIST, "main.js")) ? "dist/main.js 仍在" : true);
}

// ---------------------------------------------------------------------------
// 13. yt-dlp 委派带上凭据（cookies.txt + --add-header）
//     yt-dlp 这条路此前完全不传 Cookie，需要登录的站点在委派路径上是硬的。
// ---------------------------------------------------------------------------
{
  const YT_URL = `${SITE}/watch/yt`;
  const YT_OUT = { stdout: JSON.stringify({ title: "凭据片名", url: `${CDN}/dl/index.m3u8` }) };

  const ytdlpOnce = async (settings) => {
    const r = await runEntry(DIST, {
      entry: "resolver",
      settings: { targetHosts: "site.test", useYtdlp: true, ...settings },
      routes: {},
      ytdlp: YT_OUT,
      invoke: (e) => e.resolve(ctxOf(YT_URL)),
    });
    if (r.loadError) throw new Error(r.loadError);
    const calls = r.calls || [];
    const w = calls.find((c) => c[0] === "fs.writeFile");
    const rm = calls.find((c) => c[0] === "fs.remove");
    const run = calls.find((c) => c[0] === "ytdlp.run");
    return { r, write: w, removed: rm, args: (run && run[1]) || [] };
  };

  // --- 4a. Cookie 形态：写 cookies.txt，参数带 --cookies
  {
    const { r, write, removed, args } = await ytdlpOnce({ authCookie: "sid=abc; uid=9" });

    check("yt-dlp 凭据：Cookie 写法会写 cookies.txt", () =>
      write && write[1] === "cookies.txt" ? true : `实际 ${show(write)}`);

    check("yt-dlp 凭据：cookies.txt 用 Tab 分隔且恰好 7 列", () => {
      if (!write) return "没有写文件";
      const lines = String(write[2])
        .split("\n")
        .filter((l) => l && l.charAt(0) !== "#");
      if (!lines.length) return "正文里没有 cookie 行";
      for (const l of lines) {
        const n = l.split("\t").length;
        if (n !== 7) return `列数 ${n} != 7：${show(l)}`;
      }
      return true;
    });

    check("yt-dlp 凭据：domain 带前导点且含子域", () => {
      if (!write) return "没有写文件";
      const line = String(write[2])
        .split("\n")
        .filter((l) => l && l.charAt(0) !== "#")[0] || "";
      const f = line.split("\t");
      return f[0] === ".site.test" && f[1] === "TRUE" ? true : `实际 ${show(f)}`;
    });

    check("yt-dlp 凭据：HTTPS 任务的 secure 列为 TRUE", () => {
      if (!write) return "没有写文件";
      const f = (String(write[2]).split("\n").filter((l) => l && l.charAt(0) !== "#")[0] || "").split("\t");
      return f[3] === "TRUE" ? true : `实际 ${show(f[3])}`;
    });

    check("yt-dlp 凭据：两条 cookie 都在，值是原样", () => {
      if (!write) return "没有写文件";
      const body = String(write[2]);
      return body.indexOf("\tsid\tabc") >= 0 && body.indexOf("\tuid\t9") >= 0
        ? true
        : `正文 ${show(body)}`;
    });

    check("yt-dlp 参数：带 --cookies cookies.txt", () =>
      eq(args.slice(0, 2), ["--cookies", "cookies.txt"]));

    check("yt-dlp 凭据：用完立刻删除 cookies.txt", () =>
      removed && removed[1] === "cookies.txt" ? true : `实际 ${show(removed)}`);

    check("yt-dlp 委派本身仍然成功", () => (r.result && r.result.url ? true : `结果 ${show(r.result)}`));
  }

  // --- 4a2. 站点约束同样管住 yt-dlp 链路
  //
  // 三条注入链路（抓清单 / 下载补丁 / yt-dlp）共用 `parseCredential` 里的那一处判断。
  // 这条用例是「不漏一条链路」的守门人：谁把站点检查挪到某个调用点上，这里会先红。
  {
    const { write, args, r } = await ytdlpOnce({ authCookie: "@other.test\nsid=abc" });
    check("站点约束（yt-dlp）：站点不匹配时不写 cookies.txt", () =>
      write ? `仍写了 ${show(write)}` : true);
    check("站点约束（yt-dlp）：站点不匹配时不带 --cookies / --add-header", () => {
      const bad = args.filter((a) => a === "--cookies" || a === "--add-header");
      return bad.length ? `仍带了 ${show(bad)}` : true;
    });
    check("站点约束（yt-dlp）：不匹配时委派仍然成功（fail-open，只是不带凭据）", () =>
      r.result && r.result.url ? true : `结果 ${show(r.result)}`);
  }

  // --- 4b. HTTP 任务：secure 必须为 FALSE，否则 cookie 一条都发不出去
  {
    const r = await runEntry(DIST, {
      entry: "resolver",
      settings: { targetHosts: "site.test", useYtdlp: true, authCookie: "sid=abc" },
      routes: {},
      ytdlp: YT_OUT,
      invoke: (e) => e.resolve(ctxOf("http://site.test/watch/yt")),
    });
    const w = (r.calls || []).find((c) => c[0] === "fs.writeFile");
    check("yt-dlp 凭据：HTTP 任务的 secure 列为 FALSE", () => {
      if (!w) return "没有写文件";
      const f = (String(w[2]).split("\n").filter((l) => l && l.charAt(0) !== "#")[0] || "").split("\t");
      return f[3] === "FALSE" ? true : `实际 ${show(f[3])}`;
    });
  }

  // --- 4c. Bearer 形态：变不成 cookie 行，必须走 --add-header
  {
    const { write, args } = await ytdlpOnce({ authCookie: "bearer abc123" });
    check("yt-dlp 凭据：Bearer 不写 cookies.txt", () => (write ? `仍写了 ${show(write[1])}` : true));
    check("yt-dlp 凭据：Bearer 走 --add-header Authorization", () => {
      const i = args.indexOf("--add-header");
      if (i < 0) return `参数里没有 --add-header：${show(args)}`;
      return args[i + 1] === "Authorization: Bearer abc123" ? true : `实际 ${show(args[i + 1])}`;
    });
  }

  // --- 4d. 无凭据：行为与改造前完全一致（不写、不加参数）
  {
    const { write, args } = await ytdlpOnce({});
    check("yt-dlp 凭据：无凭据时不写文件", () => (write ? `仍写了 ${show(write)}` : true));
    check("yt-dlp 凭据：无凭据时参数里没有 --cookies / --add-header", () => {
      const bad = args.filter((a) => a === "--cookies" || a === "--add-header");
      return bad.length ? `出现了 ${show(bad)}` : true;
    });
    check("yt-dlp 无凭据：参数与原来一致", () =>
      eq(args, ["-J", "--no-warnings", YT_URL]));
  }

  // --- 4e. 写文件失败不能拖垮委派
  {
    const r = await runEntry(DIST, {
      entry: "resolver",
      settings: { targetHosts: "site.test", useYtdlp: true, authCookie: "sid=abc" },
      routes: {},
      ytdlp: YT_OUT,
      fsWriteError: "ENOSPC",
      invoke: (e) => e.resolve(ctxOf(YT_URL)),
    });
    check("yt-dlp 凭据：写 cookies.txt 失败仍继续委派", () =>
      r.result && r.result.url ? true : `结果 ${show(r.result)} / 错误 ${show(r.error)}`);
  }
}

console.log(`\n${pass}/${pass + fail} 项契约通过`);
if (fail) {
  console.error(`\n${fail} 项契约未通过 —— 请求面行为不符合预期。`);
  process.exit(1);
}
