---
name: plugin-runtime-probe
description: 在真机 FluxDown 守护进程上验证插件运行时行为（注入请求头、产物登记、目录语义等）。当需要「文档没说 / 说法矛盾」的实证，或要区分「插件写错」与「引擎行为」时使用。
---

# 真机运行时探针

用来回答「引擎到底怎么做的」。文档与 SDK 类型只能给出声明，实际语义经常更宽松或更严格，
而插件侧的 bug 常被误判成引擎限制。**先跑探针，再改代码。**

## 前置

- FluxDown 已安装且有 daemon 在跑：`~/.local/share/fluxdown/daemon.token` 存在。
- 插件已 `installDev` 指向本项目 `dist/`。
- 项目根有 `.tooling/`（已 gitignore），放一次性脚本。

## 三条硬约束（踩过的坑）

1. **`/tmp` 在沙箱不可用**。`cp -r dist /tmp/x` 之后 `cd /tmp/x` 会报不存在。一律在 `.tooling/` 下建临时目录。
2. **后台 `http.server` 会被回收**。`nohup` 与 `setsid` 都撑不住，daemon 报 `Connection refused (os error 111)`。
   必须**同进程**：`http.createServer` 持服务器 + 同进程发 RPC 建任务 + 轮询结果，一个 `node` 脚本跑完。
3. **`new URL().pathname` 会把中文路径编成 `%E6%96%87…`**，服务端 `readFile` 全 404。
   用 `decodeURIComponent(new URL(u).pathname)`。

## 步骤

1. **握手**：daemon 是 **WS RPC**，HTTP 打 `:17801` 全 404。参考 `ws://127.0.0.1:17801/rpc`：
   `system.auth.challenge {clientNonce}` → 验 `serverProof` → `system.auth.prove {clientProof}` → `system.hello`。
   MAC = `HMAC-SHA256(token, "fluxdown-daemon-auth/v1\n<role>\n<cNonce>\n<sNonce>")`，role 取 `agent-proof` / `daemon-proof`。
2. **改插件**：`npm run build`（若报 EPERM，产物通常已打包完，用 `shutil.copyfile('manifest.json','dist/manifest.json')` 补拷）。
   改 `dist/*.js` **不 reload 立即生效**；改 `dist/manifest.json` **必须** `daemon.plugin.reloadDev {identity}`。
3. **配设置**：`daemon.plugin.updateSettings {identity, entries:{k:v}}`。
4. **建任务**：`daemon.task.create {request:{url, saveDir, …}}`。status 1 下载中 / 3 完成 / 4 失败 / 5 排队（5 需 `resume`）。
5. **观察**：服务端把收到的请求头原样打印；插件侧临时加一行 `logger.info("[PROBEPATCH] …")` 打印产物。
6. **对照实验**：清空被怀疑的设置项再跑一遍。**插件注入与引擎内置行为只能靠对照组区分。**

## 判据

- 结论必须来自「A 组有、B 组无」的对照，不能只看一次输出。
- 探针结果写进 `.agents/sdk-migration.md` 第九节，附命令与原始输出片段。
- **推断与事实分开标注**。源码能确认的写「源码 `文件:行号`」，只有观察的写「实测」。
- **`http_proxy` 是红鲱鱼**：daemon 可能继承 `HTTP_PROXY`，但 `bridge.rs` 对环回恒直连、无显式代理时 `no_proxy()`。
  别顺着代理查。

## 清理

删掉插件里的 `[PROBEPATCH]`、恢复设置项原值、`rm -rf .tooling/xxx`。**确认恢复后再报告结论。**
