/**
 * `main` 入口 —— 可移植设置页签。
 *
 * 定位：**给使用者看的设置页**。宿主的「基础设置」页签是把 manifest 的 `settings[]` 平铺成
 * 一长列表单 —— 27 项、近 3000 字说明，对普通用户就是一堵墙；而且引擎的 `SettingField`
 * 是 `deny_unknown_fields`，**没有 group / advanced 字段**，所以那种平铺在宿主侧无法折叠、
 * 无法分组。这里做的就是把「一堵墙」变成「两层」：
 *
 *   - **常用（默认）**：用户真会改的十来项，按场景分组，每项一句话说明。
 *   - **专业（开关打开后）**：站点适配、剧集识别、编码音轨、下载行为等调参项。
 *
 * 三条实现纪律：
 *   - **JSX 用 SDK 的 `ui/jsx-runtime`**：该运行时会被 esbuild 内联进 `dist/main.js`，属
 *     AGPL-3.0-or-later 代码随产物分发。这是**有意为之**，不是疏忽：授权义务登记在
 *     `THIRD-PARTY.md`，决策与代价见 `.agents/adr/0005-allow-sdk-jsx-runtime.md`。
 *   - **只写改动过的键**：一次「保存」只调用一次 `settings.update`，载荷里不出现没动过的项 ——
 *     避免把用户在别处改的值覆盖回草稿。
 *   - **规则校验与拦截器同源**：`adRulesExtra` 一律走 `lib/rulecheck.ts`（内部再走 `adrules`），
 *     不在视图里另写判定，否则会出现「设置页说能生效、实际没生效」。
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

/** 四项 select 的取值必须与 manifest 的 `options` 完全一致，否则保存后宿主会回退到默认值。 */
const RESOLUTION_OPTIONS = [
  { value: "best", label: "最高码率" },
  { value: "1080", label: "1080p" },
  { value: "720", label: "720p" },
  { value: "480", label: "480p" },
  { value: "360", label: "360p" },
];

const SEPARATE_OPTIONS = [
  { value: "auto", label: "自动判断" },
  { value: "on", label: "总是分离" },
  { value: "off", label: "关闭" },
];

const CODEC_OPTIONS = [
  { value: "auto", label: "自动" },
  { value: "avc", label: "H.264 / AVC（兼容性好）" },
  { value: "hevc", label: "H.265 / HEVC（体积小）" },
  { value: "av01", label: "AV1" },
  { value: "vp9", label: "VP9" },
];

type FieldType = "switch" | "text" | "number" | "select" | "textarea";

interface Field {
  key: string;
  label: string;
  type: FieldType;
  hint?: string;
  options?: Array<{ value: string; label: string }>;
  rows?: number;
}

interface Group {
  id: string;
  title: string;
  /** 专业设置才显示的分组。 */
  expert?: boolean;
  fields: Field[];
}

/**
 * 设置项清单（视图侧元数据）。`key` 必须与 manifest 的 `settings[].key` 一一对应 ——
 * 写错一个键，用户在页面上改完保存会收到宿主的「未知设置项」错误（原文透传，不吞）。
 */
