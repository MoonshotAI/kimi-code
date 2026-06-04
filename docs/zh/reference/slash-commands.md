# 斜杠命令

斜杠命令是 Kimi Code CLI 在交互式 TUI 中提供的内置控制命令，涵盖账号配置、会话管理、模式切换、信息查询等操作。在输入框中输入 `/` 即可触发命令补全，候选列表随后续字符实时过滤；命令的别名也会一并参与匹配。

输入完整命令名后按 `Enter` 执行。如果输入的 `/` 开头内容不匹配任何内置或 Skill 命令，则按普通消息发送给 Agent。

::: tip 提示
部分命令仅在空闲（idle）状态下可用。会话正在流式输出或压缩上下文时执行这些命令会被拦截，需先按 `Esc` 或 `Ctrl-C` 中断。下表「随时可用」列标注了流式输出期间也可用的命令。
:::

## 账号与配置

| 命令 | 别名 | 说明 | 随时可用 |
| --- | --- | --- | --- |
| `/login` | — | 选择账号或平台并登录：Kimi Code 走 OAuth 验证码流程，Kimi Platform 通过 API 密钥登录 | 否 |
| `/logout` | — | 清除当前所选账号的凭据 | 否 |
| `/provider` | — | 打开交互式供应商管理器，查看、添加和删除已配置的供应商。详见[平台与模型 — `/provider` 与供应商管理](../configuration/providers.md#provider-与供应商管理) | 是 |
| `/model` | — | 切换当前会话使用的 LLM 模型 | 是 |
| `/settings` | `/config` | 打开 TUI 内的设置面板 | 是 |
| `/permission` | — | 选择权限模式 | 是 |
| `/editor` | — | 配置 `Ctrl-G` 调起的外部编辑器 | 是 |
| `/theme` | — | 切换终端 UI 配色主题 | 是 |

## 会话管理

| 命令 | 别名 | 说明 | 随时可用 |
| --- | --- | --- | --- |
| `/new` | `/clear` | 开启全新会话，丢弃当前上下文 | 否 |
| `/sessions` | `/resume` | 浏览历史会话并切换/恢复 | 否 |
| `/tasks` | `/task` | 浏览后台任务列表 | 是 |
| `/fork` | — | 基于当前会话 fork 一份新会话，保留完整对话历史 | 否 |
| `/title [<text>]` | `/rename` | 不带参数时显示当前会话标题；带参数时设置为新标题（最长 200 字符） | 是 |
| `/add-dir [<directory>]` | — | 为当前会话的 workspace 添加另一个目录，使文件工具可以读取、搜索和编辑该目录；不带参数时打开可搜索的目录选择器 | 是 |
| `/dirs` | `/directories` | 打开可搜索列表，显示当前会话的主 workspace 目录和已添加的额外目录 | 是 |
| `/remove-dir [<directory>]` | `/rm-dir` | 从当前会话的 workspace 范围移除一个额外目录；不带参数时打开已添加目录的可搜索选择器 | 是 |
| `/compact [<instruction>]` | — | 压缩当前对话上下文，释放 token 占用；可附带自定义指令，提示模型压缩时保留哪些信息 | 否 |
| `/init` | — | 分析当前代码库并生成 `AGENTS.md` | 否 |
| `/export-md [<path>]` | `/export` | 将当前会话导出为 Markdown 文件 | 否 |
| `/export-debug-zip` | — | 将当前会话导出为调试用 ZIP 压缩包（与 [`kimi export`](./kimi-command.md#kimi-export) 行为一致） | 否 |

## 模式与运行控制

| 命令 | 别名 | 说明 | 随时可用 |
| --- | --- | --- | --- |
| `/yolo [on\|off]` | `/yes` | 切换 YOLO 模式。不带参数时翻转；显式传 `on`/`off` 时强制设置。开启后跳过普通工具调用审批；Plan 模式的退出审批不受影响 | 是 |
| `/auto [on\|off]` | — | 切换 auto 权限模式。开启后工具审批自动处理，Agent 不会向用户提问 | 是 |
| `/plan [on\|off]` | — | 切换 Plan 模式。不带参数时翻转；显式传 `on`/`off` 时强制设置。单纯切换不会创建空计划文件 | 是 |
| `/plan clear` | — | 清除当前 plan 方案 | 否 |
| `/goal [...]` | — | 开始或管理一个自主 goal（实验功能，需启用 `KIMI_CODE_EXPERIMENTAL_GOAL_COMMAND=1`） | 见下文 |

::: warning 注意
`/yolo` 会跳过普通工具调用的审批确认，使用前请确保了解可能的风险。Plan 模式的退出审批不会被 `/yolo` 跳过；Plan 模式下的 `Bash` 也按 `/yolo` 的普通放行规则处理。
:::

## 自主 goal（实验功能）

::: info
`/goal` 是实验命令，需在启动 `kimi` 时设置环境变量启用：
```sh
KIMI_CODE_EXPERIMENTAL_GOAL_COMMAND=1 kimi
```
:::

`/goal` 适用于你希望 Kimi Code 通过自动续跑的轮次持续处理的任务。在命令后写目标即可开始：

```
/goal 更新 checkout 文档，运行 docs build，如果 20 轮后仍被阻塞就停止
```

Kimi Code 会保存该目标，把它作为下一条 User 消息发送，然后持续运行后续轮次，直到 goal 停止。goal 有三种停止状态：

- `complete`：目标已完成，Kimi Code 发送完成消息并清除该 goal
- `paused`：你暂停了 goal、中断了当前轮次，或恢复了原本有 active goal 的会话
- `blocked`：Kimi Code 因需要输入、无法完成目标、达到预算上限或遇到运行时失败而停止

停止条件需要写在目标本身里，`/goal` 没有单独的停止限制 flag。

管理当前 goal 的子命令：

| 命令 | 作用 | 可用性 |
| --- | --- | --- |
| `/goal` 或 `/goal status` | 显示当前 goal 及其状态、已用时间、轮次数、token 数 | 随时可用 |
| `/goal pause` | 暂停 active goal 并保留 | 随时可用 |
| `/goal resume` | 恢复 paused 或 blocked goal | 仅空闲时 |
| `/goal cancel` | 移除当前 goal | 随时可用 |
| `/goal replace <objective>` | 用新目标替换已保存的 goal | 仅空闲时 |

一个会话中只能保存一个 goal。如果目标需要以 `status`、`pause` 等子命令关键词开头，使用 `--` 分隔：

```
/goal -- cancel 函数需要在订单失败时返回可重试错误，并补充测试
```

在 `manual` 权限模式下，goal 可能会停下来等待工具调用审批，不适合无人值守场景。

## 信息与状态

| 命令 | 别名 | 说明 | 随时可用 |
| --- | --- | --- | --- |
| `/help` | `/h`、`/?` | 显示快捷键和所有可用命令 | 是 |
| `/btw [问题]` | — | 在 fork 出的子 Agent 中打开旁路对话，不改变当前主 Agent 轮次；不带问题时会先打开面板等待输入 | 是 |
| `/usage` | — | 显示 token 用量、上下文占用以及配额信息 | 是 |
| `/status` | — | 显示当前会话运行时状态：版本、模型、工作目录、权限模式等 | 是 |
| `/mcp` | — | 列出当前会话中的 MCP server 及连接状态 | 是 |
| `/plugins` | — | 打开交互式 plugin 管理器 | 是 |
| `/version` | — | 显示 Kimi Code CLI 版本号 | 是 |
| `/feedback` | — | 提交反馈以改进 Kimi Code CLI | 是 |

## 退出

| 命令 | 别名 | 说明 | 随时可用 |
| --- | --- | --- | --- |
| `/exit` | `/quit`、`/q` | 退出 Kimi Code CLI | 否 |

## Skill 动态命令

已激活的 Skill 会自动注册为斜杠命令，统一以 `skill:` 作为命名空间前缀：

```
/skill:<name> [附加文本]
```

例如 `/skill:code-style` 加载名为 `code-style` 的 Skill 并发送给 Agent；命令后附带的文本拼接到 Skill 提示词之后。

为方便输入，Skill 命令同时支持省略 `skill:` 前缀的简写形式 `/<name>`，前提是该名称未被内置命令占用——即 `/code-style` 会回退匹配到 `/skill:code-style`。

Kimi Code CLI 随包内置了 `mcp-config` Skill，用于配置 MCP server 和处理 MCP OAuth 登录；可直接输入 `/mcp-config` 调用。

::: info 说明
所有 Skill 命令仅在空闲状态下可用。`flow` 类型的 Skill 同样通过 `/skill:<name>` 暴露，没有独立的 `/flow:` 命名空间。
:::

Skill 的安装与编写详见 [Agent Skills](../customization/skills.md)。

## 下一步

- [键盘快捷键](./keyboard.md) — TUI 键盘操作速查
- [内置工具](./tools.md) — Agent 可调用的工具完整参考
