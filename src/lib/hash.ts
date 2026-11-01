/** FNV-1a 32 位 → 十六进制串。清单条目令牌与订阅 guid 共用同一定义。 */
export function fnv1a32(s: string): string {
  let h = 0x811c9dc5;
  const str = String(s);
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
  }
  return (h >>> 0).toString(16);
}
