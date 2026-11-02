/**
 * 失败归因 —— 纯函数，无 IO、无 fetch、无状态。
 *
 * 为什么需要：`failed` 阶段是引擎给插件的**最后一次**干预机会，拿到 `errorMessage`、
 * `httpStatus`、`autoRetryCount`。不给结论就等于放弃它，引擎按自己的默认策略处理。
 *
 * 关键判断：**默认策略通常是「重试」，而重试对一半的失败形态是纯粹的浪费** ——
 * 权限被撤要用户去改文件、磁盘满要用户去清空间、下载被取消是用户自己的意思，
 * 这些无论重试多少次都还是失败。所以本模块只对「重试真的可能改变结果」的形态给出
 * `retry`，其余显式返回 `null`，让引擎按原语义走。
 *
 * 三条纪律：
 *
 *   1. **不改变引擎默认语义**。想表达「不要重试」时也是返回 `null`，而不是返回
 *      `{ retry: false }` 之类的否定补丁 —— 我们没有被授权收窄引擎的重试策略。
 *   2. **不猜**。看起来像超时但文本里没有明确证据（`ETIMEDOUT` / `timed out` / `超时`）
 *      就归为 unknown 返回 null —— 误判成「可重试」会白费用户带宽，误判成「不可重试」
 *      会让本来能好的任务永久失败。两个方向都不划算。
 *   3. **重试次数有硬上限**。`autoRetryCount` 由引擎给，超过上限一律放手（返回 null），
 *      否则会把一个必然失败的任务变成无限重试。
 */

/** 失败类别。顺序即「越靠前越确定」，仅用于日志阅读，不参与判定。 */
export type FailureKind =
  | "network" // 连接类瞬时故障：重试有意义
  | "server" // 5xx：对端临时故障，重试有意义
  | "auth" // 401/403：凭据缺失或过期，重试无效
  | "missing" // 404/410：资源不在了，重试无效
  | "permission" // 本地权限 / 磁盘 / 文件系统：要用户动手
  | "codec" // 解密 / 容器 / 媒体格式：重试无效
  | "cancelled" // 用户取消：绝不自动重试
  | "interrupted" // 网络中断 / 连接被拒：属瞬时，重试有意义
  | "unknown"; // 认不出来，不给结论

export interface FailureVerdict {
  kind: FailureKind;
  /** 仅 `retry` 为 true 时填：建议的等待毫秒数。 */
  delayMs?: number;
  /** 给日志的一句话原因。 */
  reason: string;
}

/** 可重试类别的重试上限（按引擎给的 `autoRetryCount` 计）。3 次足够覆盖抖动。 */
const MAX_AUTO_RETRY = 3;

/** 瞬时网络错误的 errno 白名单。刻意不含 `ENOTFOUND`（域名解析失败多为硬错）。 */
const TRANSIENT_ERRNO: Record<string, number> = {
  ECONNRESET: 1,
  ECONNABORTED: 1,
  ECONNREFUSED: 1,
  ETIMEDOUT: 1,
  EPIPE: 1,
  EHOSTUNREACH: 1,
  ENETUNREACH: 1,
  EAI_AGAIN: 1,
};

/** 本地侧硬错：重试不会改变结果，需要用户处理。 */
const LOCAL_ERRNO: Record<string, string> = {
  EACCES: "没有写入权限",
  EPERM: "没有写入权限",
  EROFS: "目标目录是只读的",
  ENOSPC: "磁盘空间不足",
  ENAMETOOLONG: "文件名过长",
  EISDIR: "目标路径是个目录",
  ENOENT: "目标路径不存在",
};

/** 媒体层硬错特征（小写匹配）。命中即重试无效。 */
const CODEC_MARKERS: string[] = [
  "pkcs7",
  "unpad error",
  "decrypt",
  "invalid key",
  "key not found",
  "unsupported codec",
  "no video stream",
  "no audio stream",
  "invalid data found",
  "moov atom not found",
  "sample-aes",
  "keyformat",
  "drm",
];

/** 取消 / 中止的文本特征（小写匹配）。 */
const CANCEL_MARKERS: string[] = ["cancel", "aborted", "abort", "取消", "已停止", "用户终止"];

/** 超时特征（小写匹配）。 */
const TIMEOUT_MARKERS: string[] = ["timed out", "timeout", "etimedout", "超时"];

/**
 * 取错误码。
 *
 * 不能只取正则的**第一个**匹配：`read error: ECONNRESET` 里 `ERROR` 同样满足
 * `E[A-Z]{2,}`，先命中就会拿到 `ERROR` 这个不存在的码 —— 整条消息随之归类失败。
 * 所以扫出全部候选，只认白名单里的那个。
 *
 * 白名单是必须的第二个条件：它把「长得像 errno 的英文单词」全部挡在外面。
 */
