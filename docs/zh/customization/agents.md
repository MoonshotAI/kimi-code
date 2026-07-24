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

Kimi Code CLI 按作用域发现 Agent 文件，作用域越具体，优先级越高：**显式（`--agent-file`）> 项目 > 额外 > 用户 > 内置**。两个文件定义了相同的 `name` 时，高优先级作用域胜出。每个目录都会递归扫描 `.md` 文件。

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

**内置 Agent** 随 CLI 分发，优先级最低。目录中发现的文件不会仅凭同名覆盖内置 Agent；如确需替换，必须在 Frontmatter 中声明 `override: true`。通过 `--agent-file` 加载的文件视为显式启动意图，可以覆盖同名内置 Agent，优先级高于所有目录作用域，且仅对本次启动生效。另外，`$KIMI_CODE_HOME/SYSTEM.md` 可永久覆盖默认主 Agent 的系统提示词（它不参与 Agent 文件发现），其优先级交互见下文 SYSTEM.md 小节。

::: warning 信任模型
Agent 文件属于提示词配置，而项目级文件来自仓库本身 —— 包括你刚刚 clone、尚不可信的仓库。项目作用域的文件可以完全接管内置 Agent：命名为 `agent.md` 并声明 `override: true` 会替换**默认主 Agent 的整个系统提示词**，`coder.md` 加 `override: true` 则会替换默认子 Agent 类型。与 `AGENTS.md` 内容（作为参考资料注入提示词）不同，override 文件**就是**系统提示词本身，且不写 `tools` 的文件保留全部工具。在不熟悉的仓库中运行 Kimi Code 之前，请以对待脚本同样的谨慎检查其中的 `.kimi-code/agents/` 与 `.agents/agents/` 目录。
:::

### Agent 文件格式

Agent 文件是带 Frontmatter 的普通 Markdown：

