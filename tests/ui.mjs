/**
 * 视图契约测试 —— 设置页签「插件设置」（`.agents/adr/0005` 起用 JSX 渲染）。
 *
 * 为什么单独一层：视图是**新增入口**（v1.8.0 与 M1–M4 都没有 `main` 脚本），没有「等价」可比；
 * 而它出错的方式又与下载无关 —— 树不合 schema、key 重名、受控输入没写回 state，任何一条
 * 都会让用户看到错误条或点了没反应，却不会体现在下载结果里。这里直接断言「现在应该是什么样」：
 *
 *   1. manifest 声明的视图，`main` 必须真的注册了（少一个，客户端打开就是 `view not registered`）。
 *   2. 渲染树符合引擎 schema：根是节点、子节点只能是节点、kind 在允许集合内、
 *      文本类属性必须是字符串、节点数与深度在限内、**同级 key 不重复**。
 *   3. 规则校验与拦截器同源：语法错拦住保存；非法正则/未知键只警告；`off` 模式下不拦。
 *   4. 保存只写**改动过的**键、值都是字符串；失败不改已保存快照，错误原文透传。
 *   5. `main` 不做越界的事：不 fetch、不读 storage、不注册命令/事件。
 *
 * 用法：npm run ui          （需先 npm run build）
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runEntry, show } from "./parity/harness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const DIST = process.env.UI_DIST || join(ROOT, "dist");

const VIEW_ID = "ad-rules";

/** 引擎允许的 26 种节点（`ViewKind`）。写错的标签在运行时是「未知节点」，这里提前拦下。 */
const KINDS = new Set([
  "stack", "scroll", "card", "section", "divider", "text", "heading", "markdown", "code",
  "link", "image", "badge", "progress", "spinner", "kv", "callout", "empty", "button",
  "switch", "checkbox", "select", "input", "textarea", "tabs", "table", "list",
]);

/** 这些节点的这些属性直接进渲染，传数字会被引擎拒绝（「要求字符串的属性必须传字符串」）。 */
const STRING_PROPS = {
  text: ["text"],
  heading: ["text"],
  markdown: ["text"],
  code: ["text"],
  link: ["text", "href"],
  badge: ["text"],
  callout: ["text", "title"],
  empty: ["title", "description"],
  button: ["text"],
  section: ["title", "description"],
  card: ["title"],
  image: ["src"],
};

const MAX_NODES = 5000;
const MAX_DEPTH = 64;

/**
 * 按引擎规则检查一棵树，返回问题清单（空数组 = 合法）。
 * 断言强度刻意贴近 daemon 的校验，而不是「看起来对就行」。
 */
function checkTree(root) {
  const problems = [];
  let count = 0;

  const isNode = (n) =>
    n && typeof n === "object" && !Array.isArray(n) && typeof n.k === "string" && n.p && typeof n.p === "object" && Array.isArray(n.c);

  const walk = (node, path, depth) => {
    if (depth > MAX_DEPTH) {
      problems.push(`${path} 嵌套深度超过 ${MAX_DEPTH}`);
      return;
    }
    if (!isNode(node)) {
      problems.push(`${path} 不是节点（得到 ${show(node)}）`);
      return;
    }
    count++;
    if (!KINDS.has(node.k)) problems.push(`${path} 的 kind '${node.k}' 不在允许集合内`);

    for (const prop of STRING_PROPS[node.k] || []) {
      if (node.p[prop] !== undefined && typeof node.p[prop] !== "string") {
        problems.push(`${path} 的 ${prop} 必须是字符串，实际 ${typeof node.p[prop]}（${show(node.p[prop])}）`);
      }
    }

    // 同级 key 必须唯一，且任何会触发事件的节点都要有 key。
    const seen = new Set();
    for (const c of node.c) {
      if (!isNode(c)) {
        problems.push(`${path} 的子节点里有非节点值：${show(c)}`);
        continue;
      }
      const k = c.p && c.p.key;
      if (k !== undefined) {
        if (seen.has(k)) problems.push(`${path} 下 key '${k}' 重复`);
        seen.add(k);
      }
    }

    node.c.forEach((c, i) => {
      if (!isNode(c)) return;
      const k = c.p && c.p.key !== undefined ? c.p.key : i;
      walk(c, `${path}/${k}`, depth + 1);
    });
  };

  walk(root, "root", 0);
  if (count > MAX_NODES) problems.push(`节点数 ${count} 超过上限 ${MAX_NODES}`);
  return problems;
}

