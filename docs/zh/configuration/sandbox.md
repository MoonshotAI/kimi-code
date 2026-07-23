# 沙箱

Kimi Code 可以把 Agent 的 `Bash` 命令放进 OS 级沙箱里运行——与 claude-code（sandbox-runtime）和 codex 同一思路：沙箱内整个文件系统只读挂载，只有工作区和少量目录可写，敏感路径可以被遮蔽，网络默认断开。沙箱由内核强制生效（Linux 用 [bubblewrap](https://github.com/containers/bubblewrap) 的 namespace，macOS 用 `sandbox-exec` 的 Seatbelt），无论命令行怎么写都绕不过——这与文件工具已有的词法路径检查是互补关系。

沙箱只包裹 `Bash` 命令的执行。文件工具（Read/Write/Edit/Grep/Glob）通过权限策略覆盖，见[与权限系统的关系](#与权限系统的关系)。

## 快速开始

```toml
# ~/.kimi-code/config.toml
[sandbox]
enabled = true
```

Linux 上需要先装 bubblewrap（`apt install bubblewrap` / `dnf install bubblewrap` / `pacman -S bubblewrap`）；macOS 无需额外依赖（`sandbox-exec` 系统自带）。见[平台支持](#平台支持)与[失败行为](#失败行为)。

## 平台支持

| 平台 | 后端 | 要求 |
| --- | --- | --- |
| Linux | bubblewrap（`bwrap`） | `bwrap` 在 PATH 上，且 user namespace 可用（可用性探测会真的跑一条沙箱命令，所以 Ubuntu 24.04 的 AppArmor user-namespace 限制也能被发现） |
| macOS | Seatbelt（`sandbox-exec`） | 无（系统自带） |
| Windows | 不支持 | 命令直接非沙箱运行，每个会话打一次警告日志 |

后端在第一条沙箱命令时惰性探测，结果缓存到会话结束。

## 配置项参考

所有字段都可省略，省略时按下表默认值生效。

```toml
[sandbox]
enabled = false                        # 总开关，默认关。
mode = "workspace-write"               # "workspace-write" | "read-only"，沙箱内写权限基准。
require = false                        # true = 无可用后端时拒绝执行 Bash（fail-closed）。
auto_allow_sandboxed_bash = true       # 沙箱内执行的 Bash 免审批。
excluded_commands = []                 # 命中前缀的命令段不进沙箱。

[sandbox.filesystem]
deny_read = []                         # 追加的遮蔽路径（在内置敏感清单之上追加）。
allow_write = []                       # 在模式默认之外额外可写的根目录。
deny_write = []                        # 在可写集合内再排除、恢复只读的路径。

[sandbox.network]
enabled = false                        # false = 沙箱内断网。
allowed_domains = []                   # Phase 3 域名白名单代理的预留字段，当前不生效（见下方说明）。
allow_unix_sockets = []                # 预留字段（如 ssh-agent socket），当前不生效。
```

### `mode`

- **`workspace-write`（默认）**：可写根 = 会话工作目录 + additionalDirs + 系统临时目录 + `filesystem.allow_write`。
- **`read-only`**：可写根收缩为系统临时目录 + `filesystem.allow_write`，工作区本身只读——适合审计、评审类会话。此模式下写出可写根之外的路径也会被权限层硬拒绝（见下文）。

### `filesystem` 规则语义

`deny_read`、`allow_write`、`deny_write` 的条目是**字面路径，不是 glob 模式**：

- 开头的 `~` 展开为用户主目录。
- 条目匹配路径自身及其下所有内容（结尾写 `/**` 也可以，只是显式标记子树）。匹配按分隔符对齐——`/foo` 不会匹配 `/foo-evil/x`。
- 不支持其他 glob 语法（`*`、中间的 `**`、`?`）。
- `deny_read` 优先于可写根，`deny_write` 优先于 `allow_write` 和模式默认——deny 永远赢。
- Linux 下 `deny_read` / `deny_write` 里不存在的路径会被跳过（bubblewrap 无法在不存在的路径上挂载）。

### 内置 `deny_read` 清单

沙箱始终遮蔽一组内置的凭证位置——不可关闭，`filesystem.deny_read` 是在它之上追加：

```
~/.ssh  ~/.aws  ~/.gnupg  ~/.azure  ~/.config/gcloud
~/.kube  ~/.docker  ~/.netrc  ~/.git-credentials  ~/.config/gh
```

另外，每个可写根（工作区、additionalDirs、临时目录、每个 `allow_write` 条目）**直下**的 `.env` 也会被遮蔽。**子目录里**的 `.env` 不在内置规则覆盖范围——需要的话把具体目录写进 `filesystem.deny_read`。

宿主 daemon 的 unix socket 也在内置遮蔽之列（unix socket 不受网络隔离约束）：`/var/run/docker.sock`、`/run/docker.sock`、`/var/run/containerd.sock`、`/run/containerd/containerd.sock`、`/run/crio/crio.sock`、`/run/podman/podman.sock`，以及 `$XDG_RUNTIME_DIR/bus`、`$XDG_RUNTIME_DIR/docker.sock`、`$XDG_RUNTIME_DIR/podman/podman.sock`、`$XDG_RUNTIME_DIR/gnupg`（`XDG_RUNTIME_DIR` 已设置或可解析为 `/run/user/<uid>` 时）。

这些路径之外的敏感文件（`credentials`、SSH 私钥变体等）在沙箱启用时也会被权限层对文件工具硬拒绝——见下文。

### 环境变量擦除

沙箱命令不会继承密钥类环境变量：以 `_API_KEY`、`_KEY`、`_TOKEN`、`_SECRET`、`_PASSWORD`、`_CREDENTIALS` 结尾（大小写不敏感）的变量，以及 `SSH_AUTH_SOCK`、`SSH_AGENT_PID`、`GPG_AGENT_INFO`、`XAUTHORITY`，在沙箱命令的环境里会被置空。该行为不可配置；沙箱命令需要的非密钥值请放在普通变量里。

### `network`

`enabled = false`（默认）时，沙箱内命令运行在独立网络命名空间、无任何连接（Linux），或所有网络操作被拒绝（macOS）。

::: warning
`allowed_domains` 目前**只被 schema 接受，不生效**——域名白名单代理在 Phase 3 落地。配置了它会打一次警告；网络访问仍只由 `network.enabled` 决定。
:::

### `excluded_commands` 匹配语义

有些命令在沙箱里无法工作（比如要访问 daemon socket 的 `docker`）。`excluded_commands` 命中的命令不进沙箱，改走正常审批流程。匹配规则：

1. 命令行按 `&&`、`||`、`;`、`|`、换行切成段。
2. 每段剥掉开头的 `VAR=value` 环境变量赋值。
3. 条目等于段文本、或作为段文本前缀且后跟空格即命中——`docker` 能匹配 `docker ps` 但不匹配 `docker-compose up`；`"git push"` 这类带空格的多词条目也按此规则工作。

## 失败行为

- **fail-open（默认）**：后端缺失或不可用（没装 `bwrap`、user namespace 受限、平台不支持）时，打一次警告日志，命令按非沙箱运行。
- **fail-closed**：`require = true` 时，后端不可用会让每个 `Bash` 调用直接报错，不会执行。

当沙箱命令的输出出现沙箱拒绝特征（如 `Operation not permitted`、`bwrap:` 报错）时，工具结果会追加提示，建议把命令加入 `sandbox.excluded_commands`，便于处理误伤。

## 与权限系统的关系

`sandbox.enabled = true` 时，三条权限策略生效（叠加在 `Bash` 的 OS 级沙箱之上）：

1. **沙箱 Bash 免审批**——将在沙箱内运行的 `Bash` 调用直接批准，不再询问（可用 `auto_allow_sandboxed_bash = false` 关闭）。用户配置的 `deny` 规则和下面的检查仍然优先。
2. **硬拒绝**——在模式自动批准（`--auto` / `--yolo`）之前判定：
   - 读/搜索命中 `filesystem.deny_read`；
   - **递归**读/搜索（如对目录树的 `Grep`）的根目录包含某个 `deny_read` **目录**时，整个访问被拒绝，并提示缩小搜索根（文件类条目如内置 `.env` 遮蔽不会触发该判定）；
   - 写命中 `filesystem.deny_write`；
   - `read-only` 模式下写出可写根之外；
   - 任意 operation 命中**敏感文件**（env 文件、SSH 私钥、云凭证——与文件工具既有守护相同的模式），沙箱启用期间从「询问」升级为硬「拒绝」。
3. **越界询问**——文件工具的访问（读/写/搜索）越出可写根时，转为询问审批，不再静默放行。

## 已知限制

- 只有 `Bash` 走 OS 沙箱。外部 hooks 不在沙箱内运行（与 claude-code 一致）；`Grep` 工具的 `rg` 子进程不单独过沙箱——其搜索根已被工作区路径检查和上述策略覆盖。
- Linux 下 `deny_read` 只遮蔽命令启动时已存在的路径（bubblewrap 无法在不存在的路径上挂载）。
- 沙箱只遮蔽上文列出的已知 socket 路径，无法拦截新建 `AF_UNIX` socket（无 seccomp 过滤），也管不到改名或迁移过的 daemon socket。
- `network.allowed_domains` 与 `network.allow_unix_sockets` 是预留 schema 字段，暂无行为（Phase 3）。
- Windows 不支持，命令按非沙箱运行。

## 下一步

- [配置文件](./config-files.md)——所有可配置字段的完整参考
- [配置覆盖](./overrides.md)——配置文件、命令行参数与环境变量如何配合
