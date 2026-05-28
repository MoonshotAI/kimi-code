# Plugins

Plugins 围绕 `kimi.plugin.json` manifest 打包可复用的 Kimi Code CLI 行为。一个 plugin 可以贡献 Skills、插件级 Skill 说明、声明式 session-start Skill、展示元数据，以及 MCP servers。多宿主仓库可以把同一份 Kimi manifest 放在 `.kimi-plugin/plugin.json`，避免占用仓库根目录。

安装 plugin 本身不会执行 plugin 提供的 Python、Node.js、Shell 或 hook 脚本。当前版本的 Kimi Code CLI 不运行命令型 plugin tools；真实工具应通过 plugin 声明的 MCP servers 暴露。

## 安装与管理 plugins

在 TUI 中运行 `/plugins` 会打开交互式 plugin 管理器。选择器会列出已安装的 plugins，并让你安装、查看、启用、禁用、移除、重载、浏览官方 marketplace，以及启用或禁用 plugin MCP servers。用 `Enter` 或 `→` 打开详情，用 `Space` 启用或禁用已安装 plugin，用 `M` 管理该 plugin 的 MCP servers，用 `←` 或 `Esc` 返回。Marketplace 里 `Enter` 或 `Space` 会安装或更新当前选中的 plugin。

Kimi Code CLI 目前只支持 user/global（用户全局）plugin 安装。已安装 plugins 记录在 `$KIMI_CODE_HOME/plugins/` 下，并对当前用户的所有项目可用。暂不支持项目本地、仓库共享、托管/管理员范围，以及带 `--scope` 的 plugin 安装。

快捷命令仍然可用于快速操作或脚本：

```sh
/plugins
/plugins list
/plugins install /absolute/path/to/plugin
/plugins install ./relative-plugin
/plugins install https://example.com/plugin.zip
/plugins marketplace
/plugins marketplace ./plugins/marketplace.json
/plugins info <id>
/plugins enable <id>
/plugins disable <id>
/plugins remove <id>
/plugins reload
/plugins mcp enable <id> <server>
/plugins mcp disable <id> <server>
```

当前可直接安装的示例包：

```sh
/plugins install https://kimi-1300010026.cos.ap-beijing.myqcloud.com/kimi-datasource.zip
/plugins install https://kimi-1300010026.cos.ap-beijing.myqcloud.com/superpowers-kimi-5.1.0-kimi.1.zip
```

官方 marketplace 默认从 `https://cdn.kimi.com/kimi-code/plugins/marketplace.json` 加载。在 `/plugins` 中选择 **Browse official marketplace**，即可查看 marketplace 条目并直接安装。CDN 可以托管整个 marketplace 目录，目录根部放 `marketplace.json`；相对 plugin source 会按这个文件所在目录解析。

要从当前仓库生成可上传到 CDN 的 marketplace 目录，运行：

```sh
pnpm run build:plugin-marketplace
```

这个命令会写出 `plugins/cdn/marketplace.json`，并在 `plugins/cdn/` 下生成 plugin zip 包。上传时需要把整个目录作为一个整体上传，这样 `marketplace.json` 里的相对 `source` 才会继续指向生成好的 zip 文件。

需要测试预发 CDN 文件或其他 marketplace 时，可以覆盖 marketplace 来源：

```sh
KIMI_CODE_PLUGIN_MARKETPLACE_URL=https://staging.example.com/plugins/marketplace.json kimi
```

也可以不改环境变量，临时打开一个 marketplace 文件：

```sh
/plugins marketplace plugins/marketplace.json
```

CLI 开发时，`pnpm dev:cli` 会为仓库的 `plugins/` 目录启动一个 loopback marketplace server，并只为这次 dev 进程临时设置 `KIMI_CODE_PLUGIN_MARKETPLACE_URL=http://127.0.0.1:<port>/marketplace.json`。这个 server 会把本地目录型 source 临时改成 zip URL，让 marketplace 安装走和 CDN 一样的下载路径。需要在 dev 中测试真实 CDN 时，运行 `KIMI_CODE_PLUGIN_MARKETPLACE_URL=https://cdn.kimi.com/kimi-code/plugins/marketplace.json pnpm dev:cli`；dev wrapper 会使用这个值，不再启动本地 marketplace server。

