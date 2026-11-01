/**
 * M1 回归比对工具：同一批 fixture 分别喂给
 *   ① 旧实现 tests/legacy/*.js（v1.8.0）
 *   ② 新构建产物 dist/*.js（TypeScript + SDK 工程化后）
 * 逐条比对「返回值 / 抛错信息 / 日志序列 / 宿主调用序列（fetch、ffmpeg、yt-dlp、auth）」。
 *
 * 判定标准：三者完全一致才算通过。任何差异都会打印出左右两边的第一处不同。
 *
 * 用法：npm run parity        （需先 npm run build）
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { scenarios } from "./parity/scenarios.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

const LEGACY = join(ROOT, "tests", "legacy");
// PARITY_DIST 仅供自检（喂一份故意改坏产物的副本，确认本工具真的能抓到差异）
const DIST = process.env.PARITY_DIST || join(ROOT, "dist");

const entryFile = (dir, name) => join(dir, `${name}.js`);

// ---------------------------------------------------------------------------
// 规范化：对象键序不影响判定，但值与数组顺序影响
// ---------------------------------------------------------------------------
function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === "object") {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = canon(v[k]);
    return o;
  }
  if (typeof v === "number" && !Number.isFinite(v)) return String(v);
  return v;
}

const stable = (v) => JSON.stringify(canon(v));

/** 抹掉时间戳（任务标记写入 Date.now()）——两次运行必然不同，不属于行为差异。 */
const scrubTs = (v) => JSON.parse(JSON.stringify(v === undefined ? null : v).replace(/\b1[6-9]\d{11}\b/g, "<ts>"));

// ---------------------------------------------------------------------------
// 假宿主：所有入口只通过 flux 门面与沙箱交互
// ---------------------------------------------------------------------------
function createFlux(sc) {
  const calls = [];
  const logs = [];
  const store = { ...(sc.store || {}) };
  const routes = sc.routes || {};

  const record = (level) => (...args) => logs.push([level, ...args.map((a) => (typeof a === "string" ? a : canon(a)))]);

  const flux = {
    settings: { ...(sc.settings || {}) },
    storage: {
      get: async (k) => {
        calls.push(["storage.get", k]);
        return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null;
      },
      set: async (k, v) => {
        calls.push(["storage.set", k, v]);
        store[k] = v;
      },
    },
    fs: {
      writeFile: async (n) => calls.push(["fs.writeFile", n]),
      readFile: async () => null,
      remove: async () => undefined,
      list: async () => [],
    },
    info: { identity: "m3u8-resolver@cocolight", version: "1.8.0", appVersion: "0.6.5" },
    logger: { info: record("info"), warn: record("warn"), error: record("error") },
    task: { requestRetry: () => undefined, recordArtifact: async (n) => calls.push(["task.recordArtifact", n]) },
    fetch: async (opts) => {
      calls.push(["fetch", opts.url, canon(opts.headers || {}), opts.method || "GET"]);
      const route = routes[opts.url];
      if (route === undefined) return { status: 404, headers: {}, body: "", truncated: false };
      const r = typeof route === "function" ? route(opts) : route;
      return { status: 200, headers: {}, body: "", truncated: false, ...r };
    },
  };

  if (sc.auth !== false) {
    const profiles = sc.profiles || {};
    flux.auth = {
      get: async (ref) => {
        calls.push(["auth.get", ref]);
        return Object.prototype.hasOwnProperty.call(profiles, ref) ? profiles[ref] : null;
      },
      save: async (p) => {
        calls.push(["auth.save", canon(p)]);
        return sc.saveRef || "m3u8-resolver@cocolight::https://site.test";
      },
      remove: async (ref) => {
        calls.push(["auth.remove", ref]);
        return true;
      },
    };
  }

  if (sc.ffmpeg) {
    flux.ffmpeg = {
      available: async () => ({ available: true, version: "6.1" }),
      run: async (spec) => {
        calls.push(["ffmpeg.run", spec.args]);
        return {
          code: sc.ffmpeg.code ?? 0,
          stdout: "",
          stderr: sc.ffmpeg.stderr ?? "",
          timedOut: false,
          truncatedStdout: false,
          truncatedStderr: false,
        };
      },
    };
  }

  if (sc.ytdlp) {
    flux.ytdlp = {
      available: async () => ({ available: true, version: "2026.01.01" }),
      run: async (spec) => {
        calls.push(["ytdlp.run", spec.args]);
        const r = typeof sc.ytdlp === "function" ? sc.ytdlp(spec) : sc.ytdlp;
        return {
          code: r.code ?? 0,
          stdout: r.stdout ?? "",
          stderr: r.stderr ?? "",
          timedOut: false,
          truncatedStdout: false,
          truncatedStderr: false,
        };
      },
    };
  }

  return { flux, calls, logs };
}

