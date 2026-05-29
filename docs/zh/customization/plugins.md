# Plugins

Plugins 把可复用的 Kimi Code CLI 能力打包成可安装单元。一个 plugin 可以添加 [Agent Skills](./skills.md)，在会话启动时加载指定 Skill，也可以声明 MCP servers 来提供真实工具能力。

当你需要共享工作流、连接外部服务，或从官方 marketplace 安装扩展时，可以使用 plugins。Kimi Code CLI 对 plugin 采用保守的加载策略：安装 plugin 不会执行其中的 Python、Node.js、Shell、hook 或命令脚本。

## 安装与管理 plugins

在 TUI 中运行 `/plugins` 可打开 plugin 管理器。你可以在这里安装 plugins、浏览官方 marketplace、查看 plugin 详情、启用或禁用 plugins、移除 plugins、重载安装记录，以及管理 plugin 的 MCP servers。

常用按键：

| 按键 | 操作 |
| --- | --- |
| `Enter` 或 `→` | 打开选中项，或安装 marketplace 中选中的 plugin。 |
| `Space` | 启用或禁用已安装 plugin；在 marketplace 中安装或更新 plugin。 |
| `M` | 管理选中 plugin 的 MCP servers。 |
| `←` 或 `Esc` | 返回上一层。 |

多数情况下，交互式管理器已足够。也可以直接使用以下斜杠命令：

| 命令 | 说明 |
| --- | --- |
| `/plugins` | 打开交互式 plugin 管理器。 |
| `/plugins list` | 列出已安装 plugins。 |
| `/plugins install <path-or-url>` | 从本地目录（支持相对路径和 `~/`）、zip URL 或 GitHub 仓库 URL 安装。 |
| `/plugins marketplace [source]` | 浏览官方 marketplace；可选传入 marketplace JSON 的路径或 URL。 |
| `/plugins info <id>` | 查看 plugin 详情和 diagnostics；省略 `<id>` 时打开管理器。 |
| `/plugins <id>` | 查看指定 plugin 详情，等同于 `/plugins info <id>`。 |
| `/plugins enable <id>` | 启用 plugin；省略 `<id>` 时打开管理器。 |
| `/plugins disable <id>` | 禁用 plugin；省略 `<id>` 时打开管理器。 |
| `/plugins remove <id>` | 移除 plugin，需二次确认。 |
| `/plugins reload` | 重载 `installed.json` 和各 plugin manifest。 |
| `/plugins mcp enable <id> <server>` | 启用 plugin 声明的 MCP server。 |
| `/plugins mcp disable <id> <server>` | 禁用 plugin 声明的 MCP server。 |

斜杠命令的通用行为见 [斜杠命令](../reference/slash-commands.md)。

GitHub URL 支持四种形式。裸 URL `https://github.com/<owner>/<repo>` 会安装该仓库最新的 GitHub release；仓库没有 release 时回落到默认分支。`https://github.com/<owner>/<repo>/tree/<ref>` 用于安装指定分支、tag 或短 commit SHA。`https://github.com/<owner>/<repo>/releases/tag/<tag>` 和 `https://github.com/<owner>/<repo>/commit/<sha>` 用于钉死具体的 tag 或 commit。网络请求只走 `github.com` 重定向和 `codeload.github.com` 下载，**不会**调用 `api.github.com`。

Plugin 管理器会展示每个安装的来源以及一个信任徽章。`kimi-official` 表示从 Kimi marketplace 以 `official` tier 安装的 plugin；`curated` 表示 marketplace 中 `curated` tier 的 plugin；`third-party` 表示其它所有情况，包括你直接用 `/plugins install <url>` 装的或本地目录装的 plugin。重新安装时徽章会根据新的来源刷新。

Kimi Code CLI 目前按用户安装 plugins，记录在 `$KIMI_CODE_HOME/plugins/` 下，对所有项目生效。暂不支持项目级、仓库级、管理员分发，以及带 `--scope` 的安装方式。

Plugin 变更只对新会话生效。安装、启用/禁用、移除、重载 plugin，或修改 MCP server 开关后，需要通过 `/new` 开启新会话；当前会话不会更新，新的 Skills、会话启动行为和 MCP servers 只会在新会话中加载。

本地安装会被拷贝到 `$KIMI_CODE_HOME/plugins/managed/<id>/`，Kimi Code CLI 始终从这份托管副本运行。安装后再编辑原始源目录不会生效，需要重新安装——`/plugins reload` 只会重读安装记录和 manifest，不会重读原始源。移除 plugin 只会删除其安装记录，托管副本和原始源文件仍保留在磁盘上。

