# 数据路径

Kimi Code CLI 把所有运行时数据——配置文件、会话历史、登录凭据、诊断日志——集中存放在 `~/.kimi-code/` 下。本页帮你搞清楚每类数据在哪里、用来做什么，以及需要时怎么清理或搬迁。

## 数据根目录

默认数据根是 `~/.kimi-code/`，在不同平台的实际路径：

- macOS：`/Users/<name>/.kimi-code`
- Linux：`/home/<name>/.kimi-code`
- Windows：`C:\Users\<name>\.kimi-code`

如果你需要把数据目录挪到别处（比如用多个独立环境隔离不同项目的配置），设置 `KIMI_CODE_HOME` 即可：

```sh
export KIMI_CODE_HOME="$HOME/.config/kimi-code"
```

设置后，配置、会话、日志、OAuth 凭据等**全部**数据都会落到新路径下。`KIMI_CODE_HOME` 的完整说明见[环境变量](./env-vars.md)。

::: tip 两类数据不受 `KIMI_CODE_HOME` 影响

**内置工具缓存**（ripgrep 二进制）走的是 `KIMI_CODE_CACHE_DIR`，未设时使用平台缓存目录：macOS 的 `~/Library/Caches/kimi-code`、Linux 的 `~/.cache/kimi-code`、Windows 的 `%LOCALAPPDATA%\kimi-code`。

**Agent Skills** 的搜索路径是 `~/.kimi-code/skills` 和 `~/.agents/skills`（用户级），以及工作目录下的 `.kimi-code/skills` 和 `.agents/skills`（项目级）。详见 [Agent Skills](../customization/skills.md)。
:::

## 目录结构

```
$KIMI_CODE_HOME  （默认 ~/.kimi-code）
├── config.toml             # 用户配置
├── tui.toml                # 终端界面偏好（含自动更新开关）
├── mcp.json                # 用户级 MCP server 声明（可选）
├── plugins/
│   ├── installed.json      # 已安装 plugin 记录与启用状态
│   └── managed/            # zip/本地路径安装的 plugin 副本
├── session_index.jsonl     # 会话索引
├── credentials/            # OAuth 凭据（目录 0700，文件 0600）
│   ├── <name>.json
│   └── mcp/
│       └── <key>-<suffix>.json
├── sessions/               # 会话数据（详见下文）
│   └── <workDirKey>/<sessionId>/
├── bin/
│   └── rg                  # ripgrep 缓存（Windows 为 rg.exe）
├── logs/
│   └── kimi-code.log       # 全局诊断日志
├── updates/
│   ├── latest.json
│   ├── install.json
│   └── install.lock
└── user-history/
    └── <md5(workDir)>.jsonl
```

## 各类文件说明

数据根下的顶层文件各有用途，大部分由 CLI 自动管理：

- **`config.toml`**：主运行时配置，存放供应商、模型、循环控制等用户级设置。详见[配置文件](./config-files.md)。
- **`tui.toml`**：终端界面客户端偏好，包括 `[upgrade].auto_install`（自动更新，默认开启）。可在 `/settings` 关闭，或手动设为 `auto_install = false`。
- **`mcp.json`**：用户级 MCP server 声明，启动时与项目内的 `.kimi-code/mcp.json` 合并加载。详见 [MCP](../customization/mcp.md)。
- **`plugins/installed.json`**：记录已安装的 plugin、每个 plugin 的启用状态，以及通过 `/plugins` 或 `/plugins mcp disable|enable` 修改的 MCP server 能力状态。本地路径和 zip URL 安装的文件会复制到 `plugins/managed/<id>/`。详见 [Plugins](../customization/plugins.md)。
- **`credentials/`**：OAuth 凭据目录，权限 `0o700`（目录）/ `0o600`（文件），仅当前用户可读写。托管供应商凭据存为 `credentials/<name>.json`，MCP server 凭据存在 `credentials/mcp/` 子目录下。凭据写入使用原子流程（tmp → fsync → rename）防止写损。

## 会话数据

