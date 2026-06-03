# 斜杠命令

斜杠命令是 Kimi Code CLI 在交互式 TUI 中提供的内置控制命令，用于切换模式、管理会话、查看状态等。在输入框中输入 `/` 即可触发命令补全，候选列表会随后续字符实时过滤；命令的别名（alias）也会一并参与匹配。

输入完整命令名（如 `/help`）后按 `Enter` 即可执行。如果输入的 `/` 开头内容不匹配任何内置或 Skill 命令，则按普通消息发送给 Agent。

::: tip 提示
部分命令仅在空闲（idle）状态下可用。会话正在流式输出或正在压缩上下文时执行这些命令会被拦截，并提示先按 `Esc` 或 `Ctrl-C` 中断当前操作。下表的 「随时可用」 列标注了在流式输出 / 上下文压缩期间也可用的命令。
:::

## 账号与配置

| 命令 | 别名 | 说明 | 随时可用 |
| --- | --- | --- | --- |
| `/login` | — | 选择账号或平台并登录：Kimi Code 走 OAuth 验证码流程，Kimi Platform 通过 API 密钥登录。 | 否 |
| `/logout` | — | 清除当前所选账号的凭据（Kimi Code OAuth 凭据，或对应开放平台的供应商配置）。 | 否 |
| `/provider` | — | 打开交互式供应商管理器，查看、添加和删除已配置的供应商。详见 [平台与模型 — `/provider` 与供应商管理](../configuration/providers.md#provider-与供应商管理)。 | 是 |
| `/model` | — | 切换当前会话使用的 LLM 模型。 | 是 |
| `/settings` | `/config` | 打开 TUI 内的设置面板。 | 是 |
| `/permission` | — | 选择权限模式（permission mode）。 | 是 |
| `/editor` | — | 配置 `Ctrl-G` 调起的外部编辑器。 | 是 |
| `/theme` | — | 切换终端 UI 配色主题。 | 是 |

## 会话管理

| 命令 | 别名 | 说明 | 随时可用 |
| --- | --- | --- | --- |
| `/new` | `/clear` | 开启一个全新会话，丢弃当前上下文。 | 否 |
| `/sessions` | `/resume` | 浏览历史会话并切换/恢复。 | 否 |
| `/tasks` | `/task` | 浏览后台任务列表。 | 是 |
| `/fork` | — | 基于当前会话 fork 一份新会话，保留完整对话历史。 | 否 |
| `/title [<text>]` | `/rename` | 不带参数时显示当前会话标题；带参数时将其设置为新标题（最长 200 个字符）。 | 是 |
| `/compact [<instruction>]` | — | 压缩当前对话上下文，释放 token 占用；可选附带一段自定义指令，提示模型在压缩时保留哪些信息。 | 否 |
| `/init` | — | 分析当前代码库并生成 `AGENTS.md`。 | 否 |
| `/export-md [<path>]` | `/export` | 将当前会话导出为 Markdown 文件。不带参数时写入工作目录下的 `kimi-export-<short-id>-<timestamp>.md`，传入路径可指定输出位置。 | 否 |
| `/export-debug-zip` | — | 将当前会话导出为调试用的 ZIP 压缩包（与 [`kimi export`](./kimi-command.md#kimi-export) 行为一致）。压缩包始终包含当前活动的全局诊断日志。 | 否 |

## 模式与运行控制

| 命令 | 别名 | 说明 | 随时可用 |
| --- | --- | --- | --- |
| `/yolo [on\|off]` | `/yes` | 切换 YOLO 模式。不带参数时按当前状态翻转；显式传 `on`/`off` 时强制设为对应状态。开启后跳过普通工具调用审批；Plan 模式的退出审批不会被跳过。 | 是 |
| `/auto [on\|off]` | — | 切换 auto 权限模式。不带参数时按当前状态翻转；显式传 `on`/`off` 时强制设为对应状态。开启后工具审批自动处理，Agent 不会向用户提问。 | 是 |
| `/plan [on\|off]` | — | 切换 Plan 模式。不带参数时按当前状态翻转；显式传 `on`/`off` 时强制设为对应状态。单纯切换不会创建空计划文件。 | 是 |
| `/plan clear` | — | 清除当前 plan 方案。 | 否 |
| `/goal [status\|pause\|resume\|cancel\|replace <objective>\|next <objective>\|next manage\|<objective>]` | — | 开始或管理一个自主 goal。该命令仍是实验功能，通过 `KIMI_CODE_EXPERIMENTAL_GOAL_COMMAND=1` 启用。 | 见下文 |

::: warning 注意
`/yolo` 会跳过普通工具调用的审批确认，使用前请确保了解可能的风险。Plan 模式的退出审批不会被 `/yolo` 跳过；Plan 模式下的 `Bash` 也按 `/yolo` 的普通放行规则处理。
:::

## 自主 goal

`/goal` 是实验命令，适用于你希望 Kimi Code 通过自动续跑的轮次持续处理的任务。启动 `kimi` 时先启用它：

```sh
KIMI_CODE_EXPERIMENTAL_GOAL_COMMAND=1 kimi
```

实验功能 flag 目前从环境变量读取。`config.toml` 暂时没有用于启用 `/goal` 的 `experimental` 配置项。

在命令后写目标即可开始一个 goal：

```sh
/goal 更新 checkout 文档，运行 docs build，如果 20 轮后仍被阻塞就停止
```

Kimi Code 会保存该目标，把它作为下一条 User 消息发送，然后持续运行后续轮次，直到 goal 停止。goal 有三种停止状态：

- `complete`：目标已完成。Kimi Code 会发送完成消息，并清除该 goal。
- `paused`：你暂停了 goal、中断了当前轮次，或恢复了一个原本有 active goal 的会话。之后可以继续恢复。
- `blocked`：Kimi Code 因需要输入、无法按当前目标完成、达到已配置的轮次、token 或时间预算，或遇到运行时失败而停止。之后可以继续恢复。

停止条件需要写在目标本身里。`/goal` 没有单独的停止限制 flag。

在 TUI 中，如果当前权限模式是 `manual`，开始或替换 goal 前会先出现确认提示。你可以切换到 `auto`、切换到 `yolo`，或继续用 `manual`。你也可以回到输入框，且 `/goal` 命令仍会保留在那里。

`manual` 模式不适合无人值守的 goal 工作。Kimi Code 可能会停下来等你审批。

使用下列形式管理当前 goal：

| 命令 | 作用 | 可用性 |
| --- | --- | --- |
| `/goal` 或 `/goal status` | 显示当前 goal、状态、已用时间、轮次数、token 数，以及已配置的轮次、token 或时间预算。 | 随时可用 |
| `/goal pause` | 暂停 active goal 并保留它。若当前正在流式输出，会中断当前轮次。 | 随时可用 |
| `/goal resume` | 恢复 paused 或 blocked goal，并开始新的轮次。 | 仅空闲时 |
| `/goal cancel` | 移除当前 goal。若当前正在流式输出，会中断当前轮次。 | 随时可用 |
| `/goal replace <objective>` | 用新目标替换已保存的 goal。 | 仅空闲时 |
| `/goal next <objective>` | 为当前会话排入一个 upcoming goal。当前 goal 完成前，Agent 不会看到它。 | 随时可用 |
| `/goal next manage` | 打开 upcoming goal 管理器。用 `↑`/`↓` 浏览，`Space` 选择一个 goal 以便移动，选中后用 `↑`/`↓` 调整顺序，`E` 编辑，`D` 删除，`Esc` 取消。 | 随时可用 |

一个会话中同一时间只能运行一个当前 goal。如果已有 goal，需要用 `/goal replace <objective>` 开始另一个目标。如果你想在不中断当前 goal 的情况下保存更多工作，使用 `/goal next <objective>`。

Upcoming goals 会随会话保存。当前 goal 完成前，它们不会发送给 Agent。如果当前 goal 被 paused、canceled 或 blocked，Kimi Code 不会开始下一个 queued goal。当 goal 进入 blocked 状态且队列非空时，TUI 会提醒你，queued goals 需要等到当前 goal 完成后才会执行。

`status`、`pause`、`resume`、`cancel`、`replace` 和 `next` 只有作为 `/goal` 后的第一个词时才是子命令。如果你的目标需要以这些词开头，请在目标前加 `--`：

```sh
/goal -- cancel 函数需要在订单失败时返回可重试错误，并补充测试
```

如果 upcoming goal 需要以 `manage` 开头，请在 `next` 后加 `--`：

```sh
/goal next -- manage 发布检查清单
```

在非交互式 prompt 模式中，只有创建形式会启动 goal 模式：

```sh
KIMI_CODE_EXPERIMENTAL_GOAL_COMMAND=1 kimi -p "/goal 修复 checkout 测试失败"
```

Prompt 模式在 goal 完成时以退出码 `0` 退出，在 blocked 时以 `3` 退出，在 paused 时以 `6` 退出。其它 `/goal` 子命令，包括 `next`，都是 TUI 控制命令，不由 `kimi -p` 处理。

## 信息与状态

| 命令 | 别名 | 说明 | 随时可用 |
| --- | --- | --- | --- |
| `/help` | `/h`、`/?` | 显示快捷键和所有可用命令。 | 是 |
| `/btw [问题]` | — | 在 fork 出的子 Agent 中打开旁路对话，不改变当前主 Agent 轮次；不带问题时会先打开面板并等待输入。 | 是 |
| `/usage` | — | 显示 token 用量、上下文占用以及配额信息。 | 是 |
| `/status` | — | 显示当前会话运行时状态，包括版本、模型、工作目录和权限模式等。 | 是 |
| `/mcp` | — | 列出当前会话中的 MCP server 及其连接状态。 | 是 |
| `/plugins` | — | 打开面向 user/global（用户全局）安装的交互式 plugin 管理器，用于安装、查看、启用、禁用、确认移除、重载、浏览官方 marketplace，以及启用或禁用 plugin MCP servers；快捷子命令仍可使用。 | 是 |
| `/version` | — | 显示 Kimi Code CLI 版本号。 | 是 |
| `/feedback` | — | 提交反馈以改进 Kimi Code CLI。 | 是 |

## 退出

| 命令 | 别名 | 说明 | 随时可用 |
| --- | --- | --- | --- |
| `/exit` | `/quit`、`/q` | 退出 Kimi Code CLI。 | 否 |

## Skill 动态命令

除内置命令外，用户可激活的 Skill 会自动注册为斜杠命令，统一以 `skill:` 作为命名空间前缀：

```
/skill:<name> [附加文本]
```

例如 `/skill:code-style` 会加载名为 `code-style` 的 Skill 内容并发送给 Agent；命令后附带的文本会拼接到 Skill 提示词之后，例如 `/skill:git-commits 修复登录失败的问题`。

为方便输入，Skill 命令同时支持省略 `skill:` 前缀的简写形式 `/<name>`，前提是该名称未被内置命令占用。也就是说，`/code-style` 会回退匹配到 `/skill:code-style`。

Kimi Code CLI 随包内置了 `mcp-config` Skill，用于配置 MCP server 和处理 MCP OAuth 登录。它在补全和帮助里仍属于 Skill 命名空间（`/skill:mcp-config`），也可以直接输入 `/mcp-config` 调用。

可作为斜杠命令暴露的 Skill 类型包括 `prompt`、`inline`、`flow` 以及未显式声明类型的 Skill。Skill 的安装与编写详见 [Agent Skills](../customization/skills.md)。

::: info 说明
所有 Skill 命令仅在空闲状态下可用，流式输出或上下文压缩期间需先按 `Esc` 或 `Ctrl-C` 中断当前操作。
:::

::: info 说明
Flow 类型的 Skill 同样通过 `/skill:<name>` 暴露，没有独立的 `/flow:` 命名空间。
:::
