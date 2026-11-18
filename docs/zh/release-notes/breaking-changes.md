# 不兼容变更

## 未发布

### 远端执行环境改为 SSH 主机

**影响范围**：使用 `[environments]` 进行 SSH、Docker 或自定义命令执行的配置，`--environment` 与 `--environment-cwd` 命令行参数，SDK 与 REST 客户端的环境选择参数，以及 MCP 服务声明中的 `environment_id`。绑定非本地环境的旧会话将无法恢复。

**迁移方式**：将 SSH 连接设置移至 `[hosts]`，使用 Web 界面的 SSH 主机管理功能。`remote_bin` 为可选项，默认值为 `~/.kimi-code/bin/kimi`。在主机上创建新会话，并选择远端工作目录。

```toml
[hosts.dev-box]
host = "dev-box"
identity_file = "~/.ssh/id_ed25519"
remote_bin = "~/.kimi-code/bin/kimi"
```

删除旧的 `[environments]` 配置和环境选择参数。保留的 `[environments]` 配置会显示迁移警告。本地会话的工作目录会被保留，仍可恢复和派生。