本地目录和 zip URL 都会复制到 Kimi Code CLI 管理的 plugin 目录 `$KIMI_CODE_HOME/plugins/managed/<id>/`。再次安装同一个 plugin id 会覆盖这份托管副本，并保留 plugin 的启用状态和 MCP server 开关。`installed.json` 记录这份托管副本，同时保留原始来源用于展示。移除 plugin 会先二次确认，确认后只删除安装记录，不会删除托管副本或原始本地源码目录。

Plugin 变更只对新会话生效。安装、启用、禁用、移除、重载 plugin，或修改 plugin MCP server 开关后，需要通过 `/new` 开启新会话，新的 Skills、`sessionStart.skill` 和 MCP servers 才会进入会话。已有会话继续使用启动时的快照。

重载操作会重新读取 `installed.json` 和每个 plugin manifest，让 `/plugins` 与 `/plugins info <id>` 展示最新安装状态和 diagnostics。它不会热更新当前会话里的 Skills 或 MCP 连接。因为本地路径安装实际运行的是托管副本，安装后继续修改原始源码目录不会影响已安装 plugin；需要重新安装才会更新。

## Manifest 格式

Kimi Code CLI 把根目录 `kimi.plugin.json` 作为优先 plugin manifest：

```text
<plugin_root>/kimi.plugin.json
```

如果没有 `kimi.plugin.json`，Kimi Code CLI 会读取 Kimi 专属 manifest：

```text
<plugin_root>/.kimi-plugin/plugin.json
```

Kimi Code CLI 不读取根目录 `plugin.json` 或 `.codex-plugin/plugin.json`。如果同时存在 `kimi.plugin.json` 和 `.kimi-plugin/plugin.json`，根目录 `kimi.plugin.json` 胜出，`.kimi-plugin` manifest 会在 `/plugins info` 中显示为 shadowed。

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
  "skillInstructions": "Prefer the finance MCP tools for live market data. Do not invent live prices.",
  "mcpServers": {
    "data": {
      "command": "node",
      "args": ["./bin/finance-mcp.mjs"],
      "cwd": "./"
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
| `mcpServers` | MCP server 声明。Servers 默认启用，可以在 `/plugins` 中禁用，或使用 `/plugins mcp disable <id> <server>` 禁用。 |
| `interface` | `/plugins info` 的展示字段，例如 `displayName`、`shortDescription`、`longDescription`、`developerName` 和 `websiteURL`。 |

`tools`、`commands`、`configFile`、`config_file`、`inject`、`bootstrap`、`hooks`、`apps` 等不支持的运行时字段只会产生 diagnostics 并被忽略。

## Skills 与 session start

Plugin Skills 使用和普通 [Agent Skills](./skills.md) 相同的 `SKILL.md` 格式。常见目录布局如下：

```text
my-plugin/
  kimi.plugin.json
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

对于 stdio server，`command` 可以是 `PATH` 上的命令，也可以是 plugin 根目录内以 `./` 开头的路径。如果省略 `cwd`，Kimi Code CLI 会从托管 plugin 根目录启动 server。如果设置 `cwd`，它必须以 `./` 开头，并且位于 plugin 根目录内。Plugin MCP servers 会继承当前进程环境变量；写在 `env` 里的值是字面量覆盖，不是 `${VAR}` 插值。

Plugin MCP servers 默认启用，但仍然只会在新会话中启动。要交互式禁用或重新启用，运行 `/plugins`，选中 plugin，然后按 `M` 管理它的 servers。也可以使用快捷命令：

```sh
/plugins mcp disable kimi-finance finance
/new

/plugins mcp enable kimi-finance finance
/new
```

启用状态保存在 `$KIMI_CODE_HOME/plugins/installed.json`。新会话启动后，已启用的 plugin MCP servers 会进入普通 MCP 生命周期，包括状态事件、工具命名和权限审批流程。

## 安全模型

Plugins 会被保守加载：

- 安装和会话启动时，只读取 `kimi.plugin.json`、`.kimi-plugin/plugin.json` 与 Markdown Skill 文件。
- 命令型 plugin tools、hooks 和旧式工具运行时不会由 plugin loader 执行。
- Plugin 路径在解析符号链接后必须仍位于 plugin 根目录内。
- 已启用 plugin 声明的 MCP servers 默认启用，但只会在新会话中启动，并且可以在 `/plugins` 中禁用，或使用 `/plugins mcp disable` 禁用。
- 损坏的 manifest 或不安全路径会变成 `/plugins info <id>` 中的 diagnostics，不会让无关会话崩溃。
