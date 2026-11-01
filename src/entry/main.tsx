/**
 * `main` 入口 —— 可移植设置页签「去广告规则」。
 *
 * 它替代不了什么、也不替代什么：`contributes.views` 里 `location: "settings"` 的视图是
 * **在自动生成的「基础设置」页签旁边多加一个页签**（官方视图参考与可移植界面指南两处都这么写），
 * 不是替换。所以这里只做基础设置表单做不了的两件事：
 *
 *   1. **规则的即时校验** —— 基础表单里 `adRulesExtra` 只是一个 textarea，写错正则、拼错键名
 *      都要等到下次下载、翻日志才知道。这里当场解析、当场说清楚「哪一条没生效、为什么」。
 *   2. **预设档位** —— 把「从保守到激进」的四种规则形态做成按钮，省得手抄 JSON。
 *
 * 三条实现纪律：
 *   - **JSX 用 SDK 的 `ui/jsx-runtime`**：该运行时会被 esbuild 内联进 `dist/main.js`，属
 *     AGPL-3.0-or-later 代码随产物分发。这是**有意为之**，不是疏忽：授权义务登记在
 *     `THIRD-PARTY.md`，决策与代价见 `.agents/adr/0005-allow-sdk-jsx-runtime.md`。
 *   - **规则解析与拦截器同源**：一律走 `lib/adrules.ts`，不在视图里另写一套判定，否则会出现
 *     「设置页说能生效、实际没生效」。
 *   - **不改基础设置页签的值**：只有用户按「保存」才写库，其他时候一律是草稿。
 */

import type { MainFlux, Tone, ViewEvent } from "fluxdown-plugin-sdk";
import { AD_PRESETS, findPreset } from "../lib/adpresets";
import { checkAdRules, summarizeRuleCount } from "../lib/rulecheck";

const VIEW_ID = "ad-rules";

/** 与 manifest `settings[adRulesMode].options` 保持一致；值不在其中时一律按 off 处理。 */
const MODES = ["off", "marker", "heuristic"];
const MODE_OPTIONS = [
  { value: "off", label: "关闭" },
  { value: "marker", label: "仅按广告标记（保守）" },
  { value: "heuristic", label: "标记 + 推测（激进）" },
];

interface Notice {
  tone: Tone;
  text: string;
}

interface State {
  /** 草稿：正在编辑的模式与规则文本。 */
  mode: string;
  extra: string;
  /** 已保存的值，用于判断「有没有未保存改动」与「还原」的落点。 */
  savedMode: string;
  savedExtra: string;
  notice: Notice | null;
}

function str(v: unknown, def = ""): string {
  if (v === undefined || v === null) return def;
  return String(v);
}

function normMode(v: unknown): string {
  const s = str(v).trim().toLowerCase();
  return MODES.indexOf(s) >= 0 ? s : "off";
}

function errText(e: unknown): string {
  return String((e && (e as Error).message) || e);
}

/** 事件节点的 id 形如 `root/preset-dirs`；只取最后一段分发（官方推荐做法）。 */
function keyOf(ev: ViewEvent): string {
  const s = str(ev.node);
  const i = s.lastIndexOf("/");
  return i < 0 ? s : s.slice(i + 1);
}

/**
 * 注册视图。
 *
 * 为什么不像四个无状态入口那样用 `install()`：`main` 不需要挂全局函数名，它是被引擎
 * **求值一次**的常驻脚本，注册发生在求值过程中（等价于 SDK 的 `defineMain`，但省掉那层
 * 入口包装）。不导出：本文件在顶层就完成注册，import 它就等于要求有个 `flux` 在场，
 * 单测一律通过 vm 跑 `dist/main.js`。
 */
