# ui-copywriter — 中英 UI 文案与本地化写作规范

一个面向 AI Agent 的 UX Writing skill，用于撰写、优化、翻译和校验中英双语界面文案（按钮、菜单、弹窗、toast、空状态、错误提示等）。内置 Kimi 产品术语库和自动化校验脚本，适用于 Kimi Code / Claude Code / Cursor / Codex 等 Agent 环境。

---

## 快速安装

### 方式一：命令行安装（推荐）

```bash
npx skills add https://dev.msh.team/xujianxuan/ui-copywriter.git --skill ui-copywriter
```

### 方式二：对话安装

**Kimi Code（最推荐）**

> 帮我安装 ui-copywriter。请把 `https://dev.msh.team/xujianxuan/ui-copywriter.git` 克隆到 `~/.kimi/skills/ui-copywriter`，安装完成后检查 `SKILL.md`、`references/`、`scripts/` 是否存在。

**Claude Code**

> 帮我安装 ui-copywriter。请把 `https://dev.msh.team/xujianxuan/ui-copywriter.git` 克隆到 `~/.claude/skills/ui-copywriter`，安装完成后检查 `SKILL.md`、`references/`、`scripts/` 是否存在。

### 更新

> 帮我更新 ui-copywriter。请进入 skill 目录执行 `git pull`，然后告诉我当前最新 commit。

---

## 核心能力

- **双语写作规范**：中文/英文各自的措辞、标点、大小写、句式规则，CN 为文案事实源，EN 按英文 UX 习惯重写而非逐字镜像
- **术语库**：`references/terminology.md` 维护 200+ 条产品术语（Kimi Claw 系列、会员体系、功能名、第三方集成），**术语以线上 Lokalise 导出为准**
- **自动校验**：`scripts/validate_copy.py` 从术语库的 Never-use 注记自动生成禁用词检查，覆盖标点全半角、盘古之白、dialog 问号、句尾句号等机械规则
- **单源规则**：`SKILL.md` 硬约束区只是摘要 + 指针，每条规则的 canonical 版本都在对应 `references/*.md` 里，改规则只改 canonical 文件

## 目录结构

```
ui-copywriter/
├── SKILL.md                      # 入口：Workflow + 硬约束摘要 + 输出格式 + Checklist
├── references/
│   ├── core-principles.md        # 人称、绝对词、双重否定
│   ├── phrasing-rules.md         # 中文措辞（登录/帐号/请稍候等正字）
│   ├── sentence-patterns.md      # 句式（无感叹号、无是否、动宾直述…）
│   ├── punctuation.md            # 句号规则、全半角、间距
│   ├── style-guide.md            # Sentence case 及例外、盘古之白
│   ├── numbers-and-units.md      # 数字、时间、货币格式
│   ├── abbreviations.md          # 英文缩略（You're / Can't…）
│   ├── linguistic-logic.md       # 英文语法逻辑（单复数、可数性…）
│   ├── writing-patterns.md       # 场景模板（错误/确认/空态/按钮/toast/{n} 复数）
│   └── terminology.md            # 术语数据库（CN ↔ EN + 禁用说法注记）
├── scripts/
│   └── validate_copy.py          # 文案校验脚本（术语库驱动）
└── agents/
    └── openai.yaml               # Agent 平台元数据
```

---

## 术语库（Terminology）

`references/terminology.md` 是一份独立可用的 CN ↔ EN 术语数据库，共 200+ 条，即使不装整个 skill 也可以单独使用。

### 单独使用的三种方式

1. **Agent 里只做术语检查**：skill 的 Workflow 内置 "Terminology check only" 任务类型，只加载 `terminology.md`，不跑完整写作流程。直接对 Agent 说「按 ui-copywriter 的术语表检查这段文案」即可
2. **直接引用/下载文件**：它是一份纯 Markdown 表格，可直接阅读、粘贴进其他 prompt，或通过 raw 链接集成到任何工具链：
   ```
   https://dev.msh.team/xujianxuan/ui-copywriter/-/raw/main/references/terminology.md
   ```
3. **喂给校验脚本**：`validate_copy.py` 会自动解析 Notes 列里的 `Never use "X"` 注记生成禁用词检查——在术语表里加一条禁用说法，校验脚本零改动生效

### 表格结构

