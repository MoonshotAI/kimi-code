# 文档 Agent 指南

本文件补充根目录的 `AGENTS.md`，只管 `docs/` 下的文档站。

本仓库用 VitePress 构建文档站。`docs/en/` 和 `docs/zh/` 下大多数面向用户的页面都已写完；新增或更新的内容要让两个语言版本保持同步。

编写、翻译和评审页面时，按 [文档写作指南](../.agents/skills/gen-docs/references/writing-guide.md) 核对格式、页面结构和示例，交付前过一遍其中的检查清单。

## 结构

- 两个语言版本分别放在 `docs/en/` 和 `docs/zh/` 下，路径和文件名互为镜像。
- 主要栏目（导航栏 + 侧边栏）如下：
  - Guides 包含 getting-started、migration、use-cases、interaction、sessions、worktrees、tower、web、remote-control、remote-environment。
  - Customization: mcp, skills, plugins, agents, hooks, ides, other-agents, themes
  - Configuration: config-files, providers, overrides, env-vars, data-locations
  - Reference: kimi-command, tools, slash-commands, keyboard
  - Release notes: changelog
- 导航栏和侧边栏定义在 `docs/.vitepress/config.ts` 里。新增或重命名的页面，必须在这里为两个语言版本都配置好。
- 外部 agent 接入 Kimi Code 的中英文用户指南放在 `docs/{en,zh}/customization/other-agents.md`。`skills/use-kimi-code/SKILL.md` 是跨版本的公开技能，构建时复制到 `/skills/use-kimi-code.md`。`packages/kap-server/docs/kap.md` 是与运行版本匹配的 KAP 协议指南，由服务通过 `GET /api/v1/kap.md` 提供。公开技能里不要写具体端点的载荷，让 agent 从运行中的服务读取 API 用法（`GET /api/v1/kap.md`）和字段定义（`GET /openapi.json`）。

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

## 格式选择

- 按顺序操作用有序列表，步骤里不嵌套列表。独立条目用无序列表，多维对照用表格，解释原因用段落。
- 中文与英文、数字、行内代码和链接之间留空格，中文用全角标点。围栏代码块标语言，自然语言提示词除外。callout 用简短类别标题，详细说明写进正文。
- 概念首次出现时链接到具体页面或章节。重写时核对原有内容的去向，在 PR 里说明有意删减的内容。

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