function errnoOf(upper: string): string {
  const re = /\b(E[A-Z]{2,}[A-Z0-9]*)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(upper)) !== null) {
    const code = m[1];
    if (TRANSIENT_ERRNO[code] || LOCAL_ERRNO[code]) return code;
  }
  return "";
}

/**
 * 按 HTTP 状态码归类。`0` 与 `null` 视为「没有状态码」，交给文本判定。
 * 注意：`httpStatus` 只在 HTTP 层失败时才有值，媒体层与本地层错误恒为 0。
 */
function byStatus(status: number): FailureVerdict | null {
  if (!status) return null;
  if (status === 401 || status === 403) {
    return {
      kind: "auth",
      reason: `服务器返回 ${status}（凭据缺失、过期或站点拒绝），重试无效`,
    };
  }
  if (status === 404 || status === 410) {
    return {
      kind: "missing",
      reason: `服务器返回 ${status}（资源已不可用），重试无效`,
    };
  }
  if (status >= 500) {
    return {
      kind: "server",
      reason: `服务器返回 ${status}（对端临时故障）`,
      delayMs: 3000,
    };
  }
  if (status === 408 || status === 429) {
    return {
      kind: status === 408 ? "network" : "server",
      reason: `服务器返回 ${status}（${status === 408 ? "请求超时" : "被限流"}）`,
      delayMs: status === 429 ? 15000 : 3000,
    };
  }
  return null;
}

/** 按文本归类。调用方已确认没有可用的 HTTP 状态码。 */
function byText(lower: string): FailureVerdict {
  // 顺序有讲究：取消 > 媒体层 > 本地权限 > 瞬时网络 > 超时 > 未知。
  // 把「取消」放最前是因为它最容易误判成别的东西（"download cancelled: ECONNRESET"）。
  for (let i = 0; i < CANCEL_MARKERS.length; i++) {
    if (lower.indexOf(CANCEL_MARKERS[i]) >= 0) {
      return { kind: "cancelled", reason: "任务被取消，不自动重试" };
    }
  }

  for (let i = 0; i < CODEC_MARKERS.length; i++) {
    if (lower.indexOf(CODEC_MARKERS[i]) >= 0) {
      return {
        kind: "codec",
        reason: `媒体层失败（命中「${CODEC_MARKERS[i]}」），重试无效`,
      };
    }
  }

  const errno = errnoOf(lower.toUpperCase());
  if (errno && LOCAL_ERRNO[errno]) {
    return {
      kind: "permission",
      reason: `本地写入失败（${errno}：${LOCAL_ERRNO[errno]}），需处理后重下`,
    };
  }

  if (errno && TRANSIENT_ERRNO[errno]) {
    return {
      kind: errno === "ECONNREFUSED" || errno === "ECONNRESET" ? "interrupted" : "network",
      reason: `瞬时网络错误（${errno}）`,
      delayMs: 2000,
    };
  }

  for (let i = 0; i < TIMEOUT_MARKERS.length; i++) {
    if (lower.indexOf(TIMEOUT_MARKERS[i]) >= 0) {
      return { kind: "network", reason: "请求超时", delayMs: 3000 };
    }
  }

  return { kind: "unknown", reason: "认不出失败类型" };
}

/**
 * 判定一次失败要不要重试。
 *
 * 返回 `null` 表示「不给结论」——调用方应让拦截器返回 null，引擎按原语义处理。
 */
export function classifyFailure(
  errorMessage: string | null | undefined,
  httpStatus: number | null | undefined,
  autoRetryCount: number | null | undefined,
): FailureVerdict | null {
  const text = errorMessage === null || errorMessage === undefined ? "" : String(errorMessage);
  const lower = text.toLowerCase();
  const status = typeof httpStatus === "number" && isFinite(httpStatus) ? httpStatus : 0;

  const verdict = byStatus(status) || byText(lower);

  // 取消是用户的明确意思，任何情况下都不接管。
  if (verdict.kind === "cancelled") return null;

  // 只有这三类会被重试；其余一律放手。
  const retryable =
    verdict.kind === "network" || verdict.kind === "server" || verdict.kind === "interrupted";
  if (!retryable) return null;

  // 次数上限：引擎已经重试过 MAX_AUTO_RETRY 次还失败，说明不是抖动。
  const tries = typeof autoRetryCount === "number" && isFinite(autoRetryCount) ? autoRetryCount : 0;
  if (tries >= MAX_AUTO_RETRY) return null;

  return verdict;
}

/** 供测试与日志读到的常量，避免测试里重复写魔数。 */
export const FAILURE_LIMITS = { MAX_AUTO_RETRY } as const;
