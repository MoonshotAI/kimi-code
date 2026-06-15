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

设置后，配置、会话、日志、OAuth 凭据、Kimi 专属用户级 Skills、全局 `AGENTS.md` 等 **Kimi Code 数据**都会落到新路径下。`KIMI_CODE_HOME` 的完整说明见[环境变量](./env-vars.md)。

::: tip 提示

**通用 `.agents` 资源**仍放在真实 OS home 下，以便跨工具共享。例如，用户级通用 Skills 仍位于 `~/.agents/skills/`，而 Kimi 专属用户级 Skills 会随 `KIMI_CODE_HOME` 移动到 `$KIMI_CODE_HOME/skills/`。
:::

## 目录结构

```
$KIMI_CODE_HOME  （默认 ~/.kimi-code）
├── config.toml             # 用户配置
├── tui.toml                # 终端界面偏好（含自动更新开关）
├── AGENTS.md               # 全局 Kimi 专属 Agent 指令（可选）
├── mcp.json                # 用户级 MCP server 声明（可选）
├── skills/                 # Kimi 专属用户级 Skills（可选）
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
│   ├── rg                  # Grep 使用的托管 ripgrep 二进制（Windows 为 rg.exe）
│   └── fd                  # 文件引用使用的托管 fd 二进制（Windows 为 fd.exe）
├── logs/
│   └── kimi-code.log       # 全局诊断日志
├── updates/
│   ├── latest.json
│   ├── install.json
│   ├── install.lock
│   └── rollout.log
└── user-history/
    └── <md5(workDir)>.jsonl
```

## 各类文件说明

数据根下的顶层文件各有用途，大部分由 CLI 自动管理：

- **`config.toml`**：主运行时配置，存放供应商、模型、循环控制等用户级设置。详见[配置文件](./config-files.md)。
- **`tui.toml`**：终端界面客户端偏好，包括 `[upgrade].auto_install`（自动更新，默认开启）。可在 `/settings` 关闭，或手动设为 `auto_install = false`。
- **`AGENTS.md`**：全局 Kimi 专属 Agent 指令。该文件会随 `KIMI_CODE_HOME` 移动；跨工具通用指令仍可放在 `~/.agents/AGENTS.md`。
- **`mcp.json`**：用户级 MCP server 声明，启动时与项目内的 `.kimi-code/mcp.json` 合并加载。详见 [MCP](../customization/mcp.md)。
- **`skills/`**：Kimi 专属用户级 Skills。该目录会随 `KIMI_CODE_HOME` 移动；跨工具通用 Skills 仍可放在 `~/.agents/skills/`。详见 [Agent Skills](../customization/skills.md)。
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

`Grep` 工具第一次需要 ripgrep 时，CLI 可自动下载 `rg` 并缓存到 `bin/rg`（Windows 为 `bin/rg.exe`）。终端界面的文件引用补全使用 `fd`；需要时 CLI 会在后台自动下载并缓存到 `bin/fd`（Windows 为 `bin/fd.exe`）。之后的运行会直接复用缓存的二进制。`rg` 优先使用系统 `PATH`，再使用缓存；`fd` 优先检查托管缓存，再回退到系统 `fd` / `fdfind`。删除 `bin/` 目录会在下次需要时触发重新下载。

## 日志与更新状态

- **`logs/kimi-code.log`**（全局）：记录启动、登录、导出等跨会话事件。
- **`<sessionDir>/logs/kimi-code.log`**（会话级）：记录单个会话内的诊断事件。

报 bug 时，优先用 `kimi export` 导出相关会话（详见 [kimi 命令](../reference/kimi-command.md)）；会话日志默认包含在导出包里。不想分享全局日志时加 `--no-include-global-log`。

`updates/` 下的文件（`latest.json`、`install.json`、`install.lock`、`rollout.log`）由自动更新机制维护，通常无需手动编辑。`rollout.log` 记录每次更新检查命中的灰度分批情况，可用于排查设备何时能收到新版本。

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
| 强制重新下载托管 `rg` 和 `fd` | 删除 `~/.kimi-code/bin/` |
| 清除供应商 OAuth 登录态 | 运行 `/logout`，或删除对应的 `credentials/<name>.json` |
| 清除 MCP server OAuth 登录态 | 删除 `credentials/mcp/`（`/logout` 不会清理 MCP 凭据） |
| 移除用户级 MCP 声明 | 删除 `$KIMI_CODE_HOME/mcp.json`（默认为 `~/.kimi-code/mcp.json`） |
| 清理全局 Kimi 专属 Agent 指令 | 删除 `$KIMI_CODE_HOME/AGENTS.md`（默认为 `~/.kimi-code/AGENTS.md`） |
| 清理 plugin 安装记录 | 删除 `$KIMI_CODE_HOME/plugins/`（本地 plugin 源码不受影响） |
| 清空 Kimi 专属用户级 Skills | 删除 `$KIMI_CODE_HOME/skills/`（默认为 `~/.kimi-code/skills/`） |

## 下一步

- [配置文件](./config-files.md) — `config.toml` 各字段的完整说明
- [环境变量](./env-vars.md) — `KIMI_CODE_HOME` 等路径变量的详细用法
