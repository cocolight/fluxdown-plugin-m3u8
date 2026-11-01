# 扩展点索引（要加 X 改哪里）

> 回答「加一种新东西要动哪些地方、按什么顺序」。事实以源码为准，本表只给步骤与同步面。
> 走完任一条，同回合过 `AGENTS.md` §9 的同改矩阵。

## 加一个设置项

1. `manifest.json` 的 `settings[]` 追加一项：`key`（camelCase，全仓唯一）、`type`、`widget`、`default`、必要的 `min`/`max`/`options`。
2. `src/lib/settings.ts` 读取该键并给出**默认值兜底**；不要在入口里直接读 `ctx.settings`。
3. `docs/settings.md` 补一节：作用 / 怎么配 / 效果 / 示例。使用者看这一份。
4. 用户可见的行为变化同步 README「功能特性」一行。
5. 测试：能落到契约层的写进 `tests/contract.mjs`（读取优先级、边界值、换算规则）；只是把值透传的，parity 覆盖不到就必须补一条契约，否则等于没测。
6. 设置项数量变化时，检查 README 与 `docs/settings.md` 里出现的「N 个设置项」这类计数，改准或改成不写数字。

## 加一个插件入口

1. `src/entry/<name>.ts` 实现对应全局函数，宿主契约见 `fluxdown-plugin-sdk` 的类型。
2. `fluxdown-plugin.config.json` 的 `entries` 加 `"<name>.js": "src/entry/<name>.ts"`。
3. `manifest.json` 在对应段（`resolvers` / `hooks` / `auth` / `subscriptions` / `interceptors` / `main`）指向该文件。
4. 需要新权限时同步 `permissions[]` —— 引擎对已批准权限做**精确匹配**，新权限未批准时插件装上但停用，README 的升级说明要提这一条。
5. 新入口是独立 QuickJS 上下文：不得在运行时引用其他入口的导出。
6. `npm run build && npm run validate` 必须通过；产物数量变化时更新 README「文件结构」。

## 加一个拦截阶段

1. `manifest.json` 的 `interceptors.stages` 追加阶段名（当前只有 `segments`）。
2. `src/entry/intercept.ts` 按 `ctx.stage` 分派，未知阶段返回「不干预」。
3. 任何新阶段都要保持 fail-closed：判断不了就不改。
4. 契约测试覆盖：未知阶段、空数据、非本插件任务。
5. 该阶段是否在目标引擎版本提供，写进 `.agents/sdk-migration.md` 的版本门槛表。

## 提升 `minAppVersion`

- 只有用到**新版本才有的字段 / 阶段**时才抬。抬之前先确认：旧客户端遇到未知 manifest 字段是**整份拒绝**，`minAppVersion` 兜不住。
- 同回合改：`manifest.json` 的 `minAppVersion`、`.agents/sdk-migration.md` 的门槛表、README 顶部的最低版本说明、CHANGELOG 的 `Changed`。

## 加或改构建配置

- 入口映射只改 `fluxdown-plugin.config.json`，不改 `package.json` 的 scripts（除非新增命令）。
- `tsconfig.json` 的 `lib` 不得加 `DOM`：那是防止 `URL` / `btoa` 混进产物的门禁。
- 产物变化后跑 `npm run validate` 与 `npm run pack`，确认 `.fxplug` 内容正确。

## 加一篇工程文档

1. 先判归属：不读它 AI 会做错事 → `.agents/`；否则 → `docs/`（使用者文档）。
2. 放进 `.agents/` 后**必须**在 `AGENTS.md` §1 路由表加一行，否则 `scripts/check-fast.sh` 拦下。
3. 文内引用用相对路径：同目录直接写文件名，跨到仓库根写 `../`。
4. 已完成的一次性计划放 `.agents/archive/`，路由表标注「历史归档」，避免被当现行依据。

## 加一条 AI 规则 / 红线

1. 先定级：违反即回滚（阻断级）还是默认做法（提醒级）——见 `AGENTS.md` §4。
2. 写进 `AGENTS.md` §4，一条一行，短句说清「是什么」，不写推导过程。
3. **能机械判定的一律下沉到脚本**（行数、目录位置、必要文件存在、字段一致），在 `scripts/check-fast.sh` 加一条断言；只有判不了的才留在文档里靠自觉。
4. 若它同时是「完成」的必要条件，同步 `.agents/definition-of-done.md`，不得放宽。

## 加一个 CI 检查

1. 纯静态、无副作用的检查放进 `scripts/check-fast.sh` —— 本地 hook 与 CI 共用同一份，不要各写一遍。
2. 需要装依赖、跑构建、生成产物的，写进 `.github/workflows/build.yml` 的 `test` job。
3. **只拒绝，不自动修复**：检查脚本不得改文件。
4. 阈值（行数、字符数）改动时同回合改注释里的说明，阈值与说明必须一致。

## 记一次决策

- 小决策：`CHANGELOG.md` 条目末尾「（理由：一句话）」。
- 重大、难以回退、或**被否决的方向**：新增一条 ADR（复制 `.agents/adr/template.md`），并在 `.agents/adr/README.md` 的索引加行。
- 状态为「已接受」的记录不得修改，变更用新 ADR 标注取代关系。

## 加一个 AI skill

1. 建 `.agents/skills/<name>/SKILL.md`，frontmatter 必填 `name`（kebab-case，与目录同名）与 `description`（一句话说清何时该用）。
2. 在 `AGENTS.md` §1 路由表加一行指向它。
3. 内容只放一份，按所用工具的目录映射（见 `.agents/skills/README.md`）。
4. `check-fast.sh` 校验 frontmatter 两个字段，缺一个就红。

## 换或加技术栈骨架

1. `src/` `tests/` `scripts/` 三个目录的约定不变，只换里面的内容。
2. 换构建链只改 `fluxdown-plugin.config.json` 与 `package.json` 的 scripts；同回合填实 `AGENTS.md` §2 五行命令与 §8 坐标表，`CONTRIBUTING.md`「本地检查」必须与 §2 完全一致。
3. `.github/workflows/build.yml` 的 `test` job 三件事缺一不可：装依赖、类型 / 格式检查、测试。不得写成 `|| true`，不得把失败降级为警告。
4. 加一类新产物（新入口脚本、新资源文件）时，同回合改 `fluxdown-plugin.config.json`、`manifest.json` 对应段、`README.md`「文件结构」、`.agents/architecture.md` §1。
5. 分层约定尽量做成机械门禁：`tsconfig.json` 的 `lib` 不含 `DOM` 就是现成一例 —— 违规在编译期暴露，不必靠 review 记忆。
