/**
 * M4 契约测试 —— 断言 hooks 的后处理行为：产物登记 + 容器探测。
 *
 * 为什么不能靠 parity：M4 **有意**改变 onDone 的行为（v1.8.0 的 remux 产物是孤儿文件、容器
 * 靠扩展名猜），逐字比对必然报红。这几处改变的正确性在本文件里直接断言：
 *
 *   1. 每次成功写出产物后登记它 —— 登记名必须是「任务主文件主干 + 新扩展名」，
 *      这是宿主 `recordArtifact` 的硬约束（义务之外的任何名字都会被 reject）。
 *   2. 登记失败不能连累钩子（文件已经可用，只是删任务时不会被连带删除）。
 *   3. 容器以 ffprobe 的结论为准：已是 MP4 家族或无视频轨 → 不做整文件复制。
 *   4. 探测**任何**失败形态（缺失 / 非零退出 / JSON 非法 / 输出截断 / 抛错）都必须退回
 *      扩展名判断 —— 探测是增强，不能变成新的失败点。
 *   5. 探测结果在同一次 onDone 内复用，不重复起进程。
 *   6. 视频已自带音轨时不再兜底合并（否则多出一个同内容文件）。
 *
 * 用法：npm run postprocess        （需先 npm run build）
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runEntry, show } from "./parity/harness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const DIST = process.env.POSTPROCESS_DIST || join(ROOT, "dist");

const HANDLED = { handledTasks: JSON.stringify({ t1: 1 }) };

// ---------------------------------------------------------------------------
// ffprobe 输出样本（真实 ffprobe 的形状，只保留插件读的字段）
// ---------------------------------------------------------------------------
const probe = (format, streams) => ({
  stdout: JSON.stringify({ format: { format_name: format }, streams }),
});
const V = { codec_type: "video" };
const A = { codec_type: "audio" };

const P_MP4 = probe("mov,mp4,m4a,3gp,3g2,mj2", [V, A]); // QuickTime 家族共用一个解复用器
const P_TS = probe("mpegts", [V, A]);
const P_TS_NO_AUDIO = probe("mpegts", [V]);
const P_AUDIO_ONLY = probe("matroska,webm", [A]);
const P_COVER_ART = probe("matroska,webm", [{ codec_type: "video", disposition: { attached_pic: 1 } }, A]);
const P_BAD_JSON = { stdout: "{ this is not json" };
const P_CODE_1 = { code: 1, stdout: "" };

async function runDone(sc) {
  const r = await runEntry(DIST, {
    entry: "hooks",
    settings: sc.settings || {},
    store: sc.store === undefined ? HANDLED : sc.store,
    ffmpeg: sc.ffmpeg === undefined ? {} : sc.ffmpeg,
    ffprobe: sc.ffprobe, // undefined = 宿主没有 ffprobe（组件未装全）
    artifactError: sc.artifactError,
    invoke: (e) =>
      e.onDone({
        event: "done",
        taskId: sc.taskId || "t1",
        url: "",
        filePath: sc.file === undefined ? "/dl/show.ts" : sc.file,
        audioPath: sc.audio === undefined ? null : sc.audio,
        muxed: sc.muxed === undefined ? true : sc.muxed,
      }),
  });
  if (r.loadError) throw new Error(r.loadError);
  if (r.error) throw new Error(`onDone 抛错（钩子不得外抛）：${r.error}`);
  return r;
}

const callsOf = (r, name) => r.calls.filter((c) => c[0] === name);
const ffmpegCalls = (r) => callsOf(r, "ffmpeg.run");
const probeCalls = (r) => callsOf(r, "ffprobe.run");
const artifacts = (r) => callsOf(r, "task.recordArtifact").map((c) => c[1]);
const logsAt = (r, level) => r.logs.filter((l) => l[0] === level);
// 日志条目形如 [level, arg1, arg2…]；多参调用时关键词可能落在任意位置。
const anyLog = (r, needle) =>
  r.logs.some((l) => l.slice(1).some((x) => String(typeof x === "string" ? x : JSON.stringify(x)).includes(needle)));

const eq = (a, b) => (JSON.stringify(a) === JSON.stringify(b) ? true : `期望 ${show(b)}，实际 ${show(a)}`);

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

// ---------------------------------------------------------------------------
// 1. 产物登记
// ---------------------------------------------------------------------------
{
  const r = await runDone({ ffprobe: P_TS, file: "/dl/show.ts" });
  await ck("登记：remux 成功后把自己的产物登记为该任务的衍生产物", () => eq(artifacts(r), ["show.mp4"]));
  await ck("登记：只登记一次，且发生在 ffmpeg 之后", () => {
    const seq = r.calls.map((c) => c[0]).filter((n) => n === "ffmpeg.run" || n === "task.recordArtifact");
    return eq(seq, ["ffmpeg.run", "task.recordArtifact"]);
  });
  await ck("登记：产物名以任务主文件主干开头（宿主的硬性要求）", () => {
    const stem = "show";
    const name = artifacts(r)[0] || "";
    return name.startsWith(stem) ? true : `产物名 ${show(name)} 未以主干 ${show(stem)} 开头`;
  });
  await ck("登记：日志里明示「删除任务时一并删除」", () => anyLog(r, "删除任务时一并删除"));
}

{
  const r = await runDone({ ffprobe: P_TS, file: "/dl/show.ts", ffmpeg: { code: 1, stderr: "boom" } });
  await ck("登记：ffmpeg 失败时绝不登记（文件可能没写出来）", () => eq(artifacts(r), []));
}

{
  const r = await runDone({
    ffprobe: P_TS,
    file: "/dl/show.ts",
    artifactError: "recordArtifact: 文件不存在",
  });
  await ck("登记：宿主 reject 时只记 warn，钩子不失败", () => eq(artifacts(r), ["show.mp4"]));
  await ck("登记：reject 后仍留下可诊断的日志", () => anyLog(r, "产物登记失败"));
}

// ---------------------------------------------------------------------------
// 2. 容器探测决定是否转封装
// ---------------------------------------------------------------------------
{
  const r = await runDone({ ffprobe: P_MP4, file: "/dl/fmp4-muxed.ts" });
  await ck("探测：扩展名是 .ts 但容器已是 MP4 家族 → 不做整文件复制", () => eq(ffmpegCalls(r).length, 0));
  await ck("探测：跳过时给出容器名，便于用户理解「为什么没转」", () => anyLog(r, "mov,mp4,m4a,3gp,3g2,mj2"));
  await ck("探测：跳过时不登记任何产物", () => eq(artifacts(r), []));
}

{
  const r = await runDone({ ffprobe: P_AUDIO_ONLY, file: "/dl/audio.mkv" });
  await ck("探测：无视频轨 → 不转封装（转成 .mp4 只会得到无画面的文件）", () => eq(ffmpegCalls(r).length, 0));
  await ck("探测：无视频轨时日志给出原因", () => anyLog(r, "无视频轨"));
}

{
  const r = await runDone({ ffprobe: P_COVER_ART, file: "/dl/album.mkv" });
  await ck("探测：封面图（attached_pic）不算视频轨", () => eq(ffmpegCalls(r).length, 0));
}

{
  const r = await runDone({ ffprobe: P_TS, file: "/dl/show.mkv" });
  await ck("探测：容器是 mpegts 就转（不被 .mkv 扩展名绕过）", () => eq(ffmpegCalls(r).length, 1));
  await ck("探测：mpegts → 仍然产出 .mp4 并登记", () => eq(artifacts(r), ["show.mp4"]));
}

// ---------------------------------------------------------------------------
// 3. 探测失败必须退回扩展名判断（探测不能成为新的失败点）
// ---------------------------------------------------------------------------
for (const [label, fp] of [
  ["ffprobe 未安装（宿主未提供）", undefined],
  ["ffprobe 非零退出", P_CODE_1],
  ["ffprobe 输出非法 JSON", P_BAD_JSON],
  ["ffprobe 输出被截断", { ...P_TS, truncatedStdout: true }],
  ["ffprobe 调用抛错", () => { throw new Error("ffprobe 未安装或不可用"); }],
]) {
  const r = await runDone({ ffprobe: fp, file: "/dl/show.ts" });
  await ck(`回退：${label} → 仍按扩展名转封装`, () => eq(artifacts(r), ["show.mp4"]));
}

{
  const r = await runDone({ ffprobe: P_CODE_1, file: "/dl/show.mp4" });
  await ck("回退：探测不可用时沿用旧判据（.mp4 直接跳过）", () => eq(ffmpegCalls(r).length, 0));
}

// ---------------------------------------------------------------------------
// 4. 不该探测的地方一次都不探
// ---------------------------------------------------------------------------
{
  const r = await runDone({ ffprobe: P_TS, file: "/dl/pack.zip" });
  await ck("边界：非候选扩展名不探测、不转封装", () => eq([probeCalls(r).length, ffmpegCalls(r).length], [0, 0]));
}

{
  const r = await runDone({ ffprobe: P_TS, file: "/dl/show.ts", settings: { remuxToMp4: false } });
  await ck("边界：remux 关闭时不探测（不为关掉的功能起进程）", () => eq([probeCalls(r).length, ffmpegCalls(r).length], [0, 0]));
}

{
  const r = await runDone({ ffprobe: P_TS, file: "/dl/other.ts", taskId: "t9", store: { handledTasks: "{}" } });
  await ck("边界：非本插件经手的任务不探测、不动文件", () => eq([probeCalls(r).length, ffmpegCalls(r).length], [0, 0]));
}

// ---------------------------------------------------------------------------
// 5. 轨对合并（muxed=false + 独立音频）
// ---------------------------------------------------------------------------
{
  const r = await runDone({ ffprobe: P_TS, file: "/dl/show.mkv", audio: "/dl/show.m4a", muxed: false });
  await ck("合并：视频无音轨时补做合并", () => eq(ffmpegCalls(r).length, 1));
  await ck("合并：合并产物同样登记", () => eq(artifacts(r), ["show.mp4"]));
  await ck("合并：合并成功即返回，不再多跑一次转封装", () => {
    const seq = r.calls.map((c) => c[0]).filter((n) => n === "ffmpeg.run");
    return eq(seq, ["ffmpeg.run"]);
  });
}

{
  const r = await runDone({ ffprobe: P_TS, file: "/dl/show.mkv", audio: "/dl/show.m4a", muxed: false, ffmpeg: { code: 1 } });
  await ck("合并：探测结论被复用（合并失败后转封装，ffprobe 只起一次）", () => eq(probeCalls(r).length, 1));
}

{
  const r = await runDone({ ffprobe: P_TS_NO_AUDIO, file: "/dl/show.mkv", audio: "/dl/show.m4a", muxed: false });
  await ck("合并：探测显示无音轨时确实走合并（不是一律跳过）", () => eq(ffmpegCalls(r).length, 1));
}

// ---------------------------------------------------------------------------
// 6. 探测顺序：先探测再起 ffmpeg
// ---------------------------------------------------------------------------
{
  const r = await runDone({ ffprobe: P_TS, file: "/dl/show.ts" });
  await ck("顺序：先 ffprobe 后 ffmpeg", () => {
    const seq = r.calls.map((c) => c[0]).filter((n) => n === "ffprobe.run" || n === "ffmpeg.run");
    return eq(seq, ["ffprobe.run", "ffmpeg.run"]);
  });
  await ck("顺序：探测参数用相对名（牢笼只认产物目录内的 basename）", () => {
    const args = probeCalls(r)[0][1];
    const last = String(args[args.length - 1]);
    return last === "./show.ts" ? true : `末位参数是 ${show(last)}，应以 ./ 开头的裸文件名`;
  });
}

// ---------------------------------------------------------------------------
// 7. 失败可辨识：超时与普通失败必须区分（超时留下的半成品要能被认出来）
// ---------------------------------------------------------------------------
{
  // 超时：`flux.ffmpeg.run` 以 timedOut=true + code=-1 返回，此时 -y 已创建出半截 .mp4
  const r = await runDone({ ffprobe: P_TS, file: "/dl/show.ts", ffmpeg: { code: -1, timedOut: true } });
  await ck("失败：超时日志点明「5 分钟上限」而不是只给 code -1", () => anyLog(r, "超时被终止"));
  await ck("失败：超时日志提醒产物可能不完整（用户才知道要删掉重来）", () => anyLog(r, "不完整"));
  await ck("失败：超时不登记产物", () => eq(artifacts(r), []));
}

{
  const r = await runDone({ ffprobe: P_TS, file: "/dl/show.ts", ffmpeg: { code: 1, stderr: "boom" } });
  await ck("失败：普通非零退出仍报 code 与 stderr 尾部", () => anyLog(r, "失败 (code 1)") && anyLog(r, "boom"));
  await ck("失败：普通失败不套用超时文案", () =>
    anyLog(r, "超时被终止") ? "非超时失败却打了超时日志" : true);
}

console.log(`\n${pass}/${pass + fail} 项后处理契约通过`);
if (fail) {
  console.error(`\n${fail} 项契约未通过 —— M4 的后处理行为不符合预期。`);
  process.exit(1);
}
