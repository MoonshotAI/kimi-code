# 数据路径

Kimi Code CLI 将运行时数据集中存储在用户主目录下的 `~/.kimi-code/` 目录中。本页介绍各类数据的存放位置、用途，以及如何自定义和清理。

## 数据根目录

默认数据根是 `~/.kimi-code/`。`~` 由 Node.js 的 `os.homedir()` 解析，因此实际路径在不同平台略有差异：macOS 上是 `/Users/<name>/.kimi-code`，Linux 上是 `/home/<name>/.kimi-code`，Windows 上是 `C:\Users\<name>\.kimi-code`。

可以通过 `KIMI_CODE_HOME` 环境变量覆盖到任意路径：

```sh
export KIMI_CODE_HOME="$HOME/.config/kimi-code"
```

设置后，配置、会话、日志、输入历史、更新状态、OAuth 凭据等运行时数据都会落到该路径下。`KIMI_CODE_HOME` 与其他环境变量的完整说明见 [环境变量](./env-vars.md)。

::: tip 例外
**内置工具缓存**（例如自动下载的 ripgrep 二进制）不走 `KIMI_CODE_HOME`，而是走 `KIMI_CODE_CACHE_DIR`；未设置时使用平台缓存目录——macOS 上是 `~/Library/Caches/kimi-code`，Linux 上是 `$XDG_CACHE_HOME/kimi-code`（缺省 `~/.cache/kimi-code`），Windows 上是 `%LOCALAPPDATA%\kimi-code`。

用户级 Agent Skills 的搜索目录位于 `~/.kimi-code/skills` 与 `~/.agents/skills`；项目级则是工作目录下的 `.kimi-code/skills` 与 `.agents/skills`。详见 [Agent Skills](../customization/skills.md)。
:::

## 目录结构

数据根下的典型布局如下：

```
$KIMI_CODE_HOME  (默认 ~/.kimi-code)
├── config.toml             # 用户配置
├── tui.toml                # 客户端偏好，包含自动更新设置
├── mcp.json                # 用户级 MCP server 声明（可选）
├── plugins/
│   ├── installed.json      # 已安装 plugin 记录与能力状态
│   └── managed/            # 从本地路径或 zip URL 安装后的托管 plugin 副本
├── session_index.jsonl     # 会话索引
├── credentials/            # OAuth 凭据根目录（目录 0o700、文件 0o600）
│   ├── <name>.json         # 托管 Kimi / Open Platform 等 provider OAuth 凭据
│   └── mcp/                # MCP server OAuth 凭据
│       └── <key>-<suffix>.json
├── sessions/               # 会话数据
│   └── <workDirKey>/
│       └── <sessionId>/
│           ├── state.json
│           ├── upcoming-goals.json  # `/goal next` upcoming 队列
│           ├── logs/
│           │   └── kimi-code.log
│           ├── tasks/          # 后台任务持久化
│           │   ├── <task_id>.json
│           │   └── <task_id>/
│           │       └── output.log
│           ├── cron/            # 定时任务持久化
│           │   └── <id>.json
│           └── agents/
│               ├── main/
│               │   ├── wire.jsonl
│               │   └── plans/  # Plan 模式计划文件
│               └── agent-0/
│                   └── wire.jsonl
├── bin/
│   └── rg                  # ripgrep 缓存（Windows 为 rg.exe）
├── logs/                   # 全局诊断日志
│   └── kimi-code.log
├── updates/
│   ├── latest.json         # 更新检查状态
│   ├── install.json        # 自动更新安装状态
│   └── install.lock        # 自动更新启动锁（临时）
└── user-history/
    └── <md5(workDir)>.jsonl
```

::: tip
上面的目录树展示的是默认数据根（`~/.kimi-code/`）下的典型布局。Agent Skills 与内置工具缓存的路径略有特殊性，详见上方"例外"提示。
:::

## 配置文件

`config.toml` 是 Kimi Code CLI 的主运行时配置文件，存放供应商、模型、循环控制等用户级设置。详见 [配置文件](./config-files.md)。

`tui.toml` 保存 `kimi` CLI 的客户端偏好，包括终端界面偏好和 `[upgrade].auto_install`。自动更新默认开启；可以在 `/settings` 中关闭，或手动设置 `auto_install = false`。