/** 找出某个 key 对应的完整节点 id（`root/…/save`），用来构造真实事件。 */
function nodeId(root, targetKey) {
  let found = null;
  const walk = (node, id) => {
    if (found) return;
    if (node.p && node.p.key === targetKey) {
      found = id;
      return;
    }
    node.c.forEach((c, i) => {
      const k = c.p && c.p.key !== undefined ? c.p.key : i;
      walk(c, `${id}/${k}`);
    });
  };
  walk(root, "root");
  return found;
}

/** 收集树里所有 callout 的 tone + text，便于断言「页面在说什么」。 */
function callouts(node, out = []) {
  if (node.k === "callout") out.push({ tone: node.p.tone || "info", text: String(node.p.text || ""), title: node.p.title });
  for (const c of node.c) callouts(c, out);
  return out;
}

function textOf(node, out = []) {
  if (node.k === "text" && node.p.text) out.push(String(node.p.text));
  for (const c of node.c) textOf(c, out);
  return out;
}

/** 收集某类控件节点的 props（顺序即树的遍历顺序）。 */
function controls(tree, kind, out = []) {
  if (tree.k === kind) out.push(tree.p);
  for (const c of tree.c) controls(c, kind, out);
  return out;
}

/** 按 key 取某个控件的 props。 */
const byKey = (tree, kind, key) => controls(tree, kind).filter((c) => c.key === key)[0];

const mkCtx = () => ({
  session: "s1",
  props: {},
  taskId: null,
  locale: "zh-CN",
  refresh() {},
  close() {},
  navigate: async () => {},
});

/** 用真实节点 id 构造事件；id 必须能在树里找到，否则是 key 写错了。 */
function evOf(tree, key, type, value) {
  const id = nodeId(tree, key);
  if (!id) throw new Error(`树里找不到 key '${key}'（按钮点了不会有反应的那种错）`);
  const ev = { node: id, type };
  if (type === "change") ev.value = value;
  return ev;
}

const press = (tree, key) => evOf(tree, key, "press");
const change = (tree, key, value) => evOf(tree, key, "change", value);

/** 打开视图：加载 dist/main.js，取回注册的定义。 */
async function open(sc = {}) {
  const r = await runEntry(DIST, {
    entry: "main",
    main: true,
    settings: sc.settings || {},
    updateError: sc.updateError,
    steps: () => null,
  });
  if (r.loadError) throw new Error(r.loadError);
  if (r.error) throw new Error(`main 抛错：${r.error}`);
  return r;
}

/** 打开 + init + 首帧渲染。 */
async function openView(sc = {}) {
  const r = await open(sc);
  const def = r.views[VIEW_ID];
  if (!def) throw new Error(`未注册视图 '${VIEW_ID}'（已注册：${Object.keys(r.views).join(", ") || "无"}）`);
  const ctx = mkCtx();
  const state = def.init ? await def.init(ctx) : {};
  const tree = await def.render(state, ctx);
  const run = async (ev) => {
    await def.event(state, ev, ctx);
    return def.render(state, ctx);
  };
  return { ...r, def, ctx, state, tree, run };
}

let pass = 0;
let fail = 0;
const failures = [];

async function ck(name, fn) {
  try {
    const r = await fn();
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
    const d = String((e && e.message) || e);
    failures.push({ name, detail: d });
    console.log(`  FAIL ${name}`);
    console.log(`         ${d}`);
  }
}

const eq = (actual, expected, label) =>
  JSON.stringify(actual) === JSON.stringify(expected)
    ? true
    : `${label || "值"}不符：期望 ${show(expected)}，实际 ${show(actual)}`;

const updates = (r) => r.liveCalls.filter((c) => c[0] === "settings.update");

