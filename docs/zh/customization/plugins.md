# Plugins

Plugins 把可复用的 Kimi Code CLI 能力打包成可安装单元——可以添加 [Agent Skills](./skills.md)、在会话启动时自动加载指定 Skill，也可以声明 MCP servers 来提供真实工具能力。适合把工作流共享给团队、连接外部服务，或从官方 marketplace 安装扩展。

## 安装与管理

在 TUI 中运行 `/plugins` 打开 plugin 管理器。它是一个面板，有四个 tab：**Installed**（管理已装的）、**Official**（Kimi 官方 marketplace plugin）、**Third-party**（第三方 marketplace plugin）、**Custom**（从 URL 安装），用 `Tab` / `Shift-Tab` 切换。常用按键：

| 按键 | 操作 |
| --- | --- |
| `Tab` / `Shift-Tab` | 在 Installed / Official / Third-party / Custom 四个 tab 间切换 |
| `Space` | 启用或禁用选中的已安装 plugin（Installed tab） |
| `D` | 移除选中的已安装 plugin（Installed tab） |
| `M` | 管理选中 plugin 的 MCP servers（Installed tab） |
| `R` | 重新加载 `installed.json` 和所有 manifest（Installed tab） |
| `Enter` | Installed tab：有更新时安装更新，否则查看 plugin 详情 · Official/Third-party tab：安装或更新 · Custom tab：安装 |
| `I` | 查看 plugin 详情（Installed tab） |
| `Esc` | 返回或取消 |

也可以直接使用斜杠命令：

| 命令 | 说明 |
| --- | --- |
| `/plugins` | 打开交互式 plugin 管理器 |
| `/plugins list` | 列出已安装 plugins |
| `/plugins install <path-or-url>` | 从本地目录、zip URL 或 GitHub 仓库 URL 安装 |
| `/plugins marketplace [source]` | 浏览官方 marketplace，或传入自定义 marketplace JSON 的路径或 URL |
| `/plugins info <id>` | 查看 plugin 详情和 diagnostics |
| `/plugins enable <id>` | 启用 plugin |
| `/plugins disable <id>` | 禁用 plugin |
| `/plugins remove <id>` | 移除 plugin（需二次确认） |
| `/plugins reload` | 重载 `installed.json` 和各 plugin manifest |
| `/plugins mcp enable <id> <server>` | 启用 plugin 声明的 MCP server |
| `/plugins mcp disable <id> <server>` | 禁用 plugin 声明的 MCP server |

**Installed** tab 列出已安装的 plugin，并在 marketplace 有更新版本时显示更新徽章。**Official** 和 **Third-party** tab 按 tier 列出 marketplace plugin；**Custom** tab 从 URL 安装。marketplace 目录会在需要时自动加载。每个安装会显示信任徽章：`kimi-official`（来自官方地址）、`curated`（来自精选地址）、`third-party`（其他所有情况）。安装第三方 plugin（任何非官方地址的 plugin，包括 Custom 安装）会先显示一个默认「取消」的确认提示，只有在你选择信任该来源后才会继续安装。

### 从 GitHub 安装

通过 `/plugins install <url>` 可以直接从 GitHub 仓库安装，支持四种 URL 形式：

- `https://github.com/<owner>/<repo>`：安装最新 release；无 release 时回落到默认分支
- `https://github.com/<owner>/<repo>/tree/<ref>`：安装指定分支、tag 或短 commit SHA
- `https://github.com/<owner>/<repo>/releases/tag/<tag>`：钉死具体 tag
- `https://github.com/<owner>/<repo>/commit/<sha>`：钉死具体 commit

网络请求只走 `github.com` 重定向和 `codeload.github.com` 下载，不调用 `api.github.com`。

### 注意事项

- Plugin 变更需要通过 `/reload` 或新会话生效。安装、启用/禁用、移除后，运行 `/reload` 或 `/new`；当前会话不会更新。
- 本地安装会被拷贝到 `$KIMI_CODE_HOME/plugins/managed/<id>/`，CLI 始终从这份托管副本运行。安装后编辑原始源目录不会生效，需重新安装。
- 移除 plugin 只会删除安装记录，托管副本和原始源文件仍保留在磁盘上。
- Plugin 目前按用户安装，对所有项目生效，暂不支持项目级安装范围。

### 自定义 marketplace JSON

浏览自定义目录时，把 JSON 路径或 URL 传给 `/plugins marketplace <source>`；或通过 [`KIMI_CODE_PLUGIN_MARKETPLACE_URL`](../configuration/env-vars.md) 覆盖默认 marketplace。`plugins` 数组中每个条目需要 `id` 和 `source`（本地路径、zip URL 或 GitHub URL）：