`mcp.json` 是用户级 MCP server 声明，会与项目内的 `.kimi-code/mcp.json` 合并加载。字段与项目级文件相同，详见 [MCP](../customization/mcp.md)。

`plugins/installed.json` 记录 user/global（用户全局）plugin 安装、每个 plugin 是否启用，以及在 `/plugins` 中禁用或重新启用、或通过 `/plugins mcp disable|enable` 修改的 plugin MCP servers 等能力状态。本地路径和 zip URL 安装都会复制到 `plugins/managed/<id>/`；原始来源只作为展示元数据保留。暂不支持项目本地或仓库共享的 plugin 安装范围。详见 [Plugins](../customization/plugins.md)。

OAuth 凭据以文件形式存放在数据根下的 `credentials/` 子目录，目录权限 `0o700`、文件权限 `0o600`，仅当前用户可读写。其中：

- **托管 Kimi / Open Platform 等供应商的 OAuth 凭据**位于 `credentials/<name>.json`，例如 `~/.kimi-code/credentials/managed:kimi-code.json`。
- **MCP server 的 OAuth 凭据**位于 `credentials/mcp/` 子目录下，文件名按 server key 自动生成，例如 `credentials/mcp/<key>-<suffix>.json`。

凭据写入采用 `tmp → fsync → rename` 的原子流程；POSIX 下严格保证原子性，Windows 上则尽最大努力保证。

## 会话数据

会话相关的数据集中在 `sessions/` 下，并通过顶层 `session_index.jsonl` 维护一份 JSONL 索引：每行一条记录，包含 `sessionId`、`sessionDir`、`workDir` 三个字段。索引在创建会话时追加写入，加载时会校验 `sessionDir` 是否仍在 `sessions/` 下、且最后一级目录名等于 `sessionId`，以防止外部篡改指向非法路径。

每个会话目录的路径形如 `sessions/<workDirKey>/<sessionId>/`，其中 `workDirKey` 是按工作目录编码出来的桶名，格式为 `wd_<slug>_<sha256前12位>`（例如 `wd_myproject_a3f8c1d20e9b`），`sessionId` 是会话的唯一标识。`sessions/` 整条路径包括 `<workDirKey>/` 桶都按 `0o700` 权限创建，仅当前用户可访问。

会话目录的内部结构包含：

