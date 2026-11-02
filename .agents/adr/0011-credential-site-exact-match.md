# 凭据站点约束的裸域改为精确匹配，缺省继承 `targetHosts`

- 状态：已接受
- 日期：2026-11-03
- 决策者：fluxdown-plugin-m3u8 维护者
- 关系：修订 [ADR-0010](0010-credential-site-scope.md) 的决策第 1 条

## 背景

ADR-0010 把 `@a.com` 定为「裸域 `a.com` 及其所有子域」，并在正面验证表里把
「`cdn.localhost` 拿到 Cookie」标成「子域，设计如此」。真机 A/B 复现后确认这个设计站不住：

```
约束 @localhost, targetHosts=localhost
  A localhost        → cookie="sid=abc"      正确
  B cdn.localhost    → cookie="sid=abc"      ← 应为空
  C 127.0.0.1        → cookie=""             正确
```

根因在 `siteAllowed()` 的 `h === want || h.endsWith("." + want)`：它沿用了 `targetHosts`
的语义。但两者意图相反：

- `targetHosts` 是**准入白名单**。写 `a.com` 一并覆盖 `www.a.com` 是便利，漏填只导致
  「少处理几个页面」，失败方向安全。`docs/settings.md` 明说「填主域即可覆盖全部子域」，
  该语义保留不动。
- 凭据是**限制**。用户写 `@a.com` 是在声明「这份 Cookie 属于 a.com」。通用解析器会遇到
  大量陌生站点，用户被诱导点到 `evil.a.com` 是常态场景，此时把已登录的 Cookie 发出去
  就是泄漏。失败方向不安全。

ADR-0010 还有第二处需要修：它承诺「不写 `@` 行时凭据不受站点限制」，但用户在同一张表单里
填了 `targetHosts`，等于已经表达过「我只在这个站用你」—— 凭据却不受这份清单约束，
用户填了 `targetHosts` 仍然泄漏，且他无从得知。

## 决策

1. **裸主机名改为精确匹配**：`@a.com` 只匹配 `a.com` 本身。要覆盖子域必须显式写
   `@*.a.com`（保持只匹配真子域）。两者合起来让用户能精确表达意图，而不是在一个方向上
   被默默放宽。

2. **不写 `@` 行时继承 `targetHosts`**。`targetHosts` 已是用户在同一张设置表单里认可过的
   站点清单，再让他到凭据框里抄一遍只会漏抄。`targetHosts` 留空（对所有站点生效）时
   才退到真正不限 —— 老配置的兼容性由这一条兜住。

3. **显式 `@` 行优先于 `targetHosts`**。用户在凭据里做的收窄不得被宽泛的
   `targetHosts` 悄悄放大。

4. **两种情况都保留同源闸**（ADR-0010 决策 4 不变）。站点约束回答「这份凭据属于谁」，
   同源闸回答「这次请求的对象是不是任务所在站点」。

## 后果

- 正面：真机复验后 `cdn.localhost` 拿到空 Cookie，`localhost` 仍正常注入：

  | 约束 | `localhost` | `127.0.0.1` | `cdn.localhost` |
  | --- | --- | --- | --- |
  | `@localhost` | 注入 | 拦下 | 拦下 |
  | `@*.localhost` | 拦下 | 拦下 | 注入 |
  | 不写，`targetHosts=localhost` | 注入 | 拦下 | 注入（白名单父域覆盖子域） |
  | 不写，`targetHosts` 留空 | 注入 | 注入 | 注入 |

  契约测试 58 → 65 项：新增继承 `targetHosts` 4 条、`@*.` 正面 1 条、优先级 2 条，
  并把原来断言「`@site.test` 覆盖子域」的一条反转为「不覆盖」。

- 负面，两条都要认：
  1. **breaking**。已显式写 `@a.com` 且在子域取 Cookie 的用户，升级后登不上，需改成
     `@*.a.com`。方向是「宁可少发也不多发」，且 `description` 与 `docs/settings.md`
     都已写明新写法。
  2. **两份清单仍然存在**。`targetHosts` 与 `@站点` 各有各的语义，虽然现在有了缺省继承，
     但用户仍可能写出一份比另一份更宽或更窄的配置。彻底收成一份需要把站点搬进凭据框，
     而 `targetHosts` 同时管着「处理哪些页面」，两者职责确实不同，不宜合并。

- 门禁变化：`tests/contract.mjs` 的 2b 节由 8 条增至 14 条。

## 备选方案

- **维持裸域覆盖子域，只写进文档**：不破坏任何现有配置，但 `evil.a.com` 能拿到凭据。
  通用解析器的场景下把安全问题退化成文档问题，不解决问题。
- **收窄 + 兼容期双写**：`@a.com` 精确匹配，但额外放行「与 `a.com` 同注册域且用户未写
  `@*.`」的情况并记 warn，让用户自己发现。实现更绕，且 warn 出现在下载日志里，
  用户多半看不到，等于延后暴露而不减少破坏。
- **完全不继承 `targetHosts`**：只做收窄。用户填了 `targetHosts` 仍会泄漏，且这次的
  真机复现里 `targetHosts=localhost` 明摆着是用户意图，不继承等于丢掉一条已存在的信号。