function loadEntry(dir, name, flux) {
  const file = entryFile(dir, name);
  if (!existsSync(file)) throw new Error(`missing ${file}（先跑 npm run build）`);
  const sandbox = { flux, console: { log() {}, info() {}, warn() {}, error() {}, debug() {} } };
  const context = vm.createContext(sandbox);
  vm.runInContext(readFileSync(file, "utf8"), context, { filename: file });
  return sandbox;
}

async function runOne(dir, sc) {
  const { flux, calls, logs } = createFlux(sc);
  let entry;
  try {
    entry = loadEntry(dir, sc.entry, flux);
  } catch (e) {
    return { loadError: String(e && e.message ? e.message : e) };
  }
  let result;
  let error = null;
  try {
    result = sc.steps ? await sc.steps(entry) : await sc.invoke(entry);
    result = canon(result);
  } catch (e) {
    error = String(e && e.message ? e.message : e);
  }
  return { result, error, logs: scrubTs(canon(logs)), calls: scrubTs(canon(calls)) };
}

function firstDiff(a, b, path = "") {
  if (a === b) return null;
  const ta = Array.isArray(a) ? "array" : typeof a;
  const tb = Array.isArray(b) ? "array" : typeof b;
  if (ta !== tb || (ta !== "object" && ta !== "array")) return { path, a, b };
  if (ta === "array") {
    if (a.length !== b.length) return { path: path + ".length", a: a.length, b: b.length };
    for (let i = 0; i < a.length; i++) {
      const d = firstDiff(a[i], b[i], `${path}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const k of keys) {
    const d = firstDiff(a ? a[k] : undefined, b ? b[k] : undefined, `${path}.${k}`);
    if (d) return d;
  }
  return null;
}

const show = (v) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s === undefined ? "undefined" : s.length > 300 ? s.slice(0, 300) + "…" : s;
};

const results = [];
let failed = 0;

for (const sc of scenarios) {
  const oldRun = await runOne(LEGACY, sc);
  const newRun = await runOne(DIST, sc);
  const diffs = [];
  for (const field of ["loadError", "result", "error", "logs", "calls"]) {
    const d = firstDiff(oldRun[field], newRun[field], field);
    if (d) diffs.push({ field, ...d });
  }
  if (diffs.length) {
    failed++;
    results.push({ name: sc.name, ok: false, diffs });
  } else {
    results.push({ name: sc.name, ok: true, logs: oldRun.logs.length, calls: oldRun.calls.length });
  }
}

for (const r of results) {
  if (r.ok) {
    console.log(`  ok   ${r.name}  (日志 ${r.logs} 条, 宿主调用 ${r.calls} 次)`);
    continue;
  }
  console.log(`  FAIL ${r.name}`);
  for (const d of r.diffs) {
    console.log(`       字段 ${d.field} @ ${d.path || "(根)"}`);
    console.log(`         v1.8.0: ${show(d.a)}`);
    console.log(`         dist  : ${show(d.b)}`);
  }
}

const total = scenarios.length;
console.log(`\n${total - failed}/${total} 场景一致`);
if (failed) {
  console.error(`\n${failed} 个场景存在行为差异 —— M1 的验收标准是 0 差异。`);
  process.exit(1);
}