// ---------------------------------------------------------------------------
// 1. 声明与注册一致
// ---------------------------------------------------------------------------
{
  const manifest = JSON.parse(readFileSync(join(DIST, "manifest.json"), "utf8"));
  const declared = ((manifest.contributes && manifest.contributes.views) || []).map((v) => v.id);

  await ck("声明：manifest 声明了 ad-rules 视图", () =>
    declared.indexOf(VIEW_ID) >= 0 ? true : `声明的是 ${show(declared)}`);

  await ck("声明：manifest 的 main.entry 指向存在的脚本", () => {
    const entry = manifest.main && manifest.main.entry;
    if (entry !== "main.js") return `main.entry = ${show(entry)}`;
    try {
      readFileSync(join(DIST, entry));
      return true;
    } catch {
      return `${entry} 不在 dist/ 里`;
    }
  });

  await ck("注册：main 注册的视图覆盖全部声明", async () => {
    const r = await open();
    const registered = Object.keys(r.views);
    const missing = declared.filter((id) => registered.indexOf(id) < 0);
    return missing.length ? `未注册：${show(missing)}` : true;
  });

  await ck("注册：没有注册未声明的视图", async () => {
    const r = await open();
    const extra = Object.keys(r.views).filter((id) => declared.indexOf(id) < 0);
    return extra.length ? `多注册了：${show(extra)}` : true;
  });

  await ck("位置：视图的 location 是 settings 且只有一个", () => {
    const views = (manifest.contributes && manifest.contributes.views) || [];
    const settingsViews = views.filter((v) => v.location === "settings");
    return settingsViews.length === 1 ? true : `有 ${settingsViews.length} 个 settings 视图（至多一个）`;
  });

  await ck("权限：没有为视图引入新权限", () => {
    const perms = manifest.permissions || [];
    return perms.indexOf("desktop") < 0 && perms.indexOf("background") < 0
      ? true
      : `不该出现 desktop/background：${show(perms)}`;
  });
}

// ---------------------------------------------------------------------------
// 2. 渲染树合法
// ---------------------------------------------------------------------------
{
  await ck("渲染：首帧通过 schema 校验", async () => {
    const v = await openView({ settings: { adRulesMode: "marker", adRulesExtra: "" } });
    const p = checkTree(v.tree);
    return p.length ? p.join("；") : true;
  });

  await ck("渲染：根节点有 heading，能看出这是什么页", async () => {
    const v = await openView();
    const heads = [];
    const walk = (n) => {
      if (n.k === "heading") heads.push(n.p.text);
      n.c.forEach(walk);
    };
    walk(v.tree);
    return heads.some((t) => /插件设置/.test(t)) ? true : `heading：${show(heads)}`;
  });

  await ck("渲染：三档模式选项齐全且 value 合法", async () => {
    const v = await openView({ settings: { adRulesMode: "heuristic" } });
    const sel = byKey(v.tree, "select", "adRulesMode");
    if (!sel) return "树里没有 adRulesMode 的 select";
    const values = sel.options.map((o) => o.value);
    return eq(values, ["off", "marker", "heuristic"], "模式选项") === true && sel.value === "heuristic"
      ? true
      : `当前值 ${show(sel.value)}，选项 ${show(values)}`;
  });

  await ck("渲染：设置值非法时回退 off（不让 select 出现不存在的 value）", async () => {
    const v = await openView({ settings: { adRulesMode: "bogus" } });
    const sel = byKey(v.tree, "select", "adRulesMode");
    return sel && sel.value === "off" ? true : `value = ${show(sel && sel.value)}`;
  });

  await ck("渲染：节点数与深度在引擎限制内", async () => {
    const v = await openView({ settings: { adRulesMode: "marker" } });
    let n = 0;
    let maxDepth = 0;
    const walk = (node, d) => {
      n++;
      if (d > maxDepth) maxDepth = d;
      node.c.forEach((c) => walk(c, d + 1));
    };
    walk(v.tree, 0);
    return n < 5000 && maxDepth < 64 ? true : `节点 ${n}，深度 ${maxDepth}`;
  });

  await ck("渲染：每个预设都有按钮，且按钮 key 全局唯一", async () => {
    const v = await openView();
    const buttons = [];
    const walk = (n) => {
      if (n.k === "button") buttons.push(n.p.key);
      n.c.forEach(walk);
    };
    walk(v.tree);
    const uniq = new Set(buttons);
    if (uniq.size !== buttons.length) return `key 重复：${show(buttons)}`;
    // 5 个预设 + 保存 + 还原
    return buttons.length === 7 ? true : `按钮 ${buttons.length} 个：${show(buttons)}`;
  });
}

