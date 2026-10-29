# 远程环境

远程环境让 Agent 的工具——读写文件、执行 Shell 命令——在另一台机器或容器里执行，而 Kimi Code CLI 本身、所有模型请求和你的凭据都留在本机。适合代码在另一台机器上，或希望把工具执行隔离在 Docker 兼容容器里的场景。

## 远程环境的工作原理

Kimi Code 把 Agent 循环、模型请求、凭据、审批和会话状态全部留在本机，目标环境只执行两组 OS 原语：文件系统、进程。目标机器上运行一个小型执行器（`kimi exec-server`），通过一条连接提供这些原语；其余一切——包括每一次 LLM 请求——都留在本机。

即使在远程会话中，计划文件也保存在本机的会话目录里。`Read`、`Write` 和 `Edit` 在本机访问当前计划；退出计划模式后，已保存的计划仍可读取。任务输出也保留在本机，并在目标可用时同步一份；同步失败时，返回的本机输出路径仍可用 `Read` 读取。

以下安全边界是固定的：

- **API 密钥不出本机**：LLM API 密钥和 OAuth token 永远不会发送到目标环境，执行器也不发任何模型请求。
- **网络工具固定本机**：即使在远程会话中，`WebSearch` 和 `FetchURL` 也始终从本机发起。
- **Hooks 与 MCP server 默认留在本机**：生命周期钩子和未显式设置 `environment_id` 的 stdio MCP server 在本机运行，详见 [限制](#限制)。
- **SSH 走系统 `ssh`**：SSH 启动器调用系统 `ssh`，因此 `~/.ssh/config`（用户、端口、密钥、`ProxyJump`、`ControlMaster`）和 ssh-agent 照常生效——密码、口令与主机密钥的处理详见 [SSH 认证](#ssh-认证)。

仅支持 POSIX 目标，不支持 Windows 目标。

::: info 远程环境 vs. 远程控制
[远程控制](./remote-control.md) 是相反方向：它让另一台设备（比如手机）查看和操控运行在**本机**的会话。远程环境则相反——由本机的 CLI 驱动工具在**另一台**机器或容器里执行。
:::

## 声明环境

环境声明在 `config.toml` 的 `[environments]` 节中。共有三类条目：SSH 主机、Docker 兼容容器，以及用于其他环境的自定义启动命令（OrbStack 机器、`kubectl exec`、Apple Container、受管沙箱等）。

```toml
[environments]
default = "dev-box"          # 可选；未显式指定绑定时，新会话从这里开始

[environments.dev-box]
type = "ssh"
host = "dev-box"             # 交给 ~/.ssh/config 解析用户、端口、密钥、ProxyJump
defaultCwd = "/home/me/projects"

[environments.dev-container]
type = "docker"
container = "myapp-dev"
# context = "orbstack"       # 可选 docker context
defaultCwd = "/workspace"

[environments.sandbox]
command = "sandbox"              # 可执行名或绝对路径
args = ["ssh", "i-1234567890", "--"]  # 进入目标的方式；Kimi Code 会追加执行器调用
env = { SANDBOX_TOKEN = "..." }  # 可选：仅作用于本机启动器进程的环境变量
defaultCwd = "/home/me/kimi-code"
```

关键规则：

- `type` 与 `command` 在同一条目内互斥：`type = "ssh"` 和 `type = "docker"` 是内置启动器，`command` + `args` 是通用形式（与 `.mcp.json` 的 stdio 条目形态一致）。通用形式下，Kimi Code 会在 `args` 之后追加 `<remoteBin> exec-server`（默认 `~/.kimi-code/bin/kimi`），`args` 已经调用 `exec-server` 时不追加；`kubectl exec` 这类不经 shell、原样传递参数的启动器不会展开 `~`，需要把 `remoteBin` 设为绝对路径。`env` 设置的是本机启动器进程的环境，**不会**传播到 Agent 在目标环境执行的命令里。
- `defaultCwd` 是在该环境上创建会话时使用的工作目录，可被 `--environment-cwd` 覆盖。它必须是目标环境上的 POSIX 绝对路径；相对路径和 `~` 不会按本机目录或目标机器的 home 展开。系统先规范化重复分隔符、`.` 和 `..`，再在目标环境上校验目录，并保存同一个规范化路径。符号链接名称会保留，不会用 realpath 改写；因此 `symlink/..` 使用路径拼写中的父目录，而不是符号链接目标的物理父目录。
- 可选的顶层 `default` 指定创建会话时未显式给出绑定时使用的环境——冷启动、print 模式，或 API 创建。它指向的条目必须设置 `defaultCwd`。未设置 `default` 时，这些会话从 `local` 开始。TUI 里的 `/new` 不属于这种情况：它保留当前会话的环境和工作目录。还没有会话时，`/new` 使用进程启动时的 `--environment`；没有该参数时才用解析后的 default。
- 配置文件无法读取或 `[environments]` 节无效时，创建会话会以 `config.invalid` 失败，不会将其视为未设置 default。显式选择 `local` 仍可创建本地会话。
- 环境 id 即条目的键名：不超过 64 个字符，首尾不能有空白；`local` 和 `default` 是保留字。

启用[文件监听](../configuration/config-files.md#watch)后，声明文件的修改无需重启即可生效。删除环境不会把会话静默改绑到 `local`；后续工具调用会以 `environment.not_found` 或 `environment.unavailable` 失败。

修改环境的启动方式（例如 `host`、`container`、`context`、`remoteBin`、`command`、`args` 或 `env`）会断开现有连接，并终止正在运行的远程命令和远程 MCP server。下次使用时按新配置连接；会话中已经加载的项目说明（`AGENTS.md`）和项目级 skills 不会随之刷新。

环境 ID 是进程级的：绑定到同一 ID 的会话共享一条连接，工作目录可以不同。

完整字段参考见 [`environments`](../configuration/config-files.md#environments)。

## 创建与恢复会话

环境绑定是会话级的：记录该会话的工具在哪个环境上执行，以及在该环境上的工作目录。同一工作区的不同会话可以绑定不同的环境，subagent 继承父 Agent 的绑定。创建远程会话时会记录一条持久提醒，包含环境 id、OS 与架构、Shell 和工作目录，让模型知道工具运行在何处。在 `local` 上创建会话则不记录。

### `kimi --environment` 与 `--environment-cwd`

隐藏标志 `--environment <id>` 让新会话直接绑定到已配置的环境，相当于对 `[environments]` 默认配置的一次性覆盖。隐藏标志 `--environment-cwd <path>` 覆盖所选条目的 `defaultCwd`，必须与 `--environment` 一起使用：

```sh
kimi --environment dev-box --environment-cwd /home/me/projects -p "Run the test suite"
```

两个标志都只在创建会话时生效：不能与 `--session`/`--continue` 组合，因为恢复会话时会自动还原其记录的绑定。它们绑定的是本进程的第一个会话。之后的 `/new` 保留当前绑定，不再套用这些标志；只有还没有会话时，`/new` 才会使用它们。id 未声明、未提供覆盖值时条目未设置 `defaultCwd`，或目标目录无效，启动都会直接失败。创建会话会先连接目标环境再启动，连接失败会带着具体原因中止，而不是打开一个无法正常工作的会话。

恢复会话时，系统读取持久化的环境 id 和工作目录并重新连接目标环境。环境未注册或无法连接时，恢复会失败，不会改为在 `local` 上打开会话。

底部状态栏会在工作目录前显示当前环境标识；`local` 不渲染。环境断开时显示失败原因，远程会话中本机 git 状态槽会隐藏。审批面板会在命令或路径旁显示目标环境标识，`@` 文件补全查询目标文件系统。

## 断线与重连

每个环境 id 在整个进程里只有一条连接。绑到这个 id 的工作区共用它；另一个 id，哪怕在同一台机器上，仍是各自的连接。连接是否已死由两层机制判断：SSH 启动器带 `ServerAliveInterval` 的传输层保活，以及协议层的存活探测——连接空闲约 30 秒时本机向执行器发送 `ping`，10 秒内未收到响应即判定断线；任何入站流量都会重置空闲计时，活跃传输不会被误判，不认识 `ping` 的旧版本执行器会自动停用该探测。本地管道关闭也是断线信号。连接断开时——网络中断、容器停止、执行器退出——使用这个 id 的所有工作区同时进入 `disconnected`，它在目标上启动的进程随连接结束。

连接断开后**不会静默回退到本地环境**：本该落在远程机器上的 `rm` 或 `git` 命令绝不能落到你的本机。下一个工具调用会重新打开这条管道。目标持续不可达时，工具调用会以 `environment.unavailable` 错误失败。已经在旧连接上执行的调用会失败，不会在新连接上自动重试。

每次连接尝试最多等待 10 秒：目标一直不应答握手时，会以 `initialize timed out` 错误失败，而不是无声地一直等待；如果启动器曾向 stderr 写入内容——卡住的密码提示、`npx` 下载的进度——错误信息会带上这段尾部输出，让失败原因直接可见。

## SSH 认证

默认情况下，SSH 连接是非交互式的。启动器以 `-T`（不分配终端）和 `-o BatchMode=yes` 调用系统 `ssh`。BatchMode 会禁用所有交互提示——密码、密钥口令（passphrase）、主机密钥确认——因为连接的输入输出流承载着协议流量，没有终端可以回答提示。需要这些提示的主机会立即失败，报出 `Permission denied (publickey,password)` 之类的错误，并在创建会话或下一次工具调用时表现为连接失败，而不是挂在一个无人可见的提示上。

在交互式 TUI 中，如果认证失败且服务端提供 `password` 或 `keyboard-interactive`，Kimi Code CLI 还会提示你输入 SSH 密码，并通过 OpenSSH Askpass（在无终端时提供凭据的辅助程序）重试。密码只保存在当前进程内存中供重连使用，不会写入配置或凭据存储；修改环境或退出 Kimi Code CLI 后会丢弃。

该兜底需要 OpenSSH 8.4 或更高版本，仅覆盖密码及使用同一密码的 keyboard-interactive，不支持独立 OTP/MFA 或私钥口令提示。`kimi -p` 等没有交互密码回调的客户端仍按上述方式直接失败。

系统 `ssh` 支持的所有非交互认证方式都照常生效，通过 `~/.ssh/config` 和你的 shell 环境配置：

- **密钥**：`IdentityFile` 条目和 `~/.ssh/` 下的默认密钥路径，适用于无口令的密钥。
- **ssh-agent**：`SSH_AUTH_SOCK` 从你启动 Kimi Code 的终端继承，agent（保存已解锁密钥的后台程序）因此可以为 BatchMode 连接完成认证，无需提示。带口令的密钥先在自己的终端里执行一次 `ssh-add`。
- **`ProxyJump` / `ProxyCommand`**：`~/.ssh/config` 中配置的跳板机照常生效。
- **`ControlMaster`**：BatchMode 连接可以复用已有的主连接——这也是下文密码主机方案的基础。

主机密钥采用 `StrictHostKeyChecking=accept-new`（trust on first use，首次连接即信任）：首次连接新主机时不经询问直接将其密钥写入 `known_hosts`；之后主机密钥发生变化时连接会失败，需要手动修复对应条目。

只接受密码的主机有两种可行配置，都在你自己的终端里一次性完成：

- **复制密钥过去**：执行 `ssh-copy-id user@host`，只输入一次密码。此后密钥认证即可非交互工作。
- **共享主连接**：在 `~/.ssh/config` 中启用连接共享，然后自己打开一条主连接——在终端里执行 `ssh user@host`，输入一次密码。主连接在后台存活期间，后续所有连接（包括 BatchMode 连接）都复用它，不再提示。

```ssh-config
Host dev-box
  ControlMaster auto
  ControlPath ~/.ssh/cm-%r@%h:%p
  ControlPersist yes
```

## 远程执行器

执行器是 Kimi Code 自身的轻量构建，在目标环境以 `kimi exec-server` 启动。它只响应文件系统、进程请求——不接触模型 API、凭据和会话状态。stdio 是默认且唯一支持的传输方式，显式写法 `kimi exec-server --listen stdio` 与之等价且依然可用。

固定安装路径是目标环境上的 `~/.kimi-code/bin/kimi`（执行器位于其他位置时——例如预装的容器镜像——可用条目里的 `remoteBin` 覆盖）。

### 安装执行器

Kimi Code 不会自动安装执行器。连接在预期路径上找不到执行器时，连接会失败，并指引你从 Kimi Code 发布 CDN 下载目标平台对应的二进制文件，再安装到预期路径。`docker` 条目也可以在镜像里预装或挂载执行器，把 `remoteBin` 指向该绝对路径即可。`command` 条目请把匹配构建安装到你的启动器命令所调用的绝对路径上。

### 版本兼容

连接握手会校验执行器的最低版本和 POSIX 目标。版本过旧的执行器会被拒绝接入并给出升级指引——安装当前构建覆盖旧版本，然后重新连接。

## 限制

以下行为均为有意限定的范围，逐条列出已知限制：

- **Hooks 在 Kimi Code 所在主机执行**：`PreToolUse` 等生命周期钩子始终在运行 Kimi Code 的机器上执行，因此在远程会话中它们读到的是本机事实（本机文件、本机进程），而非目标环境的。它们以会话的本地工作目录运行；在目标环境上执行 hook 仍是未来才可能设计的能力。
- **MCP server 默认留在本机**：未显式设置 `environment_id` 的 stdio MCP server 在远程会话中仍在本机运行，看不到目标环境的文件系统。MCP 配置取自启动 Kimi Code 的本机目录（包括该目录的项目级配置），不读取目标环境上的 MCP 配置。
- **远程会话只加载用户级 Agent 文件**：项目级 Agent 文件可以替换系统提示词，而工作区信任目前只覆盖本机路径，因此远程会话不读取目标环境上的 `.kimi-code/agents/` 与 `.agents/agents/`，也不套用启动目录的项目级 Agent 文件。
- **远程工作区无热重载**：文件监听不在远程抽象之内，目标环境上 `AGENTS.md` 与项目级 skills 的变更不会被实时感知；新建或恢复会话、执行 `/reload` 时会重新读取。
- **不支持 Tower 模式**：Tower 多 Agent 编排在远程工作区上不可用。
- **git 状态槽隐藏**：CLI 底部状态栏的 git 指示（分支、状态、PR）仅支持本机，远程会话中隐藏。
- **`/feedback` 扫描器不支持**：`/feedback` 附带的代码库扫描器只扫描本机磁盘，远程工作区不可用，会给出提示。
- **两台主机同路径共用一个工作区条目**：工作区仅按根路径建键，两台主机上的 `/home/me/app` 会映射到同一个工作区。一个纯显示层面的副作用：TUI 的 `~` 缩写可能按本机 home 目录渲染远程路径。
- **提示词中的本机文件路径远程读不到**：在提示词中输入 `/tmp/x.png` 这类路径时，它会按目标环境的文件系统解析，Agent 无法按路径读取你的本机文件。粘贴图片不受影响——它们以二进制附件传输，不走路径。
- **目录列表上限**：列举超过 50,000 个条目的远端目录时会明确报错，不会返回部分列表。请改用较小的子目录，或拆分目录。Skill 发现会在日志中记录无法扫描的目录。
- **小文件延迟累积**：会话启动要读取大量小文件，每次读取都是一次远程往返，远程会话启动比本地慢。
- **同一目标共享一条连接**：绑定同一环境的多个工作区共享一条连接，而不是各自建立连接。代价是：连接断开会影响绑定该目标的所有工作区；仍在旧连接上进行的轮次会像断线一样失败。

## 下一步

- [`environments` 配置参考](../configuration/config-files.md#environments)——`[environments]` 节的全部字段
- [远程控制](./remote-control.md)——相反方向：从另一台设备操控本机的会话
