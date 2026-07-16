# Agent 与子 Agent

Kimi Code CLI 中的每次会话都由一个**主 Agent** 驱动。主 Agent 理解用户意图、规划步骤、调用工具，并在需要时向外派发**子 Agent** 处理更聚焦的子任务——例如探索一个陌生代码库、并行审阅多处实现、或在不触碰主上下文的情况下规划一次大型重构。

子 Agent 接受主 Agent 给出的任务描述，在自己的独立上下文里工作，最后把结论返回。它不会与用户直接对话，中间的思考和工具调用记录也不会混入主 Agent 的历史。

## 内置子 Agent

Kimi Code CLI 内置三种子 Agent，开箱即用，分别面向不同任务形态：

- **`coder`**：默认子 Agent，通用软件工程助手，可以读写文件、执行命令、搜索代码并落地具体改动。
- **`explore`**：代码库探索专用，只做只读操作，不修改任何文件。适合在不改动文件的前提下快速搜索、阅读和总结仓库。
- **`plan`**：实现规划与架构设计专用，连 Shell 命令都不提供，专注于"想清楚怎么做"而不是"动手做"。

`coder` 子 Agent 与主 Agent 共享大部分工具集：可以在后台执行 Shell 命令、维护待办列表、进入 Plan 模式、调用 Agent Skills，也可以在任务自然拆解时继续派发自己的嵌套子 Agent。如果它结束自己的轮次时仍有后台任务在运行，那么只有在这些后台任务全部落定后，这次运行才会回报完成——主 Agent 拿到结果时，背后的工作也已经真正完成。

## 调用方式

子 Agent 由主 Agent 自动调度——根据任务复杂度、上下文消耗和子任务的独立性，在适当时机派发，无需用户手动指定。

每次派发都会在终端以审批请求的形式呈现（除非命中 allow 规则或处于 YOLO 模式），方便你审视任务描述。你也可以在对话中直接指示主 Agent 使用特定子 Agent，例如"先用 explore 把相关文件梳理一遍再动手"。

子 Agent 支持在后台运行：完成后结果自动回到主 Agent，无需手动轮询。也可以唤回已有的子 Agent 实例继续推进同一任务。

## 上下文隔离与资源开销

每个子 Agent 拥有完全独立的上下文窗口，只能看到主 Agent 显式传入的任务描述，看不到主 Agent 的对话历史。子 Agent 自己的中间思考和工具调用记录不会回流，只有最终结果会出现在主 Agent 的上下文里。

这种隔离带来两个好处：

- **主 Agent 上下文保持精炼**，长会话中不会被大量探索性日志撑满。
- **多个子 Agent 可以并行运行**，互不干扰。

需要注意的是，每个子 Agent 都会独立消耗模型 token。简单任务没有必要派发子 Agent，主 Agent 直接处理更经济。

## 权限继承

子 Agent 的权限规则继承自主 Agent：主 Agent 通过 `/permission` 或在审批中接受的"始终允许"规则，会自动覆盖到它派发出的所有子 Agent，子 Agent 不需要重新审批同类工具调用。`Agent` 工具本身默认放行，因此主 Agent 可以在不打断用户的前提下完成多次委派。

如果需要某类工具在子 Agent 中始终不可用，应收紧主 Agent 的权限规则。

## 自定义 Agent

除了三个内置子 Agent，你还可以用 Markdown 文件定义自己的 Agent。每个文件描述一个 Agent：文件顶部的 Frontmatter（YAML 元数据）声明名称、描述和工具权限，文件正文是它的系统提示词。自定义 Agent 可以作为子 Agent 被委派 —— 主 Agent 会自动发现它们，与内置子 Agent 并列 —— 也可以在启动时选为主 Agent。

### Agent 目录

Kimi Code CLI 按作用域发现 Agent 文件，作用域越具体，优先级越高：**项目 > 额外 > 用户 > 内置**。两个文件定义了相同的 `name` 时，高优先级作用域胜出。每个目录都会递归扫描 `.md` 文件。

**用户级**（对所有项目生效）：
- `$KIMI_CODE_HOME/agents/`（默认：`~/.kimi-code/agents/`）
- `~/.agents/agents/`

Kimi 专属的用户 Agent 目录随 `KIMI_CODE_HOME` 移动，通用的 `~/.agents/agents/` 目录留在真实用户目录下，便于跨工具共享。

**项目级**（项目根目录 = 从工作目录向上查找、最近的包含 `.git` 的目录）：
- `.kimi-code/agents/`
- `.agents/agents/`

**额外目录**：在 `config.toml` 顶层通过 `extra_agent_dirs` 声明：

```toml
extra_agent_dirs = ["~/team-agents", ".agents/team-agents"]
```

**内置 Agent** 随 CLI 分发，优先级最低。目录中发现的文件不会仅凭同名覆盖内置 Agent；如确需替换，必须在 Frontmatter 中声明 `override: true`。通过 `--agent-file` 加载的文件视为显式启动意图，可以覆盖同名内置 Agent，优先级高于所有目录作用域，且仅对本次启动生效。

