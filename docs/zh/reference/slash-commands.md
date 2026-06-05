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
| `/experiments` | `/experimental` | 打开实验功能面板。确认后把变更持久化到 `config.toml` 并重载当前会话 | 是 |
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
| `/goal [...]` | — | 开始或管理目标模式（实验功能；可通过 `/experiments`、`[experimental].goal_command` 或 `KIMI_CODE_EXPERIMENTAL_GOAL_COMMAND=1` 启用） | 见下文 |

::: warning 注意
`/yolo` 会跳过普通工具调用的审批确认，使用前请确保了解可能的风险。Plan 模式的退出审批不会被 `/yolo` 跳过；Plan 模式下的 `Bash` 也按 `/yolo` 的普通放行规则处理。
:::

## 目标模式（实验功能）

::: info
`/goal` 是实验命令。可以通过 `/experiments` 启用，也可以写入 `~/.kimi-code/config.toml`：
```toml
[experimental]
goal_command = true
```

也可以用环境变量只覆盖当前进程：
```sh
KIMI_CODE_EXPERIMENTAL_GOAL_COMMAND=1 kimi
```
:::

`/goal` 用于开始或管理目标模式：Kimi Code 会在自动续跑的轮次中持续朝一个持久目标工作。使用指导和示例见[使用目标模式](../guides/goals.md)。

```sh
/goal 更新 checkout 文档，运行 docs build，如果 20 轮后仍被阻塞就停止
```

| 命令 | 作用 | 可用性 |
| --- | --- | --- |
| `/goal` 或 `/goal status` | 显示当前目标及其状态、已用时间、轮次数、token 数 | 随时可用 |
| `/goal pause` | 暂停当前的目标，但不删除 | 随时可用 |
| `/goal resume` | 继续被暂停或被阻塞的目标 | 仅空闲时 |
| `/goal cancel` | 移除当前目标 | 随时可用 |
| `/goal replace <objective>` | 用新目标替换已保存的目标 | 仅空闲时 |
| `/goal next <objective>` | 为当前会话安排一个后续目标。如果当前没有目标，则立即开始它。当前目标完成前，Agent 不会看到已排队的目标 | 随时可用 |
| `/goal next manage` | 打开后续目标管理器。用 <kbd>↑</kbd> / <kbd>↓</kbd> 浏览，<kbd>Space</kbd> 选择一个目标以便移动，选中后用 <kbd>↑</kbd> / <kbd>↓</kbd> 调整顺序，<kbd>E</kbd> 编辑，<kbd>D</kbd> 删除，<kbd>Esc</kbd> 取消。编辑输入框中，用 <kbd>Shift-Enter</kbd> 或 <kbd>Ctrl-J</kbd> 添加新行，用 <kbd>Enter</kbd> 保存 | 随时可用 |

`status`、`pause`、`resume`、`cancel`、`replace` 和 `next` 只有作为 `/goal` 后的第一个词时才是子命令。如果你的目标需要以这些词开头，请在目标前加 `--`：

```sh
/goal -- cancel 函数需要在订单失败时返回可重试错误，并补充测试
```

如果后续目标需要以 `manage` 开头，请在 `next` 后加 `--`：

```sh
/goal next -- manage 发布检查清单
```

在非交互式 prompt 模式中，只有创建形式会启动目标模式：

```sh
KIMI_CODE_EXPERIMENTAL_GOAL_COMMAND=1 kimi -p "/goal 修复 checkout 测试失败"
```

Prompt 模式在目标完成时以退出码 `0` 退出，在目标阻塞时以 `3` 退出，在目标暂停时以 `6` 退出。其它 `/goal` 子命令，包括 `next`，都是 TUI 控制命令，不由 `kimi -p` 处理。

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

已激活的外部 Skill 会自动注册为斜杠命令，并以 `skill:` 作为命名空间前缀：

```
/skill:<name> [附加文本]
```

例如 `/skill:code-style` 加载名为 `code-style` 的 Skill 并发送给 Agent；命令后附带的文本拼接到 Skill 提示词之后。

为方便输入，外部 Skill 命令同时支持省略 `skill:` 前缀的简写形式 `/<name>`，前提是该名称未被系统斜杠命令占用——即 `/code-style` 会回退匹配到 `/skill:code-style`。

Kimi Code CLI 随包内置的 Skill（例如 `mcp-config`）会直接以 `/<name>` 形式出现在斜杠命令面板中，用于配置 MCP server 和处理 MCP OAuth 登录等场景。

::: info 说明
所有 Skill 命令仅在空闲状态下可用。`flow` 类型的 Skill 同样通过 `/skill:<name>` 暴露，没有独立的 `/flow:` 命名空间。
:::

Skill 的安装与编写详见 [Agent Skills](../customization/skills.md)。

## 下一步

- [键盘快捷键](./keyboard.md) — TUI 键盘操作速查
- [内置工具](./tools.md) — Agent 可调用的工具完整参考
