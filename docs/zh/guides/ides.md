# 在 IDE 中使用

Kimi Code CLI 支持通过 [Agent Client Protocol (ACP)](https://agentclientprotocol.com/) 集成到 IDE 中，让你在编辑器内直接使用 AI 辅助编程。

## 前置准备

在配置 IDE 之前，请确保已安装 Kimi Code CLI 并完成登录配置。

ACP 适配层暴露子命令 `kimi acp`，IDE 通过子进程方式启动它，并在标准输入/输出上跑 JSON-RPC。每次 IDE 创建会话时，CLI 会复用它的鉴权状态——不需要重复登录。

::: tip 路径提示
macOS 下从 IDE GUI 启动的子进程通常**不会**继承终端 shell 的 `PATH`，所以如果 `kimi` 不在 `/usr/local/bin` 这类系统目录里，IDE 配置中要使用绝对路径。终端里运行 `which kimi` 可以查到当前生效的路径。
:::

## 在 Zed 中使用

[Zed](https://zed.dev/) 是一个原生支持 ACP 的现代编辑器。

在 Zed 的配置文件 `~/.config/zed/settings.json` 中添加：

```json
{
  "agent_servers": {
    "Kimi Code CLI": {
      "type": "custom",
      "command": "kimi",
      "args": ["acp"],
      "env": {}
    }
  }
}
```

配置说明：

- `type`：固定值 `"custom"`
- `command`：Kimi Code CLI 的可执行路径。如果 `kimi` 不在 PATH 中，请使用完整路径（例如 `/Users/you/.local/bin/kimi`）。
- `args`：启动参数。`acp` 子命令切换到 ACP 模式。
- `env`：附加环境变量，通常留空即可。Zed 会自动注入一份默认环境。

保存配置后，在 Zed 的 Agent 面板里新建一次对话，就会以你刚才配置的 `Kimi Code CLI` 启动一个 ACP 子进程。Zed 在 `agent_servers` 这层声明的 MCP 服务也会通过 ACP 协议转发到 kimi 这一侧。

## 在 JetBrains IDE 中使用

JetBrains 系列 IDE（IntelliJ IDEA、PyCharm、WebStorm 等）通过 AI 聊天插件支持 ACP。

如果没有 JetBrains AI 订阅，可以在注册表中启用 `llm.enable.mock.response`，便于在仅使用 ACP 的场景里访问 AI 聊天面板。连按两次 Shift 搜索 "Registry / 注册表" 即可打开。

在 AI 聊天面板的菜单中点击 "Configure ACP agents"，添加以下配置：

```json
{
  "agent_servers": {
    "Kimi Code CLI": {
      "command": "~/.local/bin/kimi",
      "args": ["acp"],
      "env": {}
    }
  }
}
```

JetBrains 这一侧对 `command` 字段处理较严格——务必填写**绝对路径**，可以在终端执行 `which kimi` 拿到。保存后，AI 聊天的 Agent 选择器里就会出现 `Kimi Code CLI`。

## 故障排查

- **会话立刻被中断 / IDE 提示 "agent exited"**：通常是 `command` 路径不对或 kimi 没登录。先在终端跑一次 `kimi acp` 验证：如果阻塞等待标准输入则说明 CLI 本身没问题，问题在 IDE 配置；如果立刻报错则按报错提示处理（多数是没 `/login`）。
- **IDE 显示 "auth required"**：表示 CLI 没有可用的鉴权令牌。退出 IDE，在终端执行 `kimi` 完成登录后再启动 IDE 即可。
- **MCP 工具看不到**：参考 [`kimi acp`](../reference/kimi-acp.md) 中的能力表确认 IDE 配的 MCP 传输类型是否被支持。当前 Kimi Code CLI 的 ACP 适配层支持 `http`、`stdio` 两种传输方式，`sse` 与 `acp` 类型会被静默丢弃并在日志中给出 warn。

## 下一步

- [kimi acp 参考](../reference/kimi-acp.md) — ACP 能力矩阵和方法覆盖详情
- [kimi 命令参考](../reference/kimi-command.md) — 完整子命令列表
