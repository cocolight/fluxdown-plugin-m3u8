/**
 * 设置表单契约 —— 「设置 → 扩展 → 插件」里宿主自动生成的那张表单。
 *
 * 为什么单独一层：表单由宿主从 `manifest.settings` 渲染（SDK 的标准设置路径），
 * 插件侧能动的只有声明本身。声明一旦散掉 —— 开关被参数打断、标题不带主题、
 * 默认值漂移 —— 用户看到的就是一堵无从下手的墙，而下载行为测试全绿。这里直接
 * 断言「声明现在应该是什么样」：
 *
 *   1. 开关连续排最前：宿主把**连续的开关字段合并进同一张卡片**（`plugin_settings.rs`
 *      的 option_group 归并），这是这张表单唯一的分组手段。
 *   2. 非开关项标题带「主题 · 项目」前缀、同主题连续、去广告殿后。
 *   3. 默认值锁定在推荐值（方案A）；manifest 与 `settings.ts` 的读取兜底一致。
 *   4. select 选项与运行时口径一致；widget×type 矩阵合法；每项都有描述。
 *   5. 产物形态：4 入口、无 main.js、零 SDK 运行时（AGENTS.md 红线 #3）。
 *
 * 用法：npm run ui          （需先 npm run build）
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { show } from "./parity/harness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const DIST = process.env.UI_DIST || join(ROOT, "dist");

const MANIFEST = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));
const FIELDS = MANIFEST.settings;

/** 开关段：连续排最前的 11 个 boolean，宿主把它们并成一张卡片。顺序即卡片内顺序。 */
const TOGGLE_KEYS = [
  "solveChallenge", "followIframe", "detectDash", "detectSeries", "htmlFallbackYtdlp",
  "autoPick", "useYtdlp", "audioOnly", "remuxToMp4", "fixMuxFallback", "ephemeral",
];

/** 非开关段的主题序列（同主题连续，去广告殿后）。 */
const THEMES = ["画质", "音轨", "命名", "站点", "网络", "解析", "剧集", "下载", "去广告"];

/** 推荐默认值（方案A）。有意改默认值时必须同步这张表，否则这里红。 */
const DEFAULTS = {
  solveChallenge: "true", followIframe: "true", detectDash: "true", detectSeries: "true",
  htmlFallbackYtdlp: "true", autoPick: "false", useYtdlp: "false", audioOnly: "false",
  remuxToMp4: "true", fixMuxFallback: "true", ephemeral: "false",
  preferResolution: "best", preferCodec: "auto", separateAudio: "auto", audioLang: "",
  nameTemplate: "{title} {host}", targetHosts: "", authCookie: "", userAgent: "",
  extraHeadersRaw: "", iframeMaxFollow: "1", manifestMinItems: "3", manifestMaxItems: "200",
  episodeLinkPattern: "", rangeCapKb: "0", adRulesMode: "off", adRulesExtra: "",
};

/** select 的取值集合 = 运行时口径（`src/lib/adrules.ts` 的 AdMode、变体选择与音轨分离）。 */
const OPTION_SETS = {
  preferResolution: ["best", "1080", "720", "480", "360"],
  preferCodec: ["auto", "avc", "hevc", "av01", "vp9"],
  separateAudio: ["auto", "on", "off"],
  adRulesMode: ["off", "marker", "heuristic"],
};

/** widget×type 矩阵（引擎 manifest.rs 的 SettingWidget 允许表）。 */
const WIDGET_MATRIX = {
  string: ["text", "password", "textarea", "select", "folder"],
  number: ["number"],
  boolean: ["toggle"],
};

const DEFAULT_WIDGET = { string: "text", number: "number", boolean: "toggle" };

let pass = 0;
let fail = 0;

async function ck(name, fn) {
  try {
    const r = await fn();
    if (r === true) {
      pass++;
      console.log(`  ok   ${name}`);
    } else {
      fail++;
      console.log(`  FAIL ${name}`);
      console.log(`         ${r}`);
    }
  } catch (e) {
    fail++;
    const d = String((e && e.message) || e);
    console.log(`  FAIL ${name}`);
    console.log(`         ${d}`);
  }
}

const eq = (actual, expected, label) =>
  JSON.stringify(actual) === JSON.stringify(expected)
    ? true
    : `${label}：期望 ${show(expected)}，实际 ${show(actual)}`;

const byKey = (k) => FIELDS.filter((f) => f.key === k)[0];

