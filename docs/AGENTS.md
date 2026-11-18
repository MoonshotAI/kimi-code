# 文档 Agent 指南

本文件补充根目录的 `AGENTS.md`，只管 `docs/` 下的文档站。

本仓库用 VitePress 构建文档站。`docs/en/` 和 `docs/zh/` 下大多数面向用户的页面都已写完；新增或更新的内容要让两个语言版本保持同步。

## 结构

- 两个语言版本分别放在 `docs/en/` 和 `docs/zh/` 下，路径和文件名互为镜像。
- 主要栏目（导航栏 + 侧边栏）如下：
  - Guides: getting-started, migration, use-cases, interaction, sessions
  - Customization: mcp, skills, plugins, datasource, agents, hooks
  - Configuration: config-files, providers, overrides, env-vars, data-locations
  - Reference: kimi-command, tools, slash-commands, keyboard
  - Release notes: changelog
- 导航栏和侧边栏定义在 `docs/.vitepress/config.ts` 里。新增或重命名的页面，必须在这里为两个语言版本都配置好。

## 唯一依据

- **变更记录页面**：英文版（`docs/en/release-notes/changelog.md`）是唯一依据，中文变更记录应从它翻译。目前变更记录是每次发布后手动运行一个技能生成的，这个技能从 CLI 包的 `CHANGELOG.md` 同步内容。
- **其他所有页面**：`docs/en/` 和 `docs/zh/` 下的页面两两互为镜像，路径、标题和章节结构都相同。在哪个语言版本上工作就改哪个，并在同一个改动里更新另一个语言版本。

发布前让两个语言版本保持同步。可以借助机器翻译；但要检查你改过的语言版本和它的镜像，确认内容准确、术语正确、没有失效链接。

## 编写流程

- 每个页面都要沿用相邻页面已经确立的章节顺序。变更记录是例外，因为它是根据发布历史生成的。
- 其他页面：改任意一个语言版本，然后在同一个改动里更新它的镜像。

重写页面之前，一定要：（1）弄清原页面为什么是现在这种结构，（2）找出读者真正需要知道什么，（3）勾勒出章节结构，然后（4）填充内容。跳过第 1–3 步，就会在调整格式的过程中丢掉内容。

## 读者

Kimi Code 文档面向两类有重叠的读者。写作时要同时照顾这两类读者。

**技术用户**：熟悉终端、配置文件、API 密钥和环境变量。直接给他们命令和路径，不要解释基础知识。

**非技术背景的 AI 用户**：产品经理、设计师、运营人员。他们用 AI 工具，但不熟悉「stdin」「exit code」「regex」这类术语。他们主要通过 VS Code 或配置文件使用产品，而不是写脚本。

两类读者的行为相同：带着具体目标而来，先扫一遍标题和首句再往下读，按顺序执行步骤，直接复制粘贴代码块。一碰到没有解释的术语，他们就会离开页面。

**写作目标**：
- 技术用户：5 分钟内完成一项任务，没有废话。
- 非技术用户：靠复制粘贴就能配出一套能用的环境，并大致明白它做了什么，不需要理解底层机制。

**术语规则**：术语第一次出现时，在括号里加一句通俗的解释。之后正常使用这个术语。

> 示例：`stdin` (the channel a program reads input from), `exit code` (the status number a program returns when it finishes; 0 means success).

## 命名约定

- 文件名用 kebab-case，并在两个语言版本间互为镜像（`docs/en/` 和 `docs/zh/` 下用同一个 slug）。
- 栏目名称保持统一，与侧边栏标题一致。
- flag、命令、子命令、命令参数、文件路径、代码标识符、类型名、字段名、字段值和键盘快捷键，都用反引号标记。

## 措辞约定

- 不要修改 H1 标题和导航栏/侧边栏标签。
- 英文 H2+ 标题用 sentence case（只有第一个词首字母大写，专有名词除外）。把「Wire」「Plan mode」「Thinking mode」以及权限模式名「Always Ask」「Ask When Needed」「Never Ask」当作专有名词；不要把「agent」当作专有名词。
- 中文 H2+ 标题里的英文单词同样用 sentence case；下方术语对照表里列出的专有名词保持原样。
- 英文用 `API key`，中文用 `API 密钥`；`JSON`、`JSONL`、`OAuth`、`macOS`、`Node.js`、`npm`、`pnpm` 和 `TypeScript` 保持原样。
- 引用内容用直双引号并加空格：`"被引内容"`（不用弯引号）。引用文字紧挨 CJK 字符时，在它前后各加一个空格。特殊术语用直角引号 `「」`（例如 `「工具」`、`「会话」`）。
- 中文里两者都适用时，优先用「终端」而不是「命令行」（例如「运行在终端中」「终端界面」「终端操作」）。
- 用「工具调用」/「tool call」，不用「工具使用」/「tool use」。
- 工具名用行内代码（例如 `Read`、`Grep`、`Bash`）。