## Plugin manifest

Plugin 是一个带 manifest 的目录或 zip 文件。Manifest 可以放在以下任一位置：

```text
<plugin_root>/kimi.plugin.json
<plugin_root>/.kimi-plugin/plugin.json
```

两个文件同时存在时，以 `kimi.plugin.json` 为准。Kimi Code CLI 不会读取根目录的 `plugin.json` 或 `.codex-plugin/plugin.json`。

示例：

```json
{
  "name": "kimi-finance",
  "version": "1.0.0",
  "description": "Finance data and analysis workflows for Kimi Code CLI",
  "skills": "./skills/",
  "sessionStart": {
    "skill": "using-finance"
  },
  "interface": {
    "displayName": "Kimi Finance",
    "shortDescription": "Market data and financial analysis workflows"
  }
}
```

支持的字段：

| 字段 | 说明 |
| --- | --- |
| `name` | 必填，作为 plugin id。必须匹配 `[a-z0-9][a-z0-9_-]{0,63}`。 |
| `version`、`description`、`keywords`、`author`、`homepage`、`license` | 展示元数据。 |
| `interface` | 在 `/plugins` 中展示的字段，例如 `displayName`、`shortDescription`、`longDescription`、`developerName` 和 `websiteURL`。 |
| `skills` | 一个或多个 `./` 路径，必须位于 plugin 根目录内。如果省略，根目录的 `SKILL.md` 会被当作单个 Skill root。 |
| `sessionStart.skill` | 在新会话或恢复会话开始时，把指定 plugin Skill 加载到主 Agent。 |
| `skillInstructions` | 每次加载此 plugin 的 Skill 时，一并附带的额外说明。 |
| `mcpServers` | MCP server 声明。默认启用，可以从 `/plugins` 中禁用。 |

`tools`、`commands`、`hooks`、`apps`、`inject`、`configFile`、`config_file`、`bootstrap` 等不支持的运行时字段会显示为 diagnostics，并被忽略。

## Skills 与 session start

Plugin Skills 使用与普通 [Agent Skills](./skills.md) 相同的 `SKILL.md` 格式。常见目录结构如下：

```text
my-plugin/
  kimi.plugin.json
  skills/
    using-my-plugin/
      SKILL.md
    another-workflow/
      SKILL.md
```

`sessionStart.skill` 会在会话启动时，把一个 plugin Skill 加载到主 Agent 中。它适合放置初始化说明、工作流规则，或将其他工具中的术语映射到 Kimi Code CLI。它只注入文本，不执行代码。

无论 Skill 是通过 `sessionStart.skill`、`/skill:<name>` 加载，还是由模型自动调用，`skillInstructions` 都会随该 plugin 的 Skill 一起出现。

## Plugin 中的 MCP servers

当 plugin 需要真实工具能力时，例如读取外部服务数据或启动本地辅助进程，可以在 manifest 中声明 `mcpServers`。Plugin MCP servers 复用 [MCP](./mcp.md) 的 schema。

Stdio server：

```json
{
  "mcpServers": {
    "finance": {
      "command": "uvx",
      "args": ["kimi-finance-mcp"]
    }
  }
}
```

HTTP server：

```json
{
  "mcpServers": {
    "docs": {
      "url": "https://example.com/mcp"
    }
  }
}
```

对于 stdio servers，`command` 可以是 `PATH` 上的命令，也可以是 plugin 根目录内以 `./` 开头的路径。如果设置了 `cwd`，它也必须以 `./` 开头并位于 plugin 根目录内；其他取值会被拒绝，该 server 会被忽略。Plugin MCP servers 会继承当前进程的环境变量；`env` 中的值会按字面量覆盖。

Plugin MCP servers 只会在新会话中启动。要禁用或重新启用某个 server，运行 `/plugins`，选中 plugin 后按 `M`。也可以使用快捷命令：

```sh
/plugins mcp disable kimi-finance finance
/new

/plugins mcp enable kimi-finance finance
/new
```

## 安全模型

Plugins 的加载范围有限：

- 安装和会话启动时，仅读取 plugin manifests 和 Markdown Skill 文件。
- 所有路径在解析符号链接后仍必须位于 plugin 根目录内。
- 命令型 plugin tools、hooks 和旧式工具运行时不会由 plugin loader 执行。
- 已启用 plugin 声明的 MCP servers 只会在新会话中启动，并且可以从 `/plugins` 中禁用。
- 损坏的 manifest 或不安全路径会显示在 `/plugins info <id>` 的 diagnostics 中，不会让无关会话崩溃。
