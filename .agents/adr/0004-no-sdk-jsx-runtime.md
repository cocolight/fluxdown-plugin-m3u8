# 视图层不用 SDK 的 JSX 运行时

> **本记录已被 [0005](0005-allow-sdk-jsx-runtime.md) 取代。** 以下是当时的判断与理由，保留作历史依据；
> 现行做法是"用 SDK 的 `ui/jsx-runtime`，义务登记在 `THIRD-PARTY.md`"。

- 状态：已被 [0005](0005-allow-sdk-jsx-runtime.md) 取代
- 日期：2026-11-01
- 决策者：fluxdown-plugin-m3u8 维护者

## 背景

M5 要给插件加一个设置页签，官方提供了两条写法：`flux.ui.h(kind, props, ...children)`，
或者配 `jsx: "react-jsx"` + `jsxImportSource` 用 JSX 写。后者的便利很明显，但 JSX 必须编译成
对某个 jsx-runtime 的调用 —— SDK 的 `fluxdown-plugin-sdk/ui/jsx-runtime` 正是运行时代码，
会被 esbuild 内联进 `dist/main.js`。这与 ADR-0003 直接冲突：SDK 是 AGPL-3.0-or-later，
本项目是 MIT，产物里混入 SDK 运行时符号即破坏授权链。

自研一份等价的 jsx-runtime（约 40 行）在技术上不难，但那是照着 SDK 的实现复刻，法律上界定模糊，
而且要多维护一份与上游同步的解析逻辑。

`flux.ui.h` 不同：它是引擎注入的宿主 API，属于协议的一部分，插件只是调用它，不复制它的实现。

## 决策

视图一律用 `flux.ui.h` 构造节点，不引入 JSX，不依赖 `sdk/ui/*` 任何导出。

`h` 的类型签名是 `(kind: string, props?: Record<string, unknown>, ...children)`，编译期不知道
哪个标签该配哪些属性，等于把 JSX 最大的好处（属性校验）丢掉了。为此在 `src/entry/main.ts`
里用一个本地类型补回来：

```ts
type H = <K extends keyof ViewIntrinsicElements>(
  kind: K,
  props: ViewIntrinsicElements[K],
  ...children: ViewChild[]
) => ViewNode;
```

`ViewIntrinsicElements` 与 `ViewNode` 都只以 `import type` 引入，运行时零依赖。写错标签名或
把 `text` 传成数字，仍然是编译错误。

## 后果

- 正面：`dist/main.js` 里 SDK 符号命中数为 0，授权链不变；无自研 jsx-runtime 的维护负担；
  节点树的 shape（`{k, p, c}`）来自 SDK 类型，与引擎 schema 同源。
- 负面：写法比 JSX 啰嗦，嵌套深时括号层数多；子节点必须显式传参，不能像 JSX 那样写
  `<stack>…</stack>`。对当前体量（一个视图、约 200 行）可以接受，视图数量涨到 3 个以上时
  应重新评估。
- 门禁：`tests/ui.mjs` 会按引擎 schema 校验渲染树（kind 白名单、文本属性必须是字符串、
  同级 key 唯一、节点数与深度上限），补上了 JSX 类型检查管不到的那一半。

## 备选方案

- 用 SDK 的 `jsx-runtime`：写法最顺，但把 AGPL 运行时代码打进 MIT 项目的分发物。
- 自研 jsx-runtime：写法同样顺，但属于照上游实现复刻，授权边界不清，且要与 SDK 版本同步。
- 全部用 `any` 绕过类型：省事，但等于放弃本 ADR 与 ADR-0002 的编译期门禁。