| 列 | 说明 |
|----|------|
| CN | 中文标准说法 |
| EN | 英文标准说法（含大小写规范） |
| Notes | branded 标记（正文保持大写的功能名）、`Never use "X"` 禁用说法、语境变体（如列表项/句中形态） |

### 术语分类一览

| 分类 | 条数 | 内容举例 |
|------|-----:|----------|
| Actions | 22 | Log in / Sign up / Delete / Deactivate |
| Entities & States | 22 | Chat history / Saved Prompts / Wi-Fi / Memory |
| Navigation & Layout | 3 | Hide sidebar / Show sidebar |
| Account & Settings | 11 | Terms of Service / Privacy Policy / 各协议文档名 |
| Onboarding & Auth | 9 | Log in with phone number / Open App / QR code |
| AI & Generation States | 13 | Searching / Reflecting / Generating at full speed |
| Content & Output | 8 | Download PDF / Copy text / Generate image |
| Common Phrases & Feedback | 3 | Delete this Saved Prompt / Maybe later |
| Templates & Presentation | 5 | Visual design expert / Select a template |
| Confirmation & Error | 9 | Delete chat / Delete {n} chats / up to {n} files |
| Kimi+ Specific | 2 | My Kimi+ |
| Time Filters | 3 | This week / This month / All chats |
| Product Names | 15 | Kimi Code / Kimi Work / Kimi Slides / Kimi AI Assistant |
| Kimi Claw | 8 | Kimi Claw / OpenClaw / Claw Groups / Kimi Claw Skills |
| Brand Terms | 2 | Moonshot AI / Light mode |
| Model Names | 9 | K2.5–K3 / HighSpeed / Nano Banana Pro |
| Membership & Plans | 14 | Explorer / Andante / Moderato / Allegretto / Vivace / Extra Usage |
| Features & Tools | 36 | Deep Research / Agent Swarm / API Key / Beta Program / Skills |
| AI PPT Modes | 4 | Visual / Classic / Banana / Express |
| Vibe Coding | 3 | Vibe Coding / Annotate / Pin |
| Integrations & Third Parties | 8 | Lark / DingTalk / WeCom / iFinD / Tianyancha |

### 维护原则

- **术语以线上 Lokalise 导出为准**：术语表与线上文案有差异时，按线上现行说法更新术语表
- 改术语只改 `terminology.md`，SKILL.md 和其他 references 通过指针引用，不复制条目

---

## 已定稿的核心规则（2026-08-05 逐批拍板）

| 规则 | 说明 |
|------|------|
| **Dialog 无问号** | 确认弹窗用动宾直述：`删除此会话` / `Delete chat`，不用 `是否`、`Are you sure...` |
| **句号** | 短文案句尾一律省点，多句仅在句间用点（`上传失败，请重试` / `Upload failed. Please try again`）；长段落（>15 词）保留完整句读 |
| **Sentence case** | 英文一律 sentence case，仅两个例外：① 术语库标记 branded 的功能名（Saved Prompts 等）正文里也保大写；② `App` 永远大写 A |
| **{n} 统一复数** | `Delete {n} chats`，不写 `chat(s)`、不做单复数分支；固定数量才用单数 |
| **绝对词** | 禁 永远/绝对/always/never/guarantee；`must` 允许用于硬性要求 |
| **术语** | 以线上 Lokalise 导出为准；禁造术语 |

## 本次更新（2026-08-05）

- **规则定稿**：dialog 去问号、单句省尾点、sentence case 双例外（branded 功能名 + App）、`{n}` 统一复数、`must` 移出绝对词
- **术语库大扩充**（约 45 条）：Kimi Claw 系列（OpenClaw / Claw Groups / Desktop / Android / Plugin / Skills）、产品新命名（Kimi Work / Kimi Slides / Docs / Sheets / Websites / Kimi AI Assistant）、会员体系（Explorer / Andante / Moderato / Allegretto / Vivace、Extra Usage、Membership Credits、Business Workspace）、第三方集成（Lark / DingTalk / WeCom / iFinD / Tianyancha…）、功能（Scheduled tasks / Skills / Dream Memory / Beta Program / API Key…）
- **校验脚本重写**：`validate_copy.py` 改为术语库驱动——在 `terminology.md` 的 Notes 里写 `Never use "X"` 即自动生成检查项；新增 dialog 问号、单句尾点、WiFi/KIMI 错误大小写等检查
- **结构治理**：SKILL.md 硬约束区单源化（摘要 + canonical 指针），references 章节重编号，EN 路径补挂 `linguistic-logic.md`
- **线上导出 sentence case 修订**：Lokalise 导出 381 行通用标签 Title Case 违规已全部改为 sentence case（产出 `Kimi_-_Web.sentence-case.xlsx` + 变更清单 TSV，seo/meta 行暂未跟进）

