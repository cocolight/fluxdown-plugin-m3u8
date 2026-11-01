/**
 * 去广告规则文本的**编辑器侧**校验 —— 与拦截器实际生效的解析器同源（都走 `parseAdRuleSet`）。
 *
 * 为什么单独一层而不是直接复用 `parseAdRuleSet` 的 `error`：那个字符串把三类问题拼在一起，
 * 而设置页要对它们区别对待 ——
 *
 *   1. **JSON 语法错 / 顶层不是对象**：人还没写完，保存下去只会让规则静默失效 → **拦住**。
 *   2. **单条规则非法**（正则写坏、超长、超条数）：运行时已经容错跳过其余规则 → 只**警告**。
 *   3. **未知键**（写成 `dropPaths` 这类复数）：运行时完全不报，规则静默不生效 —— 这是最隐蔽的
 *      一种，`parseAdRuleSet` 不管，只能在这里补。**警告**。
 *
 * 模式为 `off` 时规则本就不生效，但**不阻止保存**：用户常常先关掉去广告、再来慢慢改规则，
 * 这时把人挡在门外只会逼他去别处改坏值。语法错降级为警告，提示里说明「当前不生效」。
 */

import { parseAdRuleSet } from "./adrules";

/** 三个合法键；其余键一律视为拼写错误并警告。 */
const KNOWN_KEYS = ["keepPath", "dropPath", "dropHosts"];

export interface RuleCheck {
  /** 非 null 表示不该保存（语法错或顶层类型错），内容直接给用户看。 */
  blocked: string | null;
  /** 可以保存，但有一部分规则不会生效。 */
  warning: string | null;
  /** 解析后实际生效的条数。 */
  keep: number;
  drop: number;
  hosts: number;
}

const EMPTY: RuleCheck = { blocked: null, warning: null, keep: 0, drop: 0, hosts: 0 };

function errText(e: unknown): string {
  return String((e && (e as Error).message) || e);
}

function push(current: string | null, extra: string): string {
  return current ? current + "；" + extra : extra;
}

/**
 * 校验一段规则文本。`mode` 只影响提示措辞，不改变是否解析 —— `off` 模式下的规则仍然会被
 * 解析，这样用户在关闭状态下改好规则、切回 marker 时就立刻生效，不会「改了半天白改」。
 */
export function checkAdRules(mode: string, extra: string): RuleCheck {
  const raw = String(extra || "").trim();
  if (!raw) return EMPTY;

  const m = String(mode || "off").trim().toLowerCase();
  const off = m === "off";

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    const text = "JSON 语法错误：" + errText(e);
    return { blocked: off ? null : text, warning: off ? text + "（当前模式为关闭，规则不生效）" : null, keep: 0, drop: 0, hosts: 0 };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    const text = "顶层必须是 JSON 对象，例如 { \"dropPath\": [\"/ads/\"] }";
    return { blocked: off ? null : text, warning: off ? text + "（当前模式为关闭，规则不生效）" : null, keep: 0, drop: 0, hosts: 0 };
  }

  // 未知键：运行时静默忽略，是「规则写了却不生效」最常见的原因。
  let warning: string | null = null;
  const unknown = Object.keys(parsed as Record<string, unknown>).filter((k) => KNOWN_KEYS.indexOf(k) < 0);
  if (unknown.length) {
    warning = push(warning, `未知键 ${unknown.join("、")} 不会生效；可用键只有 ${KNOWN_KEYS.join(" / ")}`);
  }

  // 传 "marker" 而不是真实 mode：`parseAdRuleSet` 在 off 时会跳过解析，
  // 那样这里就拿不到规则级的错误了。它只读 mode 是否等于 off，别的值一律按原样解析。
  const rules = parseAdRuleSet("marker", raw);
  if (rules.error) warning = push(warning, rules.error);
  if (off) warning = push(warning, "当前模式为关闭，以下规则暂不生效");

  return { blocked: null, warning, keep: rules.keepPath.length, drop: rules.dropPath.length, hosts: rules.dropHosts.length };
}

/** 生效条数多于原始条数说明有重复项被合并（dropHosts 会去重），这里只做展示用的一句概括。 */
export function summarizeRuleCount(c: RuleCheck): string {
  const total = c.keep + c.drop + c.hosts;
  if (!total) return "无自定义规则";
  const bits: string[] = [];
  if (c.keep) bits.push(`白名单 ${c.keep} 条`);
  if (c.drop) bits.push(`黑名单 ${c.drop} 条`);
  if (c.hosts) bits.push(`广告主机 ${c.hosts} 个`);
  return bits.join("，");
}
