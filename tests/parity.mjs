/**
 * M1/M2 回归比对工具：同一批 fixture 分别喂给
 *   ① 旧实现 tests/legacy/*.js（v1.8.0）
 *   ② 新构建产物 dist/*.js（TypeScript + SDK 工程化后）
 * 逐条比对「返回值 / 抛错信息 / 日志序列 / 宿主调用序列（fetch、ffmpeg、yt-dlp、auth）」。
 *
 * 返回值先过 `requestFace()` 做请求面同义归并：v1.8.0 的 `extraHeaders` 与 M2 起的
 * `request` 补丁比「最终生效的 Referer / User-Agent / 头表 / 凭据」。M2 有意改变的
 * 「凭据作用域」（从「全部主机」收窄到「登记 origin」）不在本比对内，见 tests/contract.mjs。
 *
 * 判定标准：全部一致才算通过。任何差异都会打印出左右两边的第一处不同。
 *
 * 用法：npm run parity        （需先 npm run build）
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scenarios } from "./parity/scenarios.mjs";
import { requestFace } from "./parity/face.mjs";
import { canon, firstDiff, runEntry, show } from "./parity/harness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

const LEGACY = join(ROOT, "tests", "legacy");
// PARITY_DIST 仅供自检（喂一份故意改坏产物的副本，确认本工具真的能抓到差异）
const DIST = process.env.PARITY_DIST || join(ROOT, "dist");

/** 包装 runEntry：额外做请求面归并。 */
async function runOne(dir, sc) {
  const r = await runEntry(dir, sc);
  if (!r.loadError) r.result = canon(requestFace(r.result));
  return r;
}

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
  console.error(`\n${failed} 个场景存在行为差异 —— 验收标准是 0 差异。`);
  process.exit(1);
}