// ---------------------------------------------------------------------------
// 1. 声明结构：开关成组、三段顺序
// ---------------------------------------------------------------------------
{
  await ck("结构：共 27 项且 key 唯一", async () => {
    const keys = FIELDS.map((f) => f.key);
    const uniq = new Set(keys);
    if (uniq.size !== keys.length) return `key 重复：${show(keys)}`;
    return eq(keys.length, 27, "设置项数");
  });

  await ck("结构：11 个开关连续排最前（宿主才并得成一张卡片）", async () => {
    const head = FIELDS.slice(0, TOGGLE_KEYS.length).map((f) => f.key);
    const r = eq(head, TOGGLE_KEYS, "前 11 项");
    if (r !== true) return r;
    const tail = FIELDS.slice(TOGGLE_KEYS.length);
    const leaked = tail.filter((f) => f.type === "boolean").map((f) => f.key);
    return leaked.length === 0 ? true : `开关段之后还有 boolean：${show(leaked)}`;
  });

  await ck("结构：非开关 16 项按主题聚簇，去广告恰为最后两项", async () => {
    const rest = FIELDS.slice(TOGGLE_KEYS.length);
    const titles = rest.map((f) => f.title);
    const runs = [];
    for (const t of titles.map((x) => x.split(" · ")[0])) {
      if (runs[runs.length - 1] !== t) runs.push(t);
    }
    const r = eq(runs, THEMES, "主题序列");
    if (r !== true) return r;
    return eq(titles.slice(-2), ["去广告 · 模式", "去广告 · 自定义规则"], "末尾两项");
  });

  await ck("结构：每项都有非空 title 与 description（不留无说明的裸字段）", async () => {
    const bad = FIELDS.filter((f) => !f.title || !f.description);
    return bad.length === 0 ? true : `缺 title/description：${show(bad.map((f) => f.key))}`;
  });
}

// ---------------------------------------------------------------------------
// 2. 主题前缀：「主题 · 项目」是平铺表单里唯一的分类路标
// ---------------------------------------------------------------------------
{
  await ck("前缀：16 个非开关项标题全部符合「主题 · 项目」", async () => {
    const bad = FIELDS.slice(TOGGLE_KEYS.length).filter((f) => !/^[^ ·]+ · \S/.test(f.title));
    return bad.length === 0 ? true : `格式不合规：${show(bad.map((f) => [f.key, f.title]))}`;
  });

  await ck("前缀：主题取自白名单且 9 类全覆盖", async () => {
    const got = [...new Set(FIELDS.slice(TOGGLE_KEYS.length).map((f) => f.title.split(" · ")[0]))];
    return eq(got, THEMES, "主题集合");
  });
}

// ---------------------------------------------------------------------------
// 3. 默认值（方案A）：与 settings.ts 的读取兜底双向钉死
// ---------------------------------------------------------------------------
{
  await ck("默认值：27 项与推荐值（方案A）逐项一致", async () => {
    const bad = [];
    for (const f of FIELDS) {
      const got = f.default === undefined ? "" : String(f.default);
      if (!(f.key in DEFAULTS)) bad.push([f.key, "不在清单里", got]);
      else if (got !== DEFAULTS[f.key]) bad.push([f.key, DEFAULTS[f.key], got]);
    }
    const extra = Object.keys(DEFAULTS).filter((k) => !byKey(k));
    if (extra.length) return `清单里有、manifest 没有：${show(extra)}`;
    return bad.length === 0 ? true : `漂移 [key, 期望, 实际]：${show(bad)}`;
  });

  await ck("默认值：与 settings.ts 的 readSettings 兜底一致（防两侧漂移）", async () => {
    const src = readFileSync(join(ROOT, "src/lib/settings.ts"), "utf8");
    const want = {};
    const re = /\b(str|bool|int)\("(\w+)",\s*([^)]+)\)/g;
    let m;
    while ((m = re.exec(src))) {
      const [, fn, key, rawExpr] = m;
      const lit = rawExpr.trim();
      if (fn === "str") want[key] = lit.replace(/^"|"$/g, "");
      else if (fn === "bool") want[key] = lit;
      else want[key] = String(parseInt(lit, 10));
    }
    if (!Object.keys(want).length) return "settings.ts 里没解析到任何默认值（正则失效？）";
    const bad = [];
    for (const [key, def] of Object.entries(want)) {
      const f = byKey(key);
      if (!f) {
        bad.push([key, "settings.ts 有、manifest 没有"]);
        continue;
      }
      const got = f.default === undefined ? "" : String(f.default);
      if (got !== def) bad.push([key, def, got]);
    }
    return bad.length === 0 ? true : `两侧不一致 [key, settings.ts, manifest]：${show(bad)}`;
  });

  await ck("默认值：boolean 用 \"true\"/\"false\" 字符串，number 可解析", async () => {
    const bad = FIELDS.filter((f) => {
      const d = f.default === undefined ? "" : String(f.default);
      if (f.type === "boolean") return d !== "true" && d !== "false";
      if (f.type === "number") return d !== "" && isNaN(parseInt(d, 10));
      return false;
    });
    return bad.length === 0 ? true : `类型不符：${show(bad.map((f) => [f.key, f.default]))}`;
  });
}

