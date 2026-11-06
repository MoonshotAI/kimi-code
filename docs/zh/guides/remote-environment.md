# 远程环境

远程环境让 Kimi Code 操作另一台机器或容器。

## 远程环境的工作原理

Kimi Code CLI 仍在你的电脑上运行，只把读写文件和执行命令交给目标环境。目标环境上也需要安装一个 Kimi Code CLI 负责执行。

## 快速开始

以一台 SSH 能直接登录的机器 `dev-box` 为例。

1. 在目标机器上安装 Kimi Code CLI：

   ```sh
   ssh dev-box 'curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash'
   ```

2. 在本机的 `~/.kimi-code/config.toml` 中加入：

   ```toml
   [environments.dev-box]
   type = "ssh"
   host = "dev-box"
   defaultCwd = "/home/me/projects"
   ```

3. 启动会话：

   ```sh
   kimi --environment dev-box
   ```

   会话打开后，底部状态栏的工作目录前会显示 `dev-box`。之后 Agent 读写的文件、执行的命令都在 `dev-box` 上。

想让每个新会话都默认在 `dev-box` 上启动，见 [设为默认环境](#设为默认环境)；Docker 容器和其他接入方式见 [声明环境](#声明环境)。

## 声明环境

在 `config.toml` 的 `[environments]` 下声明环境。连接前，目标环境需要[安装 Kimi Code CLI](./getting-started.md#脚本安装-推荐)。

### SSH 主机

```toml
[environments.dev-box]
type = "ssh"
host = "dev-box"
defaultCwd = "/home/me/projects"
```

`host` 由系统 `ssh` 解析，`~/.ssh/config` 中的用户、端口、密钥和跳板机照常生效，认证方式见 [SSH 认证](#ssh-认证)。`defaultCwd` 是会话在目标上的工作目录，需要写目标机器上的绝对路径，不支持相对路径和 `~`。

### Docker 容器

```toml
[environments.dev-container]
type = "docker"
container = "myapp-dev"
defaultCwd = "/workspace"
```

`container` 填正在运行的容器名或 id，Kimi Code 通过 `docker exec` 进入容器。使用 OrbStack 等非默认 Docker context 时，加上 `context = "orbstack"`。

### 其他环境

可以通过 `command` 和 `args` 配置其他环境，例如 `kubectl exec`、WSL、Apple Container、受管沙箱，例如：

```toml
[environments.k8s-pod]
command = "kubectl"
args = ["exec", "-i", "my-pod", "--"]
remoteBin = "/root/.kimi-code/bin/kimi"
defaultCwd = "/app"

[environments.wsl]
command = 'C:\Program Files\WSL\wsl.exe'
args = ["--exec"]
remoteBin = "/home/me/.kimi-code/bin/kimi"
defaultCwd = "/home/me/projects"
```

- `kubectl exec`、`wsl --exec` 这类不经 Shell、原样传递参数的命令不会展开 `~`，需要用 `remoteBin` 写出 Kimi Code 在目标上的绝对路径。
- 含反斜杠的 Windows 路径用单引号包裹，TOML 不会转义其中的 `\`。
- 启动命令需要的凭据可以写在 `env` 里，例如 `env = { SANDBOX_TOKEN = "..." }`。这些变量只提供给本机的启动命令，不会传到 Agent 在目标上执行的命令中。

### 设为默认环境

```toml
[environments]
default = "dev-box"
```

设置后，新会话直接在该环境上启动。默认环境的条目必须写 `defaultCwd`。
在 TUI 中用 `/new` 新建会话时，沿用当前会话的环境和工作目录。

### Windows 目标环境

Windows 目标上需要安装 [Git for Windows](https://gitforwindows.org/)（`Bash` 工具通过 Git Bash 执行）。

`defaultCwd` 使用 `C:\work\project` 这样的驱动器路径：

```toml
[environments.windows-dev]
type = "ssh"
host = "windows-dev"
defaultCwd = 'C:\work\project'
```

## 临时指定环境

在启动时用 `--environment` 指定这次新会话的环境，用 `--environment-cwd` 覆盖工作目录。

```sh
kimi --environment dev-box --environment-cwd /home/me/projects -p "Run the test suite"
```

目前只有 Kimi Code CLI 支持临时指定环境。Web UI 等其他客户端新建的会话使用[默认环境](#设为默认环境)，未设置默认环境时在本机运行。

## SSH 认证

Kimi Code 以非交互方式连接 SSH 主机。在终端里执行下面的命令，不报错就说明 Kimi Code 能连上：

```sh
ssh -o BatchMode=yes dev-box true
```

- **密钥**：`~/.ssh/config` 中的密钥、ssh-agent 和跳板机照常生效。带口令的密钥先在终端执行一次 `ssh-add`。
- **密码**：在 TUI 中，Kimi Code CLI 会提示输入 SSH 密码（需要 OpenSSH 8.4 或更高版本）。`kimi -p` 不支持密码登录。
- **主机密钥**：首次连接时自动信任并写入 `known_hosts`；之后主机密钥变化时连接会失败，需要手动删除 `known_hosts` 中的对应条目。

## 注意事项

- **恢复会话会连回原环境**：环境已被删除或无法连接时，恢复会失败。
- **修改环境配置会断开连接**：正在目标环境上运行的命令会被终止，下次使用时按新配置连接。
- **目标环境上的 Kimi Code CLI 版本过旧时无法连接**：在目标环境上重新运行安装命令升级即可。
- **Hooks 和 MCP server 默认在本机运行**：它们看不到目标环境的文件；stdio MCP server 可通过 `environment_id` 改到目标环境运行，见 [MCP](../customization/mcp.md)。
- **联网工具在本机发起**：`WebSearch` 和 `FetchURL` 访问的是你电脑所在的网络。
- **提示词里的文件路径按目标环境解析**：写 `/tmp/x.png` 读的是目标环境上的文件；本机图片请直接粘贴。
- **不支持 Tower 模式**。

## 下一步

- [`environments` 配置参考](../configuration/config-files.md#environments)——`[environments]` 节的全部字段
- [远程控制](./remote-control.md)——相反方向：从另一台设备操控本机的会话
