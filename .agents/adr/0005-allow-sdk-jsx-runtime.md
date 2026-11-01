# 允许 SDK 的 JSX 运行时进入产物

> **本记录的例外已随 [0009](0009-settings-host-form-only.md) 解除。** 视图删除后产物不再需要
> JSX 运行时，0003 的「产物零 SDK 运行时」恢复为全量禁令；以下保留当时为视图开例外的理由作历史依据。

- 状态：例外已随 [0009](0009-settings-host-form-only.md) 解除（恢复 0003 的零运行时）
- 日期：2026-11-01
- 决策者：fluxdown-plugin-m3u8 维护者
- 取代：[0004](0004-no-sdk-jsx-runtime.md)
- 修订：[0003](0003-sdk-type-only-import.md) 的「产物中零 SDK 运行时」部分

## 背景

ADR-0004 为避开 AGPL 选了 `flux.ui.h`，代价是手写 `h("kind", props, ...children)`：嵌套深时括号层数多，
子节点只能当参数传，`key` 也得手写进 props。维护者评估后认为，这个代价是**长期**的（每个视图、每次改动都要付），
而授权义务是**可登记**的（说清楚、留证据即可满足），不值得用可读性长期换。

## 决策

1. `main` 入口改为 `.tsx`，JSX 编译到 `fluxdown-plugin-sdk/ui/jsx-runtime`。tsconfig 的
   `jsx: "react-jsx"` + `jsxImportSource: "fluxdown-plugin-sdk/ui"` 必须与 SDK 构建时写死的
   esbuild 选项（`dist/cli.js` 的 `baseOptions`）一致，否则 tsc 通过而产物引用到别的运行时。
2. 该运行时由 esbuild 内联进 `dist/main.js`，**随 `.fxplug` 分发**。实测代价：`dist/main.js`
   从 15.6 KB 增至 17.2 KB（+1.6 KB），零额外依赖。
3. 授权义务**如实登记**在 `THIRD-PARTY.md`，不再声称「产物零 SDK 运行时」。
4. 范围只到 JSX 运行时。其余 SDK 导出（`defineMain`、manifest 校验、`runtime` 里的辅助函数）
   仍然不引入 —— ADR-0003 的类型红利与「不做无谓运行时耦合」的判断不变。

## 后果

- 正面：视图写法与官方示例一致；`key` 由编译器搬进 props，不用手写；标签与属性校验由
  `JSX.IntrinsicElements`（继承 `ViewIntrinsicElements`）提供，本地 `type H` 补丁随之删除。
- 负面，三条都要认：
  1. **`dist/main.js` 含 AGPL-3.0-or-later 代码**，含该运行时的分发物整体须按 AGPL 条款提供对应源码。
     本仓库源码公开、构建可复现，义务可满足；但这是**事实约束**，不是「登了记就没事」。
  2. 若日后改为闭源分发、或给插件加限制性条款，会与 AGPL 冲突。那时的出路只有两条：
     退回 `flux.ui.h`，或整包转 AGPL。**这个决定把这个选项锁掉了一半。**
  3. 体积与同步成本：SDK 升级时要复核 `ui/jsx-runtime` 有没有变（当前 47 行，`jsx` 会丢掉
     `undefined` 值的 props，`key` 放 `p.key`，`children` 走 `collect` 摊平数组与 `Fragment`）。
     这些行为若变，视图树会跟着变，而 `tests/ui.mjs` 只校验 schema 不校验实现细节。
- 门禁：`tests/ui.mjs` 的树校验（kind 白名单、文本属性必须是字符串、同级 key 唯一、节点数与深度上限）
  与写法无关，改为 JSX 后照样生效，并且仍是这部分的主要防线 —— 类型检查管不到运行时 key 冲突。

## 备选方案

- 保持 ADR-0004 的 `flux.ui.h`：零授权风险，但写法持续啰嗦。维护者判定收益不抵成本，放弃。
- 自研 jsx-runtime 绕开 AGPL：授权边界模糊（本质是照上游实现复刻），且要随 SDK 同步，放弃。
