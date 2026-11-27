# Model Context Protocol

[Model Context Protocol（MCP）](https://modelcontextprotocol.io/) 是一个开放协议，让模型可以安全地调用外部进程或服务暴露的工具：读取 GitHub issues、查询数据库、操作本地文件系统。Kimi Code CLI 作为 MCP client 接入这些外部工具，把它们与内置工具一起暴露给 Agent 使用，行为上没有差异。

MCP 工具结果可以包含文本（`content`）和结构化数据（`structuredContent`）。Kimi Code CLI 会将两者提供给 Agent，只有能够确认某个文本块已包含同一份完整 JSON 值时，才省略重复的结构化内容。文本摘要和媒体不会替代结构化记录。

Kimi Code CLI 会保留因格式或大小限制而无法直接交付的内嵌 MCP 附件。内嵌图片、音频和视频即使能够原样交付也会保存，因为后续供应商协议转换或历史精简可能省略它们。模型支持相应内容时，即使工作区文件系统不可用，也仍可读取会话附件。原件随会话保存在媒体存储中，不会被图片缓存淘汰。保存的原件（包括图片压缩前的原图）均提供绝对路径和稳定的 `kimi-file://` 引用。将引用作为 `path` 传给 `Read` 或 `ReadMediaFile`，即使工作区环境无法访问会话存储，也能直接从当前会话存储读取字节。分页续读会保留该引用，包括 fork 后的会话。对于 `Read` 无法打开的二进制格式，错误信息会在可用时提供服务端本地路径；外部转换工具必须能够访问该文件系统。CSV、HTML、JSON 和普通 SVG 等文本附件使用可读取的扩展名。

供应商支持图片上传和文件引用时，MCP 工具新返回的图片首次上传后，后续模型请求可以复用这张图。

附件路径和压缩说明共用工具输出预算。较长的清单会保存为文本文件，结果中保留简短指针，即使伴随的文本被截短，该指针仍然可见；Agent 可将清单的 `kimi-file://` 引用传给 `Read`，分页读取完整内容。取消工具调用会停止后续附件处理，并通知正在进行的写入操作。如果解码或保存失败，结果会明确说明原件未能保留，并保留其他可用输出。资源链接不会被自动下载。

## 接入方式

Kimi Code CLI 支持三种 MCP server 接入方式：

- **stdio**：CLI 以子进程方式启动 MCP server，通过标准输入输出通信。适合命令行工具。默认 server 在运行 Kimi Code 的机器上执行；设置 [`environment_id`](#在远程环境中运行-stdio-server) 则改为在 [远程环境](../guides/remote-environment.md) 中启动。
- **HTTP**：CLI 连接一个已在运行的 HTTP 端点。适合远程服务或需要持久运行的进程。
- **SSE**：CLI 连接旧式 HTTP+SSE 端点。新 MCP server 优先使用 HTTP；只有服务仍仅暴露旧式 SSE 传输时，才设置 `transport: "sse"`。

## 配置

MCP server 配置写在 `mcp.json` 中，分两层：

- **用户级**：`~/.kimi-code/mcp.json`（或 `$KIMI_CODE_HOME/mcp.json`），跨项目共享
- **项目级**：项目根目录下的 `.kimi-code/mcp.json`，只对当前仓库生效。在 Git 仓库的子目录里启动时，读的也是仓库根目录下的这个文件，每个 worktree 读它自己的

同名条目以项目级为准，覆盖用户级。

在 TUI 中运行 `/mcp-config` 可以交互式地新增、编辑或删除 server，无需手动编辑 JSON 文件。运行 `/mcp` 可查看当前所有 server 的连接状态。

从配置中删除某个 server 不会打断进行中的会话：该 server 在 `/mcp` 中仍显示为 `removed`，其工具在这些会话中保持可见，但调用会失败并返回移除提示；新会话则完全不会注册这些工具。反过来，编辑 `mcp.json` 或安装 plugin 新增的 server 也不会注册到已打开的会话，只会加入之后创建的会话。

当 Kimi Code 在不受信任的项目中发现项目级 MCP server 时，信任提示会显示每个 server 的传输方式和启动目标。核对列出的命令与参数或远程 URL 后选择 `Trust and continue` 即可启用；选择 `Exit` 则直接退出，不会启用这些 server。

无头运行（例如在 CI 中执行 `kimi -p`）无法显示信任提示，因此在工作区尚未受信任时，项目级 MCP server 会保持禁用。将 [`KIMI_CODE_TRUST_WORKSPACE`](../configuration/env-vars.md#运行时开关) 设为 `1` 即可在该进程中信任当前工作区。如需全局关闭工作区信任机制并不经确认加载项目级 MCP server，可在 `config.toml` 中设置 [`[workspace] require_trust = false`](../configuration/config-files.md#workspace-trust)；仅应在所有工作区均已可信时使用该配置。

`mcp.json` 的结构：

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

含 `command` 字段的条目为 stdio server；含 `url` 字段且未写 `transport` 的条目为 HTTP server。旧式 SSE server 需要显式把 `transport` 设为 `"sse"`。

可选字段：

| 字段 | 类型 | 适用方式 | 说明 |
| --- | --- | --- | --- |
| `env` | `Record<string, string>` | stdio | 注入子进程的环境变量 |
| `environment_id` | `string` | stdio | 启动该 server 的 [远程环境](../guides/remote-environment.md) id，默认 `local` |
| `cwd` | `string` | stdio | 子进程工作目录 |
| `headers` | `Record<string, string>` | HTTP、SSE | 附加到每次请求的静态请求头 |
| `bearerTokenEnvVar` | `string` | HTTP、SSE | 存放 bearer token 的环境变量名 |
| `enabled` | `boolean` | 全部 | 设为 `false` 可禁用该 server |
| `deferred` | `boolean` | 全部 | 设为 `false` 时该 server 的工具直接进入模型的顶层工具列表；缺省时取全局 `default_deferred`（未设置则为 `true`，即按需加载）。前提与行为见 [按需加载工具](#按需加载工具) |
| `startupTimeoutMs` | `number` | 全部 | 连接超时，取值范围为 `1` 到 `2147483647` 毫秒，默认 `30000` |
| `toolTimeoutMs` | `number` | 全部 | 单次工具调用超时，取值范围为 `1` 到 `2147483647` 毫秒 |
| `enabledTools` | `string[]` | 全部 | 工具白名单 |
| `disabledTools` | `string[]` | 全部 | 工具黑名单 |

连接超时和单次工具调用超时的默认值都不必逐个 server 设置：`config.toml` 的 `[mcp] startup_timeout_ms` / `[mcp] tool_timeout_ms` 或环境变量 `KIMI_MCP_STARTUP_TIMEOUT_MS` / `KIMI_MCP_TOOL_TIMEOUT_MS` 可以调整全局默认值，优先级为 server 字段 > 环境变量 > `config.toml` > 内置默认。详见 [配置文件](../configuration/config-files.md#mcp)。

会话初始化时最多等待 `[mcp] startup_wait_ms`（默认 `2000` 毫秒，可在 `config.toml` 中配置或用环境变量 `KIMI_MCP_STARTUP_WAIT_MS` 覆盖，`0` 表示不等待）首轮 MCP 工具发现，到点即带着已就绪的工具开始对话。仍在启动中的 server 会在后台继续连接，直到各自的 `startupTimeoutMs`（默认 30 秒）才判定超时，不会在 2 秒时被提前终止；因此启动超过 2 秒的 stdio server 仍能正常连上，其工具会在后续模型步骤中可用。

HTTP/SSE server 启动时连不上，以及任意 server 在已建立连接后意外断连时，会自动按指数退避（每次尝试后等待时间翻倍）重连：首次重试等待 `[mcp] reconnect_initial_delay_ms`（默认 `5000`），等待上限为 `[mcp] reconnect_max_delay_ms`（默认 `300000`），可在 `config.toml` 或环境变量 `KIMI_MCP_RECONNECT_INITIAL_DELAY_MS` / `KIMI_MCP_RECONNECT_MAX_DELAY_MS` 调整。stdio server 首次启动失败（含启动超时）会保持 `failed`，不做后台自动重试，因为每次尝试都会重新拉起一个全新的子进程；排除故障后可在 `/mcp` 中手动重连。命令不存在、配置非法、静态凭据被拒绝等永久性失败同样不会自动重试。

HTTP 与 SSE server 支持通过 `headers` 或 `bearerTokenEnvVar` 提供静态凭证。需要 OAuth 时，运行 `/mcp-config login <server-name>` 完成浏览器授权。

在本机聊天中，如果 Agent 调用 MCP 授权工具，允许执行工具后，还需要在服务商的网页上确认授权。桌面端会尝试打开系统浏览器；网页端可点击聊天卡片上的「打开授权页」。如果浏览器没有打开或被误关，点击同一按钮即可继续，不用重新发送消息。

Plugins 也可以在 manifest 中声明 MCP servers。Plugin 声明的 servers 默认启用，可以在 `/plugins` 中禁用或重新启用：禁用或移除后，已打开会话中的工具调用会失败并返回移除提示；新增或启用 server 会立即连接到已打开的会话。详见 [Plugins](./plugins.md#plugin-中的-mcp-servers)。

::: warning 注意
项目级 `.kimi-code/mcp.json` 中的 stdio 条目会在会话启动时执行命令，只在你信任的仓库里启用。
:::

## 在远程环境中运行 stdio server

stdio server 通常在运行 Kimi Code 的机器上执行，即使会话绑定了远程环境也是如此。在 server 条目上设置 `environment_id` 可以改变这一点：CLI 会在指定的 [远程环境](../guides/remote-environment.md) 中启动该 server，其进程、工作目录以及它访问的一切都位于目标环境上。

```toml
# config.toml
[environments.dev-box]
type = "ssh"
host = "dev-box"
defaultCwd = "/srv/work"
```

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

`environment_id` 引用在 `config.toml` 的 `[environments]` 中声明的环境（见 [声明 Docker 与自定义命令环境](../guides/remote-environment.md#声明-docker-与自定义命令环境)）。该字段默认为 `local`，且不跟随会话自身的环境绑定：绑定到 `dev-box` 的会话仍会在本地运行未设置 `environment_id` 的 stdio server。环境尚未连接时，会在 server 启动时按需建立连接。

### 远程 stdio server 的环境变量

远程 stdio server 的 `PATH`、`HOME` 等基础环境变量来自目标环境，而不是你的机器，本机路径不会泄漏到远程进程中。CLI 只把 `env` 覆盖层按字面量值发送，其余变量都由目标环境解析。

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

在这个例子中，server 会收到来自 `env` 的 `LOG_LEVEL=debug`，其余变量都由目标环境自身解析。

## 按需加载工具

默认情况下，所有 MCP server 的工具都按 deferred（按需加载）处理：在支持动态加载的模型上，工具名称先通过公告披露，模型按需加载后才进入顶层工具列表，避免大量工具定义持续占用上下文。支持动态加载时，ToolSelect Resolver 会从解析后的顶层工具列表中移除 deferred 项，将 baseline 中的 deferred 名称转换为初始 reminder，后续新增和移除（包括会话启动后才连接完成的 server 所发现的工具）通过 delta 公告。内置的 `select_tools` 再把选中的 schema 加载到 system message。不支持动态加载的模型不区分 deferred 与 inline，会将 MCP 工具按普通顶层声明发送。会话启动后才连接完成的 server，其工具会在后续请求中一并带上。会话启动时已连接的 server 之后新增的工具（例如收到 `tools/list_changed` 通知后）只通过提醒告知模型，不加入顶层工具列表，以免已有的提示词缓存失效；要直接调用这些工具，请新开会话。最终编码器自身不会仅凭这个标记删除工具；重复声明优先保留顶层列表。

如果同名 deferred 工具的 schema 发生更新，会话会在同一条公告中声明移除旧版本并加入新版本。模型必须再次调用 `select_tools` 加载当前 schema，然后才能调用该工具；重新加载前的调用会被拒绝，并提示重新选择。对于 Kimi Chat Completions，供应商会按旧声明、卸载消息、新声明的顺序发送请求，避免后端因无法解析的同名重复声明而拒绝请求。同名 inline 工具的更新仍在当前会话中固定使用原 schema，不进入上述重新加载流程。

按需加载在当前模型声明 `dynamically_loaded_tools` 能力时生效：官方模型自动声明；其他模型可在 `config.toml` 的 `capabilities` 中追加，见 [配置文件](../configuration/config-files.md#models)。

如果希望某个 server 的工具直接放进顶层工具列表（含会话启动时发现的工具），在 `mcp.json` 的 server 条目里设 `deferred: false`：

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

未设置 `deferred` 的 server 取全局默认值（未改动时为 `true`）。需要 OAuth 授权的 server 在完成授权前暴露的认证工具也遵循这个字段。

如果希望全局关闭按需加载、恢复所有 server 的工具直接进入顶层列表，可以在 `config.toml` 的 `[mcp]` 下设 `default_deferred = false`，见 [配置文件](../configuration/config-files.md#mcp)。server 字段始终优先于全局默认。该值在 server 连接时固化，之后修改不会改动运行中会话的工具形态——重连该 server 或重启进程后才会应用。

## 工具命名与权限

MCP 工具按 `mcp__<server>__<tool>` 格式命名，例如 `mcp__github__create_issue`。权限规则中支持 `*` 和 `**` 通配，例如 `mcp__github__*` 命中该 server 下所有工具。MCP 工具参数不参与权限匹配。

未命中权限规则的调用会触发审批请求；在审批弹窗中选择 "Approve for this session" 后，本次会话内的后续同类调用自动放行。

也可以在 `config.toml` 的 `[[permission.rules]]` 中预置永久规则：

```toml
[[permission.rules]]
decision = "allow"
pattern = "mcp__github__*"

[[permission.rules]]
decision = "deny"
pattern = "mcp__filesystem__write_file"
```

权限规则的完整语法见 [配置文件](../configuration/config-files.md#permission)。

## 安全性

接入外部 MCP server 时需注意：

- 只接入可信来源的 server
- 在审批请求中核查工具名与参数是否合理
- 对高风险工具（写文件、执行命令等）维持手动审批，避免用 `mcp__*` 通配放行全部工具

::: warning 注意
在 [YOLO 模式](../guides/interaction.md#三种权限模式)下，MCP 工具调用会被自动批准。仅在完全信任所接入的 MCP server 时使用此模式。
:::

## 下一步

- [Plugins](./plugins.md) — 在 plugin manifest 中声明 MCP server，一键打包和分发
- [配置文件](../configuration/config-files.md#permission) — 权限规则的完整字段参考
