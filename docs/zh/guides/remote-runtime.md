# 远程运行时

远程运行时让 Agent 的工具——读写文件、执行 Shell 命令、交互终端——在另一台机器或容器里执行，而 Kimi Code CLI 本身、所有模型请求和你的凭据都留在本机。适合代码在远程服务器上，或希望把工具执行隔离在 Docker 兼容容器里的场景。

> 远程运行时是实验功能。启动 Kimi Code 前设置 `KIMI_CODE_EXPERIMENTAL_REMOTE_RUNTIME=1`，或在 `config.toml` 的 `[experimental]` 下写 `remote_runtime = true` 启用；总开关 `KIMI_CODE_EXPERIMENTAL_FLAG=1` 也会一并启用。

## 远程运行时的工作原理

Kimi Code 把 Agent 循环、模型请求、凭据、审批和会话状态全部留在本机，目标环境只执行三组 OS 原语：文件系统、进程、终端。目标机器上运行一个小型执行器（`kimi exec-server`），通过一条连接提供这些原语；其余一切——包括每一次 LLM 请求——都留在本机。

以下安全边界是固定的：

- **API 密钥不出本机**：LLM API 密钥和 OAuth token 永远不会发送到目标环境，执行器也不发任何模型请求。
- **网络工具固定本机**：即使在远程会话中，`WebSearch` 和 `FetchURL` 也始终从本机发起。
- **Hooks 与 MCP server 留在本机**：生命周期钩子和 stdio MCP server 继续在本机运行，详见 [限制](#限制)。
- **SSH 走系统 `ssh`**：SSH 启动器调用系统 `ssh`，因此 `~/.ssh/config`（用户、端口、密钥、`ProxyJump`、`ControlMaster`）和 ssh-agent 照常生效——密码、口令与主机密钥的处理详见 [SSH 认证](#ssh-认证)。

仅支持 POSIX 目标，不支持 Windows 目标。

::: info 远程运行时 vs. 远程控制
[远程控制](./remote-control.md) 是相反方向：它让另一台设备（比如手机）查看和操控运行在**本机**的会话。远程运行时则相反——由本机的 CLI 驱动工具在**另一台**机器或容器里执行。
:::

## 声明运行时

运行时声明在 `config.toml` 的 `[runtimes]` 节（user 级），或项目的 `.kimi-code/runtimes.toml`（project 级）。共有三类条目：SSH 主机、Docker 兼容容器，以及用于其他环境的自定义启动命令（OrbStack 机器、`kubectl exec`、Apple Container、受管沙箱等）。

```toml
[runtimes]
default = "dev-box"          # 可选；新会话初始绑定到该运行时

[runtimes.dev-box]
type = "ssh"
host = "dev-box"             # 交给 ~/.ssh/config 解析用户、端口、密钥、ProxyJump
defaultCwd = "/home/me/projects"

[runtimes.dev-container]
type = "docker"
container = "myapp-dev"
# context = "orbstack"       # 可选 docker context
defaultCwd = "/workspace"

[runtimes.sandbox]
command = "sandbox"              # 可执行名或绝对路径
args = ["ssh", "i-1234567890", "--",
        "/home/me/.kimi-code/bin/kimi", "exec-server", "--listen", "stdio"]
env = { SANDBOX_TOKEN = "..." }  # 可选：仅作用于本机启动器进程的环境变量
defaultCwd = "/home/me/kimi-code"
```

关键规则：

- `type` 与 `command` 在同一条目内互斥：`type = "ssh"` 和 `type = "docker"` 是内置启动器，`command` + `args` 是通用形式（与 `.mcp.json` 的 stdio 条目形态一致）。`env` 设置的是本机启动器进程的环境，**不会**传播到 Agent 在目标环境执行的命令里。
- `defaultCwd` 在绑定会话时作为工作目录输入的预填。它不在本机校验，也不做任何路径映射——必须是目标环境上的有效路径。
- 可选的顶层 `default` 指定新会话初始绑定的运行时，指向的条目必须设置 `defaultCwd`。未设置 `default` 时，新会话默认使用 `local` 运行时。
- 运行时 id 即条目的键名：不超过 64 个字符，首尾不能有空白；`local` 和 `default` 是保留字。

声明会被实时感知：新增、编辑或删除条目会即时注册、替换或注销对应运行时，无需重启。被删除的运行时不会立刻从仍在使用它的会话下消失——会话保留连接直至在执行的工作释放（有界等待，上限数秒），随后连接关闭；新的工具调用以 `runtime.not_found` 失败，绝不会静默回退到 `local`。

完整字段参考见 [`runtimes`](../configuration/config-files.md#runtimes)。

### 项目级声明与信任

项目可以在 `<项目根目录>/.kimi-code/runtimes.toml` 中自带声明，schema 与 `config.toml` 相同，外加可选的 `default`。这覆盖「代码在远端」的工作流：在本机保留一个 checkout（或空目录）作为声明载体，让在其中创建的每个会话都绑定到远程运行时。

项目级声明只为受信任的工作区加载。首次在某个文件夹启动时，Kimi Code 会显示工作区信任提示；选择信任后，其中声明的运行时（以及项目级 MCP server）才会启用。提示会列出每个声明的运行时及其完整启动命令行，你可以逐项核对将要执行的内容。未信任工作区的 `runtimes.toml` 会被完全忽略。

同 id 的项目级条目覆盖 user 级条目。两级都设置了 `default` 时，项目级优先；都未设置时，新会话默认使用 `local`。项目级声明始终从**本机**工作区根目录读取——要从远端磁盘读取项目配置，得先有连接。

## 在会话中切换运行时

运行时绑定是会话级的：记录该会话的工具在哪个运行时上执行，以及在该运行时上的工作目录。同一工作区的不同会话可以绑定不同的运行时，subagent 继承父 Agent 的绑定。

模型始终知晓工具运行在哪个环境：创建绑定远程运行时的会话，以及之后每一次双向切换，都会记录一条持久提醒，包含运行时 id、OS 与架构、Shell 和工作目录。在 `local` 上创建会话则不记录。

### `/runtime` 对话框

斜杠命令 `/runtime` 打开运行时管理器，仿照 provider 管理器设计：

- **列表**：`local` 运行时加上所有已声明的运行时，每行显示 id、类型、连接状态和 `defaultCwd`。目标 OS/架构暂不展示——只有连接握手完成后才能获知，将其纳入列表是后续增强。
- **添加**：通过最简表单新建声明——SSH 条目可从 `~/.ssh/config` 发现的候选主机中选择，其他类型或自定义命令可直接输入。表单的作用域开关决定条目写入位置：**Global**（默认）写入用户级 `config.toml`，所有工作区可用；**Project** 写入当前工作区的 `.kimi-code/runtimes.toml`，可提交到仓库与团队共享。两种方式都即时生效：新运行时立即出现在列表中，无需重启即可切换。
- **切换**：选择运行时后输入目标环境上的工作目录（按条目的 `defaultCwd` 预填）。目录由服务端用目标文件系统校验，失败时内联报错；连接失败会显示退出码和一段有界的 stderr。
- **重连**：处于断连状态的运行时提供显式重连操作。

底部状态栏会在工作目录前显示当前运行时标识（例如 `ssh:dev-box`）；`local` 不渲染。断连的运行时以错误色显示并附带 banner，远程会话中本机 git 状态槽会隐藏。审批面板会在命令或路径旁显示目标环境标识，`@` 文件补全改由服务端提供，候选来自目标文件系统。

有正在执行的轮次或待审批调用时，切换会被拒绝；切换在轮次边界生效。

### `kimi --runtime`

隐藏标志 `--runtime <id>` 让新会话直接绑定到已配置的运行时——相当于对 `[runtimes]` 默认配置的一次性覆盖，工作目录取自该条目的 `defaultCwd`：

```sh
kimi -p --runtime dev-box "Run the test suite"
```

该标志与 `--agent` 一样只在创建会话时生效：不能与 `--session`/`--continue` 组合，因为恢复会话时会自动还原其记录的绑定。id 未声明、或条目未设置 `defaultCwd` 时，启动会直接失败。创建会话会先连接目标环境再启动，连接失败会带着具体原因中止，而不是打开一个无法正常工作的会话。

## 断线与重连

远程会话依赖每个「工作区 + 运行时」一条的连接。连接断开时——网络中断、容器停止、执行器退出——会话在目标环境启动的全部进程都会被终止，终端滚动回放在本机保持只读可读。

连接断开后没有自动重连，也**不会静默回退到本地运行时**：本该落在远程机器上的 `rm` 或 `git` 命令绝不能落到你的本机。断线后工具调用会以 `runtime.unavailable` 错误失败，你需要在 `/runtime` 对话框中显式重连。

恢复旧会话是唯一的例外：还原的远程绑定会在后台自动重连，会话立即打开，运行时状态从 `connecting` 变为 `ready`——或变为 `disconnected`，失败原因显示在底部状态栏的运行时槽位和 `/runtime` 管理器中。重连仍在进行时到达的工具调用会等待这次连接完成（以连接尝试自身的超时为上界），而不是立即报错；同样绝不会静默回退到 `local`。

每次连接尝试最多等待 10 秒：目标一直不应答握手时，会以 `initialize timed out` 错误失败，而不是无声地一直等待；如果启动器曾向 stderr 写入内容——卡住的密码提示、`npx` 下载的进度——错误信息会带上这段尾部输出，让失败原因直接可见。

连接中断时会显示 SSH 退出码作为诊断线索：`255` 表示网络层断开，`127` 表示目标上找不到执行器。

## SSH 认证

SSH 连接是非交互式的。启动器以 `-T`（不分配终端）和 `-o BatchMode=yes` 调用系统 `ssh`，自动安装执行器时使用的 `scp` 共享同一组选项。BatchMode 会禁用所有交互提示——密码、密钥口令（passphrase）、主机密钥确认——因为连接的输入输出流承载着协议流量，没有终端可以回答提示。需要这些提示的主机会立即失败，报出 `Permission denied (publickey,password)` 之类的错误，并在 `/runtime` 对话框中表现为连接失败，而不是挂在一个无人可见的提示上。

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

执行器是 Kimi Code 自身的轻量构建，在目标环境以 `kimi exec-server --listen stdio` 启动。它只响应文件系统、进程、终端请求——不接触模型 API、凭据和会话状态。

固定安装路径是目标环境上的 `~/.kimi-code/bin/kimi`（执行器位于其他位置时——例如预装的容器镜像——可用条目里的 `remoteBin` 覆盖）。

### 自动安装

对于 `ssh` 和 `docker` 条目，连接到没有执行器的目标时会触发自动安装：Kimi Code 按目标的 OS 和架构下载对应构建，用固定的 SHA-256 校验后复制过去（SSH 走 `scp`，容器走 `docker cp`）。容器镜像也可以预装或挂载执行器，把 `remoteBin` 指向该绝对路径即可。

`command` 条目不做自动安装；执行器缺失时会直接失败并打印安装指引。当自动安装不可用或失败时，错误信息会给出需要手动执行的完整命令。

### 版本兼容

连接握手会校验执行器的最低版本和 POSIX 目标。版本过旧的执行器会被拒绝接入并给出升级指引；重新安装（或删除目标上的 `~/.kimi-code/bin/kimi` 后重连）即可升级到当前版本。

## 限制

远程运行时仍是实验功能，以下行为均为已知限制，逐条列出：

- **Hooks 在 Kimi Code 所在主机执行**：`PreToolUse` 等生命周期钩子始终在运行 Kimi Code 的机器上执行，因此在远程会话中它们读到的是本机事实（本机文件、本机进程），而非目标环境的。它们以会话的本地工作目录运行；在目标环境上执行 hook 仍是未来才可能设计的能力。
- **MCP server 留在本机**：远程会话中的 stdio MCP server 仍在本机运行，看不到目标环境的文件系统。
- **远程工作区无热重载**：文件监听不在远程抽象之内，目标环境上 `AGENTS.md`、项目级 skills、MCP 配置的变更不会被实时感知。会话启动时的首次加载正常；之后的变更需要重连或重启会话才能生效。
- **不支持 Tower 模式**：Tower 多 Agent 编排在远程工作区上不可用。
- **git 状态槽隐藏**：CLI 底部状态栏的 git 指示（分支、状态、PR）仅支持本机，远程会话中隐藏。
- **`/feedback` 扫描器不支持**：`/feedback` 附带的代码库扫描器只扫描本机磁盘，远程工作区不可用，会给出提示。
- **权限路径规则 fail-closed**：已保存的权限规则携带着批准时所在运行时的路径模式。切换运行时后，旧模式会静默失配——审批提示只会变多，不会变少（fail-closed，失败即关闭）。在新运行时下重新批准即可保存新规则。
- **两台主机同路径共用一个工作区条目**：工作区仅按根路径建键，两台主机上的 `/home/me/app` 会映射到同一个工作区。一个纯显示层面的副作用：TUI 的 `~` 缩写可能按本机 home 目录渲染远程路径。
- **提示词中的本机文件路径远程读不到**：在提示词中输入 `/tmp/x.png` 这类路径时，它会按目标环境的文件系统解析，Agent 无法按路径读取你的本机文件。粘贴图片不受影响——它们以二进制附件传输，不走路径。
- **小文件延迟累积**：会话启动要读取大量小文件，每次读取都是一次远程往返，远程会话启动比本地慢。
- **每个「工作区 + 运行时」一条连接**：没有连接池——绑定同一运行时的每个工作区各自建立连接（SSH 目标可用 `~/.ssh/config` 的 `ControlMaster` 缓解）。

## 下一步

- [`runtimes` 配置参考](../configuration/config-files.md#runtimes)——`[runtimes]` 节与 `.kimi-code/runtimes.toml` 的全部字段
- [远程控制](./remote-control.md)——相反方向：从另一台设备操控本机的会话
