// FluxDown M3U8 插件 —— 钩子脚本
// 订阅 onDone / onError / onCancel：
//   onDone   - ① 轨对任务合并失败兜底（核心 muxed=false 且留下独立音频文件时，插件补做 mux）
//              ② 下载后 remux 为 MP4（增强 A，保守白名单）
//   onError  - 记录失败原因（钩子改变不了任务，仅用于可观测性）
//   onCancel - 用户取消也是终态，清掉任务标记（官方文档没列这个事件，但引擎 VALID_EVENTS 里有）
//
// 为什么需要「任务标记」：
//   manifest 的 hooks.match 只能拿**任务的原始 URL** 过滤。播放页场景下原始 URL 里
//   不含 m3u8（例：https://site.com/watch/123），旧配置 match:["*://*m3u8*"] 会让
//   remux / 兜底合并对这类任务永远不触发 —— 一个静默失效。现改为不设 match
//   （对所有任务都收到事件），再用 resolver 写入的 taskId 标记判断「这个任务是不是
//   本插件经手的」，从而既覆盖两种入口，又不会去动无关下载（.mkv 等）。
//
// 安全护栏：
//   - 输入扩展名白名单（INPUT_OK），杜绝 .zip/.pdf 等被误转。
//   - ffmpeg 沙箱只认产物目录内的相对名，一律用 basename 且前缀 ./。
//   - flux.ffmpeg 仅在 onDone 可用；未装 ffmpeg 组件则直接跳过。

// 允许被 remux 的输入容器（其余一律跳过，避免损坏非媒体文件）
const INPUT_OK = /\.(ts|mkv|webm|flv|m4v|mov|m2ts|mpeg|mpg|ogv)$/i;

// 与 resolver.js 共用同一存储键（两个脚本各有独立上下文，代码需各自持有一份）
const HANDLE_KEY = "handledTasks";

function settingBool(key, def) {
  const v = flux.settings ? flux.settings[key] : undefined;
  if (v === undefined || v === null || v === "") return !!def;
  if (typeof v === "boolean") return v;
  const s = String(v).trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes" || s === "on";
}
function baseName(p) {
  return String(p || "").split(/[\\/]/).pop() || "";
}
async function readHandled() {
  try {
    if (!flux.storage) return {};
    const s = await flux.storage.get(HANDLE_KEY);
    if (!s) return {};
    const o = JSON.parse(s);
    return o && typeof o === "object" ? o : {};
  } catch (e) {
    return {};
  }
}
async function isHandled(taskId) {
  if (!taskId) return false;
  const map = await readHandled();
  return !!map[taskId];
}
async function unmark(taskId) {
  if (!taskId || !flux.storage) return;
  try {
    const map = await readHandled();
    if (map[taskId] !== undefined) {
      delete map[taskId];
      await flux.storage.set(HANDLE_KEY, JSON.stringify(map));
    }
  } catch (e) {}
}

// ---- 失败日志：只记本插件经手的任务，避免对全应用的失败任务刷日志 ----
globalThis.onError = async (ctx) => {
  try {
    if (!(await isHandled(ctx && ctx.taskId))) return;
    flux.logger.error(
      "[m3u8-resolver] 任务失败 " + String((ctx && ctx.taskId) || "") + ": " + String((ctx && ctx.message) || "")
    );
    await unmark(ctx && ctx.taskId);
  } catch (e) {}
};

// ---- 取消：同样是终态，清掉标记，避免它滞留到 TTL 过期 ----
// onDone / onError 已各自清理，缺了这条时，被用户取消的任务标记会一直留着：
// 既占满 60 条上限，也可能让一个被复用的 taskId 被误判成「本插件经手」。
globalThis.onCancel = async (ctx) => {
  try {
    if (await isHandled(ctx && ctx.taskId)) await unmark(ctx && ctx.taskId);
  } catch (e) {}
};

globalThis.onDone = async (ctx) => {
  try {
    if (!(await isHandled(ctx && ctx.taskId))) return;
    await unmark(ctx && ctx.taskId);

    const video = baseName(ctx && ctx.filePath);
    if (!video) return;

    // ---- ① 轨对合并失败兜底 ----
    // 核心在 url + audioUrl 成对返回时会自己做合并；muxed=false 且 audioPath 非空
    // 说明核心已降级（留下独立音频文件）。两个文件同目录，可用相对名直接补做。
    if (settingBool("fixMuxFallback", true) && ctx.audioPath && ctx.muxed === false) {
      const audio = baseName(ctx.audioPath);
      if (audio && audio !== video && flux.ffmpeg && INPUT_OK.test(video)) {
        if (/\.mp4$/i.test(video)) {
          flux.logger.warn("[m3u8-resolver] 轨对未合并，但视频已是 MP4，请自行检查音轨:", video);
        } else {
          const out = video.replace(/\.[^.]+$/, "") + ".mp4";
          flux.logger.warn("[m3u8-resolver] 核心未合并轨对，尝试 ffmpeg 兜底:", video, "+", audio, "->", out);
          const r = await flux.ffmpeg.run({
            args: [
              "-i", "./" + video,
              "-i", "./" + audio,
              "-map", "0:v:0", "-map", "1:a:0",
              "-c", "copy", "-movflags", "+faststart",
              "-y", "./" + out,
            ],
          });
          if (r.code === 0) {
            flux.logger.info("[m3u8-resolver] 兜底合并完成:", out);
            return; // 已产出 mp4，不再走下面的转封装
          }
          flux.logger.error("[m3u8-resolver] 兜底合并失败 (code " + r.code + "):", (r.stderr || "").slice(-400));
        }
      }
    }

    // ---- ② 下载后 remux 为 MP4（增强 A）----
    if (!settingBool("remuxToMp4", true)) return;
    if (!flux.ffmpeg) return;
    if (/\.mp4$/i.test(video)) return;   // 已是 mp4，无需处理
    if (!INPUT_OK.test(video)) return;   // 非音视频容器，跳过

    const out = video.replace(/\.[^.]+$/, "") + ".mp4";
    flux.logger.info("[m3u8-resolver] onDone remux:", video, "->", out);

    const r = await flux.ffmpeg.run({
      args: ["-i", "./" + video, "-c", "copy", "-movflags", "+faststart", "-y", "./" + out],
    });
    if (r.code !== 0) {
      flux.logger.error("[m3u8-resolver] remux 失败 (code " + r.code + "):", (r.stderr || "").slice(-400));
    } else {
      flux.logger.info("[m3u8-resolver] remux 完成:", out);
    }
  } catch (e) {
    try {
      flux.logger.error("[m3u8-resolver] onDone 异常:", String(e));
    } catch (e2) {}
  }
};
