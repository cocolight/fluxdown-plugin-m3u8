# AI skill

本目录放可复用的 AI skill。**不预置任何 skill** —— 需要时自建，一个目录一个 skill。

## 契约

```text
.agents/skills/<name>/
└── SKILL.md          # frontmatter 必填 name、description
```

- `name`：kebab-case，与目录名一致。
- `description`：一句话说清「什么时候该用」，AI 靠它决定是否加载。
- 正文写步骤与判据。不写「请注意」「值得一提的是」这类填充语。

## 加载

在 `AGENTS.md` §1 路由表加一行「任务类型 → `.agents/skills/<name>/SKILL.md`」。
`scripts/check-fast.sh` 校验 frontmatter 的两个字段，缺一个即失败；路由表漏登记同样失败。

## 换 AI 工具

skill 内容与工具无关，只放一份。按所用工具的目录映射，不要复制第二份：

| 工具 | 映射位置 |
|---|---|
| Claude Code | `.claude/skills/<name>/SKILL.md` |
| Cursor | `.cursor/rules/<name>.mdc` |
| 其他 | 按其文档约定映射 |

映射用软链（Windows 需开发者模式）或同步脚本，不要手工复制：复制出来的第二份必然与源漂移。
