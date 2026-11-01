/** HTML 实体解码。顺序要紧：先解具体实体，最后解 `&amp;`，否则 `&amp;lt;` 会被误解成 `<`。 */
export function decodeEntities(s: string | null | undefined): string {
  return String(s == null ? "" : s)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&amp;/g, "&");
}

/** 通用文件名字符清洗：替换非法字符、空白压成单个空格，上限 200 字符，空串回落 "download"。 */
export function sanitize(s: string): string {
  return (
    String(s)
      .replace(/[\\/:*?"<>|\n\r\t]+/g, "_")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 200) || "download"
  );
}