// ---------------------------------------------------------------------------
// 4. 字段合法性：select 选项、widget 矩阵、值域
// ---------------------------------------------------------------------------
{
  await ck("select：options 非空且默认值落在选项内", async () => {
    const bad = FIELDS.filter(
      (f) =>
        (f.widget || DEFAULT_WIDGET[f.type]) === "select" &&
        (!Array.isArray(f.options) || !f.options.length || f.options.map((o) => o.value).indexOf(String(f.default)) < 0),
    );
    return bad.length === 0 ? true : `问题项：${show(bad.map((f) => f.key))}`;
  });

  await ck("select：取值集合与运行时口径一致（防选项漂移）", async () => {
    const bad = [];
    for (const [key, want] of Object.entries(OPTION_SETS)) {
      const f = byKey(key);
      if (!f) {
        bad.push([key, "manifest 没有"]);
        continue;
      }
      const got = (f.options || []).map((o) => o.value);
      if (JSON.stringify(got) !== JSON.stringify(want)) bad.push([key, want, got]);
    }
    return bad.length === 0 ? true : `漂移：${show(bad)}`;
  });

  await ck("矩阵：widget×type 合法；number 带值域且默认在域内", async () => {
    const bad = [];
    for (const f of FIELDS) {
      const w = f.widget || DEFAULT_WIDGET[f.type];
      const allowed = WIDGET_MATRIX[f.type];
      if (!allowed || allowed.indexOf(w) < 0) {
        bad.push([f.key, `type=${f.type} widget=${w}`]);
        continue;
      }
      if (f.type === "number") {
        const d = parseInt(String(f.default), 10);
        if (f.min === undefined || f.max === undefined) bad.push([f.key, "缺 min/max"]);
        else if (!(f.min <= d && d <= f.max)) bad.push([f.key, `默认 ${d} 出域 [${f.min},${f.max}]`]);
      }
    }
    return bad.length === 0 ? true : `问题项：${show(bad)}`;
  });

  await ck("凭据项保留 helperScript（一键复制取 Cookie 的脚本）", async () => {
    const f = byKey("authCookie");
    return f && f.helperScript && f.helperLabel
      ? true
      : `authCookie 的 helper 字段缺失：${show([f && f.helperScript, f && f.helperLabel])}`;
  });

  await ck("去广告规则项自带格式说明（预设按钮移除后的替代指引）", async () => {
    const f = byKey("adRulesExtra");
    const d = (f && f.description) || "";
    const keys = ["keepPath", "dropPath", "dropHosts"].filter((k) => d.indexOf(k) < 0);
    return keys.length === 0 ? true : `描述里缺规则键：${show(keys)}`;
  });
}

// ---------------------------------------------------------------------------
// 5. 产物形态：表单是唯一设置面，产物零 SDK 运行时
// ---------------------------------------------------------------------------
{
  await ck("产物：manifest 无 main 入口、无 contributes.views", async () => {
    const bad = [];
    if (MANIFEST.main !== undefined) bad.push("main");
    if (MANIFEST.contributes !== undefined) bad.push("contributes");
    return bad.length === 0 ? true : `仍声明 ${show(bad)}（表单必须是唯一设置面）`;
  });

  await ck("产物：dist/manifest.json 与根清单一致", async () => {
    const a = readFileSync(join(DIST, "manifest.json"), "utf8");
    const b = readFileSync(join(ROOT, "manifest.json"), "utf8");
    return a === b ? true : "两份 manifest 内容不同（构建后忘了拷贝？）";
  });

  await ck("产物：入口与 config.json 映射一致，且没有 main.js", async () => {
    const cfg = JSON.parse(readFileSync(join(ROOT, "fluxdown-plugin.config.json"), "utf8"));
    const want = Object.keys(cfg.entries).sort();
    const got = readdirSync(DIST).filter((f) => f.endsWith(".js")).sort();
    return eq(got, want, "dist 入口");
  });

  // 红线 #3 的新形态：视图删除后任何入口都不许再引入 SDK 运行时。
  // 这条断言守的是「禁令不得被悄悄打破」——有人写了 JSX，jsx-runtime 就会被
  // 内联进产物，AGPL 面积随之扩大。
  await ck("例外边界：全部入口零 SDK 运行时（jsx 运行时不再有例外）", async () => {
    const marker = "#fragment";
    const files = readdirSync(DIST).filter((f) => f.endsWith(".js"));
    if (!files.length) return "dist 里没有入口产物";
    const leaked = files.filter((f) => readFileSync(join(DIST, f), "utf8").includes(marker));
    return leaked.length === 0 ? true : `${leaked.join(", ")} 内联了 jsx 运行时（红线 #3：全部入口禁止）`;
  });
}

console.log(`\n${pass}/${pass + fail} 项设置表单契约通过`);
if (fail) {
  console.error(`\n${fail} 项未通过 —— 设置表单的声明或产物不符合预期。`);
  process.exit(1);
}
