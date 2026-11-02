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

/** 开关段：连续排在一起 11 个 boolean，宿主把它们并成一张卡片。顺序即卡片内顺序。 */
const TOGGLE_KEYS = [
  "solveChallenge", "followIframe", "detectDash", "detectSeries", "htmlFallbackYtdlp",
  "autoPick", "useYtdlp", "audioOnly", "remuxToMp4", "fixMuxFallback", "ephemeral",
];

/**
 * 站点段：`targetHosts` 与 `authCookie`，排在最前。
 *
 * 为什么在最前：这两项决定「插件在哪些站生效、用什么身份」，是用户配置的第一步；
 * 而它们彼此相关（`targetHosts` 还是凭据的缺省站点范围），放在一起才能看出关系。
 *
 * 宿主只把**连续开关**合并成一张卡片（`plugin_settings.rs:442` 的 option_group），
 * 非开关字段一律逐个渲染、彼此分隔 —— 所以这两项做不成「一张卡片」，只能做到
 * 「排在最前、相邻、形成可见的开头区块」。这是声明式表单的能力上限，不是取舍。
 */
const SITE_KEYS = ["targetHosts", "authCookie"];

/** 去广告段：紧随开关之后，让「要不要去广告、怎么去」连在一起。 */
const AD_KEYS = ["adRulesMode", "adRulesExtra"];

/** 其余参数段的主题序列（同主题连续，顺序即渲染顺序）。 */
const THEMES = ["画质", "音轨", "命名", "网络", "解析", "剧集", "下载"];

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
// 1. 声明结构：站点段 → 开关段 → 去广告段 → 参数段
// ---------------------------------------------------------------------------
{
  await ck("结构：共 27 项且 key 唯一", async () => {
    const keys = FIELDS.map((f) => f.key);
    const uniq = new Set(keys);
    if (uniq.size !== keys.length) return `key 重复：${show(keys)}`;
    return eq(keys.length, 27, "设置项数");
  });

  await ck("结构：站点两项排最前（生效范围 → 登录凭据）", async () => {
    return eq(FIELDS.slice(0, SITE_KEYS.length).map((f) => f.key), SITE_KEYS, "前 2 项");
  });

  await ck("结构：11 个开关连续成段（宿主才并得成一张卡片）", async () => {
    const start = SITE_KEYS.length;
    const head = FIELDS.slice(start, start + TOGGLE_KEYS.length).map((f) => f.key);
    const r = eq(head, TOGGLE_KEYS, "开关段");
    if (r !== true) return r;
    const tail = FIELDS.slice(start + TOGGLE_KEYS.length);
    const leaked = tail.filter((f) => f.type === "boolean").map((f) => f.key);
    return leaked.length === 0 ? true : `开关段之外还有 boolean：${show(leaked)}`;
  });

  await ck("结构：去广告两项紧随开关段", async () => {
    const start = SITE_KEYS.length + TOGGLE_KEYS.length;
    return eq(FIELDS.slice(start, start + AD_KEYS.length).map((f) => f.key), AD_KEYS, "去广告段");
  });

  await ck("结构：其余参数按主题聚簇（同主题连续，不交错）", async () => {
    const rest = FIELDS.slice(SITE_KEYS.length + TOGGLE_KEYS.length + AD_KEYS.length);
    const runs = [];
    for (const t of rest.map((f) => f.title.split(" · ")[0])) {
      if (runs[runs.length - 1] !== t) runs.push(t);
    }
    return eq(runs, THEMES, "主题序列");
  });

  await ck("结构：每项都有非空 title 与 description（不留无说明的裸字段）", async () => {
    const bad = FIELDS.filter((f) => !f.title || !f.description);
    return bad.length === 0 ? true : `缺 title/description：${show(bad.map((f) => f.key))}`;
  });
}

// ---------------------------------------------------------------------------
// 2. 主题前缀：「主题 · 项目」是平铺表单里唯一的分类路标
//
// 站点段与去广告段各有自己的分组方式（排在最前 / 紧随开关），标题仍走主题前缀，
// 因此它们也计入前缀断言 —— 前缀是**唯一**的分类路标，一处失效整张表单就失去结构。
// ---------------------------------------------------------------------------
{
  const PREFIXED = FIELDS.filter((f) => f.type !== "boolean");
  await ck("前缀：16 个非开关项标题全部符合「主题 · 项目」", async () => {
    const bad = PREFIXED.filter((f) => !/^[^ ·]+ · \S/.test(f.title));
    return bad.length === 0 ? true : `格式不合规：${show(bad.map((f) => [f.key, f.title]))}`;
  });

  await ck("前缀：主题取自白名单且全覆盖（站点在最前、去广告紧随开关）", async () => {
    const got = [...new Set(PREFIXED.map((f) => f.title.split(" · ")[0]))];
    return eq(got, ["站点", "去广告", ...THEMES], "主题集合（按首次出现顺序）");
  });
}

// ---------------------------------------------------------------------------
// 3. 默认值（方案A）：与 settings.ts 的读取兜底双向钉死
// ---------------------------------------------------------------------------
{
  // 缺 `default` 键 ≠ 默认空串。引擎侧 value_of() 走
  // `values.get(key).or_else(|| field.default)` → 两边都没有就是 None，
  // build_typed_settings_json 对 string 产出 Null，插件侧 flux.settings[k] 拿到
  // null，而 src/lib/settings.ts 的 str() 用 String(v) 把它变成 "null" ——
  // 一个合法的「主机名」。targetHosts 因此会把生效范围锁成名为 null 的站点，
  // 所有播放页都不处理。宿主表单却回显空串（plugin_settings.rs:102 的
  // 兜底），界面看不出异常。这条断言就是堵「测试绿、运行时崩」的缝。
  await ck("默认值：27 项都显式声明了 default（缺键会让运行时拿到 null）", async () => {
    const bad = FIELDS.filter((f) => !("default" in f)).map((f) => f.key);
    return bad.length === 0
      ? true
      : `缺 default 键：${show(bad)}（引擎会回落到 null，str() 再变成 "null"）`;
  });

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
