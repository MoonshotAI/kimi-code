# Model Context Protocol

[Model Context Protocol（MCP）](https://modelcontextprotocol.io/) 是一个开放协议，让模型可以安全地调用外部工具，例如读取 GitHub issues、查询数据库或操作本地文件。Kimi Code CLI 作为 MCP client 连接这些 server，把外部工具与内置工具一起交给 Agent 使用。

接入一个 MCP server 只需选择连接方式并写入 `mcp.json`，或在 TUI 中运行 `/mcp-config` 交互式添加。工具默认按需加载以节省上下文；会话启动最多等待首轮工具发现 2 秒，慢启动的 server 会在后台继续连接。

## 接入方式

按 server 的部署形态选择连接方式，新接入优先用 HTTP 或 stdio：

- **stdio**：CLI 以子进程启动 server，通过标准输入输出通信，适合本地命令行工具。默认在本机运行，设置 [`environment_id`](#在远程环境中运行-stdio-server) 可改到 [远程环境](../guides/remote-environment.md) 中启动。
- **HTTP**：CLI 连接已运行的 HTTP 端点，适合远程服务或常驻进程。
- **SSE**：连接旧式 HTTP+SSE 端点。仅当服务仍只提供 SSE 时，才显式设置 `transport: "sse"`。

## 配置

配置分用户级和项目级两层，同名 server 以项目级为准：

- **用户级**：`~/.kimi-code/mcp.json`，跨项目共享；设置 `KIMI_CODE_HOME` 时位于 `$KIMI_CODE_HOME/mcp.json`。
- **项目级**：仓库根目录下的 `.kimi-code/mcp.json`，只对当前仓库生效。在仓库子目录启动时同样读取根目录配置，每个 worktree 读取各自的文件。

在 TUI 中运行 `/mcp-config` 可交互式增删改 server，运行 `/mcp` 查看连接状态。配置变更的生效范围如下：

- **编辑 `mcp.json` 或安装新 plugin**：只对之后新建的会话生效。
- **删除 server**：不打断当前会话；工具在当前会话中保留但调用报错，`/mcp` 显示 `removed`，新会话不再注册。
- **在 `/plugins` 中管理**：禁用或移除后当前会话调用立即报错；新增或启用后立即连接到当前会话。

`mcp.json` 示例：

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    },
    "linear": {
      "url": "https://mcp.linear.app/mcp"
    },
    "legacy-events": {
      "transport": "sse",
      "url": "https://mcp.example.com/sse"
    }
  }
}
```

含 `command` 的为 stdio server；含 `url` 且未写 `transport` 的为 HTTP server；SSE server 需显式设置 `transport: "sse"`。

可选字段：

| 字段 | 类型 | 适用方式 | 说明 |
| --- | --- | --- | --- |
| `env` | `Record<string, string>` | stdio | 注入子进程的环境变量 |
| `environment_id` | `string` | stdio | 启动该 server 的 [远程环境](../guides/remote-environment.md) id，默认 `local` |
| `cwd` | `string` | stdio | 子进程工作目录 |
| `headers` | `Record<string, string>` | HTTP、SSE | 附加到每次请求的静态请求头 |
| `bearerTokenEnvVar` | `string` | HTTP、SSE | 存放 bearer token 的环境变量名 |
| `enabled` | `boolean` | 全部 | 设为 `false` 禁用该 server |
| `deferred` | `boolean` | 全部 | 设为 `false` 让工具直接进入顶层列表；缺省取全局 `default_deferred`，默认按需加载，见 [按需加载工具](#按需加载工具) |
| `startupTimeoutMs` | `number` | 全部 | 连接超时，范围 `1` 到 `2147483647` 毫秒，默认 `30000` |
| `toolTimeoutMs` | `number` | 全部 | 单次工具调用超时，范围 `1` 到 `2147483647` 毫秒 |
| `enabledTools` | `string[]` | 全部 | 工具白名单 |
| `disabledTools` | `string[]` | 全部 | 工具黑名单 |

Plugins 也可以在 manifest 中声明 MCP servers，默认启用，详见 [Plugins](./plugins.md#plugin-中的-mcp-servers)。

::: warning 注意
项目级 `.kimi-code/mcp.json` 中的 stdio 条目会在会话启动时执行命令，只在你信任的仓库里启用。
:::

### 认证与 OAuth 授权

静态凭证用 `headers` 或 `bearerTokenEnvVar` 传入；需要 OAuth 时，运行 `/mcp-config login <server-name>` 完成浏览器授权。

Agent 调用 MCP 授权工具并获准执行后，仍需在服务商网页确认授权：桌面端会打开系统浏览器，网页端点击聊天卡片上的「打开授权页」。浏览器未打开或被误关时，再次点击该按钮即可继续，无需重发消息。

## 工作区信任

项目级 `mcp.json` 可以执行本地命令，因此只在受信任的工作区启用：

- **交互式会话**：发现未信任项目的 MCP server 时，终端会列出传输方式和启动目标。核对命令、参数或远程 URL 后选择 `Trust and continue` 启用；选择 `Exit` 则退出且不启用。
- **无头运行**：CI 中的 `kimi -p` 等场景无法弹窗确认，未信任工作区的项目级 server 默认禁用。可将 [`KIMI_CODE_TRUST_WORKSPACE`](../configuration/env-vars.md#运行时开关) 设为 `1` 信任当前进程，或在 `config.toml` 中设置 [`[workspace] require_trust = false`](../configuration/config-files.md#workspace-trust) 全局关闭检查；后者仅在所有工作区均可信时使用。

## 连接、超时与重连

慢启动和临时断连不会阻塞对话：首轮工具发现有等待上限，断连后自动重试。运行参数可在 `config.toml` 或环境变量中统一调整：

| 行为 | `[mcp]` 字段 / 环境变量 | 默认值 |
| --- | --- | --- |
| 首轮发现等待上限 | `startup_wait_ms` / `KIMI_MCP_STARTUP_WAIT_MS` | `2000` 毫秒，`0` 表示不等待 |
| 连接超时 | `startup_timeout_ms` / `KIMI_MCP_STARTUP_TIMEOUT_MS` | `30000` 毫秒 |
| 单次调用超时 | `tool_timeout_ms` / `KIMI_MCP_TOOL_TIMEOUT_MS` | 按 server 的 `toolTimeoutMs` 设置 |
| 重连首次等待 | `reconnect_initial_delay_ms` / `KIMI_MCP_RECONNECT_INITIAL_DELAY_MS` | `5000` 毫秒 |
| 重连等待上限 | `reconnect_max_delay_ms` / `KIMI_MCP_RECONNECT_MAX_DELAY_MS` | `300000` 毫秒 |

超时优先级为 server 字段 > 环境变量 > `config.toml` > 内置默认，详见 [配置文件](../configuration/config-files.md#mcp)。

**启动等待**：到达等待上限后，会话先带着已就绪的工具开始对话；未连上的 server 继续在后台启动，直到各自的 `startupTimeoutMs` 才判定超时，工具就绪后在后续模型步骤中可用。

**自动重连**：HTTP/SSE 启动失败或连接意外中断时按指数退避重连，每次尝试后等待时间翻倍，直到达到上限。stdio 首次启动失败保持 `failed`，因为每次重试都会拉起新子进程，需排除故障后在 `/mcp` 手动重连。命令不存在、配置非法、静态凭据被拒等永久性失败不会自动重试。

## 在远程环境中运行 stdio server

stdio server 默认在本机运行，即使会话绑定了远程环境也是如此。在 server 条目上设置 `environment_id`，可让该 server 在指定的 [远程环境](../guides/remote-environment.md) 中启动，进程、工作目录和文件访问都发生在目标机器上。

先在 `config.toml` 中声明环境：

```toml
[environments.dev-box]
type = "ssh"
host = "dev-box"
defaultCwd = "/srv/work"
```

再在 `mcp.json` 中引用该环境 id：

```json
{
  "mcpServers": {
    "remote-fs": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/srv/data"],
      "environment_id": "dev-box"
    }
  }
}
```

`environment_id` 默认 `local`，不跟随会话自身的环境绑定，未设置该字段的 server 仍在本机运行。环境尚未连接时，会在 server 启动时按需建立连接。环境声明方式见 [声明 Docker 与自定义命令环境](../guides/remote-environment.md#声明-docker-与自定义命令环境)。

### 远程 stdio server 的环境变量

远程 server 的 `PATH`、`HOME` 等基础变量来自目标环境，本机路径不会泄漏到远程进程。CLI 只把 `env` 中的键值按字面量发送，其余变量由目标环境解析：

```json
{
  "mcpServers": {
    "remote-db": {
      "command": "db-mcp-server",
      "environment_id": "dev-box",
      "env": { "LOG_LEVEL": "debug" }
    }
  }
}
```

## 按需加载工具

为节省上下文，所有 MCP server 的工具默认按需加载：模型先看到工具名称，需要时通过内置的 `select_tools` 加载完整定义。

- **生效条件**：当前模型需声明 `dynamically_loaded_tools` 能力。官方模型自动声明；其他模型需在 `config.toml` 的 `capabilities` 中追加，见 [配置文件](../configuration/config-files.md#models)。不支持动态加载的模型直接接收全部已连接工具。
- **工具披露**：初始未加载的工具以提醒形式披露名称；会话启动后才连上的 server 以及后续增删的工具通过增量公告下发。同名重复声明优先保留顶层列表。

### 调整加载方式

需要工具常驻顶层列表时，可按 server 或全局关闭按需加载：

- **单个 server**：在 `mcp.json` 中设 `"deferred": false`。
- **全局默认**：在 `config.toml` 的 `[mcp]` 下设 `default_deferred = false`，见 [配置文件](../configuration/config-files.md#mcp)。

server 字段始终优先于全局默认，OAuth 完成前暴露的认证工具也遵循该字段。配置在 server 连接时固化，修改后需重连该 server 或重启进程才会生效。

```json
{
  "mcpServers": {
    "github": {
      "url": "https://mcp.example.com/mcp",
      "deferred": false
    }
  }
}
```

### 工具 schema 更新

同名按需加载工具的定义更新时，会话会公告移除旧版本并加入新版本。模型必须重新调用 `select_tools` 加载当前定义后才能调用该工具，否则调用会被拒绝并提示重新选择；供应商按“旧声明 → 卸载 → 新声明”的顺序发送请求，避免重复声明报错。常驻顶层的同名工具在当前会话中固定使用原定义，不触发重新加载。

## 工具命名与权限

MCP 工具按 `mcp__<server>__<tool>` 命名，例如 `mcp__github__create_issue`。权限规则按工具名匹配，支持 `*` 和 `**` 通配，例如 `mcp__github__*` 命中该 server 下所有工具；工具参数不参与匹配。

未命中权限规则的调用会弹出审批请求；选择 "Approve for this session" 后，本次会话内的后续同类调用自动放行。也可以在 `config.toml` 的 `[[permission.rules]]` 中预置永久规则：

```toml
[[permission.rules]]
decision = "allow"
pattern = "mcp__github__*"