function register(flux: MainFlux): void {
  function readCurrent(): { mode: string; extra: string } {
    const s = flux.settings;
    return { mode: normMode(s.adRulesMode), extra: str(s.adRulesExtra) };
  }

  async function persist(state: State): Promise<void> {
    const check = checkAdRules(state.mode, state.extra);
    if (check.blocked) {
      state.notice = { tone: "danger", text: "未保存：" + check.blocked };
      return;
    }
    try {
      // 值必须是字符串，即使是 number/boolean 类型的设置；这两项本来就都是字符串。
      await flux.settings.update({ adRulesMode: state.mode, adRulesExtra: state.extra });
      state.savedMode = state.mode;
      state.savedExtra = state.extra;
      state.notice = {
        tone: "success",
        text: "已保存。规则在下一次开始下载时生效；已在下载中的任务不受影响。",
      };
    } catch (e) {
      // 引擎的校验错误是原文（例如「未知设置项」），原样给用户看，不要改写。
      state.notice = { tone: "danger", text: "保存失败：" + errText(e) };
    }
  }

  flux.ui.view<State>(VIEW_ID, {
    init: (): State => {
      const cur = readCurrent();
      return { mode: cur.mode, extra: cur.extra, savedMode: cur.mode, savedExtra: cur.extra, notice: null };
    },

    render: (state: State) => {
      const check = checkAdRules(state.mode, state.extra);
      const dirty = state.mode !== state.savedMode || state.extra !== state.savedExtra;
      const ruleCount = summarizeRuleCount(check);
      const modeLabel = (MODE_OPTIONS.filter((o) => o.value === state.mode)[0] || MODE_OPTIONS[0]).label;

      return (
        <stack gap="md" padding="md">
          <heading text="去广告规则" level={2} />
          <text
            text="去广告在下载开始前按播放列表丢弃广告分片，只对本插件解析出来的任务生效。这里改的是「怎么判广告」，与基础设置页签里的同一项设置等价。"
            tone="muted"
            size="sm"
          />

          <section key="sec-mode" title="① 模式">
            <select key="mode" options={MODE_OPTIONS} value={state.mode} />
            <kv
              items={[
                { key: "当前模式", value: modeLabel },
                { key: "自定义规则", value: ruleCount },
              ]}
            />
            {state.mode === "off" ? (
              <callout
                key="off-tip"
                tone="neutral"
                text="已关闭：下载时不丢弃任何分片，下面填的规则也不会生效。"
              />
            ) : null}
          </section>

          <section
            key="sec-presets"
            title="② 预设"
            description="点一下套用到下方草稿，仍需按「保存」才写库。档位越靠后丢得越多。"
          >
            {AD_PRESETS.map((p) => (
              <stack key={"preset-" + p.id} direction="row" gap="sm" align="center">
                <button key={"apply-" + p.id} text={p.label} variant="outline" />
                <text text={p.note} tone="muted" size="xs" />
              </stack>
            ))}
          </section>

          <section
            key="sec-rules"
            title="③ 自定义规则（JSON）"
            description="三个可选键：keepPath（白名单，命中即永不丢弃）、dropPath（黑名单，命中即丢）、dropHosts（广告分片主机名，精确相等才丢）。留空表示只用内置判定。"
          >
            <textarea
              key="extra"
              value={state.extra}
              rows={8}
              placeholder={'{ "dropPath": ["/ads/"] }'}
            />
            {check.blocked ? (
              <callout key="rule-error" tone="danger" title="这段规则不能保存" text={check.blocked} />
            ) : null}
            {!check.blocked && check.warning ? (
              <callout key="rule-warn" tone="warning" title="部分规则不会生效" text={check.warning} />
            ) : null}
            {!check.blocked && !check.warning && str(state.extra).trim() ? (
              <callout key="rule-ok" tone="success" text={"规则解析通过：" + ruleCount} />
            ) : null}
          </section>

          <divider />

          <stack key="actions" direction="row" gap="sm" align="center">
            <button key="save" text="保存" variant="primary" disabled={!dirty} />
            <button key="reset" text="还原" disabled={!dirty} />
            <text
              key="dirty-hint"
              text={dirty ? "有未保存的改动" : "与已保存的值一致"}
              tone={dirty ? "warning" : "muted"}
              size="xs"
            />
          </stack>

          {state.notice ? (
            <callout
              key="notice"
              tone={state.notice.tone}
              title={state.notice.tone === "success" ? "已保存" : "提示"}
              text={state.notice.text}
            />
          ) : null}
        </stack>
      );
    },

    event: async (state: State, ev: ViewEvent): Promise<void> => {
      const key = keyOf(ev);

      if (ev.type === "change") {
        if (key === "mode") {
          state.mode = normMode(ev.value);
          state.notice = null;
          return;
        }
        if (key === "extra") {
          state.extra = str(ev.value);
          state.notice = null;
          return;
        }
        return;
      }

      if (ev.type !== "press") return;

      if (key === "save") {
        await persist(state);
        return;
      }
      if (key === "reset") {
        state.mode = state.savedMode;
        state.extra = state.savedExtra;
        state.notice = { tone: "neutral", text: "已还原为上次保存的内容。" };
        return;
      }

      // 预设按钮：`apply-<presetId>`。
      if (key.indexOf("apply-") === 0) {
        const preset = findPreset(key.slice("apply-".length));
        if (!preset) return;
        state.mode = preset.mode;
        state.extra = preset.extra;
        state.notice = { tone: "info", text: "已套用预设「" + preset.label + "」，按「保存」才会写入。" };
      }
    },
  });
}

// 引擎在启动 `main` 时已注入全局 `flux`；安装时的编译检查不包含 `main`（按需编译），
// 所以这里在顶层取用是安全的。等价于 `defineMain(setup)` 去掉那层包装。
register(flux as unknown as MainFlux);