// ---------------------------------------------------------------------------
// 2b. 大众 / 专业两档
// ---------------------------------------------------------------------------
{
  const hasPick = (tree, kind, key) => !!byKey(tree, kind, key);

  await ck("分档：默认只显示常用项，专业项不出现", async () => {
    const v = await openView({ settings: { expertMode: false } });
    const leaked = ["targetHosts", "episodeLinkPattern", "rangeCapKb", "preferCodec"].filter((k) =>
      hasPick(v.tree, "input", k) || hasPick(v.tree, "select", k),
    );
    return leaked.length === 0 ? true : `专业项漏出来了：${show(leaked)}`;
  });

  await ck("分档：打开专业设置后专业项出现", async () => {
    const v = await openView({ settings: { expertMode: true } });
    const need = ["targetHosts", "episodeLinkPattern", "rangeCapKb"];
    const missing = need.filter((k) => !hasPick(v.tree, "input", k));
    return missing.length === 0 ? true : `仍缺：${show(missing)}`;
  });

  await ck("分档：开关本身在树里，且反映 expertMode", async () => {
    const off = await openView({ settings: { expertMode: false } });
    const on = await openView({ settings: { expertMode: true } });
    const a = byKey(off.tree, "switch", "expertMode");
    const b = byKey(on.tree, "switch", "expertMode");
    return a && b && a.checked === false && b.checked === true
      ? true
      : `off=${show(a && a.checked)} on=${show(b && b.checked)}`;
  });

  await ck("分档：点开关立即展开，不等保存", async () => {
    const v = await openView({ settings: { expertMode: false } });
    const next = await v.run(change(v.tree, "expertMode", true));
    if (!hasPick(next, "input", "targetHosts")) return "展开后仍看不到 targetHosts";
    return v.state.draft.expertMode === "true" ? true : `草稿 expertMode=${show(v.state.draft.expertMode)}`;
  });

  await ck("分档：每个 select 的当前值都在自己的 options 里（防视图与 manifest 漂移）", async () => {
    const v = await openView({ settings: { expertMode: true } });
    // 空串表示这项没被赋值（真实宿主会按 manifest 的 default 填），不算漂移；
    // 除此之外的值必须出现在视图硬编码的 options 里，否则保存后宿主会把它当非法值处理。
    const bad = controls(v.tree, "select").filter(
      (s) => s.value !== "" && s.options.map((o) => o.value).indexOf(s.value) < 0,
    );
    return bad.length === 0 ? true : `值不在选项内：${show(bad.map((s) => [s.key, s.value]))}`;
  });

  await ck("分档：专业项数量与 manifest 声明一致", async () => {
    // 视图里硬编码了分组与 key，manifest 改键名而视图没跟上 ⇒ 用户改完保存收到「未知设置项」。
    const manifest = JSON.parse(readFileSync(join(DIST, "manifest.json"), "utf8"));
    const declared = manifest.settings.map((s) => s.key);
    const v = await openView({ settings: { expertMode: true } });
    const rendered = [
      ...controls(v.tree, "input").map((c) => c.key),
      ...controls(v.tree, "select").map((c) => c.key),
      ...controls(v.tree, "textarea").map((c) => c.key),
      ...controls(v.tree, "switch").map((c) => c.key),
    ];
    const missing = declared.filter((k) => rendered.indexOf(k) < 0);
    return missing.length === 0 ? true : `manifest 有、页面没有：${show(missing)}`;
  });
}