const GROUPS: Group[] = [
  {
    id: "quality",
    title: "画质与命名",
    fields: [
      { key: "preferResolution", label: "画质", type: "select", options: RESOLUTION_OPTIONS },
      { key: "autoPick", label: "自动选最高画质", type: "switch", hint: "关掉后每次下载前弹窗让你自己挑" },
      { key: "nameTemplate", label: "文件命名", type: "text", hint: "留空 = 「标题-清晰度」；支持 {title} {author} {quality} 等占位" },
    ],
  },
  {
    id: "access",
    title: "登录与请求头",
    fields: [
      {
        key: "authCookie",
        label: "登录凭据",
        type: "textarea",
        rows: 4,
        hint: "只发给同一站点的请求。支持 Cookie 原文、bearer:令牌、basic:用户名:密码、多行「键: 值」",
      },
      { key: "userAgent", label: "User-Agent", type: "text", hint: "留空用 FluxDown 默认；部分站点按 UA 给不同清晰度" },
      { key: "extraHeadersRaw", label: "额外请求头", type: "textarea", rows: 3, hint: "每行「键: 值」，以 # 开头为注释；同名头会覆盖自动推导的 Referer" },
    ],
  },
  {
    id: "audio",
    title: "音轨",
    fields: [
      { key: "separateAudio", label: "独立音轨", type: "select", options: SEPARATE_OPTIONS },
      { key: "audioOnly", label: "只要音频", type: "switch", hint: "跳过视频，只下音轨" },
    ],
  },
  {
    id: "post",
    title: "下载后处理",
    fields: [
      { key: "remuxToMp4", label: "转成 MP4", type: "switch", hint: "容器不标准时无损转封装，多花一点时间" },
      { key: "useYtdlp", label: "复杂站点交给 yt-dlp", type: "switch", hint: "内置解析抓不到时改用 yt-dlp 重试，需已安装该组件" },
    ],
  },
  {
    id: "hosts",
    title: "站点适配",
    expert: true,
    fields: [
      { key: "targetHosts", label: "只在这些站点生效", type: "text", hint: "逗号分隔的主机名；留空 = 对所有站点生效" },
      { key: "solveChallenge", label: "自动过「安全检查」页", type: "switch", hint: "遇到防抓页时解出 Cookie 并重试一次" },
      { key: "followIframe", label: "跟随内嵌播放器", type: "switch", hint: "页面里没有 m3u8 时跟进 iframe 再找" },
      { key: "iframeMaxFollow", label: "内嵌最多跟进几层", type: "number", hint: "1–3，默认 1" },
      { key: "detectDash", label: "识别 DASH 清单", type: "switch", hint: "页面只给 .mpd 时也能发现" },
      { key: "htmlFallbackYtdlp", label: "抓到网页时用 yt-dlp 兜底", type: "switch" },
    ],
  },
  {
    id: "series",
    title: "剧集识别",
    expert: true,
    fields: [
      { key: "detectSeries", label: "识别剧集页", type: "switch", hint: "命中时弹选集框" },
      { key: "manifestMinItems", label: "判为剧集的最少条目", type: "number", hint: "低于此数不弹选集" },
      { key: "manifestMaxItems", label: "选集框最多列几条", type: "number" },
      { key: "episodeLinkPattern", label: "自定义剧集链接正则", type: "text", hint: "留空用内置规则" },
    ],
  },
  {
    id: "codec",
    title: "编码与音轨细节",
    expert: true,
    fields: [
      { key: "preferCodec", label: "编码偏好", type: "select", options: CODEC_OPTIONS },
      { key: "audioLang", label: "音轨语言", type: "text", hint: "留空不限" },
    ],
  },
  {
    id: "download",
    title: "下载行为",
    expert: true,
    fields: [
      { key: "ephemeral", label: "一次性签名链接", type: "switch", hint: "跳过元数据探测，直接下" },
      { key: "rangeCapKb", label: "单次 Range 上限（KiB）", type: "number", hint: "0 = 不限制；低于 64 按关闭处理" },
      { key: "fixMuxFallback", label: "合并失败时插件兜底", type: "switch", hint: "音视频分轨下载后合并失败，用 ffmpeg 再试一次" },
    ],
  },
];

/** 去广告分组在页面上单独渲染（它有预设按钮与即时校验），其余分组走通用渲染。 */
const AD_GROUP_MODE = "adRulesMode";
const AD_GROUP_EXTRA = "adRulesExtra";

interface Notice {
  tone: Tone;
  text: string;
}

interface State {
  /** 草稿：键 → 字符串值（开关用 "true"/"false"，与宿主要求一致）。 */
  draft: Record<string, string>;
  /** 已保存的快照，用于判断脏值与「还原」。 */
  saved: Record<string, string>;
  /** 视图自己的展开状态，不进设置。 */
  expertOpen: boolean;
  notice: Notice | null;
}

function str(v: unknown, def = ""): string {
  if (v === undefined || v === null) return def;
  return String(v);
}

