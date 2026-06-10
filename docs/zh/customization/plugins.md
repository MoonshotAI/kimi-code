# Plugins

Plugins 把可复用的 Kimi Code CLI 能力打包成可安装单元——可以添加 [Agent Skills](./skills.md)、在会话启动时自动加载指定 Skill，也可以声明 MCP servers 来提供真实工具能力。适合把工作流共享给团队、连接外部服务，或从官方 marketplace 安装扩展。

Kimi Code CLI 对 plugin 采用保守的加载策略：安装 plugin 时不会执行其中的 Python、Node.js、Shell、hook 或命令脚本。

## 安装与管理

在 TUI 中运行 `/plugins` 打开 plugin 管理器，可以在这里完成所有日常操作。常用按键：

| 按键 | 操作 |
| --- | --- |
| `Enter` 或 `→` | 打开选中项，或安装 marketplace 中的 plugin |
| `Space` | 启用或禁用已安装 plugin；在 marketplace 中安装或更新 plugin |
| `M` | 管理选中 plugin 的 MCP servers |
| `←` 或 `Esc` | 返回上一层 |

在 marketplace 列表里，已安装且有新版本的 plugin 会显示 `update <本地版本> → <最新版本>`，已是最新显示 `installed · v<版本>`，未安装显示 `install v<版本>`。选中可更新的项按 `Enter` 即可更新。

也可以直接使用斜杠命令：

| 命令 | 说明 |
| --- | --- |
| `/plugins` | 打开交互式 plugin 管理器 |
| `/plugins list` | 列出已安装 plugins |
| `/plugins install <path-or-url>` | 从本地目录、zip URL 或 GitHub 仓库 URL 安装 |
| `/plugins marketplace [source]` | 浏览官方 marketplace；可选传入 marketplace JSON 的路径或 URL |
| `/plugins info <id>` | 查看 plugin 详情和 diagnostics |
| `/plugins enable <id>` | 启用 plugin |
| `/plugins disable <id>` | 禁用 plugin |
| `/plugins remove <id>` | 移除 plugin（需二次确认） |
| `/plugins reload` | 重载 `installed.json` 和各 plugin manifest |
| `/plugins mcp enable <id> <server>` | 启用 plugin 声明的 MCP server |
| `/plugins mcp disable <id> <server>` | 禁用 plugin 声明的 MCP server |

Plugin 管理器会展示每个安装的来源和信任徽章：`kimi-official`（来自官方地址）、`curated`（来自精选地址）、`third-party`（其他所有情况）。

### 从 GitHub 安装

通过 `/plugins install <url>` 可以直接从 GitHub 仓库安装，支持四种 URL 形式：

- `https://github.com/<owner>/<repo>`：安装最新 release；无 release 时回落到默认分支
- `https://github.com/<owner>/<repo>/tree/<ref>`：安装指定分支、tag 或短 commit SHA
- `https://github.com/<owner>/<repo>/releases/tag/<tag>`：钉死具体 tag
- `https://github.com/<owner>/<repo>/commit/<sha>`：钉死具体 commit

网络请求只走 `github.com` 重定向和 `codeload.github.com` 下载，不调用 `api.github.com`。

### 注意事项

- Plugin 变更只对新会话生效。安装、启用/禁用、移除后，需通过 `/reload` 重载插件或通过 `/new` 开启新会话；当前会话不会更新。
- 本地安装会被拷贝到 `$KIMI_CODE_HOME/plugins/managed/<id>/`，CLI 始终从这份托管副本运行。安装后编辑原始源目录不会生效，需重新安装。
- 移除 plugin 只会删除安装记录，托管副本和原始源文件仍保留在磁盘上。
- Plugin 目前按用户安装，对所有项目生效，暂不支持项目级安装范围。

## Kimi Datasource

Kimi Datasource 是 Kimi Code 官方数据插件，让你通过自然语言直接查询金融行情、宏观经济、企业工商和学术文献，无需手动调用接口或申请任何数据账号。

### 安装

需先通过 `/login` 完成 Kimi Code 账号 OAuth 登录，插件依赖本地凭据访问数据服务。

1. 运行 `/plugins`，选择 **Marketplace**
2. 找到 **Kimi Datasource**，按 `Space` 安装
3. 安装完成后运行 `/reload` 重载插件，即可使用

### 使用方式

安装完成后，直接用自然语言描述你的需求，Kimi Code 会自动调用数据能力；也可以通过 `/skill:kimi-datasource` 明确触发数据查询 Skill。

### 能做什么

**实时量化研究**：盯着茅台想做个量化分析？一句话拉取近三年的每日收盘价、MACD 和 KDJ 信号，直接出结论，不用找第三方数据平台。

**跨国宏观对比**：研究中印越产业转移？基于世界银行 50 年历史数据，一次查询拿到三国 GDP 增速、贸易额、人口结构的完整时间序列对比。

