/**
 * M3 契约测试 —— 断言拦截器（`segments` 阶段去广告）的具体形状与边界纪律。
 *
 * 为什么不能靠 parity：拦截器是**新增**入口，v1.8.0 基线里根本没有 intercept.js，
 * 没有「等价」可比。这里直接断言「现在应该是什么样」：
 *
 *   1. 关闭 / 未配置 / 阶段不对 / 格式不对 → 一律 `null`（fail-closed，绝不返回空 drop）。
 *   2. 只处理本插件经手的任务（靠 taskId 标记），别人的下载一律不动。
 *   3. CUE-OUT / CUE-IN 必须成对；只有 OUT 没有 IN 时不动（纪律 1）。
 *   4. 丢弃块跨 `map` / `key` 边界时不动（纪律 2）—— 否则后续段解不开。
 *   5. 会丢空、或丢超过一半时整体放弃（纪律 3）。
 *   6. `drop` 里是**绝对 media sequence**，不是数组下标；单测里用错位的 id 来钉死这一点。
 *   7. 用户自定义规则：keepPath 豁免优先于一切，dropHosts 按主机名精确匹配。
 *   8. 启发式只在 heuristic 模式生效；marker 模式不因命名/时长丢段。
 *
 * 用法：npm run intercept        （需先 npm run build）
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runEntry, show } from "./parity/harness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const DIST = process.env.INTERCEPT_DIST || join(ROOT, "dist");

const HANDLED = { handledTasks: JSON.stringify({ t1: 1 }) };
const TASK = {
  id: "t1",
  url: "https://cdn.test/hls/v/index.m3u8",
  sourceUrl: "https://site.test/watch/1",
  fileName: "ep1.mp4",
  saveDir: "/tmp",
  protocol: "hls",
  trackPair: false,
  isResume: false,
};

/** 构造一个 SegmentItem（默认是 6 秒的普通正片段）。 */
const seg = (id, uri, extra = {}) => ({
  id,
  uri,
  duration: 6,
  byteRange: null,
  discontinuity: false,
  title: null,
  programDateTime: null,
  dateRange: null,
  tags: [],
  key: null,
  map: null,
  number: null,
  time: null,
  ...extra,
});

/** 一批 n 段正片，id 从 base 起（用 base 错位来验证返回值是 id 而非下标）。 */
const plain = (n, base = 0, prefix = "seg") =>
  Array.from({ length: n }, (_, i) => seg(base + i, `https://cdn.test/hls/v/${prefix}${i}.ts`));