```markdown
---
name: reviewer
description: 严格的代码审查 Agent，按严重度分级报告问题
whenToUse: 代码评审与 PR 检查
override: false
model_preference: primary
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
| `name` | 否 | kebab-case 唯一标识。缺省时取文件名（去掉扩展名，如 `review.md` → `review`）；解析后名字缺失或不是 kebab-case 的文件会被跳过并告警 |
| `description` | 是 | Agent 的用途。主 Agent 挑选子 Agent 时会看到，请围绕委派决策来写 |
| `whenToUse` | 否 | 补充说明何时应使用该 Agent |
| `override` | 否 | 是否允许覆盖同名内置 Agent，默认 `false`。`--agent-file` 属于显式启动意图，无需设置此字段 |
| `model_preference` | 否 | `Agent` 或 `AgentSwarm` 启动该 profile 时的符号默认值：`primary` 选择调用方的主模型，`secondary` 选择 `[secondary_model] model`。工具调用显式传入的 `model` 优先；两者均未设置时，已配置的次主力模型仍为默认值。未配置次主力模型时，子 Agent 继承调用方模型 |
| `tools` | 否 | 工具名允许列表，如 `Read`、`Bash`；MCP 工具用 glob 匹配，如 `mcp__github__*`。支持 YAML 列表或逗号分隔字符串（`tools: Read, Grep`）两种写法。缺省表示允许全部工具；单独的 `*` 同样表示允许全部工具；空列表（`tools: []`）表示禁用全部工具 |
| `disallowedTools` | 否 | 禁止列表，写法与匹配规则相同，在 `tools` 之后应用 |
| `subagents` | 否 | 允许委派的子 Agent 名称列表，写法与 `tools` 相同（YAML 列表或逗号分隔字符串）。缺省表示可委派所有类型；单独的 `*` 同样表示全部 |

内置工具与用户工具按名称精确匹配（区分大小写）；以 `mcp__` 开头的条目按 glob 匹配 MCP 工具。有三种写法永远匹配不到任何工具，在 profile 生效时会给出警告：`mcp__` 模式之外使用通配符（`disallowedTools` 里单独的 `*` 什么也禁不掉）；不是完整 `mcp__<服务器>__<工具>` 形式的 `mcp__` 字面量（`mcp__github` 匹配不到任何工具 —— 匹配整个服务器要用 `mcp__github__*`）；以及任何已注册或内置工具都没有的名字（通常是笔误，如把 `Read` 写成 `read`）。

正文即 Agent 的系统提示词，每次构建提示词时都会作为模板渲染：`${var}` 占位符替换为实时上下文值——未知变量保持原样，单独的 `$` 没有特殊含义，上下文中缺失的变量渲染为空字符串。`${base_prompt}` 会在你放置它的位置嵌入有效默认系统提示词（内置默认，或存在时为你的 `SYSTEM.md` 覆盖），因此文件可以"包裹"默认行为而不是替换它。可用变量见下文 SYSTEM.md 变量表。

未知字段会被忽略，新版本写的文件在旧版本上仍可读取。其他 Agent 工具的字段（如 Claude Code 的 `model`、OpenCode 的 `mode`）同样会被忽略；加上 `tools` 的逗号分隔写法和 `name` 缺省回退到文件名，Claude Code 与 OpenCode 风格的 Agent 文件一般可直接加载 —— 只含 `description` 和正文的最小文件可跨工具通用。

`model_preference` 仅在次主力模型实验功能启用时对新启动的子 Agent 生效。在 `kimi web` 下，设置 `KIMI_CODE_EXPERIMENTAL_SECONDARY_MODEL=1`；在实验性 `kimi -p` 下，必需的 `KIMI_CODE_EXPERIMENTAL_FLAG=1` 也会启用该功能。TUI 目前会忽略此字段。该字段不用于填写具体模型 alias，已恢复的子 Agent 也会保持原模型。主 Agent 会在 profile 描述中看到这项偏好，因此仍可在某项任务需要不同选择时显式传入 `model`。

目录中发现的非法文件会被跳过并告警，不影响其他文件。通过 `--agent-file` 显式传入的文件必须合法 —— 否则 CLI 会报错并退出。

::: warning 注意
`tools` 与 `disallowedTools` 不仅决定模型能"看到"哪些工具，还会在执行前再次强制检查。`subagents` 同样双重生效：`Agent` 工具的类型列表只包含允许委派的子 Agent，`Agent` 与 `AgentSwarm` 在实际派发前都会强制校验；唤回已有子 Agent 不受此限制。权限规则仍是独立的控制层，用于决定哪些操作需要审批。
:::

作为子 Agent 委派的自定义 Agent 不会携带内置子 Agent 的角色框架（"你的最后一条消息就是完整交付"）。如果编写的 Agent 用于委派，请在正文中说明：其最后一条消息应当是交付给调用方的完整、自包含的结果。

### 选择主 Agent

两个 CLI flag 用于选择驱动会话的 Agent。**目前二者仅在 `KIMI_CODE_EXPERIMENTAL_FLAG=1` 时的 `kimi -p` 下可用**；交互式 TUI 会以明确错误拒绝它们：

- **`--agent <name>`**：以指定 Agent 作为主 Agent 启动会话。名称可以指向内置 Agent 或任何已发现的文件；名称不存在时会报错，并列出可用的 Agent。
- **`--agent-file <path>`**：以最高优先级加载一个 Agent 文件（仅本次启动）并以其启动。该 flag 只接受一个文件：不可重复传入，也不能与 `--agent` 同时使用。

例如在 print 模式下：

```sh
KIMI_CODE_EXPERIMENTAL_FLAG=1 kimi -p --agent reviewer "审查这个分支上的改动"
```

绑定的 Agent 即会话的身份：在会话首次绑定后即固定，之后不可切换。重复选择已绑定的 Agent（例如以相同的 `--agent` 恢复会话）是 no-op；选择不同的 Agent 会报 "already bound" 错误。

定制主 Agent 时，在正文中引用 `${base_prompt}` 可保持默认提示词的环境、工作区指令和 Skill 注入生效；不引用 `${base_prompt}` 的正文则完全拥有自己的提示词，适合自包含的子 Agent。

### 用 SYSTEM.md 覆盖主 Agent 的系统提示词

希望永久覆盖主 Agent 的系统提示词、而不必每次启动都传入 `--agent` 或 `--agent-file` 时，可以写一份 `$KIMI_CODE_HOME/SYSTEM.md`（默认：`~/.kimi-code/SYSTEM.md`，随 `KIMI_CODE_HOME` 移动）。文件存在且非空期间，它整体替换内置默认主 Agent 的系统提示词——但只替换提示词，描述与工具集仍沿用内置默认值。SYSTEM.md 目前仅在 `kimi web`，以及 `KIMI_CODE_EXPERIMENTAL_FLAG=1` 时的 `kimi -p` 下生效；交互式 TUI 会忽略该文件。

SYSTEM.md 是纯 Markdown 正文，不需要也不读取 Frontmatter。文件缺失或为空时不生效；读取失败时会告警并回退到内置提示词。优先级上，显式意图仍然胜出：项目作用域中声明了 `override: true` 的同名 Agent 文件、通过 `--agent-file` 传入的文件都排在 SYSTEM.md 之前，用 `--agent` 选择其他 Agent 时 SYSTEM.md 也不会生效；而在用户作用域内部，SYSTEM.md 优先于 `agents/` 目录中扫描到的同名文件。

与普通 Agent 文件的正文一样，SYSTEM.md 在每次构建提示词时作为模板渲染——正文中的 `${var}` 占位符会被替换为实时上下文：

| 变量 | 内容 |
| --- | --- |
| `${skills}` | 合并后的 Agent Skills 注入内容；`Skill` 工具不可用时为空 |
| `${agents_md}` | 工作区指令文件（如 `AGENTS.md`）的内容 |
| `${cwd}` | 当前工作目录 |
| `${cwd_listing}` | 工作目录的文件列表 |
| `${os}` | 操作系统类型 |
| `${shell}` | Shell 名称与路径，例如 `bash (\`/bin/bash\`)` |
| `${now}` | 当前时间（ISO 格式） |
| `${additional_dirs_info}` | 加入工作区的额外目录信息；没有时为空 |
| `${base_prompt}` | 默认系统提示词。在 `SYSTEM.md` 中指内置默认提示词；在 Agent 文件中指有效默认提示词（内置默认，或存在时为你的 `SYSTEM.md` 覆盖） |

未知变量原样保留，单独的 `$` 没有特殊含义；上下文中缺失的变量渲染为空字符串。另有三个预组合块——`${windows_notes}`、`${additional_dirs_section}`、`${skills_section}`——渲染对应的内置提示词段落，不适用时为空字符串。利用这些变量可以重建内置提示词的骨架，例如：

```markdown
You are Kimi, running at ${cwd} on ${os}.

${agents_md}

${skills}
```

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
