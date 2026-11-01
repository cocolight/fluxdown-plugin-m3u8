/**
 * 设置读取 —— 一次读齐、强类型。
 *
 * v1.8.0 在 resolver.js:29-48 用 settingBool/settingStr/settingInt 三个函数按需读取，
 * 每个调用点都要自己带默认值，默认值散落在全文件（且与 manifest.json 有重复）。这里改为
 * 单一入口 `readSettings()`：默认值与 manifest 的 `default` 一一对应，缺失时行为不变。
 *
 * 容错口径沿用旧实现（**不要按 SDK 文档收紧**）：布尔值除 `true` 外还认 `"1"/"yes"/"on"`。
 * 沙箱里 number 型设置是字符串序列化的，故 number 一律 `parseInt`。
 */

export interface Settings {
  targetHosts: string;
  solveChallenge: boolean;
  followIframe: boolean;
  detectDash: boolean;
  iframeMaxFollow: number;
  detectSeries: boolean;
  manifestMinItems: number;
  manifestMaxItems: number;
  episodeLinkPattern: string;
  preferResolution: string;
  preferCodec: string;
  autoPick: boolean;
  separateAudio: string;
  audioLang: string;
  audioOnly: boolean;
  nameTemplate: string;
  authCookie: string;
  userAgent: string;
  extraHeadersRaw: string;
  ephemeral: boolean;
  useYtdlp: boolean;
  htmlFallbackYtdlp: boolean;
  remuxToMp4: boolean;
  fixMuxFallback: boolean;
  rangeCapKb: number;
}

function raw(key: string): string | number | boolean | null | undefined {
  const s = flux.settings;
  return s ? s[key] : undefined;
}

function str(key: string, def: string): string {
  const v = raw(key);
  if (v === undefined || v === null) return def;
  return String(v);
}

function bool(key: string, def: boolean): boolean {
  const v = raw(key);
  if (v === undefined || v === null || v === "") return def;
  if (typeof v === "boolean") return v;
  const s = String(v).trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes" || s === "on";
}

function int(key: string, def: number): number {
  const v = raw(key);
  if (v === undefined || v === null || v === "") return def;
  const n = parseInt(String(v), 10);
  return isNaN(n) ? def : n;
}

export function readSettings(): Settings {
  return {
    targetHosts: str("targetHosts", ""),
    solveChallenge: bool("solveChallenge", true),
    followIframe: bool("followIframe", true),
    detectDash: bool("detectDash", true),
    iframeMaxFollow: int("iframeMaxFollow", 1),
    detectSeries: bool("detectSeries", true),
    manifestMinItems: int("manifestMinItems", 3),
    manifestMaxItems: int("manifestMaxItems", 200),
    episodeLinkPattern: str("episodeLinkPattern", ""),
    preferResolution: str("preferResolution", "best"),
    preferCodec: str("preferCodec", "auto"),
    autoPick: bool("autoPick", false),
    separateAudio: str("separateAudio", "auto"),
    audioLang: str("audioLang", ""),
    audioOnly: bool("audioOnly", false),
    nameTemplate: str("nameTemplate", "{title} {host}"),
    authCookie: str("authCookie", ""),
    userAgent: str("userAgent", ""),
    extraHeadersRaw: str("extraHeadersRaw", ""),
    ephemeral: bool("ephemeral", false),
    useYtdlp: bool("useYtdlp", false),
    htmlFallbackYtdlp: bool("htmlFallbackYtdlp", true),
    remuxToMp4: bool("remuxToMp4", true),
    fixMuxFallback: bool("fixMuxFallback", true),
    rangeCapKb: int("rangeCapKb", 0),
  };
}