**合同前风险排查**：签合同前五分钟才想起来要查对方背景？输入公司名，立刻拿到工商注册信息、股权穿透、司法纠纷和失信记录，当场决策。

**文献综述加速**：写论文要梳理 RLHF 领域的研究脉络？直接列出高引论文、主要作者和核心结论，综述提纲半小时内成型。

### 数据覆盖

| 类别 | 覆盖范围 |
|---|---|
| 股票行情 | A 股、港股、美股及全球主要市场实时/历史行情、技术指标、财务报表、股票筛选 |
| 宏观经济 | 世界银行 189 个成员国、50 年以上历史时间序列（GDP、贸易、人口、气候等） |
| 企业数据 | 中国大陆境内企业工商信息、股权穿透、司法风险、关联图谱 |
| 学术文献 | 物理、数学、计算机、金融、经济等领域百万量级论文，支持预印本查询 |

### 注意事项

- 数据查询按次计费，消耗 Kimi Code 账号额度
- 插件为只读查询，不提供任何写入或交易功能
- 技术指标（MACD、KDJ 等）及实时行情仅在交易时段内可用
- AI 输出内容仅供参考，不构成任何投资或商业决策建议

## Plugin manifest

Plugin 是一个带 manifest 的目录或 zip 文件。Manifest 可以放在以下任一位置：

```text
<plugin_root>/kimi.plugin.json
<plugin_root>/.kimi-plugin/plugin.json
```

两个文件同时存在时，以 `kimi.plugin.json` 为准。

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
| `name` | 必填，作为 plugin id。必须匹配 `[a-z0-9][a-z0-9_-]{0,63}` |
| `version`、`description`、`keywords`、`author`、`homepage`、`license` | 展示元数据 |
| `interface` | 在 `/plugins` 中展示的字段：`displayName`、`shortDescription`、`longDescription`、`developerName`、`websiteURL` |
| `skills` | 一个或多个 `./` 路径，必须位于 plugin 根目录内。省略时根目录的 `SKILL.md` 被当作单个 Skill root |
| `sessionStart.skill` | 在新会话或恢复会话开始时，把指定 plugin Skill 加载到主 Agent |
| `skillInstructions` | 每次加载此 plugin 的 Skill 时一并附带的额外说明 |
| `mcpServers` | MCP server 声明，默认启用，可从 `/plugins` 中禁用 |

`tools`、`commands`、`hooks`、`apps`、`inject`、`configFile` 等不支持的运行时字段会显示为 diagnostics 并被忽略。

## Skills 与会话启动

Plugin Skills 使用与普通 [Agent Skills](./skills.md) 相同的 `SKILL.md` 格式，典型目录结构如下：

```text
my-plugin/
  kimi.plugin.json
  skills/
    using-my-plugin/
      SKILL.md
    another-workflow/
      SKILL.md
```

`sessionStart.skill` 在会话启动时把一个 plugin Skill 加载到主 Agent，适合放置初始化说明、工作流规则，或把其他工具中的术语映射到 Kimi Code CLI。它只注入文本，不执行代码。

无论 Skill 通过哪种方式加载（`sessionStart.skill`、`/skill:<name>` 或模型自动调用），`skillInstructions` 都会随该 plugin 的 Skill 一起出现。

## Plugin 中的 MCP servers

当 plugin 需要真实工具能力时，可以在 manifest 中声明 `mcpServers`，复用 [MCP](./mcp.md) 的 schema。

Stdio server（本地命令）：

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

HTTP server（远程服务）：

```json
{
  "mcpServers": {
    "docs": {
      "url": "https://example.com/mcp"
    }
  }
}
```

对于 stdio servers，`command` 可以是 `PATH` 上的命令，也可以是 plugin 根目录内以 `./` 开头的路径。`cwd` 同理，必须以 `./` 开头并位于 plugin 根目录内，否则该 server 会被忽略。

Plugin MCP servers 只会在新会话中启动。启用或禁用某个 server：

```sh
/plugins mcp disable kimi-finance finance
/new

/plugins mcp enable kimi-finance finance
/new
```

## 安全模型

Plugin 的加载范围有限，以下操作不会在安装或会话启动时发生：

- 不会执行命令型 plugin tools、hooks 或旧式工具运行时
- 所有路径在解析符号链接后仍必须位于 plugin 根目录内
- 已启用 plugin 的 MCP servers 只在新会话中启动，且可随时从 `/plugins` 禁用
- 损坏的 manifest 或不安全路径会显示在 `/plugins info <id>` 的 diagnostics 中，不影响其他会话

## 下一步

- [Agent Skills](./skills.md) — Skills 的文件格式与 frontmatter 字段参考
- [MCP](./mcp.md) — Plugin MCP servers 的完整 schema 与权限配置
