import type { FluxEvent } from "fluxdown-plugin-sdk";
import { install } from "../lib/install";
import { readSettings } from "../lib/settings";
import { isHandled, unmarkHandled } from "../lib/handled";

/**
 * hooks 入口 —— 任务终态后的后处理。
 *
 * 订阅 onDone / onError / onCancel：
 *   onDone   - ① 轨对任务合并失败兜底（引擎 muxed=false 且留下独立音频文件时补做 mux）
 *              ② 下载后 remux 为 MP4（增强 A，保守白名单）
 *   onError  - 记录失败原因（钩子改变不了任务，仅用于可观测性）
 *   onCancel - 用户取消也是终态，清掉任务标记
 *
 * 安全护栏：
 *   - 输入扩展名白名单（INPUT_OK），杜绝 .zip / .pdf 等被误转。
 *   - ffmpeg 沙箱只认产物目录内的相对名，一律用 basename 且前缀 `./`。
 *   - flux.ffmpeg 仅在 onDone 可用；未装 ffmpeg 组件则直接跳过。
 *
 * ⚠️ M1 阶段刻意保持与 1.8.0 逐字等价：remux 产物**不登记**（成为孤儿文件）。
 *    `flux.task.recordArtifact()` 登记放在 M4，与 ffprobe 预判容器一起做。
 */

/** 允许被 remux 的输入容器（其余一律跳过，避免损坏非媒体文件）。 */
const INPUT_OK = /\.(ts|mkv|webm|flv|m4v|mov|m2ts|mpeg|mpg|ogv)$/i;

function baseName(p: string | null | undefined): string {
  return String(p || "").split(/[\\/]/).pop() || "";
}

type DoneEvent = Extract<FluxEvent, { event: "done" }>;
type ErrorEvent = Extract<FluxEvent, { event: "error" }>;
type CancelEvent = Extract<FluxEvent, { event: "cancel" }>;

// ---- 失败日志：只记本插件经手的任务，避免对全应用的失败任务刷日志 ----
async function onError(ev: ErrorEvent): Promise<void> {
  try {
    if (!(await isHandled(ev && ev.taskId))) return;
    flux.logger.error("[m3u8-resolver] 任务失败 " + String((ev && ev.taskId) || "") + ": " + String((ev && ev.message) || ""));
    await unmarkHandled(ev && ev.taskId);
  } catch {
    /* 钩子异常不得外抛 */
  }
}

/**
 * 取消：同样是终态，清掉标记，避免它滞留到 TTL 过期。
 * onDone / onError 已各自清理，缺了这条时被用户取消的任务标记会一直留着：
 * 既占满 60 条上限，也可能让一个被复用的 taskId 被误判成「本插件经手」。
 */
async function onCancel(ev: CancelEvent): Promise<void> {
  try {
    if (await isHandled(ev && ev.taskId)) await unmarkHandled(ev && ev.taskId);
  } catch {
    /* 同上 */
  }
}

async function onDone(ev: DoneEvent): Promise<void> {
  try {
    if (!(await isHandled(ev && ev.taskId))) return;
    await unmarkHandled(ev && ev.taskId);

    const video = baseName(ev && ev.filePath);
    if (!video) return;

    const s = readSettings();

    // ---- ① 轨对合并失败兜底 ----
    // 核心在 url + audioUrl 成对返回时会自己做合并；muxed=false 且 audioPath 非空说明核心已降级
    // （留下独立音频文件）。两个文件同目录，可用相对名直接补做。
    if (s.fixMuxFallback && ev.audioPath && ev.muxed === false) {
      const audio = baseName(ev.audioPath);
      if (audio && audio !== video && flux.ffmpeg && INPUT_OK.test(video)) {
        if (/\.mp4$/i.test(video)) {
          flux.logger.warn("[m3u8-resolver] 轨对未合并，但视频已是 MP4，请自行检查音轨:", video);
        } else {
          const out = video.replace(/\.[^.]+$/, "") + ".mp4";
          flux.logger.warn("[m3u8-resolver] 核心未合并轨对，尝试 ffmpeg 兜底:", video, "+", audio, "->", out);
          const r = await flux.ffmpeg.run({
            args: [
              "-i",
              "./" + video,
              "-i",
              "./" + audio,
              "-map",
              "0:v:0",
              "-map",
              "1:a:0",
              "-c",
              "copy",
              "-movflags",
              "+faststart",
              "-y",
              "./" + out,
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
    if (!s.remuxToMp4) return;
    if (!flux.ffmpeg) return;
    if (/\.mp4$/i.test(video)) return; // 已是 mp4，无需处理
    if (!INPUT_OK.test(video)) return; // 非音视频容器，跳过

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
    } catch {
      /* 日志本身失败就算了 */
    }
  }
}

install("onError", onError);
install("onCancel", onCancel);
install("onDone", onDone);
