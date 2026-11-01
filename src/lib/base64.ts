/**
 * UTF-8 字符串 → base64。
 *
 * 为什么不是一行 `btoa(s)`：`btoa` 只接受「每个字符 ≤ 0xFF」的二进制字符串，直接把中文
 * 用户名塞进去会抛 InvalidCharacterError，而 Basic 凭据里的用户名完全可能含非 ASCII
 * （`tests/parity/scenarios.mjs` 的 basic 用例就是「用户」+「p@ss」）。沙箱又没有
 * `TextEncoder` / `Buffer`，所以 UTF-8 编码必须手写。
 *
 * 关于 `btoa` 本身：v1.8.0 在 QuickJS 里实测为 undefined（因此当年手写了编码器），而
 * 现在的官方「JavaScript 运行环境」文档把它列进了可用列表 —— 两份结论冲突，尚未装机复验。
 * 因此保留字符表兜底：有 `btoa` 走原生，没有就走表。装机确认 `btoa` 存在后，删掉
 * `encodeViaTable` 即可（其余部分仍需保留，UTF-8 前置编码与 btoa 无关）。
 */

const TABLE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** 字符串 → UTF-8 字节序列（含代理对，逐个码点编码）。 */
function utf8Bytes(s: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const cp = 0x10000 + ((c - 0xd800) << 10) + (s.charCodeAt(++i) - 0xdc00);
      out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    } else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}

/** 字节序列 → 「每字符一字节」的二进制字符串（btoa 的输入形态）。 */
function toBinary(bytes: number[]): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
  return out;
}

function encodeViaTable(bin: string): string {
  let out = "";
  for (let i = 0; i < bin.length; i += 3) {
    const b0 = bin.charCodeAt(i);
    const b1 = i + 1 < bin.length ? bin.charCodeAt(i + 1) : -1;
    const b2 = i + 2 < bin.length ? bin.charCodeAt(i + 2) : -1;
    out += TABLE[b0 >> 2];
    out += TABLE[((b0 & 3) << 4) | (b1 < 0 ? 0 : b1 >> 4)];
    out += b1 < 0 ? "=" : TABLE[((b1 & 15) << 2) | (b2 < 0 ? 0 : b2 >> 6)];
    out += b2 < 0 ? "=" : TABLE[b2 & 63];
  }
  return out;
}

export function base64Utf8(input: string): string {
  const bin = toBinary(utf8Bytes(String(input == null ? "" : input)));
  const native = (globalThis as unknown as { btoa?: (s: string) => string }).btoa;
  if (typeof native === "function") {
    try {
      return native(bin);
    } catch {
      // 原生实现异常（个别 polyfill 对高位字节报错）→ 落到字符表
    }
  }
  return encodeViaTable(bin);
}
