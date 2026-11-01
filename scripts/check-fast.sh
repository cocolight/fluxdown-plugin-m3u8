#!/bin/sh
# check-fast.sh — 快速门禁
#
# 由 .githooks/pre-commit 与 CI 共同调用：同一份断言，不各写一遍。
# 只拒绝，不修改任何文件；全量检查，不做增量。
# 项目根按本脚本位置推导（scripts/ 的上级），因此在任何 cwd 调用都作用于同一个项目。
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd -P)
cd "$ROOT"

fail=0
bad() { printf '  ✗ %s\n' "$1"; fail=1; }
ok() { printf '  ✓ %s\n' "$1"; }

# 1. 常驻上下文体积：AGENTS.md 每次会话必读，体积即上下文预算
if [ -f AGENTS.md ]; then
  n=$(wc -l < AGENTS.md | tr -d ' ')
  if [ "$n" -le 200 ]; then
    ok "AGENTS.md $n 行（上限 200）"
  else
    bad "AGENTS.md $n 行，超过 200：拆分到 .agents/，本文件只留入口与红线"
  fi
fi

# 2. CHANGELOG 条目体积：条目即发布说明
if [ -f CHANGELOG.md ]; then
  long=$(grep '^[[:space:]]*- ' CHANGELOG.md 2>/dev/null | while IFS= read -r line; do
           n=$(printf '%s' "$line" | LC_ALL=C.UTF-8 wc -m | tr -d ' ')
           [ "$n" -le 150 ] || printf '%s 字符：%s\n' "$n" "$line"
         done) || true
  if [ -z "$long" ]; then
    ok "CHANGELOG 条目均 ≤150 字符"
  else
    bad "CHANGELOG 条目超 150 字符：
$long"
  fi
fi

# 3. .agents/ 下每篇文档都必须在 AGENTS.md §1 路由表出现，否则等于死文档。
#    adr/ 与 skills/ 是集合，按目录整体登记即可，逐个文件豁免。
if [ -d .agents ] && [ -f AGENTS.md ]; then
  missing=$(find .agents -name '*.md' | sed 's|^\.agents/||' | sort | while IFS= read -r f; do
              case "$f" in
                adr/*|skills/*/SKILL.md) continue ;;
              esac
              grep -qF ".agents/$f" AGENTS.md || printf '.agents/%s\n' "$f"
            done)
  if [ -z "$missing" ]; then
    ok ".agents/ 下文档均在 AGENTS.md §1 路由表内"
  else
    bad "这些文件未进 AGENTS.md §1 路由表：
$missing"
  fi
fi

# 4. skill frontmatter：没有 name / description 的 skill 无法被 AI 匹配到
if [ -d .agents/skills ]; then
  errs=""
  total=0
  for f in .agents/skills/*/SKILL.md; do
    [ -f "$f" ] || continue
    total=$((total + 1))
    if ! head -n 20 "$f" | grep -q '^name:'; then errs="$errs
$f 缺 frontmatter 字段 name"; fi
    if ! head -n 20 "$f" | grep -q '^description:'; then errs="$errs
$f 缺 frontmatter 字段 description"; fi
  done
  if [ -z "$errs" ]; then
    ok "skill frontmatter（$total 个，字段齐全）"
  else
    bad "skill frontmatter 不合契约：$errs"
  fi
fi

# 5. 版本号两处一致：manifest.json 是发给客户端的事实源，package.json 供 npm 生态读取。
#    发版时只改这两处，且必须相等；其余文档不得另抄版本号。
if [ -f manifest.json ] && [ -f package.json ]; then
  mv=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' manifest.json | head -n 1)
  pv=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' package.json | head -n 1)
  if [ -n "$mv" ] && [ "$mv" = "$pv" ]; then
    ok "版本号一致（$mv）"
  else
    bad "版本号不一致：manifest.json=${mv:-空} package.json=${pv:-空}"
  fi
fi

# 6. manifest 声明的每个入口都要有构建映射。
#    漏一条的后果不是「构建警告」而是「装不上」—— 客户端要求 manifest 点名的文件都在包里，
#    缺一个就是「必须存在的文件缺失」。加 main 入口时最容易忘的就是这个文件。
if [ -f manifest.json ] && [ -f fluxdown-plugin.config.json ] && command -v node >/dev/null 2>&1; then
  missing=$(node -e '
const fs = require("fs");
const m = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
const entries = JSON.parse(fs.readFileSync("fluxdown-plugin.config.json", "utf8")).entries || {};
const need = [];
const add = (p) => { if (typeof p === "string" && p && need.indexOf(p) < 0) need.push(p); };
if (m.main) add(m.main.entry);
if (m.hooks) add(m.hooks.entry);
if (m.auth) add(m.auth.entry);
if (m.interceptors) add(m.interceptors.entry);
(m.resolvers || []).forEach((r) => add(r.entry));
(m.subscriptions || []).forEach((s) => add(s.entry));
const missing = need.filter((n) => !Object.prototype.hasOwnProperty.call(entries, n) && !fs.existsSync(n));
if (missing.length) console.log(missing.join("\n"));
' 2>/dev/null) || missing=""
  if [ -z "$missing" ]; then
    ok "manifest 入口均有构建映射"
  else
    bad "这些入口没有构建映射（dist/ 里不会出现，安装会报缺文件）：
$missing"
  fi
fi

# 7. 代码文件卫生：行尾空白与未解决的冲突标记。
#    CI 的 checkout 是干净的，`git diff --check` 在 CI 里必然空转，所以改为扫描已跟踪文件。
#    Markdown 不查行尾空白（两空格是合法的硬换行）。
if git rev-parse --git-dir >/dev/null 2>&1; then
  conflicts=$(git grep -nIE '^(<<<<<<< |=======$|>>>>>>> )' -- '*.ts' '*.js' '*.mjs' '*.sh' '*.json' '*.md' 2>/dev/null || true)
  trailing=$(git grep -nIE '[[:space:]]+$' -- '*.ts' '*.js' '*.mjs' '*.sh' 2>/dev/null || true)
  if [ -z "$conflicts" ] && [ -z "$trailing" ]; then
    ok "无冲突标记、代码文件无行尾空白"
  fi
  if [ -n "$conflicts" ]; then
    bad "存在未解决的合并冲突标记：
$conflicts"
  fi
  if [ -n "$trailing" ]; then
    bad "代码文件存在行尾空白：
$trailing"
  fi
fi

if [ "$fail" -ne 0 ]; then
  printf '\n门禁未通过：修正后再提交。不要用 --no-verify 绕过。\n' >&2
  exit 1
fi
printf '\ncheck-fast 全部通过。\n'