术语对照表（中文 <-> 英文，以及专有名词的处理）：

| 中文 | 英文 | 是否专有名词（中文） | 是否专有名词（英文） |
| --- | --- | --- | --- |
| Agent | agent | yes | no |
| main agent | main agent | no | no |
| subagent | subagent | no | no |
| Shell | shell | yes | no |
| Plan 模式 | Plan mode | yes | yes (Plan mode) |
| 始终询问 | Always Ask | yes | yes |
| 必要时询问 | Ask When Needed | yes | yes |
| 完全自动 | Never Ask | yes | yes |
| Thinking 模式 | Thinking mode | yes | yes (Thinking mode) |
| MCP | MCP | yes | yes |
| Kimi Code CLI | Kimi Code CLI | yes | yes |
| Agent Skills | Agent Skills | yes | yes |
| Skill | skill | yes | no |
| 系统提示词 | system prompt | no | no |
| 提示词 | prompt | no | no |
| 会话 | session | no | no |
| 上下文 | context | no | no |
| API 密钥 | API key | yes | no |
| JSON | JSON | yes | yes |
| JSONL | JSONL | yes | yes |
| OAuth | OAuth | yes | yes |
| macOS | macOS | yes | yes |
| TypeScript | TypeScript | yes | yes |
| Node.js | Node.js | yes | yes |
| npm | npm | yes | yes |
| pnpm | pnpm | yes | yes |
| kimi | kimi | yes | yes |
| 审批请求 | approval request | no | no |
| 斜杠命令 | slash command | no | no |
| 工具调用 | tool call | no | no |
| Frontmatter | frontmatter | yes | no |
| User 消息 | user message | yes (User) | no |
| Assistant 消息 | assistant message | yes (Assistant) | no |
| Tool 消息 | tool message | yes (Tool) | no |
| 轮次 | turn | no | no |
| 供应商 | provider | no | no |
| Prompt Flow | Prompt Flow | yes | yes |
| Diff | diff | yes | no |

### Kimi 平台规则

有两个不同的平台，绝不能混用：