### Agent 文件格式

Agent 文件是带 Frontmatter 的普通 Markdown：

```markdown
---
name: reviewer
description: 严格的代码审查 Agent，按严重度分级报告问题
whenToUse: 代码评审与 PR 检查
override: false
mode: replace
tools:
  - Read
  - Grep
  - Glob
  - mcp__github__*
disallowedTools:
  - Bash
---

你是严格的代码审查者。阅读 diff 后，按严重度分级报告问题……
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `name` | 是 | kebab-case 唯一标识。缺少合法 `name` 的文件会被跳过并告警 |
| `description` | 是 | Agent 的用途。主 Agent 挑选子 Agent 时会看到，请围绕委派决策来写 |
| `whenToUse` | 否 | 补充说明何时应使用该 Agent |
| `override` | 否 | 是否允许覆盖同名内置 Agent，默认 `false`。`--agent-file` 属于显式启动意图，无需设置此字段 |
| `mode` | 否 | `replace`（默认）：正文即 Agent 的完整系统提示词。`append`：正文追加到默认系统提示词之上，工作区指令和 Skill 注入保持生效 |
| `tools` | 否 | 工具名允许列表，如 `Read`、`Bash`；MCP 工具用 glob 匹配，如 `mcp__github__*`。缺省表示允许全部工具；空列表（`tools: []`）表示禁用全部工具 |
| `disallowedTools` | 否 | 禁止列表，匹配规则相同，在 `tools` 之后应用 |

未知字段会被忽略，新版本写的文件在旧版本上仍可读取。

目录中发现的非法文件会被跳过并告警，不影响其他文件。通过 `--agent-file` 显式传入的文件必须合法 —— 否则 CLI 会报错并退出。

::: warning 注意
`tools` 与 `disallowedTools` 只决定模型能"看到"哪些工具，并不是执行时的沙箱。如需保证某个工具无法运行，请收紧相应的权限规则。
:::

作为子 Agent 委派的自定义 Agent 不会携带内置子 Agent 的角色框架（"你的最后一条消息就是完整交付"）。如果编写的 Agent 用于委派，请在正文中说明：其最后一条消息应当是交付给调用方的完整、自包含的结果。

### 选择主 Agent

两个 CLI flag 用于选择驱动会话的 Agent。**目前二者都要求 v2 引擎** —— 即 `KIMI_CODE_EXPERIMENTAL_FLAG=1` 下的 `kimi -p`；交互式 TUI（v1）暂时会以明确错误拒绝它们：

- **`--agent <name>`**：以指定 Agent 作为主 Agent 启动会话。名称可以指向内置 Agent 或任何已发现的文件；名称不存在时会报错，并列出可用的 Agent。
- **`--agent-file <path>`**：以最高优先级加载一个 Agent 文件（仅本次启动）并以其启动。重复传入可注册多个文件 —— 不传 `--agent` 时，以最后一个 `--agent-file` 定义的 Agent 启动 —— 配合 `--agent <name>` 按名称选择。

例如在 print 模式下：

```sh
KIMI_CODE_EXPERIMENTAL_FLAG=1 kimi -p --agent reviewer "审查这个分支上的改动"
```

绑定的 Agent 即会话的身份：在会话首次绑定后即固定，之后不可切换。重复选择已绑定的 Agent（例如以相同的 `--agent` 恢复会话）是 no-op；选择不同的 Agent 会报 "already bound" 错误。

定制主 Agent 时推荐使用 `mode: append`，以保持环境、工作区指令和 Skill 注入生效；`mode: replace` 适合自包含、完全拥有自己提示词的子 Agent。

## 指令文件

全局 Kimi 专属指令可放在 `$KIMI_CODE_HOME/AGENTS.md`（默认：`~/.kimi-code/AGENTS.md`）。当你用 `KIMI_CODE_HOME` 移动数据根时，这份全局指令文件也会一起移动。跨工具通用指令仍可放在真实 OS home 下的 `~/.agents/AGENTS.md`，项目级指令仍放在项目目录中，例如 `.kimi-code/AGENTS.md` 或 `AGENTS.md`。

## 会话目录中的存储位置

子 Agent 的运行状态持久化到当前会话目录的 `agents/` 子目录下，每个子 Agent 实例对应一个独立目录，其中包含按时间顺序记录提示词、消息历史与最终状态的 `wire.jsonl` 文件。后台子 Agent 还会通过 `tasks/` 子目录暴露生命周期状态。

::: warning 注意
会话目录、wire 文件和任务记录都属于本地调试材料，可能包含用户 prompt、命令输出、仓库路径、工具返回内容或凭证痕迹。不要把这些文件直接提交到公开仓库、issue 或聊天记录里；如确需分享，请先脱敏。
:::

## 下一步

- [Hooks](./hooks.md) — 在子 Agent 完成等关键节点触发本地脚本通知或拦截
- [Agent Skills](./skills.md) — 给子 Agent 注入专业知识和工作流程
