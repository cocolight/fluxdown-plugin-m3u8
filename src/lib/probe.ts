/**
 * 容器探测（M4）：用 ffprobe 读真实容器与轨道，替代「按扩展名猜」。
 *
 * 为什么值得多一次进程调用：
 *   1. **扩展名会骗人**。HLS 的 fMP4 分片合并出来的文件常被命名成 `.ts`，容器其实已经是 MP4；
 *      v1.8.0 会对它整份文件做一次 `-c copy` 复制 —— 大文件几十秒白等，还可能因时间戳问题失败。
 *      反过来 `.mkv` 里装的若是 MP4，同样不必转。
 *   2. **轨道对任务**里视频文件可能已自带音轨，此时再合并只会产出冗余文件。
 *
 * 失败即退：ffprobe 缺失 / 退出码非零 / stdout 被截断 / JSON 非法，一律返回 null，调用方退回
 * v1.8.0 的扩展名判断。探测是增强，不能成为新的失败点 —— 它失败时用户得到的必须和旧版一样。
 *
 * 牢笼约束：ffprobe 与 ffmpeg 共用同一个 `onDone` 工作目录与参数筛查，因此文件名一律
 * basename + `./` 前缀，参数里不得出现绝对路径。
 */

export interface ProbeResult {
  /** `format.format_name`，如 `mov,mp4,m4a,3gp,3g2,mj2`（QuickTime 家族共用一个解复用器）。 */
  format: string;
  hasVideo: boolean;
  hasAudio: boolean;
}

/** 与 `mp4` 目标容器同族、无需转封装的解复用器名（`-c copy` 到 mp4 只会原地重写）。 */
const MP4_FAMILY: Record<string, 1> = {
  mov: 1,
  mp4: 1,
  m4a: 1,
  m4v: 1,
  "3gp": 1,
  "3g2": 1,
  mj2: 1,
  ipod: 1,
  psp: 1,
};

/** ffprobe 参数。`-v error` 压掉版本横幅，JSON 只为解析。 */
export function probeArgs(file: string): string[] {
  return [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    "./" + file,
  ];
}

/** 解析 ffprobe 的 JSON 输出；结构不合预期时返回 null（不抛）。 */
export function parseProbe(stdout: string): ProbeResult | null {
  let d: unknown;
  try {
    d = JSON.parse(String(stdout || ""));
  } catch {
    return null;
  }
  if (!d || typeof d !== "object") return null;
  const o = d as Record<string, unknown>;

  const fmtObj = o.format;
  const format =
    fmtObj && typeof fmtObj === "object" ? String((fmtObj as Record<string, unknown>).format_name || "") : "";

  const streams = Array.isArray(o.streams) ? o.streams : [];
  let hasVideo = false;
  let hasAudio = false;
  for (const raw of streams) {
    if (!raw || typeof raw !== "object") continue;
    const st = raw as Record<string, unknown>;
    const kind = String(st.codec_type || "");
    // 封面图（mp3/m4a 的 attached_pic）在 ffprobe 里也是 "video" 流，别把它当视频轨。
    const disp = st.disposition;
    const attached =
      disp && typeof disp === "object" && Number((disp as Record<string, unknown>).attached_pic || 0) === 1;
    if (kind === "video" && !attached) hasVideo = true;
    else if (kind === "audio") hasAudio = true;
  }
  if (!format && !hasVideo && !hasAudio) return null;
  return { format, hasVideo, hasAudio };
}

/** 该容器是否已是 MP4 家族（转封装无收益）。 */
export function isMp4Family(format: string): boolean {
  const parts = String(format || "").toLowerCase().split(",");
  for (const p of parts) if (MP4_FAMILY[p.trim()]) return true;
  return false;
}

/**
 * 探测一个已完成文件。返回 null 表示「探测不可用或结论不明」，调用方必须回退到扩展名判断。
 * 不做缓存 —— 缓存由调用方按需做（一次 onDone 内可能要用两次）。
 */
export async function probeFile(file: string): Promise<ProbeResult | null> {
  const fp = flux.ffprobe;
  if (!fp || typeof fp.run !== "function") return null; // 未声明 ffmpeg 权限，或宿主未提供 ffprobe
  try {
    const r = await fp.run({ args: probeArgs(file) });
    if (!r || r.code !== 0) return null;
    // stdout 超 256 KB 会被截断 —— 截断的 JSON 解析必然失败，此处显式拒绝以防「半个对象」。
    if (r.truncatedStdout) return null;
    return parseProbe(r.stdout);
  } catch {
    return null; // ffprobe 未安装 / 参数被筛查 / 宿主拒绝
  }
}
