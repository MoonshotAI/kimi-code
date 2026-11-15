# 远程环境

远程环境让 Agent 在另一台机器或容器中读写文件、执行 Shell 命令，Kimi Code CLI、模型请求、凭据和会话状态仍留在本机。

## 通过 SSH 使用远程环境

### 1. 准备远程机器

- 将目标平台的 Kimi Code 执行器安装到 `~/.kimi-code/bin/kimi`。
- 确认本机可以通过 SSH 密钥登录远程机器。
- 用户、端口、密钥和跳板机可先在 `~/.ssh/config` 中配置。

Kimi Code 不会自动安装执行器。找不到执行器或版本不兼容时，请安装或更新为目标平台提供的构建。

### 2. 在本机 `config.toml` 中声明环境

```toml
[environments.dev-box]
type = "ssh"
host = "dev-box"
defaultCwd = "/home/me/projects"
```

执行器不在默认路径时，增加一项：

```toml
remoteBin = "/path/to/kimi"
```

### 3. 创建远程会话

```sh
kimi --environment dev-box
```

临时更换远程工作目录：

```sh
kimi --environment dev-box --environment-cwd /home/me/another-project
```

恢复会话时会自动恢复原来的远程环境和工作目录，无需重复这些参数。

配置完成后：

- 文件操作和 Shell 命令在远程机器执行。
- CLI、模型请求和凭据留在本机。
- subagent 继承父 Agent 的远程环境。

#### `kimi --environment` 与 `--environment-cwd`

- 两个参数只用于创建会话，不能与 `--session` 或 `--continue` 组合。
- `--environment-cwd` 必须与 `--environment` 一起使用。
- 之后的 `/new` 保留当前环境，不再次应用启动参数。

## SSH 认证

推荐先在本机终端完成一次配置：

- 只有密码的主机：执行 `ssh-copy-id user@host`，之后使用密钥登录。
- 私钥有口令：先执行 `ssh-add`，让 ssh-agent 保存已解锁的密钥。
- 需要跳板机或连接共享：在 `~/.ssh/config` 中配置 `ProxyJump` 或 `ControlMaster`。

连接行为：

- 首次连接新主机时会记录主机密钥；之后密钥发生变化会连接失败，需要手动处理。
- 交互式 CLI 可以在服务器支持时提示输入 SSH 密码。密码只保存在当前进程内存中。
- 密码提示需要 OpenSSH 8.4 或更高版本，不支持独立 OTP/MFA 或私钥口令提示。
- `kimi -p` 等非交互方式不会提示输入密码，请提前配置密钥或连接共享。

## 声明 Docker 与自定义命令环境

除 SSH 外，还可以声明 Docker 兼容容器或自定义启动命令。

Docker 示例：

```toml
[environments.dev-container]
type = "docker"
container = "myapp-dev"
defaultCwd = "/workspace"
```

自定义命令示例：

```toml
[environments.sandbox]
command = "sandbox"
args = ["ssh", "i-1234567890", "--"]
defaultCwd = "/home/me/kimi-code"
```

常用规则：

- `defaultCwd` 必须是目标环境中的绝对路径。
- `type` 与 `command` 在同一条目内互斥。
- 可选的 `[environments] default = "dev-box"` 指定新会话的默认环境。
- 修改启动方式后，下次使用会按新配置重新连接；正在运行的远程命令会终止。

完整字段见 [`environments` 配置参考](../configuration/config-files.md#environments)。

## Windows 目标

远程目标为 Windows 机器时：

- 安装 [Git for Windows](https://gitforwindows.org/) 和 Windows 版执行器。
- 默认执行器路径为 `~/.kimi-code/bin/kimi.exe`。
- `defaultCwd` 使用 `C:\work\project` 这类原生驱动器路径。
- 支持 SSH 和自定义命令，不支持 Docker 容器。

```toml
[environments.windows-dev]
type = "ssh"
host = "windows-dev"
remoteBin = "kimi"
defaultCwd = 'C:\work\project'
```

## 断线与重连

- 下一个工具调用会尝试重新连接。
- 不会静默回退到本机，远程命令不会误在本机执行。
- 断线时正在执行的调用会失败，不会自动重试。
- 目标持续不可达时，工具调用会报错，请先检查网络、SSH 和执行器。

## 限制

- `WebSearch` 和 `FetchURL` 始终从本机发起。
- Hooks 和未设置 `environment_id` 的 stdio MCP server 默认在本机运行。
- 远程会话不读取目标环境的项目级 Agent 文件。
- 远程 `AGENTS.md` 和项目级 Skills 不热重载；新建、恢复会话或执行 `/reload` 时重新读取。
- 提示词中的文件路径按远程环境解析；本机路径不能直接读取，粘贴图片不受影响。
- 远程工作区不支持 Tower 模式。

<details>
<summary>更多限制</summary>

- `/feedback` 的代码库扫描器不支持远程工作区。
- 远程目录超过 50,000 个条目时会报错，请改用较小的子目录。
- 大量小文件会增加远程会话的启动时间。
- 两台主机上的相同根路径会共用一个工作区条目。
- Windows 主进程退出后，遗留的子进程可能不会自动清理；请先停止后台任务。

</details>

## 下一步

- [`environments` 配置参考](../configuration/config-files.md#environments)：查看全部字段。
- [远程控制](./remote-control.md)：从另一台设备操控本机会话。