| | Kimi Code 平台 | Kimi Open Platform |
|---|---|---|
| 目标用户 | 个人开发者，订阅制 | 企业 / 产品集成，按 token 计费 |
| OpenAI 兼容的 base URL | `https://api.kimi.com/coding/v1` | `https://api.moonshot.cn/v1` |
| Anthropic 兼容的 base URL | `https://api.kimi.com/coding/` | 不支持 |
| API 密钥入口 | [Kimi Code 控制台](https://www.kimi.com/code/console) | [platform.kimi.com](https://platform.kimi.com) |

规则：
- 为 Kimi Code CLI 或 VS Code 写文档时：始终用 `api.kimi.com/coding/…`。在这种语境下，绝不要写 `api.moonshot.cn`。
- 为 Open Platform 的接入写文档时：用 `api.moonshot.cn/v1`。
- 明确区分语境：「in Kimi Code CLI / VS Code」与「in third-party tools / your own product」。
- 产品全称：**Kimi Code CLI** 和 **Kimi Code for VS Code**。不要缩写成「Kimi CLI」。

## 排版

- **中英文混排的空格**：中文字符与英文单词、数字、行内代码或链接之间加一个空格。例外：全角标点前不加空格。
  - ✓ 在 TypeScript 中使用 `class` 关键字
  - ✗ 在TypeScript中使用`class`关键字
  - ✓ 详见 [配置文件](./config.md)。
  - ✗ 详见[配置文件](./config.md)。
- **全角标点**：中文文本里用全角标点：`，。；：？！（）`，不用 `, . ; : ? ! ( )`。
- **键盘快捷键**：修饰键和按键之间用连字符（`Ctrl-C`、`Ctrl-D`、`Shift-Tab`、`Alt-V`），不用加号。例外：照录的应用输出（例如产品自己输出的 `Press Ctrl+C again to exit` 提示）保持原样。
- **代码块语言**：围栏代码块一律标注语言（例如 ` ```sh `、` ```toml `、` ```json `、` ```ts `）。例外：自然语言示例（用户提示词）可以不标语言。
- **callout 容器标题**：callout 容器（`::: tip`、`::: warning`、`::: info`、`::: danger`）用简短的类别标题。详细说明写在块的内容里，不要写在标题里。
  - 中文：tip 用 `提示`，warning 用 `注意`，info 用 `说明`，danger 用 `警告`。
  - 英文：不加标题，或者用简短的词，例如 warning 用 `Note`。
  - ✓ `::: tip 提示` + 以要点开头的内容
  - ✓ `::: warning 注意` + 内容 `部分 \`.agents\` 资源不受 \`KIMI_CODE_HOME\` 影响。...`
  - ✗ `::: warning 不影响 .agents`（标题太长，应该写进内容）
  - ✗ `::: tip .agents 路径独立于 KIMI_CODE_HOME`（标题太长）
- **版本信息块**：说明版本变化的 callout 容器用 `::: info`，并带类别标题（英文：Added/Changed/Removed；中文：新增/变更/移除）。内容要写成完整的句子。
  - ✓ `::: info 新增` + 内容 `新增于 0.2.0。`
  - ✗ `::: info 新增于 0.2.0`（标题太长）
  - ✓ `::: info Changed` + 内容 `Renamed in 0.2.0. ...`
  - ✗ `::: info Renamed in 0.2.0`（标题太长）
- **callout 容器语法**：独立的 callout 容器用 `:::`。`::::` 只能用作嵌套容器的外层围栏，而且必须正确闭合；未闭合或不匹配的 `::::` 会破坏页面渲染。不需要嵌套时，改用 callout 容器里的 `>` 引用块来写次要说明。

## 写作风格

- **自然叙述**：像写文章一样组织内容，引导读者顺畅地读下去。
- **避免碎片化**：不要把每个要点都变成小标题，改用段落之间的过渡。这条适用于叙述性内容，也就是以连贯文字展开的解释、动机和逐步推理。
- **全局视角**：「Getting Started」只介绍核心概念；详细用法放到后面的页面。
- **逐步深入**：Guides → Customization → Configuration → Reference，信息逐步加深。
- **不加导航用的 callout 容器**：VitePress 会自动提供上一页/下一页导航；不要在页面末尾加 `::: tip 接下来` 块。有紧密相关的后续页面时，可以加一个 `## Next steps` 小节，见 [页面结构](#页面结构)。
- **一段一个要点**：每段只讲一个要点。以 3–4 句为目标；一段超过 5 句就拆开。
- **先地图，后细节**：每个页面和每个主要章节，开头都先用一句「地图」句说明这一部分讲什么、和前文有什么关系，再展开细节。读者深入之前，应该先知道自己在哪儿。

  > ❌ 直接跳进细节：「Credential resolution has three steps: first read `api_key`…」
  >
  > ✓ 先地图，后细节：「Provider credentials follow a separate resolution path from ordinary runtime parameters — the CLI reads only from `config.toml` and never falls back to shell environment variables. The priority order is:…」

- **并列内容需要格式化**：这条和「避免碎片化」相对应，区别在于你手上是哪一类内容。同一类的多个条目（文件说明、配置字段解释、注意事项）写成一段段没有视觉区分的段落，会迫使读者去辨认形式，而不是理解意思。修正方法：
  - 每个条目都是「名称 + 一句话」时，用无序列表：`- **Name**: description`
  - 有多个维度（名称 + 类型 + 说明）时，用表格
  - 每个条目都超过两句话时，用 `###` 小标题

### 示例：好写法与坏写法

大纲提示词：

```
* Install and upgrade
  * System requirements: Node.js 24.15.0+, recommend pnpm
  * Install, upgrade, uninstall steps
```

**坏写法**（机械地转换成标题）：

```markdown
## Install and upgrade

### System requirements

- Node.js 24.15.0+
- Recommend pnpm

### Install

...

### Upgrade

...
```

**好写法**（自然叙述）：

```markdown
## Install and upgrade

Kimi Code CLI requires Node.js 24.15.0 or later. We recommend using pnpm for installation and management.

If you haven't installed pnpm yet, please refer to the pnpm installation docs first. Install Kimi Code CLI:

(code block)

Verify the installation:

(code block)

Upgrade to the latest version:

(code block)
```

## 格式选择

按内容本身的结构选格式，不要选看起来最周全的那种。

**有序列表**：必须按顺序进行的步骤（安装、配置、迁移）。不要在步骤里嵌套子列表。

**无序列表**：没有先后依赖的并列条目。格式：`- **Name**: one-sentence description`。

**表格**：需要对比或查阅的多维度参考内容（配置字段的名称 + 类型 + 是否必填 + 说明；键盘快捷键；平台对比）。单元格内容需要换行才能读清时，避免用表格。

**段落文字**：解释、动机、注意事项，以及其他适合用连贯句子自然展开的内容。不要只为了增加视觉上的结构，就把段落文字改成列表。

## 交叉引用

读者从来不会只读一个页面。完整的理解通常分散在好几个页面里。只要链接有帮助，就加上。

**以下情况一定要加链接**：
1. 本页提到的某个概念在另一个页面有完整解释：第一次提到时就链接过去，不要等到第二次或第三次。相关内容在某个具体章节时，优先链接到锚点（`#section`），而不是页面顶部。
2. 本页只给了简要概述，而另一个页面有完整的字段参考或示例：从概述链接到详细内容。
3. 本页靠后的章节依赖本页前面定义的概念：用 `[term](#anchor)` 链回去，让读者不用来回滚动。

**不要这样写**：
- 「See related documentation」：到底是哪份文档？读者会直接跳过这种话。
- 只在页面底部的「Next steps」列表里放链接：读到一半卡住的读者，不会滚到页尾去找链接。
- 第一次提到时不加链接，第二次或第三次提到时才加：第一次提到时，正是读者最想点链接的时候。

**行内链接与「Next steps」**：行内链接服务于读到一半需要补充信息的读者。页面结尾的「Next steps」小节，服务于读完整页、想顺着往下读的读者。两者各有用处，谁也替代不了谁。

## 页面结构

```
# Title (noun phrase, no period)

Opening sentence or two + plain-English summary (only when the concept has a learning curve)

> blockquote (optional: Beta notice, prerequisites)

Supplementary context / use-case list (optional)

Diagram (optional)

::: warning Banner (deprecation, breaking change, security notice — after opening content, before first ##)

## First section

Body…

## Next steps (optional, only when related pages exist)
- [Page name](/path) — one sentence describing what the reader can do there
```

**横幅位置规则**：横幅必须放在所有开头内容（开头的句子、引用块、图示）之后、第一个 `##` 之前。横幅绝不能是页面上的第一项内容。

## 内容完整性

**默认做法：全部保留**。编辑页面时，原有内容的每一块都要有明确的去向：要么保留，要么有意删掉并写明理由。

**可以删减内容的正当理由**：
- 过于底层 / 纯属实现细节，用户永远不需要据此做任何操作
- 另一个页面已经讲得更完整，而且本页链接到了那个页面
- 内容含糊或疑似过时：把它标出来，而不是悄悄删掉

**不成立的理由**：
- 「看起来不重要」：这是猜测，不是理由
- 「我对这块不太确定」：去查清楚，而不是删掉
- 「页面越来越长了」：调整结构，不要删减

如果删减了内容，在 PR 描述或提交说明里明确写出来。不要在文档正文里写删减说明。

## 检查清单

任何文档改动在标记为可以评审之前，都要先过一遍这份清单。

### 格式

| 问题 | 修正方法 |
|---|---|
| `::::` 未闭合或不匹配 | 闭合围栏；如果不需要嵌套，换成 `:::` |
| callout 容器互相嵌套 | 把内层的改成 `>` 引用块 |
| 横幅在第一个 `##` 之前，但也在开头内容之前 | 移到开头的句子 / 引用块 / 图示之后 |
| 步骤写成了无序列表 | 改成有序列表 |
| 多维度的对比写成了段落文字 | 改成表格 |
| 技术术语第一次出现时没有解释 | 在括号里加一句通俗的解释 |
| 交叉引用写成「see …」，却没有链接 | 加行内链接；优先链接到章节锚点，而不只是页面顶部 |
| 概念依赖前文的定义，却没有回链 | 加上 `[term](#anchor)` |
| 改了 zh 却没改 en（或者反过来） | 两个语言版本都更新 |
| 代码块没有语言标记 | 加上语言（例如 `sh`、`toml`、`json`）；例外：自然语言的提示词示例可以不加标记 |

### Kimi 相关的一致性

发布之前，确认下面这些值和文档其他部分一致：

- **Base URL**：与上文 [Kimi 平台规则](#kimi-平台规则) 里的表格一致
- **升级命令**：与 `guides/getting-started.md` 一致
- **模型 ID**：用 `kimi-for-coding`，不用带版本号的模型名
- **登录命令**：`/login`，不是 `/setup`
- **产品全称**：**Kimi Code CLI** 或 **Kimi Code for VS Code**，绝不能写成「Kimi CLI」
- **平台 URL**：Kimi Code 平台用 `api.kimi.com/coding/…`；Open Platform 用 `api.moonshot.cn/v1`，两者绝不能混用

## 构建与预览

- 文档由 VitePress 从 `docs/` 构建。
- 常用命令（在 `docs/` 目录下运行）：
  - `npm install`
  - `npm run dev`
  - `npm run build`
  - `npm run preview`
- 构建产物在 `docs/.vitepress/dist`。

## 变更记录同步

变更记录的生成流程见 `sync-changelog` 技能。