```json
{
  "version": "2",
  "plugins": [
    {
      "id": "my-plugin",
      "displayName": "My Plugin",
      "source": "./my-plugin"
    }
  ]
}
```

## Kimi Datasource

Kimi Datasource 是 Kimi Code 官方数据插件，让你通过自然语言直接查询金融行情、宏观经济、企业工商、学术文献和中国法律法规，并接入 Wind、IMF、恒生聚源、SEC EDGAR、S&P Capital IQ 等专业金融数据源，无需手动调用接口或申请任何数据账号。

### 安装

需先通过 `/login` 完成 Kimi Code 账号 OAuth 登录，插件依赖本地凭据访问数据服务。

1. 运行 `/plugins`，选择 **Official**
2. 找到 **Kimi Datasource**，按 `Enter` 安装
3. 安装完成后运行 `/reload` 或 `/new` 激活 plugin

当前最新版本为 v3.3.0。插件安装后不会自动更新，如需升级到新版本，重新执行上述安装步骤即可。

### 使用方式

安装完成后，直接用自然语言描述你的需求，Kimi Code 会自动调用数据能力；也可以通过 `/skill:kimi-datasource` 明确触发数据查询 Skill。

### 能做什么

**实时量化研究**：盯着茅台想做个量化分析？一句话拉取近三年的每日收盘价、MACD 和 KDJ 信号，直接出结论，不用找第三方数据平台。

**跨国宏观对比**：研究中印越产业转移？基于世界银行 50 年历史数据，一次查询拿到三国 GDP 增速、贸易额、人口结构的完整时间序列对比。

**合同前风险排查**：签合同前五分钟才想起来要查对方背景？输入公司名，立刻拿到工商注册信息、股权穿透、司法纠纷和失信记录，当场决策。

**文献综述加速**：写论文要梳理 RLHF 领域的研究脉络？直接列出高引论文、主要作者和核心结论，综述提纲半小时内成型。

**法律条文速查**：碰上居住权的合同纠纷，拿不准法条？一句话定位《民法典》相关条文原文、效力级别和时效性，再顺手拉几个相近判例佐证，不用翻法规库。

**机构级美股研究**：写美股深度报告？一句话拉出 10-K 年报原文、XBRL 标准化指标、前 50 大股东和分析师一致预期，SEC 披露文件和 S&P 数据一次配齐，不用在多个数据终端之间来回切。

### 数据覆盖

| 类别 | 覆盖范围 |
|---|---|
| 股票行情 | A 股、港股、美股及全球主要市场实时/历史行情、技术指标、财务报表、股票筛选 |
| 宏观经济 | 世界银行 189 个成员国、50 年以上历史时间序列（GDP、贸易、人口、气候等） |
| 企业数据 | 中国大陆境内企业工商信息、股权穿透、司法风险、关联图谱 |
| 学术文献 | 物理、数学、计算机、金融、经济等领域百万量级论文，支持预印本查询 |
| 法律法规 | 中国法律法规与司法案例：宪法、法律、司法解释、部门规章等各效力层次的法规语义/关键词检索与详情，普通及权威判例检索 |
| 综合金融终端（Wind） | A 股、基金、债券、指数行情与财务指标，上市公司公告研报，宏观经济数据 |
| 国际宏观（IMF） | IFS、BOP、DOTS、WEO 等官方数据集：汇率、CPI、国际收支、贸易、GDP 预测 |
| 智能筛选（恒生聚源） | 自然语言选股 / 选基金 / 基金经理筛选，宏观行业数据、研报、公告与新闻 |
| 美股披露（SEC EDGAR） | 8,000+ 美股上市公司 10-K/10-Q 财报、XBRL 指标、Form 4 内部人交易、13F 机构持仓、8-K 重大事项（2009 年至今） |
| 美股基本面（S&P Capital IQ） | 标准化财务报表、估值比率、分析师一致预期、股东与高管、竞争对手关系、公司事件与电话会纪要 |

