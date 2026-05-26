# Kimi Code 插件协议当前实现

> 已被 `reports/2026-05-27-superpowers-kimi-plugin-handoff.md` 接手文档更新。
> 最新方向是支持 `plugin.json` / `.kimi-plugin/plugin.json`，并移除
> `.codex-plugin/plugin.json` fallback。

## 结论

当前 `/plugins` 应收束为 Kimi Code 自己的插件协议，而不是旧 Kimi CLI
`tools[].command` runtime 的延续。

当前原生协议入口是：

```text
<plugin_root>/plugin.json
```

如果没有根目录 `plugin.json`，可以把 Codex 插件 manifest 作为 skills-only
fallback 导入：

```text
<plugin_root>/.codex-plugin/plugin.json
```

这个 fallback 只读取元数据、`skills` 和 `interface` 展示字段，不导入 Kimi
运行时语义。

不支持：

```text
<plugin_root>/.kimi-plugin/plugin.json
```

最终模型：

```text
Kimi Code plugin =
  root plugin.json
  + optional .codex-plugin skills-only fallback
  + skills
  + sessionStart skill injection
  + opt-in mcpServers
  + skillInstructions
  + display metadata
```

## Manifest 形状

```json
{
  "name": "kimi-finance",
  "version": "1.0.0",
  "description": "Finance data and analysis workflows for Kimi Code",
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

## 当前支持字段

| 字段 | 行为 |
|---|---|
| `name` | 必填，作为 plugin id 的来源 |
| `version` / `description` / `keywords` | 展示和搜索元数据 |
| `skills` | 声明 skill root，支持 `skills/<name>/SKILL.md` |
| root `SKILL.md` | 没有 `skills` 字段时自动作为单 skill root |
| `sessionStart.skill` | 新 session 首轮注入指定 skill |
| `skillInstructions` | 附加到该插件所有 skill 正文前 |
| `mcpServers` | 解析并展示；必须用户显式 enable 后，下个 session 才启动 |
| `interface` | `/plugins info` 的展示信息 |

## `.codex-plugin` fallback

`.codex-plugin/plugin.json` 只用于兼容已经存在的 Codex/Superpowers
skills-only 插件目录。它不是 Kimi 原生协议。

fallback 导入字段：

```text
name
version
description
keywords
homepage
license
author
skills
interface
```

fallback 明确不导入：

```text
hooks
sessionStart
mcpServers
apps
skillInstructions
```

如果同时存在根目录 `plugin.json` 和 `.codex-plugin/plugin.json`，根目录
`plugin.json` 胜出，`.codex-plugin/plugin.json` 只在 `/plugins info` 里作为
shadowed manifest 展示。根目录 `plugin.json` 语法错误时也不会 fallback，
避免一个坏的原生 manifest 被悄悄绕过。

## 当前明确不支持字段

这些字段只生成 unsupported diagnostic，不产生执行能力：

```text
tools
configFile
config_file
inject
bootstrap
hooks
apps
```

其中 `bootstrap` 和旧的 `hooks.sessionStart.skill` 被 `sessionStart.skill` 取代。

## MCP 策略

`mcpServers` 是真实 Kimi Code plugin 字段，但不是安装即运行。

安装后：

```text
/plugins install /path/to/plugin
/plugins info kimi-finance
```

用户会看到：

```text
MCP servers:
  finance disabled (plugin-kimi-finance-finance)
    command: uvx kimi-finance-mcp
```

显式启用：

```text
/plugins mcp enable kimi-finance finance
```

禁用：

```text
/plugins mcp disable kimi-finance finance
```

启用状态保存在：

```text
$KIMI_HOME/plugins/installed.json
```

新 session 创建时，enabled plugin MCP server 会合并进现有 session MCP config，
然后走 Kimi 现有 MCP 生命周期、状态事件、工具注册和权限展示。

## 为什么不支持 tools[].command

旧 `tools[].command` 的实际含义是：

```text
插件安装后，可以把任意本地命令注册成模型可调用工具。
```

这会引入一条和 MCP、Bash、权限系统并行的执行通道。当前协议不创建新的执行通道。

插件需要执行能力时，应该选择：

1. 用 skill 指导模型调用 Kimi 现有工具，例如 `Bash`。
2. 声明 MCP server，并让用户显式 enable。
3. 后续使用一方维护的 managed runtime。

## 旧财经插件迁移形态

旧财经插件不做 legacy adapter。推荐重写为：

```text
kimi-finance-plugin/
  plugin.json
  skills/
    using-finance/SKILL.md
    stock-analysis/SKILL.md
    earnings-analysis/SKILL.md
  mcp/
    finance-server/
```

短期可以用 skills 指导模型走现有工具；长期应该用 `mcpServers.finance`
提供结构化数据工具，例如 quote、financials、news。stdio MCP 会继承当前进程环境变量；
如果必须在 manifest 里写 `env`，那就是字面量覆盖，不是 `${VAR}` 插值。

## Superpowers 迁移形态

现有 Superpowers checkout 可以通过 `.codex-plugin/plugin.json` fallback 安装，
并贡献 `skills/` 里的 Skills。但这种模式不会自动启用
`using-superpowers`，因为 Codex manifest 没有 Kimi 的 session-start 语义。

Superpowers 要成为完整的 Kimi 原生插件，需要根目录 `plugin.json`：

```json
{
  "name": "superpowers",
  "version": "5.1.0",
  "skills": "./skills/",
  "sessionStart": {
    "skill": "using-superpowers"
  },
  "skillInstructions": "Kimi-specific tool mapping and behavior notes.",
  "interface": {
    "displayName": "Superpowers"
  }
}
```

Kimi 代码不再 hardcode `superpowers`。`.codex-plugin/plugin.json` 只提供
skills-only 导入，不会推导 `sessionStart`、`skillInstructions` 或
`mcpServers`。
