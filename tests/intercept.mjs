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

console.log(`\n${pass}/${pass + fail} 项拦截器契约通过`);
if (fail) {
  console.error(`\n${fail} 项未通过 —— 拦截器的边界纪律不符合预期。`);
  process.exit(1);
}
