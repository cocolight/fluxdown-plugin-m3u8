import type { FluxEvent } from "fluxdown-plugin-sdk";
import { install } from "../lib/install";
import { readSettings } from "../lib/settings";
import { isHandled, unmarkHandled } from "../lib/handled";
import { isMp4Family, probeFile, type ProbeResult } from "../lib/probe";

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
 *   - 输入扩展名白名单（INPUT_OK），杜绝 .zip / .pdf 等被误转；同时它也是「值得探测」的判据。
 *   - ffmpeg 沙箱只认产物目录内的相对名，一律用 basename 且前缀 `./`。
 *   - flux.ffmpeg 仅在 onDone 可用；未装 ffmpeg 组件则直接跳过。
 *
 * ★ M4 变更（2026-11-01）：
 *   1. 产物登记。remux / 合并产物此前是**孤儿文件** —— 用户删除任务时它不会被删，永久留在
 *      下载目录。现在每次成功写出后调 `flux.task.recordArtifact()`（仅 onDone 可用）。
 *   2. 容器探测。先用 `flux.ffprobe` 读真实容器与轨道，再决定是否转封装 —— 扩展名会骗人
 *      （fMP4 合并出来常叫 `.ts`，容器其实已是 MP4，整份 `-c copy` 纯属浪费）。
 *      探测失败一律退回扩展名判断，保证「探测不可用」与 v1.8.0 行为一致。
 */

/** 允许被 remux 的输入容器（其余一律跳过，避免损坏非媒体文件）。 */
const INPUT_OK = /\.(ts|mkv|webm|flv|m4v|mov|m2ts|mpeg|mpg|ogv)$/i;

function baseName(p: string | null | undefined): string {
  return String(p || "").split(/[\\/]/).pop() || "";
}

/**
 * ffmpeg 失败的日志文案。
 *
 * 为什么要区分超时：`flux.ffmpeg.run` 的默认 `timeoutMs` 是 5 分钟，超时返回的
 * `code` 是 `-1`（与「进程被杀死」共用一个哨兵值）。此时 ffmpeg 多半已经写出一个**半截**
 * 的 .mp4（`-y` 会先创建文件再填充），而调用方不清理它。只说「失败 (code -1)」用户无从判断，
 * 于是这里明确告诉他产物可能不完整、该删掉重来。
 *
 * 另外 `-c copy` 成功时也可能只写出容器外壳（源时间戳断裂是 HLS 合并产物的常见状态），
 * 故把 stderr 尾部一并带上，便于用户/我们判断是超时还是源本身有问题。
 */
function ffmpegFailLog(what: string, out: string, r: { code: number; timedOut?: boolean; stderr?: string }): void {
  const tail = String((r && r.stderr) || "").slice(-400);
  if (r && r.timedOut) {
    flux.logger.error(
      "[m3u8-resolver] " + what + "超时被终止（默认 5 分钟上限）：" + out + " 可能是不完整的半成品，建议删除后重试",
      tail,
    );
    return;
  }
  flux.logger.error("[m3u8-resolver] " + what + "失败 (code " + String(r && r.code) + "):", tail);
}

type DoneEvent = Extract<FluxEvent, { event: "done" }>;
type ErrorEvent = Extract<FluxEvent, { event: "error" }>;
type CancelEvent = Extract<FluxEvent, { event: "cancel" }>;

/**
 * 登记衍生产物。宿主口径（API 参考）：`name` 必须是保存目录下的裸文件名、以任务主文件主干
 * 开头、且文件必须已存在 —— 我们只登记自己刚写出的同主干文件，天然合规。
 * 即便 reject 也只记日志：文件已经可用，不该让整个钩子失败。
 */
async function registerArtifact(name: string): Promise<void> {
  const t = flux.task;
  if (!t || typeof t.recordArtifact !== "function") return;
  try {
    await t.recordArtifact(name);
    flux.logger.info("[m3u8-resolver] 已登记产物（删除任务时一并删除）:", name);
  } catch (e) {
    flux.logger.warn("[m3u8-resolver] 产物登记失败（文件本身可用，但删除任务不会删除它）:", name, String(e));
  }
}

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
 * 既占满上限，也可能让一个被复用的 taskId 被误判成「本插件经手」。
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
    const needMux = !!(s.fixMuxFallback && ev.audioPath && ev.muxed === false);
    if (!needMux && !s.remuxToMp4) return;
    if (!flux.ffmpeg) return; // 未安装/未授权 ffmpeg 组件：两条路径都用不上

    // 探测按需触发并只做一次：合并与转封装用的是同一个文件的同一条结论。
    let cached: ProbeResult | null | undefined;
    const probe = async (): Promise<ProbeResult | null> => {
      if (cached === undefined) {
        cached = INPUT_OK.test(video) ? await probeFile(video) : null; // 非候选容器根本不探
      }
      return cached;
    };

    // ---- ① 轨对合并失败兜底 ----
    // 核心在 url + audioUrl 成对返回时会自己做合并；muxed=false 且 audioPath 非空说明核心已降级
    // （留下独立音频文件）。两个文件同目录，可用相对名直接补做。
    if (needMux) {
      const audio = baseName(ev.audioPath);
      if (audio && audio !== video) {
        const p = await probe();
        if (p && p.hasAudio) {
          // 视频已自带音轨：再合一次只会多出一个同内容文件（且占用一份磁盘）。
          flux.logger.info("[m3u8-resolver] 视频已含音轨，跳过兜底合并:", video);
        } else if (/\.mp4$/i.test(video)) {
          flux.logger.warn("[m3u8-resolver] 轨对未合并，但视频已是 MP4，请自行检查音轨:", video);
        } else if (INPUT_OK.test(video)) {
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
            await registerArtifact(out);
            return; // 已产出 mp4，不再走下面的转封装
          }
          ffmpegFailLog("兜底合并", out, r);
        }
      }
    }

    // ---- ② 下载后 remux 为 MP4（增强 A）----
    if (!s.remuxToMp4) return;
    if (!INPUT_OK.test(video)) return; // 非音视频容器，跳过

    const p = await probe();
    if (p) {
      if (isMp4Family(p.format)) {
        // 扩展名说不是 MP4、容器其实已是 MP4 —— 旧版会白跑一次整文件复制。
        flux.logger.info("[m3u8-resolver] 容器已是 MP4 家族（" + p.format + "），无需转封装:", video);
        return;
      }
      if (!p.hasVideo) {
        // 纯音频（如 .mkv 里只有音轨）：转成 .mp4 只会得到无画面的文件。
        flux.logger.info("[m3u8-resolver] 文件无视频轨，跳过转封装:", video);
        return;
      }
    } else if (/\.mp4$/i.test(video)) {
      return; // 探测不可用时的旧判据：扩展名已是 mp4
    }

    const out = video.replace(/\.[^.]+$/, "") + ".mp4";
    flux.logger.info("[m3u8-resolver] onDone remux:", video, "->", out);

    const r = await flux.ffmpeg.run({
      args: ["-i", "./" + video, "-c", "copy", "-movflags", "+faststart", "-y", "./" + out],
    });
    if (r.code !== 0) {
      ffmpegFailLog("remux", out, r);
    } else {
      flux.logger.info("[m3u8-resolver] remux 完成:", out);
      await registerArtifact(out);
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
