# Plugins

Plugins 围绕 `plugin.json` manifest 打包可复用的 Kimi Code CLI 行为。一个 plugin 可以贡献 Skills，为这些 Skills 增加插件级说明，声明会话开始时要加载的 Skill，也可以声明需要用户显式启用的 MCP servers。多宿主仓库可以把同一份 Kimi manifest 放在 `.kimi-plugin/plugin.json`，避免占用仓库根目录。

Kimi Code CLI plugins 是数据包，不是任意命令运行时。安装 plugin 不会执行 plugin 提供的 Python、Node.js、Shell 或 hook 脚本。如果一个流程需要外部工具或实时数据，优先用 Skill 指导 Agent 调用 Kimi Code CLI 现有工具，或者声明 MCP server 并让用户显式启用。

## 安装与管理 plugins

在 TUI 中使用 `/plugins`：

```sh
/plugins
/plugins install /absolute/path/to/plugin
/plugins install ./relative-plugin
/plugins install https://example.com/plugin.zip
/plugins info <id>
/plugins enable <id>
/plugins disable <id>
/plugins remove <id>
/plugins reload
/plugins mcp enable <id> <server>
/plugins mcp disable <id> <server>
```

本地目录只会登记到 `installed.json`，不会被复制。Zip URL 会被下载、解压，并保存到 Kimi Code CLI 管理的 plugin 目录中。移除 plugin 只删除安装记录，不会删除原始本地源码目录。

Plugin 变更只对新会话生效。安装、启用、禁用、移除、重载 plugin，或启用 plugin MCP server 后，需要通过 `/new` 开启新会话，新的 Skills、`sessionStart.skill` 和 MCP servers 才会进入会话。已有会话继续使用启动时的快照。

`/plugins reload` 会重新读取 `installed.json` 和每个 plugin manifest，让 `/plugins` 与 `/plugins info <id>` 展示最新安装状态和 diagnostics。它不会热更新当前会话里的 Skills 或 MCP 连接。

## Manifest 格式

Kimi Code CLI 把根目录 `plugin.json` 作为优先 plugin manifest：

```text
<plugin_root>/plugin.json
```

如果没有 `plugin.json`，Kimi Code CLI 会读取 Kimi 专属 manifest：

```text
<plugin_root>/.kimi-plugin/plugin.json
```

Kimi Code CLI 不读取 `.codex-plugin/plugin.json`。如果同时存在 `plugin.json` 和 `.kimi-plugin/plugin.json`，根目录 `plugin.json` 胜出，`.kimi-plugin` manifest 会在 `/plugins info` 中显示为 shadowed。

一个典型的 plugin manifest 如下：

```json
{
  "name": "kimi-finance",
  "version": "1.0.0",
  "description": "Finance data and analysis workflows for Kimi Code CLI",
  "keywords": ["finance", "mcp"],
  "skills": "./skills/",
  "sessionStart": {
    "skill": "using-finance"
  },
  "skillInstructions": "Prefer finance MCP tools for live market data. Do not invent live prices.",
  "mcpServers": {
    "finance": {
      "command": "uvx",
      "args": ["kimi-finance-mcp"]
    }
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
| `name` | 必填，作为 plugin id 来源。必须匹配 `[a-z0-9][a-z0-9_-]{0,63}`。 |
| `version`、`description`、`keywords`、`author`、`homepage`、`license` | 展示元数据。 |
| `skills` | 一个路径或路径数组。每个路径必须以 `./` 开头，并且符号链接解析后仍位于 plugin 根目录内。 |
| 根目录 `SKILL.md` | 如果省略 `skills`，且 plugin 根目录存在 `SKILL.md`，则根目录会作为单 Skill root 处理。 |
| `sessionStart.skill` | 声明式地在新会话或恢复会话开始时，把指定 Skill 注入到主 Agent。 |
| `skillInstructions` | 每次加载此 plugin 的 Skill 时，附加到 Skill 内容前面的额外说明。 |
| `mcpServers` | MCP server 声明。安装后会展示，但每个 server 默认禁用，直到用户显式启用。 |
| `interface` | `/plugins info` 的展示字段，例如 `displayName`、`shortDescription`、`longDescription`、`developerName`、`capabilities`、`websiteURL` 和 `defaultPrompt`。 |

`tools`、`configFile`、`config_file`、`inject`、`bootstrap`、`hooks`、`apps` 等旧字段只会产生 diagnostics 并被忽略。

## Skills 与 session start

Plugin Skills 使用和普通 [Agent Skills](./skills.md) 相同的 `SKILL.md` 格式。常见目录布局如下：

```text
my-plugin/
  plugin.json
  skills/
    using-my-plugin/
      SKILL.md
    another-workflow/
      SKILL.md
```

`sessionStart.skill` 是声明式会话启动规则：它会在会话开始时，把某个 Skill 一次性加载到主 Agent 上下文中。它不会执行代码。适合用于 plugin 需要在第一个用户任务前建立工作规则的场景，例如把另一个工具环境里的术语映射到 Kimi Code CLI 工具。

无论 Skill 是通过 `sessionStart.skill`、`/skill:<name>`，还是模型自动调用加载，`skillInstructions` 都会跟 Skill 内容放在一起。

## Plugin 中的 MCP servers

Plugin MCP servers 复用 [MCP](./mcp.md) 的 server schema。可以声明 stdio server：

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

也可以声明 HTTP server：

```json
{
  "mcpServers": {
    "docs": {
      "url": "https://example.com/mcp"
    }
  }
}
```

对于 stdio server，`command` 可以是 `PATH` 上的命令，也可以是 plugin 根目录内以 `./` 开头的路径。如果设置 `cwd`，它也必须以 `./` 开头，并且位于 plugin 根目录内。Plugin MCP servers 会继承当前进程环境变量；写在 `env` 里的值是字面量覆盖，不是 `${VAR}` 插值。

安装 plugin 不会启动它的 MCP servers。需要显式启用：

```sh
/plugins mcp enable kimi-finance finance
/new
```

启用状态保存在 `$KIMI_CODE_HOME/plugins/installed.json`。新会话启动后，已启用的 plugin MCP servers 会进入普通 MCP 生命周期，包括状态事件、工具命名和权限审批流程。

## 安全模型

Plugins 会被保守加载：

- 安装和会话启动时，只读取 `plugin.json`、`.kimi-plugin/plugin.json` 与 Markdown Skill 文件。
- Plugin 提供的脚本、命令、hooks 和旧式工具运行时不会由 plugin loader 执行。
- Plugin 路径在解析符号链接后必须仍位于 plugin 根目录内。
- Plugin 声明的 MCP servers 默认不启用，只有 `/plugins mcp enable` 后的新会话才会启动。
- 损坏的 manifest 或不安全路径会变成 `/plugins info <id>` 中的 diagnostics，不会让无关会话崩溃。