每个会话的数据存在 `sessions/<workDirKey>/<sessionId>/` 下，同时在顶层 `session_index.jsonl` 里维护一份索引（每行一条记录，含 `sessionId`、`sessionDir`、`workDir` 三个字段）。`workDirKey` 是从工作目录路径生成的桶名，格式为 `wd_<slug>_<sha256前12位>`。

会话目录内部包含：

- **`state.json`**：会话标题、`lastPrompt`、创建/更新时间、`forkedFrom` 等元数据。
- **`upcoming-goals.json`**：由 `/goal next <objective>` 创建的 TUI 专属队列。它不属于 Agent 对话；只有当前目标完成并提升后续目标后，才会进入 Agent 对话。
- **`agents/main/wire.jsonl`**：主 Agent 的完整通信记录，用于会话恢复和回放。
- **`agents/main/plans/`**：Plan 模式下写入的计划文件，按计划 id 命名（`<id>.md`）。
- **`agents/agent-0/` 等**：子 Agent 实例目录，各自含 `wire.jsonl`。
- **`logs/kimi-code.log`**：该会话的诊断日志，只有发生诊断事件时才存在。
- **`tasks/`**：后台任务持久化——`tasks/<task_id>.json` 保存状态/pid/退出码，`tasks/<task_id>/output.log` 保存输出。
- **`cron/`**：定时任务持久化，`kimi resume` 时重新加载到调度器。详见[定时任务](../reference/tools.md#定时任务)。

## 内置工具缓存

CLI 第一次需要 ripgrep 时会自动下载并缓存到 `bin/rg`（Windows 为 `bin/rg.exe`），之后直接复用。如果系统 `PATH` 里本来就有 `rg`，优先使用系统版本。删除 `bin/` 目录会在下次需要时触发重新下载。

## 日志与更新状态

- **`logs/kimi-code.log`**（全局）：记录启动、登录、导出等跨会话事件。
- **`<sessionDir>/logs/kimi-code.log`**（会话级）：记录单个会话内的诊断事件。

报 bug 时，优先用 `kimi export` 导出相关会话（详见 [kimi 命令](../reference/kimi-command.md)）；会话日志默认包含在导出包里。不想分享全局日志时加 `--no-include-global-log`。

`updates/` 下的三个文件（`latest.json`、`install.json`、`install.lock`）由自动更新机制维护，通常无需手动编辑。

## 输入历史

终端输入历史按工作目录分开保存，路径为 `user-history/<md5(workDir)>.jsonl`。用于在终端界面里用方向键浏览历史提示词。

## 清理数据

删除数据根目录（`~/.kimi-code/` 或 `KIMI_CODE_HOME` 指定路径）可清除所有运行时数据。只需清理部分内容时：

| 需求 | 操作 |
| --- | --- |
| 重置配置 | 删除 `~/.kimi-code/config.toml` |
| 重置终端界面偏好 | 删除 `~/.kimi-code/tui.toml` |
| 清理所有会话 | 删除 `~/.kimi-code/sessions/` 和 `session_index.jsonl` |
| 清理诊断日志 | 删除 `~/.kimi-code/logs/` |
| 清理输入历史 | 删除 `~/.kimi-code/user-history/` |
| 重置更新状态 | 删除 `~/.kimi-code/updates/latest.json` |
| 强制重新下载 ripgrep | 删除 `~/.kimi-code/bin/` |
| 清除供应商 OAuth 登录态 | 运行 `/logout`，或删除对应的 `credentials/<name>.json` |
| 清除 MCP server OAuth 登录态 | 删除 `credentials/mcp/`（`/logout` 不会清理 MCP 凭据） |
| 移除用户级 MCP 声明 | 删除 `~/.kimi-code/mcp.json` |
| 清理 plugin 安装记录 | 删除 `~/.kimi-code/plugins/`（本地 plugin 源码不受影响） |
| 清空用户级 Skills | 删除 `~/.kimi-code/skills/` |

## 下一步

- [配置文件](./config-files.md) — `config.toml` 各字段的完整说明
- [环境变量](./env-vars.md) — `KIMI_CODE_HOME` 等路径变量的详细用法
