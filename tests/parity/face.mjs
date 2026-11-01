/**
 * 把 resolver 返回值投影成「请求面」。
 *
 * 为什么需要这一层：v1.8.0 把所有下载请求头塞进 `extraHeaders`（一次性头表，作用于该任务的
 * 全部请求），M2 起改用 `request` 补丁（`referrer` / `userAgent` / `setHeaders` / `originHeaders`）。
 * 两者字段名不同、语义也不完全等价，直接逐字段比会全红，但**语义上该一致的部分**必须继续一致：
 *
 *   最终 Referer、最终 User-Agent、其余要下发的头、以及凭据头的取值。
 *
 * 这个投影只做「同义归并」，不做宽泛裁剪 —— 少比的只有「凭据作用域」（`*` 全部主机 vs
 * 具体 origin），那正是 M2 有意改变的部分，由 `tests/contract.mjs` 单独断言。
 */

const CRED_HEADERS = { cookie: 1, authorization: 1 };

/**
 * @param {any} v resolver 返回值
 * @returns {any} 可逐字段比对的结构
 */
export function requestFace(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return v;
  const hasLegacy = Object.prototype.hasOwnProperty.call(v, "extraHeaders");
  const hasPatch = Object.prototype.hasOwnProperty.call(v, "request");
  if (!hasLegacy && !hasPatch) return v; // subscribe / auth / manifest 结果：原样比

  const rest = {};
  for (const k of Object.keys(v)) {
    if (k === "extraHeaders" || k === "request") continue;
    rest[k] = v[k];
  }

  const face = { referrer: null, userAgent: null, headers: {}, credentials: {} };

  // v1.8.0 形态
  const eh = v.extraHeaders;
  if (eh && typeof eh === "object") {
    for (const k of Object.keys(eh)) {
      const lk = k.toLowerCase();
      if (lk === "referer") face.referrer = eh[k];
      else if (lk === "user-agent") face.userAgent = eh[k];
      else if (CRED_HEADERS[lk]) face.credentials[k] = eh[k];
      else face.headers[k] = eh[k];
    }
  }

  // M2 形态
  const rp = v.request;
  if (rp && typeof rp === "object") {
    if (rp.referrer !== undefined) face.referrer = rp.referrer;
    if (rp.userAgent !== undefined) face.userAgent = rp.userAgent;
    if (rp.setHeaders && typeof rp.setHeaders === "object") {
      for (const k of Object.keys(rp.setHeaders)) face.headers[k] = rp.setHeaders[k];
    }
    if (Array.isArray(rp.originHeaders)) {
      for (const oh of rp.originHeaders) {
        const h = (oh && oh.headers) || {};
        for (const k of Object.keys(h)) face.credentials[k] = h[k];
      }
    }
  }

  return { ...rest, requestFace: face };
}

/** 凭据会被附加到哪些主机（`"*"` = 全部，v1.8.0 的 extraHeaders 语义）。仅契约测试用。 */
export function credentialScope(v) {
  if (!v || typeof v !== "object") return [];
  if (v.request && Array.isArray(v.request.originHeaders) && v.request.originHeaders.length) {
    return v.request.originHeaders.map((o) => o.origin);
  }
  const eh = v.extraHeaders;
  if (eh && typeof eh === "object") {
    for (const k of Object.keys(eh)) {
      const lk = k.toLowerCase();
      if (CRED_HEADERS[lk] && eh[k]) return ["*"];
    }
  }
  return [];
}
