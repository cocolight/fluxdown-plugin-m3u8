// FluxDown M3U8 插件 —— 钩子脚本（增强 A：下载后 remux 为 MP4）
// 触发条件：任务完成（onDone）且插件设置「remuxToMp4」开启（默认开）。
// 行为：仅当产物不是 .mp4 且属于常见音视频容器时，用 ffmpeg 无损转封装为 .mp4。
// 安全护栏：
//   - 不是本插件经手的任务（原始 URL 不含 m3u8）不会触发（见 manifest hooks.match）。
//   - 输入扩展名白名单，杜绝 .zip/.pdf 等被误转。
//   - flux.ffmpeg 仅在 onDone 可用，未装 ffmpeg 组件则直接跳过。

// 允许被 remux 的输入容器（其余一律跳过，避免损坏非媒体文件）
const INPUT_OK = /\.(ts|mkv|webm|flv|m4v|mov|m2ts|mpeg|mpg|ogv)$/i;

globalThis.onDone = async (ctx) => {
  if (!flux.settings.remuxToMp4) return; // 开关关闭
  if (!flux.ffmpeg) return;              // 未声明权限或未安装 ffmpeg 组件

  const name = ctx.filePath.split(/[\\/]/).pop();
  if (/\.mp4$/i.test(name)) return;      // 已是 mp4，无需处理
  if (!INPUT_OK.test(name)) return;      // 非音视频容器，跳过（保护 .zip/.pdf 等）

  const out = name.replace(/\.[^.]+$/, "") + ".mp4";
  flux.logger.info("[m3u8-resolver] onDone remux:", name, "->", out);

  const r = await flux.ffmpeg.run({
    args: ["-i", "./" + name, "-c", "copy", "-movflags", "+faststart", "-y", "./" + out],
  });
  if (r.code !== 0) {
    flux.logger.error("[m3u8-resolver] remux 失败 (code " + r.code + "):", (r.stderr || "").slice(-400));
  } else {
    flux.logger.info("[m3u8-resolver] remux 完成:", out);
  }
};