async function runOnce(sc) {
  const r = await runEntry(DIST, {
    entry: "intercept",
    settings: sc.settings || {},
    store: sc.store === undefined ? HANDLED : sc.store,
    invoke: (e) =>
      e.intercept({
        stage: "segments",
        format: "hls",
        track: "video",
        playlistUrl: "https://cdn.test/hls/v/index.m3u8",
        manifestText: "",
        manifestTextOmitted: false,
        mediaSequence: 0,
        targetDuration: 6,
        periodIndex: null,
        representationId: null,
        task: TASK,
        segments: sc.segments,
        ...(sc.ctx || {}),
      }),
  });
  if (r.loadError) throw new Error(r.loadError);
  if (r.error) throw new Error(`intercept 抛错：${r.error}`);
  return r;
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

const dropOf = (r) => (r.result && r.result.drop ? r.result.drop : null);

// ---------------------------------------------------------------------------
// 1. 关闭与「不归我管」：一律 null
// ---------------------------------------------------------------------------
{
  const cue = [
    seg(0, "https://cdn.test/hls/v/a0.ts"),
    seg(1, "https://cdn.test/hls/v/ad1.ts", { tags: ["#EXT-X-CUE-OUT:30"] }),
    seg(2, "https://cdn.test/hls/v/ad2.ts", { tags: ["#EXT-X-CUE-OUT-CONT:15"] }),
    seg(3, "https://cdn.test/hls/v/ad3.ts", { tags: ["#EXT-X-CUE-IN"] }),
    seg(4, "https://cdn.test/hls/v/a4.ts"),
  ];

  await ck("关闭：默认未配置时不动", async () => eq(dropOf(await runOnce({ segments: cue })), null));
  await ck("关闭：显式 off 时不动", async () =>
    eq(dropOf(await runOnce({ settings: { adRulesMode: "off" }, segments: cue })), null));
  await ck("关闭：off 时不读任务标记（零成本）", async () => {
    const r = await runOnce({ settings: { adRulesMode: "off" }, segments: cue });
    const reads = r.calls.filter((c) => c[0] === "storage.get");
    return reads.length === 0 ? true : `仍发生 ${show(reads)}`;
  });
  await ck("归属：没有 taskId 标记时不动", async () =>
    eq(dropOf(await runOnce({ settings: { adRulesMode: "marker" }, store: {}, segments: cue })), null));
  await ck("归属：标记属于别的任务时不动", async () =>
    eq(
      dropOf(
        await runOnce({
          settings: { adRulesMode: "marker" },
          store: { handledTasks: JSON.stringify({ other: 1 }) },
          segments: cue,
        }),
      ),
      null,
    ));
  await ck("阶段：prepare 阶段直接返回 null", async () =>
    eq(dropOf(await runOnce({ settings: { adRulesMode: "marker" }, segments: cue, ctx: { stage: "prepare" } })), null));
  await ck("格式：DASH 任务不处理", async () =>
    eq(dropOf(await runOnce({ settings: { adRulesMode: "marker" }, segments: cue, ctx: { format: "dash" } })), null));
  await ck("空分片表：返回 null", async () =>
    eq(dropOf(await runOnce({ settings: { adRulesMode: "marker" }, segments: [] })), null));
}

// ---------------------------------------------------------------------------
// 2. 标记块（纪律 1：必须成对）
// ---------------------------------------------------------------------------
{
  const r = await runOnce({
    settings: { adRulesMode: "marker" },
    segments: [
      seg(10, "https://cdn.test/hls/v/a0.ts"),
      seg(11, "https://cdn.test/hls/v/ad1.ts", { tags: ["#EXT-X-CUE-OUT:30"] }),
      seg(12, "https://cdn.test/hls/v/ad2.ts", { tags: ["#EXT-X-CUE-OUT-CONT:15"] }),
      seg(13, "https://cdn.test/hls/v/ad3.ts", { tags: ["#EXT-X-CUE-IN"] }),
      seg(14, "https://cdn.test/hls/v/a4.ts"),
    ],
  });
  await ck("标记：OUT..IN 之间整块丢弃（含两端）", async () => eq(dropOf(r), [11, 12, 13]));
  await ck("标记：返回的是绝对 media sequence，不是数组下标", async () => {
    const d = dropOf(r);
    return d && d[0] === 11 ? true : `得到 ${show(d)}；若为下标应是 [1,2,3]`;
  });
  await ck("标记：日志里带丢弃段数", async () => {
    const s = r.logs.map((l) => l.join(" ")).join("\n");
    return /丢弃 3\/5 段/.test(s) ? true : `日志：${show(s)}`;
  });

  const noIn = await runOnce({
    settings: { adRulesMode: "marker" },
    segments: [
      seg(20, "https://cdn.test/hls/v/a0.ts"),
      seg(21, "https://cdn.test/hls/v/ad1.ts", { tags: ["#EXT-X-CUE-OUT:30"] }),
      seg(22, "https://cdn.test/hls/v/ad2.ts", { tags: ["#EXT-X-CUE-OUT-CONT:15"] }),
      seg(23, "https://cdn.test/hls/v/a3.ts"),
    ],
  });
  await ck("标记：只有 OUT 没有 IN 时不动（打包器标记不完整）", async () => eq(dropOf(noIn), null));

  const single = await runOnce({
    settings: { adRulesMode: "marker" },
    segments: [
      seg(30, "https://cdn.test/hls/v/a0.ts"),
      seg(31, "https://cdn.test/hls/v/ad1.ts", { tags: ["#EXT-X-CUE-OUT:0", "#EXT-X-CUE-IN"] }),
      seg(32, "https://cdn.test/hls/v/a2.ts"),
      seg(33, "https://cdn.test/hls/v/a3.ts"),
      seg(34, "https://cdn.test/hls/v/a4.ts"),
    ],
  });
  await ck("标记：单段自成块（OUT 与 IN 同段）也只丢这一段", async () => eq(dropOf(single), [31]));

  const multi = await runOnce({
    settings: { adRulesMode: "marker" },
    segments: [
      seg(40, "https://cdn.test/hls/v/a0.ts"),
      seg(41, "https://cdn.test/hls/v/ad1.ts", { tags: ["#EXT-X-CUE-OUT:10"] }),
      seg(42, "https://cdn.test/hls/v/ad2.ts", { tags: ["#EXT-X-CUE-IN"] }),
      seg(43, "https://cdn.test/hls/v/a3.ts"),
      seg(44, "https://cdn.test/hls/v/ad4.ts", { tags: ["#EXT-X-CUE-OUT:10"] }),
      seg(45, "https://cdn.test/hls/v/ad5.ts", { tags: ["#EXT-X-CUE-IN"] }),
      seg(46, "https://cdn.test/hls/v/a6.ts"),
      seg(47, "https://cdn.test/hls/v/a7.ts"),
    ],
  });
  await ck("标记：多个广告块分别成块", async () => eq(dropOf(multi), [41, 42, 44, 45]));
}

// ---------------------------------------------------------------------------
// 3. DATERANGE
// ---------------------------------------------------------------------------
{
  const dr = (id, extra) => seg(id, `https://cdn.test/hls/v/i${id}.ts`, extra);
  const r = await runOnce({
    settings: { adRulesMode: "marker" },
    segments: [
      dr(0, {}),
      dr(1, {
        duration: 15,
        dateRange: {
          id: "ad-1",
          class: "com.apple.hls.interstitial",
          startDate: "2026-01-01T00:00:00Z",
          endDate: null,
          duration: 15,
          plannedDuration: 15,
          endOnNext: false,
          attributes: {},
        },
      }),
      dr(2, {}),
      dr(3, {
        duration: 20,
        dateRange: {
          id: "s-1",
          class: null,
          startDate: "2026-01-01T00:00:00Z",
          endDate: null,
          duration: 20,
          plannedDuration: null,
          endOnNext: false,
          attributes: { "SCTE35-OUT": "0xFC30" },
        },
      }),
      dr(4, {}),
    ],
  });
  await ck("DATERANGE：interstitial 与 SCTE35 标注的段被丢弃", async () => eq(dropOf(r), [1, 3]));
}

// ---------------------------------------------------------------------------
// 4. 纪律 2：禁止跨 key / map 边界
// ---------------------------------------------------------------------------
{
  const keyA = { method: "AES-128", uri: "https://cdn.test/k1.bin", iv: null };
  const keyB = { method: "AES-128", uri: "https://cdn.test/k2.bin", iv: null };
  const mk = (id, tags, key) => seg(id, `https://cdn.test/hls/v/s${id}.ts`, { tags, key });

  const crossing = await runOnce({
    settings: { adRulesMode: "marker" },
    segments: [
      mk(0, [], keyA),
      mk(1, [], keyA),
      mk(2, [], keyA),
      mk(3, ["#EXT-X-CUE-OUT:12"], keyA),
      mk(4, ["#EXT-X-CUE-IN"], keyA),
      mk(5, [], keyB),
      mk(6, [], keyB),
    ],
  });
  await ck("纪律 2：丢弃块前后密钥不同 → 不动", async () => eq(dropOf(crossing), null));

  const same = await runOnce({
    settings: { adRulesMode: "marker" },
    segments: [
      mk(0, [], keyA),
      mk(1, [], keyA),
      mk(2, [], keyA),
      mk(3, ["#EXT-X-CUE-OUT:12"], keyA),
      mk(4, ["#EXT-X-CUE-IN"], keyA),
      mk(5, [], keyA),
      mk(6, [], keyA),
    ],
  });
  await ck("纪律 2：密钥一致时正常丢弃", async () => eq(dropOf(same), [3, 4]));

  const mapA = { uri: "https://cdn.test/init1.mp4", byteRange: null };
  const mapB = { uri: "https://cdn.test/init2.mp4", byteRange: null };
  const mm = (id, tags, map) => seg(id, `https://cdn.test/hls/v/m${id}.m4s`, { tags, map });

  const mapCross = await runOnce({
    settings: { adRulesMode: "marker" },
    segments: [
      mm(0, [], mapA),
      mm(1, [], mapA),
      mm(2, ["#EXT-X-CUE-OUT:12"], mapA),
      mm(3, ["#EXT-X-CUE-IN"], mapA),
      mm(4, [], mapB),
      mm(5, [], mapB),
    ],
  });
  await ck("纪律 2：丢弃块前后初始化段不同 → 不动", async () => eq(dropOf(mapCross), null));
}

// ---------------------------------------------------------------------------
// 5. 纪律 3：不丢空、不丢大半
// ---------------------------------------------------------------------------
{
  const allCue = await runOnce({
    settings: { adRulesMode: "marker" },
    segments: [
      seg(0, "https://cdn.test/hls/v/a0.ts", { tags: ["#EXT-X-CUE-OUT:30"] }),
      seg(1, "https://cdn.test/hls/v/a1.ts", { tags: ["#EXT-X-CUE-IN"] }),
      seg(2, "https://cdn.test/hls/v/a2.ts", { tags: ["#EXT-X-CUE-OUT:30"] }),
      seg(3, "https://cdn.test/hls/v/a3.ts", { tags: ["#EXT-X-CUE-IN"] }),
    ],
  });
  await ck("纪律 3：会清空全部分片 → 放弃并返回 null", async () => eq(dropOf(allCue), null));
  await ck("纪律 3：放弃时记一条 warn 说明原因", async () => {
    const s = allCue.logs.map((l) => l.join(" ")).join("\n");
    return /已跳过/.test(s) ? true : `日志：${show(s)}`;
  });

  const packed = Array.from({ length: 10 }, (_, i) => seg(i, `https://cdn.test/hls/v/p${i}.ts`));
  for (const from of [0, 3, 6]) {
    packed[from].tags = ["#EXT-X-CUE-OUT:10"];
    packed[from + 2].tags = ["#EXT-X-CUE-IN"];
  }
  const packedRun = await runOnce({ settings: { adRulesMode: "marker" }, segments: packed });
  await ck("纪律 3：丢弃数超过八成 → 放弃", async () => eq(dropOf(packedRun), null));

  const crowded = await runOnce({
    settings: { adRulesMode: "marker" },
    segments: [
      seg(0, "https://cdn.test/hls/v/a0.ts", { tags: ["#EXT-X-CUE-OUT:30"] }),
      seg(1, "https://cdn.test/hls/v/a1.ts", { tags: ["#EXT-X-CUE-IN"] }),
      seg(2, "https://cdn.test/hls/v/a2.ts", { tags: ["#EXT-X-CUE-OUT:30"] }),
      seg(3, "https://cdn.test/hls/v/a3.ts", { tags: ["#EXT-X-CUE-IN"] }),
      seg(4, "https://cdn.test/hls/v/a4.ts"),
    ],
  });
  await ck("纪律 3：短流里丢 3/5 仍然放行（六成不算错配）", async () => eq(dropOf(crowded), [0, 1, 2, 3]));
}

// ---------------------------------------------------------------------------
// 6. 模式差异：marker 不猜，heuristic 才猜
// ---------------------------------------------------------------------------
{
  const named = [
    seg(0, "https://cdn.test/hls/v/ep1.ts"),
    seg(1, "https://cdn.test/hls/v/ad1.ts"),
    seg(2, "https://cdn.test/hls/v/ep2.ts"),
    seg(3, "https://cdn.test/hls/v/ep3.ts"),
    seg(4, "https://cdn.test/hls/v/ep4.ts"),
  ];
  await ck("模式：marker 不因命名丢段", async () =>
    eq(dropOf(await runOnce({ settings: { adRulesMode: "marker" }, segments: named })), null));
  await ck("模式：heuristic 丢掉 ad1.ts", async () =>
    eq(dropOf(await runOnce({ settings: { adRulesMode: "heuristic" }, segments: named })), [1]));

  const shortSeg = [
    seg(0, "https://cdn.test/hls/v/b0.ts"),
    seg(1, "https://cdn.test/hls/v/b1.ts", { duration: 0 }),
    seg(2, "https://cdn.test/hls/v/b2.ts"),
    seg(3, "https://cdn.test/hls/v/b3.ts"),
    seg(4, "https://cdn.test/hls/v/b4.ts"),
  ];
  await ck("模式：heuristic 丢掉 0 时长的占位段", async () =>
    eq(dropOf(await runOnce({ settings: { adRulesMode: "heuristic" }, segments: shortSeg })), [1]));

  const hostLike = [
    seg(0, "https://cdn.test/hls/v/c0.ts"),
    seg(1, "https://ad.cdn.test/hls/v/c1.ts"),
    seg(2, "https://cdn.test/hls/v/c2.ts"),
    seg(3, "https://cdn.test/hls/v/c3.ts"),
    seg(4, "https://cdn.test/hls/v/c4.ts"),
  ];
  await ck("模式：主机名里的 ad. 不算命名命中（只看 path）", async () =>
    eq(dropOf(await runOnce({ settings: { adRulesMode: "heuristic" }, segments: hostLike })), null));
}

// ---------------------------------------------------------------------------
// 7. 用户自定义规则
// ---------------------------------------------------------------------------
{
  const segs = [
    seg(0, "https://cdn.test/hls/v/ep1.ts"),
    seg(1, "https://ads.cdn.test/x/a1.ts"),
    seg(2, "https://cdn.test/hls/v/ep2.ts"),
    seg(3, "https://cdn.test/hls/v/ep3.ts"),
  ];
  await ck("自定义：dropHosts 按主机名精确匹配", async () =>
    eq(
      dropOf(
        await runOnce({
          settings: { adRulesMode: "marker", adRulesExtra: '{"dropHosts":["ads.cdn.test"]}' },
          segments: segs,
        }),
      ),
      [1],
    ));
  await ck("自定义：dropHosts 不做后缀匹配（子域不误伤）", async () =>
    eq(
      dropOf(
        await runOnce({
          settings: { adRulesMode: "marker", adRulesExtra: '{"dropHosts":["cdn.test"]}' },
          segments: [
            seg(0, "https://media.cdn.test/hls/v/e0.ts"),
            seg(1, "https://media.cdn.test/hls/v/e1.ts"),
          ],
        }),
      ),
      null,
    ));
  await ck("自定义：keepPath 豁免内置规则", async () =>
    eq(
      dropOf(
        await runOnce({
          settings: { adRulesMode: "heuristic", adRulesExtra: '{"keepPath":["/ep1\\\\.ts$"]}' },
          segments: [seg(0, "https://cdn.test/hls/v/ep1.ts"), seg(1, "https://cdn.test/hls/v/ad1.ts"), seg(2, "https://cdn.test/hls/v/ep2.ts")],
        }),
      ),
      [1],
    ));
  await ck("自定义：dropPath 强执行（生效于 marker 模式）", async () =>
    eq(
      dropOf(
        await runOnce({
          settings: { adRulesMode: "marker", adRulesExtra: '{"dropPath":["/x/a1\\\\.ts"]}' },
          segments: [seg(0, "https://cdn.test/hls/v/e0.ts"), seg(1, "https://ads.cdn.test/x/a1.ts"), seg(2, "https://cdn.test/hls/v/e2.ts")],
        }),
      ),
      [1],
    ));

  const bad = await runOnce({
    settings: { adRulesMode: "marker", adRulesExtra: "{not json" },
    segments: [seg(0, "https://cdn.test/hls/v/q0.ts"), seg(1, "https://cdn.test/hls/v/q1.ts")],
  });
  await ck("自定义：JSON 写坏时不崩，只记一条 warn", async () => {
    if (dropOf(bad) !== null) return `却产生了 ${show(dropOf(bad))}`;
    const warns = bad.logs.filter((l) => l[0] === "warn" && /自定义规则/.test(l.join(" ")));
    return warns.length === 1 ? true : `warn 条数 ${warns.length}`;
  });
}

// ---------------------------------------------------------------------------
// 8. 规模化：200 集剧集不炸、且标记不被挤掉
// ---------------------------------------------------------------------------
{
  const many = Array.from({ length: 400 }, (_, i) => seg(i, `https://cdn.test/hls/v/s${i}.ts`));
  const cueAt = (from) => {
    many[from].tags = ["#EXT-X-CUE-OUT:10"];
    many[from + 1].tags = ["#EXT-X-CUE-IN"];
  };
  for (let i = 100; i < 400; i += 50) cueAt(i);
  const r = await runOnce({ settings: { adRulesMode: "heuristic" }, segments: many });
  await ck("规模：400 段里 6 个广告块全部命中", async () => eq(dropOf(r), [100, 101, 150, 151, 200, 201, 250, 251, 300, 301, 350, 351]));

  // 标记容量：HANDLE_MAX 由 60 提到 300。这里验证「200 条标记的存储仍能被正确认领」——
  // 60 条上限下，批量建 200 集会把先建的标记挤掉，表现为「前面的集数不去广告」。
  const stamp = Date.now();
  const map = { t1: stamp };
  for (let i = 0; i < 199; i++) map[`task-${i}`] = stamp;
  const filled = { handledTasks: JSON.stringify(map) };
  await ck("规模：200 条任务标记并存时仍能认领本任务", async () =>
    eq(
      dropOf(
        await runOnce({
          settings: { adRulesMode: "marker" },
          store: filled,
          segments: [
            seg(0, "https://cdn.test/hls/v/a0.ts", { tags: ["#EXT-X-CUE-OUT:10"] }),
            seg(1, "https://cdn.test/hls/v/a1.ts", { tags: ["#EXT-X-CUE-IN"] }),
            seg(2, "https://cdn.test/hls/v/a2.ts"),
          ],
        }),
      ),
      [0, 1],
    ));
}

// ---------------------------------------------------------------------------
// 9. `failed` 阶段：失败归因与定向重试
// ---------------------------------------------------------------------------

/** 跑一次 `failed` 阶段。`sc` 里没给 task 时默认用 TASK（已在标记里）。 */
async function runFailed(sc) {
  const r = await runEntry(DIST, {
    entry: "intercept",
    settings: sc.settings || {},
    store: sc.store === undefined ? HANDLED : sc.store,
    invoke: (e) =>
      e.intercept({
        stage: "failed",
        task: sc.task === undefined ? TASK : sc.task,
        errorMessage: sc.errorMessage === undefined ? "" : sc.errorMessage,
        httpStatus: sc.httpStatus === undefined ? null : sc.httpStatus,
        autoRetryCount: sc.autoRetryCount === undefined ? 0 : sc.autoRetryCount,
      }),
  });
  if (r.loadError) throw new Error(r.loadError);
  if (r.error) throw new Error(`failed 阶段抛错（拦截器不得外抛）：${r.error}`);
  return r;
}

const delayOf = (r) => (r.result && r.result.retry ? r.result.retry.delayMs : null);

{
  // 9.1 不归我管 / 未知阶段：一律 null
  await ck("failed：别人的任务不接管", async () =>
    eq((await runFailed({ store: {}, errorMessage: "ECONNRESET", httpStatus: null })).result, null));

  await ck("failed：未知阶段返回 null", async () => {
    const r = await runEntry(DIST, {
      entry: "intercept",
      settings: {},
      store: HANDLED,
      invoke: (e) => e.intercept({ stage: "prepare", task: TASK }),
    });
    return eq(r.result, null);
  });

  // 9.2 瞬时网络错误要重试
  for (const [label, msg] of [
    ["ECONNRESET", "request failed: ECONNRESET"],
    ["ETIMEDOUT", "read error ETIMEDOUT"],
    ["超时文本", "连接超时"],
    ["小写 timeout", "operation timed out after 30s"],
  ]) {
    await ck(`failed：${label} → 重试`, async () => {
      const r = await runFailed({ errorMessage: msg, httpStatus: null });
      return r.result && r.result.retry ? (delayOf(r) > 0 ? true : "delayMs 应为正数") : `应重试，实际 ${show(r.result)}`;
    });
  }

  // 9.3 5xx 与限流要重试，且限流等得更久
  await ck("failed：503 → 重试", async () => {
    const r = await runFailed({ errorMessage: "service unavailable", httpStatus: 503 });
    return r.result && r.result.retry ? true : "5xx 应重试";
  });

  await ck("failed：429 等待长于 5xx（限流不该猛击）", async () => {
    const a = delayOf(await runFailed({ errorMessage: "", httpStatus: 503 }));
    const b = delayOf(await runFailed({ errorMessage: "", httpStatus: 429 }));
    return b > a ? true : `429 的等待应更长：503=${a}ms，429=${b}ms`;
  });

  // 9.4 重试无效的形态：全部 null
  for (const [label, sc] of [
    ["401 凭据", { errorMessage: "unauthorized", httpStatus: 401 }],
    ["403 拒绝", { errorMessage: "forbidden", httpStatus: 403 }],
    ["404 缺失", { errorMessage: "not found", httpStatus: 404 }],
    ["410 移除", { errorMessage: "gone", httpStatus: 410 }],
    ["磁盘满", { errorMessage: "写入失败: ENOSPC: no space left on device", httpStatus: null }],
    ["无权限", { errorMessage: "EACCES: permission denied", httpStatus: null }],
    ["解密失败", { errorMessage: "PKCS7 padding check failed (Unpad Error)", httpStatus: null }],
    ["DRM", { errorMessage: "SAMPLE-AES keyformat not supported", httpStatus: null }],
    ["认不出", { errorMessage: "something odd happened", httpStatus: null }],
    ["空消息空状态", { errorMessage: "", httpStatus: null }],
  ]) {
    await ck(`failed：${label} → 不接管`, async () => eq((await runFailed(sc)).result, null));
  }

  // 9.5 取消优先于一切。这条必须与「纯 ECONNRESET 要重试」成对看 —— 只断言 null 的话，
  //     「取消优先」被删掉后结果仍是 null（cancelled 本就不在重试白名单），断言没有区分力。
  await ck("failed：取消优先于瞬时错误（对照组必须重试）", async () => {
    const withCancel = (await runFailed({ errorMessage: "download cancelled: ECONNRESET", httpStatus: null })).result;
    const noCancel = (await runFailed({ errorMessage: "read error: ECONNRESET", httpStatus: null })).result;
    if (withCancel !== null) return `带「取消」字样时不得重试，实际 ${show(withCancel)}`;
    if (!noCancel || !noCancel.retry) return `不带「取消」字样的 ECONNRESET 应重试，实际 ${show(noCancel)}`;
    return true;
  });

  // 9.6 重试次数上限
  await ck("failed：autoRetryCount 达上限 → 不接管", async () =>
    eq((await runFailed({ errorMessage: "ECONNRESET", autoRetryCount: 3 })).result, null));

  await ck("failed：autoRetryCount 未达上限 → 仍重试", async () => {
    const r = await runFailed({ errorMessage: "ECONNRESET", autoRetryCount: 2 });
    return r.result && r.result.retry ? true : "2 < 3 应继续重试";
  });

  // 9.7 HTTP 状态优先于文本：403 的正文里可能恰好含 "timeout" 字样
  await ck("failed：403 优先于正文里的超时字样", async () =>
    eq((await runFailed({ errorMessage: "gateway timeout", httpStatus: 403 })).result, null));

  // 9.8 ENOTFOUND 属硬错（域名解析失败多为配置错误，重试无益）
  await ck("failed：ENOTFOUND 不重试", async () =>
    eq((await runFailed({ errorMessage: "getaddrinfo ENOTFOUND cdn.example" })).result, null));

  // 9.9 回归：errno 必须是白名单里的那个，不能取正则的第一个匹配。
  // `read error: ECONNRESET` 里 `ERROR` 同样形如 errno —— 取第一个匹配会拿到 `ERROR`，
  // 于是这条本该重试的消息被判成「认不出」而放手。
  for (const [label, msg] of [
    ["消息里含 ERROR 字样", "read error: ECONNRESET"],
    ["含 ERROR 且 errno 在句首", "ERROR: ETIMEDOUT while reading"],
    ["多个候选只认白名单", "Error EPIPE broken pipe"],
  ]) {
    await ck(`failed：${label} → 仍能识别 errno 并重试`, async () => {
      const r = await runFailed({ errorMessage: msg, httpStatus: null });
      return r.result && r.result.retry ? true : `应重试，实际 ${show(r.result)}`;
    });
  }

  await ck("failed：EXAMPLES 之类非 errno 词不误判", async () =>
    eq((await runFailed({ errorMessage: "see EXAMPLES section", httpStatus: null })).result, null));
}

// ---------------------------------------------------------------------------
// 10. `refresh` 阶段：凭据换发
// ---------------------------------------------------------------------------

/** 跑一次 `refresh` 阶段。`sc.routes` 是 flux.fetch 的路由表（与 parity harness 同形）。 */
async function runRefresh(sc) {
  const r = await runEntry(DIST, {
    entry: "intercept",
    settings: sc.settings || {},
    store: sc.store === undefined ? HANDLED : sc.store,
    routes: sc.routes || {},
    invoke: (e) =>
      e.intercept({
        stage: "refresh",
        task: sc.task === undefined ? TASK : sc.task,
        request: { url: sc.refusedUrl || "https://cdn.test/hls/v/index.m3u8", method: "GET" },
        status: sc.status === undefined ? 403 : sc.status,
        refreshCount: sc.refreshCount === undefined ? 0 : sc.refreshCount,
      }),
  });
  if (r.loadError) throw new Error(r.loadError);
  if (r.error) throw new Error(`refresh 阶段抛错（拦截器不得外抛）：${r.error}`);
  return r;
}

const cookiesOf = (r) => (r.result && r.result.cookies ? r.result.cookies : null);
const fetchCalls = (r) => r.calls.filter((c) => c[0] === "fetch");

// 站点地址（凭据同源闸按它判断）与 CDN 地址故意不同：真实场景里清单在站内、分片在 CDN。
const SITE = "https://site.test/watch/1";

{
  // 10.1 不归我管 / 非鉴权状态码 → 不发请求、返回 null
  await ck("refresh：别人的任务不发请求", async () => {
    const r = await runRefresh({
      store: {},
      status: 403,
      routes: { [SITE]: { headers: { "set-cookie": "sid=new" } } },
    });
    if (r.result !== null) return `应返回 null，实际 ${show(r.result)}`;
    return fetchCalls(r).length === 0 ? true : `不应发请求，实际 ${fetchCalls(r).length} 次`;
  });

  await ck("refresh：404 不换发凭据（换凭据无意义）", async () => {
    const r = await runRefresh({ status: 404, routes: { [SITE]: { headers: { "set-cookie": "sid=new" } } } });
    if (r.result !== null) return `应返回 null，实际 ${show(r.result)}`;
    return fetchCalls(r).length === 0 ? true : `不应发请求，实际 ${fetchCalls(r).length} 次`;
  });

  await ck("refresh：未知阶段返回 null", async () => {
    const r = await runEntry(DIST, {
      entry: "intercept",
      settings: {},
      store: HANDLED,
      invoke: (e) => e.intercept({ stage: "probed", task: TASK }),
    });
    return eq(r.result, null);
  });

  // 10.2 拿到新 Cookie 就下发，且是**合并**而非替换
  await ck("refresh：403 时重新访问任务地址并下发新 Cookie", async () => {
    const r = await runRefresh({
      settings: { authCookie: "old=1; keep=2" },
      status: 403,
      routes: { [SITE]: { headers: { "set-cookie": "sid=abc123; Path=/; HttpOnly" } } },
    });
    const ck = cookiesOf(r);
    if (!ck) return `应下发 cookies，实际 ${show(r.result)}`;
    return ck.indexOf("sid=abc123") >= 0 ? true : `新 Cookie 未下发：${ck}`;
  });

  await ck("refresh：新 Cookie 与旧值合并（不整串替换）", async () => {
    const r = await runRefresh({
      settings: { authCookie: "old=1; keep=2" },
      status: 401,
      routes: { [SITE]: { headers: { "set-cookie": "sid=abc123" } } },
    });
    const ck = cookiesOf(r) || "";
    // 旧值必须还在：refresh 的职责是补，不是抹。
    return ck.indexOf("old=1") >= 0 && ck.indexOf("keep=2") >= 0 && ck.indexOf("sid=abc123") >= 0
      ? true
      : `应保留旧 Cookie 并加入新值，实际 ${ck}`;
  });

  // 10.3 纪律 1：只换发一次
  await ck("refresh：refreshCount ≥ 1 → 不再动作且不发请求", async () => {
    const r = await runRefresh({
      status: 403,
      refreshCount: 1,
      routes: { [SITE]: { headers: { "set-cookie": "sid=x" } } },
    });
    if (r.result !== null) return `应返回 null，实际 ${show(r.result)}`;
    return fetchCalls(r).length === 0 ? true : `不应再发请求，实际 ${fetchCalls(r).length} 次`;
  });

  // 10.4 纪律 3：取不到就不下发
  await ck("refresh：重新访问返回非 2xx → 不下发", async () => {
    const r = await runRefresh({
      status: 403,
      routes: { [SITE]: { status: 500, headers: { "set-cookie": "sid=x" } } },
    });
    return eq(r.result, null);
  });

  await ck("refresh：响应无 Set-Cookie → 不下发", async () => {
    const r = await runRefresh({ status: 403, routes: { [SITE]: { headers: {} } } });
    return eq(r.result, null);
  });

  await ck("refresh：新 Cookie 与现值相同 → 不下发（不变补丁等于没补）", async () => {
    const r = await runRefresh({
      settings: { authCookie: "sid=same" },
      status: 403,
      routes: { [SITE]: { headers: { "set-cookie": "sid=same" } } },
    });
    return eq(r.result, null);
  });

  // 10.5 失败不得外抛
  await ck("refresh：fetch 抛错时吞掉并返回 null", async () => {
    const r = await runRefresh({
      status: 403,
      routes: {
        [SITE]: () => {
          throw new Error("boom");
        },
      },
    });
    return eq(r.result, null);
  });

  // 10.6 多条 Set-Cookie 合并（宿主可能用逗号拼接）
  await ck("refresh：逗号拼接的多条 Set-Cookie 全部取出", async () => {
    const r = await runRefresh({
      status: 403,
      routes: { [SITE]: { headers: { "set-cookie": "a=1; Path=/, b=2; Path=/, c=3" } } },
    });
    const ck = cookiesOf(r) || "";
    return ck.indexOf("a=1") >= 0 && ck.indexOf("b=2") >= 0 && ck.indexOf("c=3") >= 0
      ? true
      : `三条都应取出，实际 ${ck}`;
  });

  await ck("refresh：Expires 里的逗号不被当成 Cookie 分隔符", async () => {
    const r = await runRefresh({
      status: 403,
      routes: {
        [SITE]: { headers: { "set-cookie": "sid=abc; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/" } },
      },
    });
    const ck = cookiesOf(r) || "";
    if (ck.indexOf("sid=abc") < 0) return `sid 未取出：${ck}`;
    return ck.indexOf("Oct") < 0 ? true : `日期被误当 Cookie：${ck}`;
  });
}

console.log(`\n${pass}/${pass + fail} 项拦截器契约通过`);
if (fail) {
  console.error(`\n${fail} 项未通过 —— 拦截器的边界纪律不符合预期。`);
  process.exit(1);
}