function boolStr(v: unknown): string {
  if (typeof v === "boolean") return v ? "true" : "false";
  const s = String(v == null ? "" : v).trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes" || s === "on" ? "true" : "false";
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

/** 所有需要进草稿的键：manifest 里除 expertMode 之外的 26 项 + expertMode 自己。 */
const ALL_FIELDS: Field[] = GROUPS.reduce<Field[]>((acc, g) => acc.concat(g.fields), []);

function readDraft(settings: Record<string, unknown>): Record<string, string> {
  const d: Record<string, string> = {};
  for (const f of ALL_FIELDS) {
    d[f.key] = f.type === "switch" ? boolStr(settings[f.key]) : str(settings[f.key]);
  }
  d[AD_GROUP_MODE] = normMode(settings[AD_GROUP_MODE]);
  d[AD_GROUP_EXTRA] = str(settings[AD_GROUP_EXTRA]);
  d.expertMode = boolStr(settings.expertMode);
  return d;
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
  async function persist(state: State): Promise<void> {
    // 只有 adRulesExtra 会让整次保存被拦下：其它项即便规则写坏也不影响它们本身。
    const check = checkAdRules(state.draft[AD_GROUP_MODE], state.draft[AD_GROUP_EXTRA]);
    const extraDirty = state.draft[AD_GROUP_EXTRA] !== state.saved[AD_GROUP_EXTRA];
    if (check.blocked && extraDirty) {
      state.notice = { tone: "danger", text: "未保存：去广告规则有问题 —— " + check.blocked };
      return;
    }

    const patch: Record<string, string> = {};
    for (const k in state.draft) {
      if (Object.prototype.hasOwnProperty.call(state.draft, k) && state.draft[k] !== state.saved[k]) {
        patch[k] = state.draft[k];
      }
    }
    if (!Object.keys(patch).length) {
      state.notice = { tone: "neutral", text: "没有改动。" };
      return;
    }

    try {
      // 值必须是字符串，即使是 number/boolean 类型的设置；草稿里已统一成字符串。
      await flux.settings.update(patch);
      state.saved = {};
      for (const k in state.draft) {
        if (Object.prototype.hasOwnProperty.call(state.draft, k)) state.saved[k] = state.draft[k];
      }
      const n = Object.keys(patch).length;
      state.notice = {
        tone: "success",
        text: "已保存 " + n + " 项。下载相关的改动在下一次开始任务时生效；已在下载中的任务不受影响。",
      };
    } catch (e) {
      // 引擎的校验错误是原文（例如「未知设置项」），原样给用户看，不要改写。
      state.notice = { tone: "danger", text: "保存失败：" + errText(e) };
    }
  }

  flux.ui.view<State>(VIEW_ID, {
    init: (): State => {
      const draft = readDraft(flux.settings as unknown as Record<string, unknown>);
      return { draft, saved: { ...draft }, expertOpen: draft.expertMode === "true", notice: null };
    },

    render: (state: State) => {
      const check = checkAdRules(state.draft[AD_GROUP_MODE], state.draft[AD_GROUP_EXTRA]);
      const ruleCount = summarizeRuleCount(check);
      const dirtyKeys = Object.keys(state.draft).filter((k) => state.draft[k] !== state.saved[k]);
      const dirty = dirtyKeys.length > 0;
      const expert = state.expertOpen;

      const drawField = (f: Field) => {
        const v = state.draft[f.key];
        if (f.type === "switch") {
          return <switch key={f.key} label={f.label} checked={v === "true"} />;
        }
        if (f.type === "select") {
          return (
            <stack key={f.key} gap="xs">
              <text text={f.label} size="sm" />
              <select key={f.key} options={f.options || []} value={v} />
              {f.hint ? <text text={f.hint} tone="muted" size="xs" /> : null}
            </stack>
          );
        }
        if (f.type === "textarea") {
          return (
            <stack key={f.key} gap="xs">
              <text text={f.label} size="sm" />
              <textarea key={f.key} value={v} rows={f.rows || 4} />
              {f.hint ? <text text={f.hint} tone="muted" size="xs" /> : null}
            </stack>
          );
        }
        return (
          <stack key={f.key} gap="xs">
            <text text={f.label} size="sm" />
            <input key={f.key} value={v} kind={f.type === "number" ? "number" : "text"} />
            {f.hint ? <text text={f.hint} tone="muted" size="xs" /> : null}
          </stack>
        );
      };

      const groups = GROUPS.filter((g) => expert || !g.expert).map((g) => (
        <section key={"g-" + g.id} title={g.title}>
          {g.fields.map(drawField)}
        </section>
      ));

      const expertCount = GROUPS.filter((g) => g.expert).reduce((n, g) => n + g.fields.length, 0);

      return (
        <stack gap="md" padding="md">
          <heading text="插件设置" level={2} />
          <text
            text="下面只列常用的几项。本站适配、剧集识别、编码音轨这些调参项默认收起，需要时再打开「专业设置」。与「基础设置」页签里的项等价，改一处即可。"
            tone="muted"
            size="sm"
          />

          {groups}

          <section key="g-ad" title="去广告">
            <stack key="ad-mode" gap="xs">
              <text text="模式" size="sm" />
              <select key={AD_GROUP_MODE} options={MODE_OPTIONS} value={state.draft[AD_GROUP_MODE]} />
              <text text={"当前：" + ruleCount} tone="muted" size="xs" />
            </stack>
            {state.draft[AD_GROUP_MODE] === "off" ? (
              <callout
                key="off-tip"
                tone="neutral"
                text="已关闭：下载时不丢弃任何分片，下面的规则也不会生效。"
              />
            ) : null}

            <text text="预设（点一下套用到下方草稿，仍需保存）" size="sm" />
            <stack key="presets" gap="xs">
              {AD_PRESETS.map((p) => (
                <stack key={"preset-" + p.id} direction="row" gap="sm" align="center">
                  <button key={"apply-" + p.id} text={p.label} variant="outline" />
                  <text text={p.note} tone="muted" size="xs" />
                </stack>
              ))}
            </stack>

            <stack key="ad-extra" gap="xs">
              <text text="自定义规则（JSON，可留空）" size="sm" />
              <textarea key={AD_GROUP_EXTRA} value={state.draft[AD_GROUP_EXTRA]} rows={6} placeholder={'{ "dropPath": ["/ads/"] }'} />
              <text
                text="三个可选键：keepPath（白名单，命中永不丢弃）、dropPath（黑名单，命中即丢）、dropHosts（广告分片主机名）。"
                tone="muted"
                size="xs"
              />
            </stack>

            {check.blocked ? (
              <callout key="rule-error" tone="danger" title="这段规则不能保存" text={check.blocked} />
            ) : null}
            {!check.blocked && check.warning ? (
              <callout key="rule-warn" tone="warning" title="部分规则不会生效" text={check.warning} />
            ) : null}
            {!check.blocked && !check.warning && str(state.draft[AD_GROUP_EXTRA]).trim() ? (
              <callout key="rule-ok" tone="success" text={"规则解析通过：" + ruleCount} />
            ) : null}
          </section>

          <section key="g-expert-toggle" title="专业设置">
            <switch
              key="expertMode"
              label={"显示专业设置（另有 " + expertCount + " 项：站点适配、剧集识别、编码、下载行为）"}
              checked={expert}
            />
            <text
              text="默认关闭是为了让上面这一页能一次看完。改完这些项同样需要按「保存」。"
              tone="muted"
              size="xs"
            />
          </section>

          <divider />

          <stack key="actions" direction="row" gap="sm" align="center">
            <button key="save" text="保存" variant="primary" disabled={!dirty} />
            <button key="reset" text="还原" disabled={!dirty} />
            <text
              key="dirty-hint"
              text={dirty ? "有 " + dirtyKeys.length + " 项未保存" : "与已保存的值一致"}
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
      state.notice = null;

      if (ev.type === "change") {
        if (key === "expertMode") {
          // 开关既改草稿（跟着「保存」落库），也立刻展开/收起 —— 否则点了没反应要等保存。
          const on = ev.value === true || ev.value === "true";
          state.expertOpen = on;
          state.draft.expertMode = on ? "true" : "false";
          return;
        }
        if (key === AD_GROUP_MODE) {
          state.draft[AD_GROUP_MODE] = normMode(ev.value);
          return;
        }
        if (key === AD_GROUP_EXTRA) {
          state.draft[AD_GROUP_EXTRA] = str(ev.value);
          return;
        }
        const f = ALL_FIELDS.filter((x) => x.key === key)[0];
        if (!f) return;
        state.draft[key] = f.type === "switch" ? (ev.value === true || ev.value === "true" ? "true" : "false") : str(ev.value);
        return;
      }

      if (ev.type !== "press") return;

      if (key === "save") {
        await persist(state);
        return;
      }
      if (key === "reset") {
        state.draft = { ...state.saved };
        state.expertOpen = state.saved.expertMode === "true";
        state.notice = { tone: "neutral", text: "已还原为上次保存的内容。" };
        return;
      }

      // 预设按钮：`apply-<presetId>`。
      if (key.indexOf("apply-") === 0) {
        const preset = findPreset(key.slice("apply-".length));
        if (!preset) return;
        state.draft[AD_GROUP_MODE] = normMode(preset.mode);
        state.draft[AD_GROUP_EXTRA] = preset.extra;
        state.notice = { tone: "info", text: "已套用预设「" + preset.label + "」，按「保存」才会写入。" };
      }
    },
  });
}

// 引擎在启动 `main` 时已注入全局 `flux`；安装时的编译检查不包含 `main`（按需编译），
// 所以这里在顶层取用是安全的。等价于 `defineMain(setup)` 去掉那层包装。
register(flux as unknown as MainFlux);