[[permission.rules]]
decision = "deny"
pattern = "mcp__filesystem__write_file"
```

完整语法见 [配置文件](../configuration/config-files.md#permission)。

## 工具结果与附件

MCP 工具返回的内容按三类规则处理：**文本与结构化数据**直接交给模型，**媒体与文件附件**保存原件供随时读取，**超长输出与异常**通过转存文件和明确报错保证结果不丢失。

### 文本与结构化数据

- **完整交付**：工具结果中的文本 `content` 和结构化数据 `structuredContent` 都会交给 Agent。
- **自动去重**：只有当某个文本块已包含同一份完整 JSON 值时，才省略重复的结构化副本；文本摘要和媒体不会替代结构化记录。

### 媒体与文件附件

- **原件保存**：因格式或大小限制无法直接交付的附件会保存到会话媒体存储。图片、音频和视频即使能原样交付也会保留原件，避免后续供应商协议转换或历史精简将其省略，且不受图片缓存淘汰影响。
- **读取方式**：原件提供绝对路径和稳定的 `kimi-file://` 引用，Agent 把引用作为 `path` 传给 `Read` 或 `ReadMediaFile` 即可读取，不依赖工作区文件系统，分页续读和 fork 后的会话同样有效。
- **格式处理**：CSV、HTML、JSON 和普通 SVG 使用可读取的扩展名；`Read` 无法打开的二进制格式会在报错中给出本地路径，供能访问该文件系统的外部转换工具使用。
- **图片复用**：供应商支持图片上传和文件引用时，新返回的 MCP 图片在首次上传后可供后续模型请求复用。

### 超长输出与异常

- **超长清单转存**：附件路径和压缩说明计入工具输出预算。超长清单会保存为文本文件，即使正文被截短，结果中仍保留清单的 `kimi-file://` 指针供 `Read` 分页读取。
- **取消与失败**：取消工具调用会停止后续附件处理并中断正在进行的写入；解码或保存失败时会明确说明原件未能保留，同时保留其余可用输出。
- **资源链接**：返回的远程资源链接不会被自动下载。

## 安全性

- 只接入可信来源的 server。
- 在审批请求中核查工具名与参数是否合理。
- 对写文件、执行命令等高风险工具维持手动审批，避免用 `mcp__*` 通配放行全部工具。

::: warning 注意
在 [YOLO 模式](../guides/interaction.md#三种权限模式)下，MCP 工具调用会被自动批准。仅在完全信任所接入的 MCP server 时使用此模式。
:::

## 下一步

- [Plugins](./plugins.md) — 在 plugin manifest 中声明 MCP server，一键打包和分发
- [配置文件](../configuration/config-files.md#permission) — 权限规则的完整字段参考