// ---------------------------------------------------------------------------
// 3. 规则校验（与拦截器同源）
// ---------------------------------------------------------------------------
{
  const noDanger = (tree) => callouts(tree).filter((c) => c.tone === "danger");
  const warns = (tree) => callouts(tree).filter((c) => c.tone === "warning");

  await ck("校验：空规则不显示任何提示条", async () => {
    const v = await openView({ settings: { adRulesMode: "marker", adRulesExtra: "" } });
    const all = callouts(v.tree);
    return all.length === 0 ? true : `出现 ${show(all)}`;
  });

  await ck("校验：合法规则显示「解析通过」", async () => {
    const v = await openView({
      settings: { adRulesMode: "marker", adRulesExtra: '{"dropPath":["/ads/"]}' },
    });
    const ok = callouts(v.tree).filter((c) => c.tone === "success");
    return ok.length === 1 && /通过/.test(ok[0].text) ? true : `提示：${show(callouts(v.tree))}`;
  });

  await ck("校验：JSON 语法错 → 拦住保存的 danger", async () => {
    const v = await openView({ settings: { adRulesMode: "marker", adRulesExtra: "{not json" } });
    const d = noDanger(v.tree);
    return d.length === 1 && /JSON 语法错误/.test(d[0].text) ? true : `danger：${show(d)}`;
  });

  await ck("校验：顶层是数组 → 拦住（必须是对象）", async () => {
    const v = await openView({ settings: { adRulesMode: "marker", adRulesExtra: '["/ads/"]' } });
    const d = noDanger(v.tree);
    return d.length === 1 && /顶层必须是 JSON 对象/.test(d[0].text) ? true : `danger：${show(d)}`;
  });

  await ck("校验：未知键（dropPaths）→ 警告并点名", async () => {
    const v = await openView({ settings: { adRulesMode: "marker", adRulesExtra: '{"dropPaths":["/ads/"]}' } });
    const w = warns(v.tree);
    return w.length === 1 && /dropPaths/.test(w[0].text) ? true : `warning：${show(w)}`;
  });

  await ck("校验：非法正则 → 警告（运行时容错跳过，不拦保存）", async () => {
    const v = await openView({ settings: { adRulesMode: "marker", adRulesExtra: '{"dropPath":["/ads("]}' } });
    const w = warns(v.tree);
    const d = noDanger(v.tree);
    return w.length === 1 && d.length === 0 ? true : `warning ${show(w)} / danger ${show(d)}`;
  });

  await ck("校验：off 模式下语法错不拦保存（只是警告）", async () => {
    const v = await openView({ settings: { adRulesMode: "off", adRulesExtra: "{bad" } });
    const d = noDanger(v.tree);
    const w = warns(v.tree);
    return d.length === 0 && w.length === 1 && /不生效/.test(w[0].text) ? true : `danger ${show(d)} / warning ${show(w)}`;
  });

  await ck("校验：生效条数写进 kv", async () => {
    const v = await openView({
      settings: { adRulesMode: "marker", adRulesExtra: '{"keepPath":["/ep1/"],"dropHosts":["ads.test"]}' },
    });
    const texts = textOf(v.tree).join(" ");
    return /白名单 1 条/.test(texts) && /广告主机 1 个/.test(texts)
      ? true
      : `正文里没有条数摘要：${show(texts.slice(0, 300))}`;
  });
}

