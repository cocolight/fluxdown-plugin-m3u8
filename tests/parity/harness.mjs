/**
 * 测试用假宿主：所有入口只通过 `flux` 门面与沙箱交互，因此一个假门面就能完整模拟引擎。
 * 记录三类观测值供断言：日志序列、宿主调用序列（fetch/auth/storage/ffmpeg/ytdlp）、入口返回值。
 *
 * parity.mjs（新旧实现比对）与 contract.mjs（M2 契约断言）共用本文件 —— 两份测试必须跑在
 * 同一个假宿主上，否则「比对通过」与「契约通过」说的不是一件事。
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

// ---------------------------------------------------------------------------
// 规范化
// ---------------------------------------------------------------------------
export function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === "object") {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = canon(v[k]);
    return o;
  }
  if (typeof v === "number" && !Number.isFinite(v)) return String(v);
  return v;
}

export const stable = (v) => JSON.stringify(canon(v));

/** 抹掉时间戳（任务标记写入 Date.now()）——两次运行必然不同，不属于行为差异。 */
export const scrubTs = (v) =>
  JSON.parse(JSON.stringify(v === undefined ? null : v).replace(/\b1[6-9]\d{11}\b/g, "<ts>"));

// ---------------------------------------------------------------------------
// 假宿主
// ---------------------------------------------------------------------------

/** 节点子节点展平：`null` / `false` / `undefined` 丢弃，数组递归展开（与引擎一致）。 */
function flatten(children) {
  const out = [];
  const walk = (c) => {
    if (Array.isArray(c)) {
      for (const inner of c) walk(inner);
    } else if (c !== null && c !== undefined && c !== false) {
      out.push(c);
    }
  };
  walk(children);
  return out;
}

export function createFlux(sc) {
  const calls = [];
  const logs = [];
  const store = { ...(sc.store || {}) };
  const routes = sc.routes || {};
  /** `main` 脚本注册的视图定义：id → definition。非 main 场景恒为空对象。 */
  const views = {};
  /** main 注册的命令 / rpc / 事件处理器，供 ui 测试直接调用。 */
  const commands = {};
  const rpcHandlers = {};
  const eventHandlers = {};

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
    task: {
      requestRetry: () => undefined,
      recordArtifact: async (n) => {
        calls.push(["task.recordArtifact", n]);
        if (sc.artifactError) throw new Error(sc.artifactError);
      },
    },
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
          // 透传：超时返回 code=-1 + timedOut=true（宿主口径）。写死 false 会让「超时分支」
          // 永远测不到 —— 这个盲区已经让一次日志改动假绿过。
          timedOut: !!sc.ffmpeg.timedOut,
          truncatedStdout: false,
          truncatedStderr: false,
        };
      },
    };

    // 真实宿主里 ffprobe 与 ffmpeg 同权限、同牢笼、同装同卸。`sc.ffprobe` 未给时表现为
    // 「ffprobe 缺失」—— 插件必须退回扩展名判断，与安装前 ffmpeg 组件不齐的机器一致。
    flux.ffprobe = {
      run: async (spec) => {
        calls.push(["ffprobe.run", spec.args]);
        if (sc.ffprobe === undefined) throw new Error("ffprobe 未安装或不可用（随 ffmpeg 组件一并安装）");
        const r = typeof sc.ffprobe === "function" ? sc.ffprobe(spec) : sc.ffprobe;
        return {
          code: r.code ?? 0,
          stdout: r.stdout ?? "",
          stderr: r.stderr ?? "",
          timedOut: false,
          truncatedStdout: !!r.truncatedStdout,
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

  // ---------------------------------------------------------------------
  // 常驻 main 上下文专属接口
  //
  // 只在 `sc.main` 为真时注入：parity / contract / intercept / postprocess 跑的都是无状态入口，
  // 多给它们 ui/timers 只会让「假宿主和真宿主」的差异面变大，反而降低比对的可信度。
  // ---------------------------------------------------------------------
  if (sc.main) {
    let timerSeq = 0;
    flux.ui = {
      view(id, def) {
        views[id] = def;
        calls.push(["ui.view", id]);
      },
      /** 与引擎 `flux.ui.h` 同义：节点是 `{k, p, c}`，子节点展平并丢弃 null/false/undefined。 */
      h(kind, props, ...children) {
        return { k: kind, p: { ...(props || {}) }, c: flatten(children) };
      },
      Fragment(props) {
        return { k: "#fragment", p: {}, c: flatten([props && props.children]) };
      },
      toast(level, text) {
        calls.push(["ui.toast", level, text]);
      },
    };

    flux.commands = {
      register(id, fn) {
        calls.push(["commands.register", id]);
        commands[id] = fn;
      },
    };

    flux.rpc = {
      handle(name, fn, opts) {
        calls.push(["rpc.handle", name, canon(opts || {})]);
        rpcHandlers[name] = fn;
      },
    };

    flux.events = {
      on(name, fn) {
        calls.push(["events.on", name]);
        (eventHandlers[name] || (eventHandlers[name] = [])).push(fn);
      },
    };

    // 定时器只记录不执行：真跑 setTimeout 会让测试挂住，而本项目的视图不依赖定时刷新。
    flux.timers = {
      setTimeout(_fn, ms) {
        calls.push(["timers.setTimeout", ms]);
        return ++timerSeq;
      },
      setInterval(_fn, ms) {
        calls.push(["timers.setInterval", ms]);
        return ++timerSeq;
      },
      clear(id) {
        calls.push(["timers.clear", id]);
      },
    };

    // 不可枚举：现有四层测试会对 `flux.settings` 取快照，多出一个函数会污染 parity 比对。
    Object.defineProperty(flux.settings, "update", {
      enumerable: false,
      value: async (entries) => {
        calls.push(["settings.update", canon(entries)]);
        if (sc.updateError) throw new Error(sc.updateError);
        Object.assign(flux.settings, entries);
      },
    });
  }

  return { flux, calls, logs, views };
}

export function loadEntry(dir, name, flux) {
  const file = join(dir, `${name}.js`);
  if (!existsSync(file)) throw new Error(`missing ${file}（先跑 npm run build）`);
  const sandbox = { flux, console: { log() {}, info() {}, warn() {}, error() {}, debug() {} } };
  const context = vm.createContext(sandbox);
  vm.runInContext(readFileSync(file, "utf8"), context, { filename: file });
  return sandbox;
}

/**
 * 跑一个场景，返回 `{ result | error, logs, calls }`（不含请求面投影，调用方自行投影）。
 *
 * `calls` / `logs` 是**深拷贝快照**（parity 比对需要可序列化、稳定）。常驻 `main` 的测试要在
 * 加载**之后**继续观察宿主调用（点按钮 → settings.update），所以额外给出 `liveCalls` ——
 * 同一个数组的引用，会随调用持续增长。别拿 `calls` 断言交互期行为，那是快照。
 */
export async function runEntry(dir, sc) {
  const { flux, calls, logs, views } = createFlux(sc);
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
  return {
    result,
    error,
    logs: scrubTs(canon(logs)),
    calls: scrubTs(canon(calls)),
    liveCalls: calls,
    views,
  };
}

// ---------------------------------------------------------------------------
// 差异定位
// ---------------------------------------------------------------------------
export function firstDiff(a, b, path = "") {
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

export const show = (v) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s === undefined ? "undefined" : s.length > 300 ? s.slice(0, 300) + "…" : s;
};