- `state.json`：会话标题、`lastPrompt`、`createdAt`、`updatedAt`、`isCustomTitle`、`forkedFrom` 以及各个 Agent 的元数据。
- `upcoming-goals.json`：由 `/goal next <objective>` 创建的 TUI-only 队列。它只由终端界面读取，不属于 Agent 对话；只有当前 goal 完成并提升 queued goal 后，才会进入 Agent 对话。
- `agents/main/wire.jsonl`：主 Agent 的 Wire 事件流（内部通信记录），用于回放和恢复。`main` 是主 Agent 的固定 id。
- `agents/main/plans/`：Plan 模式下主 Agent 写入的计划文件，按计划 id 命名为 `<id>.md`。
- `agents/agent-0/`、`agents/agent-1/` 等：子 Agent 实例的目录，各自包含 `wire.jsonl`。子 Agent id 由会话内的递增计数器生成（`agent-` 加从 0 起的整数）。
- `logs/kimi-code.log`：该会话的诊断日志。只有发生被记录的诊断事件时才会出现；普通对话不一定产生这个文件。
- `tasks/`：后台任务持久化目录。每个任务在 `tasks/<task_id>.json` 保存元信息（状态、pid、退出码等），标准输出与标准错误写入 `tasks/<task_id>/output.log`。任务 id 格式为 `bash-` 或 `agent-` 前缀加 8 位随机字母数字（如 `bash-a1b2c3d4`）。
- `cron/`：定时任务持久化目录。通过 `CronCreate` 安排的每个任务会镜像到 `cron/<id>.json`，其中 `<id>` 是 8 位小写 16 进制字符。执行 `kimi resume` 时这些任务会被重新加载到内存调度器中。任务仅绑定到恢复的会话 id，不会带入新会话。工具表面参见 [定时任务](../reference/tools.md#定时任务)。

`sessionId` 仅允许 `[A-Za-z0-9._-]+` 且不能为 `.` 或 `..`，以避免路径注入。会话列表按 `updatedAt` 倒序排序，`updatedAt` 取目录与各关键文件 mtime 的最大值。详见 [会话管理](../guides/sessions.md)。

## 内置工具缓存

Kimi Code CLI 在首次需要 ripgrep 时会自动下载并缓存。下载过程中，压缩包写入系统临时目录，校验 SHA-256 后解压，二进制直接安装到数据根下的 `bin/rg`（Windows 上为 `bin/rg.exe`）并赋予 `0o755` 执行权限。后续在同一数据根下直接复用，无需再次下载。如果系统 `PATH` 中本来就有 `rg`，会优先使用系统版本；删除 `bin/` 会在下一次需要时触发重新下载。

## 日志与更新状态

顶层 `logs/kimi-code.log` 是全局诊断日志，主要记录启动、登录、导出等不属于单个会话的问题。单个会话自己的诊断日志在 `<sessionDir>/logs/kimi-code.log`。

如需报告 bug，优先使用 `kimi export` 导出相关会话（详见 [kimi 命令](../reference/kimi-command.md)）；如果会话日志存在，它会默认包含在导出包里。全局诊断日志默认也会打包；因为它可能包含其它会话或其它项目的事件，不想分享时使用 `--no-include-global-log` 排除。

`updates/latest.json` 记录 CLI 检测到的最新版本。`updates/install.json` 保存正在进行的后台安装、后台安装失败后的重试状态，以及后台更新生效后的一次性成功提示。`updates/install.lock` 是一个临时原子锁，用于避免多个并发 session 同时启动重复的后台安装。这些文件都由 CLI 自动维护，通常无需手动编辑。

## 输入历史

终端中的命令输入历史按工作目录分别保存。每个工作目录对应一个文件，路径为 `user-history/<md5(workDir)>.jsonl`，其中文件名是工作目录字符串的 MD5 哈希值（UTF-8 编码）。文件格式为 JSONL，每行一条历史记录。

输入历史用于在终端界面下浏览和搜索此前输入过的提示词。

## 清理数据

直接删除数据根目录（默认 `~/.kimi-code/`，或 `KIMI_CODE_HOME` 指定的路径）可以完全清理 Kimi Code CLI 的所有运行时数据，包括配置、会话、日志、输入历史和内置工具缓存。

如只需清理部分数据：

| 需求 | 操作 |
| --- | --- |
| 重置配置 | 删除 `~/.kimi-code/config.toml` |
| 重置客户端偏好 | 删除 `~/.kimi-code/tui.toml` |
| 清理所有会话 | 删除 `~/.kimi-code/sessions/` 与 `~/.kimi-code/session_index.jsonl` |
| 清理诊断日志 | 删除 `~/.kimi-code/logs/` 目录 |
| 清理输入历史 | 删除 `~/.kimi-code/user-history/` 目录 |
| 重置更新检查状态 | 删除 `~/.kimi-code/updates/latest.json` |
| 重置自动更新安装状态 | 删除 `~/.kimi-code/updates/install.json` |
| 清理过期的自动更新启动锁 | 删除 `~/.kimi-code/updates/install.lock` |
| 强制重新下载 ripgrep | 删除 `~/.kimi-code/bin/` 目录 |
| 清除托管 Kimi / Open Platform OAuth 登录态 | 运行 `/logout`（仅清理当前供应商的 OAuth），或删除对应 `~/.kimi-code/credentials/<name>.json` |
| 清除 MCP server OAuth 登录态 | 删除 `~/.kimi-code/credentials/mcp/` 目录；`/logout` **不会**清理 MCP 的 OAuth 凭据 |
| 移除用户级 MCP 声明 | 删除 `~/.kimi-code/mcp.json` |
| 清理 plugin 安装记录和托管 zip plugins | 删除 `~/.kimi-code/plugins/` 目录；本地 plugin 源码目录不会被删除 |
| 清空用户级 Skills | 删除 `~/.kimi-code/skills/` 目录 |