// ---------------------------------------------------------------------------
// 4. 交互：受控输入必须写回 state
// ---------------------------------------------------------------------------
{
  await ck("交互：切换模式写回 state 并反映到下一帧", async () => {
    const v = await openView({ settings: { adRulesMode: "off" } });
    const next = await v.run(change(v.tree, "adRulesMode", "heuristic"));
    if (v.state.draft.adRulesMode !== "heuristic") return `草稿 = ${show(v.state.draft.adRulesMode)}`;
    const sel = byKey(next, "select", "adRulesMode");
    return sel && sel.value === "heuristic" ? true : `下一帧 select.value = ${show(sel && sel.value)}`;
  });

  await ck("交互：模式值非法时按 off 处理", async () => {
    const v = await openView({ settings: { adRulesMode: "marker" } });
    await v.run(change(v.tree, "adRulesMode", "whatever"));
    return v.state.draft.adRulesMode === "off" ? true : `state.mode = ${show(v.state.draft.adRulesMode)}`;
  });

  await ck("交互：编辑规则文本写回 state，并立刻重新校验", async () => {
    const v = await openView({ settings: { adRulesMode: "marker", adRulesExtra: "" } });
    const next = await v.run(change(v.tree, "adRulesExtra", "{oops"));
    if (v.state.draft.adRulesExtra !== "{oops") return `state.extra = ${show(v.state.draft.adRulesExtra)}`;
    const d = callouts(next).filter((c) => c.tone === "danger");
    return d.length === 1 ? true : `danger ${show(d)}`;
  });

  await ck("交互：未保存时「保存」按钮从禁用变为可用", async () => {
    const v = await openView({ settings: { adRulesMode: "marker", adRulesExtra: "" } });
    const disabledOf = (tree, key) => {
      const out = [];
      const walk = (n) => {
        if (n.k === "button" && n.p.key === key) out.push(!!n.p.disabled);
        n.c.forEach(walk);
      };
      walk(tree);
      return out[0];
    };
    const before = disabledOf(v.tree, "save");
    const next = await v.run(change(v.tree, "adRulesMode", "heuristic"));
    const after = disabledOf(next, "save");
    return before === true && after === false ? true : `保存前 ${before}，改动后 ${after}`;
  });

  await ck("交互：套用「广告目录过滤」预设 → mode 与规则文本同时更新", async () => {
    const v = await openView({ settings: { adRulesMode: "off", adRulesExtra: "" } });
    const next = await v.run(press(v.tree, "apply-dirs"));
    if (v.state.draft.adRulesMode !== "heuristic") return `state.mode = ${show(v.state.draft.adRulesMode)}`;
    const parsed = JSON.parse(v.state.draft.adRulesExtra);
    if (!/\/ads\?\//.test(parsed.dropPath.join(","))) return `dropPath = ${show(parsed.dropPath)}`;
    const ok = callouts(next).filter((c) => c.tone === "danger");
    return ok.length === 0 ? true : `预设本身不该产生 danger：${show(ok)}`;
  });

  await ck("交互：套用「关闭」预设清空规则文本", async () => {
    const v = await openView({ settings: { adRulesMode: "marker", adRulesExtra: '{"dropPath":["/ads/"]}' } });
    await v.run(press(v.tree, "apply-off"));
    return v.state.draft.adRulesMode === "off" && v.state.draft.adRulesExtra === "" ? true : `mode ${show(v.state.draft.adRulesMode)} extra ${show(v.state.draft.adRulesExtra)}`;
  });

  await ck("交互：还原回到已保存的值", async () => {
    const v = await openView({ settings: { adRulesMode: "marker", adRulesExtra: '{"dropPath":["/x/"]}' } });
    await v.run(change(v.tree, "adRulesMode", "heuristic"));
    await v.run(change(v.tree, "adRulesExtra", "{broken"));
    await v.run(press(v.tree, "reset"));
    return v.state.draft.adRulesMode === "marker" && v.state.draft.adRulesExtra === '{"dropPath":["/x/"]}'
      ? true
      : `mode ${show(v.state.draft.adRulesMode)} extra ${show(v.state.draft.adRulesExtra)}`;
  });

  await ck("交互：未知 key 的事件不改变 state（不崩）", async () => {
    const v = await openView({ settings: { adRulesMode: "marker" } });
    await v.run({ node: "root/nope", type: "press" });
    await v.run({ node: "root/nope", type: "change", value: "x" });
    return v.state.draft.adRulesMode === "marker" && v.state.draft.adRulesExtra === "" ? true : `state 被改坏了：${show(v.state)}`;
  });
}

// ---------------------------------------------------------------------------
// 5. 保存
// ---------------------------------------------------------------------------
{
  await ck("保存：只写两个键，且值都是字符串", async () => {
    const v = await openView({ settings: { adRulesMode: "off", adRulesExtra: "" } });
    await v.run(change(v.tree, "adRulesMode", "heuristic"));
    await v.run(change(v.tree, "adRulesExtra", '{"dropPath":["/ads/"]}'));
    await v.run(press(v.tree, "save"));
    const u = updates(v);
    if (u.length !== 1) return `update 调用了 ${u.length} 次`;
    const payload = u[0][1];
    if (JSON.stringify(Object.keys(payload).sort()) !== JSON.stringify(["adRulesExtra", "adRulesMode"])) {
      return `键不对：${show(Object.keys(payload))}`;
    }
    const bad = Object.keys(payload).filter((k) => typeof payload[k] !== "string");
    return bad.length === 0 ? true : `非字符串值：${show(bad.map((k) => [k, typeof payload[k]]))}`;
  });

  await ck("保存：成功后 saved* 同步，未保存标记消失", async () => {
    const v = await openView({ settings: { adRulesMode: "off", adRulesExtra: "" } });
    await v.run(change(v.tree, "adRulesMode", "marker"));
    const next = await v.run(press(v.tree, "save"));
    if (v.state.saved.adRulesMode !== "marker") return `savedMode = ${show(v.state.saved.adRulesMode)}`;
    const hints = textOf(next);
    return hints.some((t) => /与已保存的值一致/.test(t)) ? true : `提示：${show(hints)}`;
  });

  await ck("保存：语法错时不调用 update，并给出 danger", async () => {
    const v = await openView({ settings: { adRulesMode: "marker", adRulesExtra: "" } });
    await v.run(change(v.tree, "adRulesExtra", "{broken"));
    const next = await v.run(press(v.tree, "save"));
    const u = updates(v);
    if (u.length !== 0) return `不该调用 update，实际 ${show(u)}`;
    const d = callouts(next).filter((c) => c.tone === "danger");
    return d.length >= 1 && /未保存/.test(d[d.length - 1].text) ? true : `danger ${show(d)}`;
  });

  await ck("保存：off 模式下语法错仍然允许保存", async () => {
    const v = await openView({ settings: { adRulesMode: "off", adRulesExtra: "" } });
    await v.run(change(v.tree, "adRulesExtra", "{broken"));
    await v.run(press(v.tree, "save"));
    return updates(v).length === 1 ? true : "off 模式被拦住了 —— 用户会没法先关掉再慢慢改";
  });

  await ck("保存：宿主拒绝时原文透传且 saved* 不变", async () => {
    const v = await openView({
      settings: { adRulesMode: "marker", adRulesExtra: "" },
      updateError: "'adRulesExtra' 不是合法的 JSON",
    });
    await v.run(change(v.tree, "adRulesMode", "heuristic"));
    const next = await v.run(press(v.tree, "save"));
    if (v.state.saved.adRulesMode !== "marker") return `savedMode 被改成了 ${show(v.state.saved.adRulesMode)}`;
    const d = callouts(next).filter((c) => c.tone === "danger");
    return d.length === 1 && /不是合法的 JSON/.test(d[0].text) ? true : `danger ${show(d)}`;
  });
}

// ---------------------------------------------------------------------------
// 6. main 不越界
// ---------------------------------------------------------------------------
{
  await ck("越界：main 不发请求、不读 storage、不碰 ffmpeg", async () => {
    const v = await openView({ settings: { adRulesMode: "marker", adRulesExtra: '{"dropPath":["/ads/"]}' } });
    await v.run(change(v.tree, "adRulesMode", "heuristic"));
    await v.run(press(v.tree, "apply-guard"));
    await v.run(press(v.tree, "save"));
    const bad = v.liveCalls.filter((c) => c[0] === "fetch" || c[0] === "storage.get" || c[0] === "storage.set" || /ffmpeg|ytdlp|ffprobe/.test(String(c[0])));
    return bad.length === 0 ? true : `发生了 ${show(bad)}`;
  });

  await ck("越界：没有多余的命令 / rpc / 事件订阅", async () => {
    const v = await openView();
    const extra = v.liveCalls.filter((c) => /^(commands\.|rpc\.|events\.)/.test(String(c[0])));
    return extra.length === 0 ? true : `注册了 ${show(extra)}`;
  });

  await ck("越界：只注册一次视图（重复求值不会重复注册）", async () => {
    const v = await openView();
    const regs = v.liveCalls.filter((c) => c[0] === "ui.view");
    return regs.length === 1 ? true : `ui.view 调用了 ${regs.length} 次`;
  });

  // ADR-0005 的红线：SDK 运行时只允许出现在 main.js。这条断言守的是「例外不得扩大」——
  // 有人给别的入口写了 JSX，jsx-runtime 就会被内联进那个产物，AGPL 面积随之变大。
  await ck("例外边界：jsx 运行时只在 main.js，其他入口零 SDK 运行时", async () => {
    const marker = "#fragment";
    const mainSrc = readFileSync(join(DIST, "main.js"), "utf8");
    if (!mainSrc.includes(marker)) return "main.js 里找不到 jsx 运行时，视图会在运行时崩";
    // 入口清单从产物目录取，而不是硬编码：删/加入口时这条断言不该跟着改，
    // 否则「忘了同步」会被误读成「没有泄漏」。
    const others = readdirSync(DIST).filter((f) => f.endsWith(".js") && f !== "main.js");
    if (!others.length) return "产物里没有其他入口，断言失去意义";
    const leaked = others.filter((f) => readFileSync(join(DIST, f), "utf8").includes(marker));
    return leaked.length === 0 ? true : `${leaked.join(", ")} 也内联了 jsx 运行时（ADR-0005 的例外不得扩大）`;
  });
}

console.log(`\n${pass}/${pass + fail} 项视图契约通过`);
if (fail) {
  console.error(`\n${fail} 项未通过 —— 设置页签的行为不符合预期。`);
  process.exit(1);
}