### 计费与限制

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
| `hooks` | 在 plugin 启用期间于生命周期事件上运行的 hook 规则；见[插件中的 Hooks](#插件中的-hooks) |
| `commands` | 一个或多个 `./` 路径，指向目录或 `.md` 文件，把其中的 Markdown 文件注册为斜杠命令；见[插件斜杠命令](#插件斜杠命令) |

`tools`、`apps`、`inject`、`configFile` 等不支持的运行时字段会显示为 diagnostics 并被忽略。

## 插件斜杠命令

斜杠命令把一段常用提示词存成 `/命令`，输入它就能触发，省得每次重打。

下面是一个最小完整例子，插件目录结构：

```text
kimi-finance/
  kimi.plugin.json
  commands/
    report.md
```

manifest（`kimi.plugin.json`）用 `commands` 字段指出命令文件的位置：

```json
{
  "name": "kimi-finance",
  "version": "1.0.0",
  "commands": "./commands/"
}
```

命令文件 `commands/report.md`。顶部两行 `---` 之间是 frontmatter（描述命令的元数据），下面的正文是触发时发给 Agent 的提示词：

```markdown
---
description: 拉取指定股票的财报并总结
---

拉取 $ARGUMENTS 的最新财报数据，总结营收、利润和关键风险。
```

装好并启用后，在对话里输入：

```text
/kimi-finance:report TSLA
```

Kimi 会把正文里的 `$ARGUMENTS` 替换成 `TSLA`，再执行这段提示词。三处细节分述如下。

### 声明命令（`commands` 字段）

`commands` 填一个 `./` 路径或路径数组，指向 plugin 根目录内的目录或 `.md` 文件：

- 指向**目录**：递归收集其中所有 `.md` 文件，每个各成为一个命令。
- 指向**单个 `.md` 文件**：只注册这一个。
- 指向非 `.md` 或不存在的路径：显示为 diagnostics（`/plugins` 面板里的诊断提示）并被忽略。

### 编写命令文件

命令文件分两部分：可选的 **frontmatter**（顶部两行 `---` 之间的元数据，可写 `name`、`description`）和**正文**（`---` 之后的提示词）。两个字段省略时的回退规则：

- `name`（命令名）：省略时用文件相对 `commands` 路径的路径命名（去 `.md`、`/` 分隔），如 `commands/frontend/component.md` → `frontend/component`；frontmatter 里显式写的优先。
- `description`（命令列表里的说明）：省略时取正文首行非空文字（超 240 字符截断）；正文也为空则显示 `No description provided.`。

### 调用命令与传参

命令自动以插件 id 作前缀（即命名空间），注册成 `<插件名>:<命令名>`，所以上面的命令实际叫 `/kimi-finance:report`，不同插件的同名命令因此不会冲突。

命令后输入的文字会替换正文里的 `$ARGUMENTS`（上例中 `TSLA` 替换掉 `$ARGUMENTS`）。若正文没写 `$ARGUMENTS` 却传了参数，参数不会丢弃，而是以 `ARGUMENTS: <你输入的内容>` 追加到正文末尾。

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

Plugin MCP servers 会在 `/reload` 后或新会话中启动。启用或禁用某个 server：

```sh
/plugins mcp disable kimi-finance finance
/reload

/plugins mcp enable kimi-finance finance
/reload
```

## 插件中的 Hooks

plugin 可以在其 manifest 中声明 hook 规则，在 plugin 启用期间于生命周期事件上运行。每一项使用与 [`config.toml` 中的 `[[hooks]]` 规则](./hooks.md#配置)相同的字段（`event`、`matcher`、`command`、`timeout`）：

```json
{
  "hooks": [
    {
      "event": "PreToolUse",
      "matcher": "Bash",
      "command": "node ./hooks/check-bash.mjs",
      "timeout": 5
    }
  ]
}
```

plugin hooks 复用与全局 hooks 相同的机制——事件列表、stdin JSON 载荷以及退出码和返回值如何影响主流程，详见 [Hooks](./hooks.md)。区别如下：

- plugin 的 hooks 仅在 plugin **启用**期间生效；禁用 plugin 后其 hooks 停止运行。
- 每条 hook 的工作目录为 plugin 根目录，因此 `command` 可以使用 plugin 内的 `./` 路径。
- hook 进程会额外收到两个环境变量：`KIMI_CODE_HOME` 和 `KIMI_PLUGIN_ROOT`（plugin 根目录）。

仅安装 plugin 本身不会运行其 hooks——它们只在 plugin 启用期间、匹配的事件触发时运行。

## 安全模型

Plugin 的加载范围有限，以下操作不会在安装或会话启动时发生：

- 不会执行命令型 plugin tools 或旧式工具运行时
- 所有路径在解析符号链接后仍必须位于 plugin 根目录内
- 已启用 plugin 的 MCP servers 会在 `/reload` 后或新会话中启动，且可随时从 `/plugins` 禁用
- 损坏的 manifest 或不安全路径会显示在 `/plugins info <id>` 的 diagnostics 中，不影响其他会话