## Use Case Example

**场景：写一个「删除常用语」的确认弹窗 + 操作结果 toast**

❌ 错误写法：

```
弹窗标题  CN: 是否删除此常用语？
弹窗标题  EN: Delete this Prompt Preset?
弹窗描述  EN: This prompt preset will be permanently deleted.
删除失败  EN: Prompts Delete Failed
成功 toast EN: Delete Success!
批量删除  EN: Delete {n} chat(s)?
侧边栏    EN: Hide Sidebar / Chat History
```

违反了 6 条规则：dialog 用 `是否` + 问号、旧术语 `Prompt Preset`（线上现行 = Saved Prompts）、通用标签 Title Case、`{n}` 写了 `(s)` 分支、感叹号、动名词语序。

✅ 正确写法：

```
弹窗标题  CN: 删除此常用语
弹窗标题  EN: Delete this Saved Prompt
弹窗描述  CN: 这条常用语将被删除，不可恢复及撤销
弹窗描述  EN: This Saved Prompt will be deleted and can't be recovered
删除失败  CN: 常用语删除失败，请重试
删除失败  EN: Prompts delete failed. Please try again
成功 toast CN: 已删除
成功 toast EN: Deleted
批量删除  CN: 删除 {n} 个会话
批量删除  EN: Delete {n} chats
侧边栏    EN: Hide sidebar / Chat history
```

要点：弹窗动宾直述无问号；branded 功能名 `Saved Prompt` 正文里保持大写；操作消息里用 `Prompts`（sentence case）；短文案句尾一律省点，句间用句号；`{n}` 一律复数。

写完别忘跑校验：

```bash
python3 scripts/validate_copy.py '删除此常用语'
python3 scripts/validate_copy.py 'Delete this Saved Prompt'
```

---

## English

A reusable Agent skill for writing, optimizing, translating, and validating Chinese/English UI copy (buttons, menus, dialogs, toasts, empty states, error messages). Ships with a Kimi product terminology database and an automated checker. Works with Kimi Code / Claude Code / Cursor / Codex.

### Features

- **Terminology consistency** — 200+ term pairs in `references/terminology.md`; the live Lokalise export is the source of truth
- **Punctuation rules** — full-width for CN, half-width for EN; short copy omits the final period even across multiple sentences (`Upload failed. Please try again`)
- **Tone & style** — second person (你/You); no absolute words, no exclamation marks, no double negatives
- **Sentence case** — EN copy uses sentence case; only branded feature names (Saved Prompts, etc.) and `App` keep their capitals
- **Dialogs** — verb-object phrases, no question marks, no "Are you sure..."
- **Plurals** — `{n}` placeholders always take the plural form (`Delete {n} chats`)
- **Validation** — `scripts/validate_copy.py` auto-generates forbidden-term checks from the terminology database

### Terminology (standalone use)

`references/terminology.md` is a self-contained CN ↔ EN term database (200+ rows across 21 categories: product names, Kimi Claw, membership tiers, features, integrations…). You can use it without installing the skill:

- Ask your agent to "check this copy against ui-copywriter's terminology table" — the skill has a terminology-only task type that loads just this file
- Fetch the raw file for any toolchain: `https://dev.msh.team/xujianxuan/ui-copywriter/-/raw/main/references/terminology.md`
- `Never use "X"` notes in the table auto-feed `validate_copy.py` — adding a banned variant needs no script changes

When the table and the live product copy differ, the live Lokalise export wins.

### Install

```bash
npx skills add https://dev.msh.team/xujianxuan/ui-copywriter.git --skill ui-copywriter
```

Or ask your agent: "Clone `https://dev.msh.team/xujianxuan/ui-copywriter.git`, then follow `ui-copywriter/SKILL.md`."
