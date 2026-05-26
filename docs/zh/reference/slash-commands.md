# 斜杠命令

斜杠命令是 Kimi Code CLI 在交互式 TUI 中提供的内置控制命令，用于切换模式、管理会话、查看状态等。在输入框中输入 `/` 即可触发命令补全，候选列表会随后续字符实时过滤；命令的别名（alias）也会一并参与匹配。

输入完整命令名（如 `/help`）后按 `Enter` 即可执行。如果输入的 `/` 开头内容不匹配任何内置或 Skill 命令，则按普通消息发送给 Agent。

::: tip 提示
部分命令仅在空闲（idle）状态下可用。会话正在流式输出或正在压缩上下文时执行这些命令会被拦截，并提示先按 `Esc` 或 `Ctrl-C` 中断当前操作。下表的 「随时可用」 列标注了在流式输出 / 上下文压缩期间也可用的命令。
:::

## 账号与配置

| 命令 | 别名 | 说明 | 随时可用 |
| --- | --- | --- | --- |
| `/login` | — | 选择账号或平台并登录：Kimi Code 走 OAuth device code 流程，Moonshot AI 开放平台通过 API 密钥登录。 | 否 |
| `/logout` | — | 清除当前所选账号的凭据（Kimi Code OAuth 凭据，或对应开放平台的供应商配置）。 | 否 |
| `/connect [--refresh] [--url=<catalog-url>]` | — | 从模型目录中选择并配置供应商与模型。CLI 已内置默认目录；传入 `--refresh` 可从 models.dev 拉取最新目录，传入 `--url` 可指向自定义目录地址。详见 [平台与模型 — `/connect` 与模型目录](../configuration/providers.md#connect-与模型目录)。 | 否 |
| `/model` | — | 切换当前会话使用的 LLM 模型。 | 否 |
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

## 模式与运行控制

| 命令 | 别名 | 说明 | 随时可用 |
| --- | --- | --- | --- |
| `/yolo [on\|off]` | `/yes` | 切换自动批准模式（auto-approve）。不带参数时按当前状态翻转；显式传 `on`/`off` 时强制设为对应状态。开启后跳过普通工具调用审批；Plan 模式的退出审批不会被跳过。 | 是 |
| `/plan [on\|off]` | — | 切换 Plan 模式。不带参数时按当前状态翻转；显式传 `on`/`off` 时强制设为对应状态。单纯切换不会创建空计划文件。 | 是 |
| `/plan clear` | — | 清除当前 plan 方案。 | 否 |

::: warning 注意
`/yolo` 会跳过普通工具调用的审批确认，使用前请确保了解可能的风险。Plan 模式的退出审批不会被 `/yolo` 跳过；Plan 模式下的 `Bash` 也按 `/yolo` 的普通放行规则处理。
:::

## 信息与状态

| 命令 | 别名 | 说明 | 随时可用 |
| --- | --- | --- | --- |
| `/help` | `/h`、`/?` | 显示快捷键和所有可用命令。 | 是 |
| `/usage` | — | 显示 token 用量、上下文占用以及配额信息。 | 是 |
| `/status` | — | 显示当前会话运行时状态，包括版本、模型、工作目录和权限模式等。 | 是 |
| `/mcp` | — | 列出当前会话中的 MCP server 及其连接状态。 | 是 |
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
