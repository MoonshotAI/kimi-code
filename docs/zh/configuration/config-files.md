# 配置文件

Kimi Code CLI 把全局配置保存在一份 TOML 文件中，包含 API 供应商、模型别名、Agent 循环参数、后台任务、外部服务等。这份文档介绍配置文件的位置、顶层字段、各嵌套结构，以及一份完整示例。

## 配置文件位置

默认配置文件位于 `~/.kimi-code/config.toml`。目录和文件会在首次运行时自动创建，并设置严格的访问权限。

如果你希望把数据目录放到别处，可以通过环境变量 `KIMI_CODE_HOME` 覆盖默认路径：

```sh
export KIMI_CODE_HOME=/path/to/kimi-home
```

此时配置文件路径变为 `$KIMI_CODE_HOME/config.toml`。无论目录在哪里，文件名固定为 `config.toml`。

::: tip 提示
TOML 中的字段名一律使用 snake_case（例如 `default_model`、`max_context_size`）。如果 key 中包含 `.`，需要使用带引号的 TOML key，否则 TOML 会把 `.` 当作嵌套表分隔符。
:::

## 顶层字段

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `default_model` | `string` | — | 默认使用的模型别名，必须在 `models` 中定义 |
| `default_thinking` | `boolean` | `false` | 新会话启动时 Thinking 开关的初始值，可在会话内通过模型菜单切换。即使该字段为 `true`，`[thinking].mode = "off"` 也会强制禁用 Thinking。详见下文 [`thinking`](#thinking) |
| `default_permission_mode` | `string` | `manual` | 新会话的默认权限模式，可选 `manual`、`auto`、`yolo` |
| `default_plan_mode` | `boolean` | `false` | 新会话是否默认以 Plan 模式启动；省略等同 `false` |
| `merge_all_available_skills` | `boolean` | `true` | 是否合并所有可用目录中的 Agent Skills |
| `extra_skill_dirs` | `array<string>` | — | 额外的 Skill 搜索目录，会叠加到默认目录之上 |
| `telemetry` | `boolean` | `true` | 是否启用匿名遥测；仅在显式设为 `false` 时关闭 |
| `providers` | `table` | `{}` | API 供应商表，详见下文 |
| `models` | `table` | — | 模型别名表，详见下文 |
| `thinking` | `table` | — | Thinking 模式默认参数 |
| `loop_control` | `table` | — | Agent 循环控制参数 |
| `background` | `table` | — | 后台任务运行参数 |
| `services` | `table` | — | 内置外部服务配置 |
| `permission` | `table` | — | 权限规则配置，详见下文 |
| `hooks` | `array<table>` | — | 生命周期 hook 配置，详见 [Hooks](../customization/hooks.md) |

## 完整示例

```toml
default_model = "kimi-code/kimi-for-coding"
default_thinking = true
default_permission_mode = "manual"
default_plan_mode = false
merge_all_available_skills = true
telemetry = true

[providers."managed:kimi-code"]
type = "kimi"
base_url = "https://api.kimi.com/coding/v1"
api_key = ""

[models."kimi-code/kimi-for-coding"]
provider = "managed:kimi-code"
model = "kimi-for-coding"
max_context_size = 262144

[thinking]
mode = "auto"

[loop_control]
max_retries_per_step = 3
reserved_context_size = 50000

[background]
max_running_tasks = 4
keep_alive_on_exit = false
agent_task_timeout_s = 900

[[permission.rules]]
decision = "allow"
pattern = "Read"

[[permission.rules]]
decision = "deny"
pattern = "Bash(rm -rf*)"

[[hooks]]
event = "PreToolUse"
matcher = "Bash"
command = "node ~/.kimi-code/hooks/check-bash.mjs"
timeout = 5
```

## `providers`

`providers` 表中的每一项定义一个 API 供应商连接信息，以唯一的名称作为 key。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `type` | `string` | 是 | 供应商类型，可选 `anthropic`、`openai`、`kimi`、`google-genai`、`openai_responses`、`vertexai` |
| `api_key` | `string` | 否 | API 密钥 |
| `base_url` | `string` | 否 | API 基础 URL |
| `oauth` | `table` | 否 | OAuth 凭据引用，详见下文 |
| `env` | `table<string, string>` | 否 | 按供应商约定的键读取的配置子表，作为 `api_key` / `base_url` 等字段的备用来源（如 `KIMI_API_KEY`、`ANTHROPIC_API_KEY`、`GOOGLE_CLOUD_PROJECT` 等）。这只是写在配置文件里的子表，**不会真正写入到终端的环境变量**；仅在 `[providers.<name>]` 上直接字段缺省时被 CLI 读取 |
| `custom_headers` | `table<string, string>` | 否 | 请求时附加的自定义 HTTP 头 |

OAuth 凭据引用结构：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `storage` | `string` | 是 | 凭据存储位置；目前只支持 `"file"` |
| `key` | `string` | 是 | 凭据条目的唯一标识 |

```toml
[providers.openai]
type = "openai"
base_url = "https://api.openai.com/v1"
api_key = "sk-xxx"
custom_headers = { "X-Custom-Header" = "value" }
```

## `models`

`models` 表中的每一项定义一个模型别名，以唯一的名称作为 key。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `provider` | `string` | 是 | 使用的供应商名称，必须在 `providers` 中定义 |
| `model` | `string` | 是 | 调用 API 时使用的模型标识符 |
| `max_context_size` | `integer` | 是 | 最大上下文长度（token 数），必须大于等于 1 |
| `max_output_size` | `integer` | 否 | 单次请求的输出预算上限（即请求层面的 `max_tokens`）。目前仅 `anthropic` 供应商会读取该字段。当别名能识别到具体的 Claude 家族时，覆盖值不会超过模型允许的上限，避免超出服务端限制。省略时使用模型推导出的默认值，详见 [`providers.md`](./providers.md#anthropic)。 |
| `capabilities` | `array<string>` | 否 | 显式追加的模型能力标签，例如 `thinking`、`image_in`、`video_in`、`audio_in`、`tool_use` |
| `display_name` | `string` | 否 | 在 UI 中显示的名称，未设置时回退到 `model` |
| `reasoning_key` | `string` | 否 | 仅 `openai` 供应商。覆盖推理内容所用的字段名。默认情况下供应商会自动识别响应中的 `reasoning_content`、`reasoning_details`、`reasoning`，并以 `reasoning_content` 回传思考内容 —— 只有当网关使用非标准字段名时才需要设置 |

`capabilities` 与供应商 capability registry 按模型名前缀自动匹配出来的能力做并集 —— 只能追加、不能移除。通常无需手写；只有当模型未被 registry 覆盖、或希望强制启用某项能力时才用得到。

如果模型别名包含 `.`，需要使用带引号的 key：

```toml
[models."gpt-4.1"]
provider = "openai"
model = "gpt-4.1"
max_context_size = 1047576
```

## `thinking`

`thinking` 控制 Thinking 模式的默认行为。即便顶层 `default_thinking = true`，将 `mode` 设为 `"off"` 也会强制禁用 Thinking。

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `mode` | `string` | — | 触发策略，可选 `auto`、`on`、`off`。设为 `"off"` 时强制禁用 Thinking；其它取值或省略时不禁用，由会话内的 Thinking 开关与 `effort` 共同决定 |
| `effort` | `string` | `high` | 启用 Thinking 时使用的默认强度，可选 `low`、`medium`、`high`、`xhigh`、`max`，实际可用等级由供应商决定 |

## `loop_control`

`loop_control` 控制 Agent 执行循环的步数、重试和上下文压缩阈值。

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `max_steps_per_turn` | `integer` | — | 单轮最大步数；不设置或设为 `0` 则无上限。设为 `0` 可用于显式覆盖此前已配置的限制。 |
| `max_retries_per_step` | `integer` | `3` | 单步最大重试次数 |
| `reserved_context_size` | `integer` | — | 预留给响应生成的 token 数；上下文逼近该阈值时触发压缩 |

## `background`

`background` 控制后台任务的运行限制。后台任务通过 `Bash` 工具或 `Agent` 工具的 `run_in_background=true` 参数启动。

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `max_running_tasks` | `integer` | — | 同时运行的最大后台任务数 |
| `keep_alive_on_exit` | `boolean` | `true` | 会话关闭时是否保留仍在运行的后台任务。设为 `false` 后，`kimi -p` 完成退出、SDK 关闭 session 或 harness 关闭时会请求停止后台任务 |
| `agent_task_timeout_s` | `integer` | — | 后台 Agent 任务的最大运行时间（秒） |

`keep_alive_on_exit` 可以被环境变量 `KIMI_CODE_BACKGROUND_KEEP_ALIVE_ON_EXIT` 覆盖；环境变量优先级高于 `config.toml`。schema 还预留了 `kill_grace_period_ms`、`print_wait_ceiling_s` 两个字段，目前仅 schema 校验通过，CLI 运行时不会读取。

## `services`

`services` 配置 Kimi Code CLI 调用的内置外部服务。当前仅识别 `moonshot_search`（网页搜索）和 `moonshot_fetch`（网页抓取）两个固定 key，其他 key 会被忽略。两项的字段相同：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `base_url` | `string` | 否 | 服务 API URL |
| `api_key` | `string` | 否 | API 密钥 |
| `oauth` | `table` | 否 | OAuth 凭据引用，结构同 `providers.*.oauth` |
| `custom_headers` | `table<string, string>` | 否 | 请求时附加的自定义 HTTP 头 |

```toml
[services.moonshot_search]
base_url = "https://api.moonshot.cn/v1/search"
api_key = "sk-xxx"

[services.moonshot_fetch]
base_url = "https://api.moonshot.cn/v1/fetch"
api_key = "sk-xxx"
```

## `permission`

`permission` 配置会话启动时加载的初始权限规则，控制工具调用的默认审批行为。新会话的默认权限模式由顶层 `default_permission_mode` 控制；启动时显式传入的权限模式（例如 CLI 的 `--yolo`）会覆盖这个默认值。

规则通过 `[[permission.rules]]` 数组表写出，每条规则包含以下字段：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `decision` | `string` | 是 | 决策结果，可选 `allow`、`deny`、`ask` |
| `scope` | `string` | 否 | 规则作用域，可选 `turn-override`、`session-runtime`、`project`、`user`；默认 `user` |
| `pattern` | `string` | 是 | 匹配模式，格式为 `ToolName` 或 `ToolName(arg-pattern)`。`ToolName` 必须与运行时真实工具名一致——内置工具是 `Read`、`Write`、`Edit`、`Bash`、`Grep` 等（详见 [内置工具](../reference/tools.md)）。参数模式只由带内置参数 matcher 的工具解释，例如 `Bash`、文件工具和搜索工具；MCP 工具和自定义工具只按工具名匹配 |
| `reason` | `string` | 否 | 规则说明，供调试或审计使用 |

示例：

```toml
[[permission.rules]]
decision = "allow"
pattern = "Read"

[[permission.rules]]
decision = "allow"
pattern = "Grep"

[[permission.rules]]
decision = "deny"
pattern = "Bash(rm -rf*)"

[[permission.rules]]
decision = "ask"
pattern = "Bash"
```

::: tip 提示
MCP server 的声明配置写在 `~/.kimi-code/mcp.json` 或项目内 `.kimi-code/mcp.json` 中，不在 `config.toml` 里。交互式配置入口是 `/mcp-config`，详见 [Model Context Protocol](../customization/mcp.md)。
:::
