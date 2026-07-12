# 配置文件

Kimi Code CLI 把所有长期偏好写进 `~/.kimi-code/` 下的 TOML（一种结构清晰的纯文本配置格式）文件——比如使用哪个模型、填哪个 API 密钥、Agent 每轮最多跑几步。改一次，每次启动都生效。Agent 与运行时设置放在 `config.toml`，终端界面与客户端偏好（主题、编辑器、通知、自动更新）放在配套的 `tui.toml`。

默认位置：`~/.kimi-code/config.toml`，首次运行时自动创建。

## 配置文件位置

CLI 从 `~/.kimi-code/config.toml` 读取配置。如需把数据目录迁移到别处，可用 `KIMI_CODE_HOME` 环境变量覆盖：

```sh
export KIMI_CODE_HOME=/path/to/kimi-home
```

此时配置文件路径变为 `$KIMI_CODE_HOME/config.toml`。无论目录在哪里，文件名固定是 `config.toml`。

::: tip
TOML 字段名一律用下划线（snake_case），如 `default_model`、`max_context_size`。字段名里若含 `.`，需用引号包住，例如 `[models."gpt-4.1"]`——否则 TOML 会把 `.` 解释为嵌套表分隔符。
:::

## 完整示例

以下示例覆盖最常用的配置项，可直接复制后按需修改：

```toml
default_model = "kimi-code/kimi-for-coding"
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
capabilities = [ "thinking", "always_thinking", "image_in", "video_in", "tool_use" ]

[models."kimi-code/kimi-for-coding-highspeed"]
provider = "managed:kimi-code"
model = "kimi-for-coding-highspeed"
max_context_size = 262144
capabilities = [ "thinking", "always_thinking", "image_in", "video_in", "tool_use" ]

[thinking]
enabled = true
effort = "high"
keep = "all"

[loop_control]
max_retries_per_step = 3
reserved_context_size = 50000

[background]
max_running_tasks = 4
keep_alive_on_exit = false

[services.moonshot_search]
base_url = "https://api.kimi.com/coding/v1/search"
api_key = ""

[services.moonshot_fetch]
base_url = "https://api.kimi.com/coding/v1/fetch"
api_key = ""

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

## 顶层字段

配置文件里的字段分两类：**顶层标量**直接控制默认行为，**嵌套表**（`providers`、`models`、`thinking` 等）各有独立结构，在下文各节单独说明。

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `default_model` | `string` | — | 默认模型别名，必须在 `models` 中定义 |
| `default_permission_mode` | `string` | `manual` | 新会话的默认权限模式，可选 `manual`（逐次询问）、`auto`（自动批准读操作）、`yolo`（全部自动批准） |
| `default_plan_mode` | `boolean` | `false` | 新会话是否默认以 Plan 模式（先出计划再执行）启动 |
| `merge_all_available_skills` | `boolean` | `true` | 是否合并所有目录中的 Agent Skills |
| `extra_skill_dirs` | `array<string>` | — | 额外 Skill 搜索目录，叠加到默认目录之上 |
| `telemetry` | `boolean` | `true` | 是否启用匿名遥测；显式设为 `false` 时关闭 |
| `providers` | `table` | `{}` | API 供应商表 → [`providers`](#providers) |
| `models` | `table` | — | 模型别名表 → [`models`](#models) |
| `thinking` | `table` | — | Thinking 模式默认参数 → [`thinking`](#thinking) |
| `loop_control` | `table` | — | Agent 循环控制参数 → [`loop_control`](#loop_control) |
| `background` | `table` | — | 后台任务运行参数 → [`background`](#background) |
| `image` | `table` | — | 图片压缩参数 → [`image`](#image) |
| `services` | `table` | — | 内置外部服务配置 → [`services`](#services) |
| `permission` | `table` | — | 初始权限规则 → [`permission`](#permission) |
| `hooks` | `array<table>` | — | 生命周期 hook，详见 [Hooks](../customization/hooks.md) |

以下各节对 `providers`、`models`、`thinking`、`loop_control`、`background`、`image`、`services`、`permission` 等嵌套表逐一展开。

## `providers`

`providers` 表的每一项定义一个 API 供应商，以唯一名称为 key。CLI 只从这里读取凭证，**不会**从 shell 环境变量自动取后备值——在终端里 `export KIMI_API_KEY` 不会让供应商自动获得密钥，必须显式写在配置文件里（详见[配置覆盖](./overrides.md#供应商凭证)）。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `type` | `string` | 是 | 供应商类型：`kimi`、`anthropic`、`openai`、`openai_responses`、`google-genai`、`vertexai` |
| `api_key` | `string` | 否 | API 密钥，明文写在配置文件里 |
| `base_url` | `string` | 否 | API 基础 URL |
| `oauth` | `table` | 否 | OAuth 凭据引用（`storage`、`key` 两个字段），由登录流程自动注入，通常无需手写 |
| `env` | `table<string, string>` | 否 | 供应商凭证的备用来源，详见下文 |
| `custom_headers` | `table<string, string>` | 否 | 每次请求附加的自定义 HTTP 头 |

**`env` 子表**：可以把供应商惯用的键名（如 `KIMI_API_KEY`）写在 `[providers.<name>.env]` 里，作为 `api_key` / `base_url` 的备用来源。这个子表**只在配置文件里读取**，不会修改 shell 环境：

```toml
[providers.kimi.env]
KIMI_API_KEY = "sk-xxx"
KIMI_BASE_URL = "https://api.moonshot.ai/v1"
```

优先级：`api_key` 字段 > `env` 子表键 > 两者都缺时启动报错。

## `models`

`models` 表的每一项定义一个模型别名（即 `default_model` 或 `-m` 参数里使用的名称），以唯一名称为 key。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `provider` | `string` | 是 | 使用的供应商名称，必须在 `providers` 中定义 |
| `model` | `string` | 是 | 调用 API 时实际传给服务端的模型 ID |
| `max_context_size` | `integer` | 是 | 最大上下文长度（token 数），必须 ≥ 1 |
| `max_output_size` | `integer` | 否 | 单次请求的输出 token 上限（对应 `max_tokens`）。目前仅 `anthropic` 供应商读取。为 Claude 模型设置后，这个显式值会覆盖内置的服务端最大值 |
| `capabilities` | `array<string>` | 否 | 显式追加的能力标签：`thinking`、`always_thinking`、`image_in`、`video_in`、`audio_in`、`tool_use`。与供应商自动识别的能力取并集，只能追加不能移除 |
| `support_efforts` | `array<string>` | 否 | 模型目录声明的 Thinking 档位。managed 和 open-platform 刷新可能会改写该字段；如需手动固定，请改用 `[models."<alias>".overrides] support_efforts` |
| `default_effort` | `string` | 否 | 模型的默认 Thinking 档位。managed 和 open-platform 刷新可能会改写该字段；如需手动固定，请改用 `[models."<alias>".overrides] default_effort` |
| `display_name` | `string` | 否 | UI 中显示的名称，未设时回退到 `model` |
| `reasoning_key` | `string` | 否 | 仅 `openai` 供应商。当网关用非标准字段名返回推理内容时才需要设置；默认自动识别 `reasoning_content` / `reasoning_details` / `reasoning` |
| `adaptive_thinking` | `boolean` | 否 | 仅 `anthropic` 供应商。强制开启或关闭 adaptive thinking，覆盖按模型名推断的逻辑。省略时自动推断（Claude ≥ 4.6 使用 adaptive） |

别名中含 `.` 时需要加引号：

```toml
[models."gpt-4.1"]
provider = "openai"
model = "gpt-4.1"
max_context_size = 1047576
```

### 模型覆盖项

如果某些用户覆盖需要在 provider-model 刷新后保留，请写到 `[models."<alias>".overrides]`。运行时读取的是 effective 值：有 override 时用 override，否则用顶层字段。

```toml
[models."kimi-code/kimi-for-coding"]
provider = "managed:kimi-code"
model = "kimi-for-coding"
max_context_size = 262144

[models."kimi-code/kimi-for-coding".overrides]
max_context_size = 131072
display_name = "Kimi for Coding (custom)"
```

`[models."<alias>".overrides]` 接受普通模型字段，例如 `max_context_size`、`max_output_size`、`capabilities`、`display_name`、`reasoning_key`、`adaptive_thinking`、`support_efforts` 和 `default_effort`。不接受身份 / 路由字段：`provider`、`model`、`protocol` 和 `beta_api`。

无需修改配置文件也可以临时切换模型——通过 `KIMI_MODEL_*` 环境变量在内存里合成一个临时供应商，详见[用环境变量定义模型](./env-vars.md#用环境变量定义模型-kimi-model)。

## `thinking`

`thinking` 设置 Thinking 模式的全局默认行为。

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `enabled` | `boolean` | `true` | 新会话是否默认开启 Thinking，设为 `false` 可强制关闭 |
| `effort` | `string` | — | Thinking 强度（例如 `low`、`medium`、`high`、`xhigh`、`max`），实际可用等级取决于模型声明的 `support_efforts`，未识别的值会被供应商忽略 |
| `keep` | `string` | `"all"` | 保留思考透传。在 `kimi` 上以 `thinking.keep` 发送；在 `anthropic`（Claude 以及 Kimi 的 Anthropic 兼容模式）上以 `context_management` 的 `clear_thinking_20251015` 编辑发送（开启 keep 会让 Anthropic 请求走 beta Messages API；关值可禁用 keep 并回到标准端点）。`"all"` 会保留历史轮次的思考内容（`reasoning_content` / Anthropic thinking blocks）；传入关值（`false`/`0`/`no`/`off`/`none`/`null`）可禁用。可被 `KIMI_MODEL_THINKING_KEEP` 覆盖；仅在 Thinking 开启时注入 |

### 已废弃字段

| 字段 | 废弃版本 | 描述 |
| --- | --- | --- |
| `default_thinking` | 0.21.0 | 顶层布尔值，由 `[thinking] enabled` 取代。将 `default_thinking = true` 迁移为 `enabled = true`，`default_thinking = false` 迁移为 `enabled = false`。 |
| `thinking.mode` | 0.21.0 | 可选值 `auto` / `on` / `off`，由 `[thinking] enabled` 取代。`mode = "off"` 改为 `enabled = false`；`mode = "on"` 和 `mode = "auto"` 等价于 `enabled = true`（默认值），可删除该行。 |

## `loop_control`

`loop_control` 控制 Agent 执行循环的步数上限、单步重试次数，以及触发上下文自动压缩的阈值。

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `max_steps_per_turn` | `integer` | — | 单轮最大步数；不设或设为 `0` 则无上限 |
| `max_retries_per_step` | `integer` | `3` | 单步失败后的最大重试次数 |
| `reserved_context_size` | `integer` | — | 预留给模型输出的 token 数；上下文窗口剩余量低于此值时触发自动压缩 |

## `background`

`background` 控制后台任务（通过 `Bash` 工具或 `Agent` 工具的 `run_in_background=true` 参数启动）的并发数。

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `max_running_tasks` | `integer` | — | 同时运行的最大后台任务数 |
| `keep_alive_on_exit` | `boolean` | `false` | 会话关闭时是否保留仍在运行的后台任务。默认情况下，Kimi Code 会在进程退出前请求停止所有后台任务；只有希望任务在会话结束后继续运行时才设为 `true`。在 print 模式（`kimi -p`）下，本字段仅作为 `print_background_mode` 未设置时的兼容回退：`true` 等价于 `print_background_mode = "drain"` |
| `print_background_mode` | `"exit" \| "drain" \| "steer"` | `"exit"` | 仅 print 模式（`kimi -p`）生效，决定主 agent 的 turn 结束后如何处理未返回的后台任务：`"exit"` 立即退出；`"drain"` 退出前等待所有后台任务进入终态（结果不回馈给主 agent）；`"steer"` 不退出，让后台任务完成时像后台子代理一样以合成 user 消息 steer 主 agent 进入新 turn，直到某 turn 结束时无未决后台任务或触及上限。设置后优先级高于 `keep_alive_on_exit` 的 print 回退 |
| `print_wait_ceiling_s` | `integer` | `3600` | print 模式（`kimi -p`）下，`print_background_mode` 为 `"drain"` 或 `"steer"` 时，等待/steer 循环的墙钟上限（秒）。在非 print 模式或 `"exit"` 时无效 |
| `print_max_turns` | `integer` | `50` | print 模式（`kimi -p`）且 `print_background_mode = "steer"` 时，允许由后台任务完成触发的新 turn 的最大数量，防止 steer 循环失控 |

`keep_alive_on_exit` 可被环境变量 `KIMI_CODE_BACKGROUND_KEEP_ALIVE_ON_EXIT` 覆盖，优先级高于配置文件。

在 print 模式（`kimi -p "<prompt>"`）下，Kimi Code 默认只跑一个非交互的单轮 turn，主 agent 一结束就退出（`print_background_mode = "exit"`）。如果你启动了后台任务（例如通过 `Agent(run_in_background=true)` 并发子代理，或 `Bash(run_in_background=true)` 的长命令）并希望它们跑完，可将 `print_background_mode` 设为 `"drain"`（等任务结束再退出，结果不回馈）或 `"steer"`（任务结束后把结果 steer 给主 agent，触发新 turn 继续处理）。`"steer"` 适合让主 agent 依据后台长任务（如训练、评测）的结果继续做后续步骤；其总耗时受 `print_wait_ceiling_s` 限制、额外 turn 数受 `print_max_turns` 限制。

## `subagent`

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `timeout_ms` | `integer` | `7200000`（2 小时） | 单个子代理（`Agent` / `AgentSwarm`）允许运行的最长时间（毫秒）。超时后子代理以 `timed_out` 收尾。设为很大的值（例如 `259200000`，即 3 天）可近似取消上限。该值是后台任务管理器对每个子代理任务的 per-task timeout，因此对前台与后台子代理同时生效。注意：超过 `2147483647`（约 24.8 天）会被运行时钳成 1ms |

`timeout_ms` 可被环境变量 `KIMI_SUBAGENT_TIMEOUT_MS` 覆盖，优先级高于配置文件。

## `image`

`image` 控制图片发送给模型前的压缩行为，对所有图片入口生效（粘贴图片、`ReadMediaFile` 读图、MCP 工具结果里的图片等）。

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `max_edge_px` | `integer` | `2000` | 图片最长边上限（像素）。超过时按比例缩小到该值以内；调大可保留更多细节，代价是更大的请求体积 |
| `read_byte_budget` | `integer` | `262144`（256 KB） | 模型自行读取的图片（`ReadMediaFile` 默认读取）的单图字节预算。会话中模型反复截图、读图时，累计请求体大小由它控制；细节可通过 `region` 参数按原图坐标全保真回读（`region` 与 `full_resolution` 不受此预算限制） |

`max_edge_px` 可被环境变量 `KIMI_IMAGE_MAX_EDGE_PX` 覆盖，`read_byte_budget` 可被 `KIMI_IMAGE_READ_BYTE_BUDGET` 覆盖，优先级均高于配置文件。

<!--
## `experimental`

`experimental` 存放实验功能 flag 的持久化覆盖。目前 `micro_compaction` 是唯一用户可见的字段，默认值为 `false`；如需自动清理较旧的大型工具结果，把它设为 `true`。

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `micro_compaction` | `boolean` | `false` | 清理较旧的大型工具结果内容，同时保留最近对话 |
-->

## `services`

`services` 配置网页搜索（`moonshot_search`）和网页抓取（`moonshot_fetch`）两项内置服务。只识别这两个固定 key，其他 key 会被忽略。两项字段相同：

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

`permission` 设置会话启动时自动加载的权限规则，控制 Agent 调用工具时是否需要用户确认。规则用 `[[permission.rules]]` 数组表写出，按顺序匹配，第一条命中即生效。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `decision` | `string` | 是 | 匹配后的处置：`allow`（直接放行）、`deny`（直接拒绝）、`ask`（每次询问） |
| `scope` | `string` | 否 | 规则有效范围：`turn-override`、`session-runtime`、`project`、`user`；默认 `user` |
| `pattern` | `string` | 是 | 匹配模式，格式为 `工具名` 或 `工具名(参数模式)`，如 `Read`、`Bash(rm -rf*)` |
| `reason` | `string` | 否 | 规则说明，仅用于调试和审计 |

内置工具名见[内置工具](../reference/tools.md)。大多数支持规则参数的内置工具会定义自己的匹配对象，例如 `Bash(command-pattern)` 或 `Read(path-pattern)`。`AgentSwarm`、MCP 工具和自定义工具只能按工具名匹配，不支持参数模式。

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

::: tip
MCP server 的声明配置写在 `~/.kimi-code/mcp.json` 或项目内 `.kimi-code/mcp.json` 中，不在 `config.toml` 里。交互式配置入口是 `/mcp-config`，详见 [Model Context Protocol](../customization/mcp.md)。
:::

## `tui.toml`

除了 `config.toml`，CLI 还在同一目录下用一份配套的 `tui.toml` 保存终端界面与客户端偏好（`~/.kimi-code/tui.toml`，或覆盖后的 `$KIMI_CODE_HOME/tui.toml`）。它在首次运行时以默认值创建，交互式命令 `/config`、`/theme`、`/editor` 会自动写入，通常无需手动编辑。文件格式有误时，CLI 会回退到默认值并给出提示，而不是启动失败。

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `theme` | `string` | `auto` | 配色主题：`auto`（跟随终端）、`dark`、`light`，或[自定义主题](../customization/themes)的名字 |
| `disable_paste_burst` | `boolean` | `false` | 禁用非 bracketed paste 的粘贴突发兜底；默认开启，避免快速多行粘贴被逐行提交 |
| `[editor].command` | `string` | `""` | 编写长输入用的外部编辑器命令；留空则回退到 `$VISUAL` / `$EDITOR` |
| `[notifications].enabled` | `boolean` | `true` | 是否发送桌面通知 |
| `[notifications].notification_condition` | `string` | `unfocused` | 何时通知：`unfocused`（仅终端失去焦点时）或 `always`（总是） |
| `[upgrade].auto_install` | `boolean` | `true` | 是否自动安装新版本 |

```toml
# ~/.kimi-code/tui.toml
theme = "auto" # "auto" | "dark" | "light" | 自定义主题名
disable_paste_burst = false # true 表示禁用非 bracketed paste 的粘贴突发兜底

[editor]
command = "" # 留空则使用 $VISUAL / $EDITOR

[notifications]
enabled = true
notification_condition = "unfocused" # "unfocused" | "always"

[upgrade]
auto_install = true
```

修改在下次启动时生效，或用 `/reload-tui` 立即生效（只重载 `tui.toml`）；`/reload` 会同时重载 `config.toml` 和 `tui.toml`。

## 项目级本地配置

除了 `~/.kimi-code` 下的用户级文件，Kimi Code 还会读取位于 `<项目根目录>/.kimi-code/local.toml` 的项目级本地配置文件。它保存的是与某一个项目检出相关、通常不应与队友共享的设置。

该文件会在你通过 [`/add-dir`](../reference/slash-commands.md) 添加额外工作目录并选择记入项目时自动创建，通常无需手动编辑。

### `[workspace]`

`[workspace]` 表用于存放项目级的工作区设置：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `additional_dir` | `array<string>` | 否 | 额外工作目录列表，以绝对路径存储。在 `/add-dir` 中确认"记住此目录"时自动写入；启动时读回，使这些目录在该项目的每个会话中都可用 |

```toml
[workspace]
additional_dir = ["/absolute/path/to/shared"]
```

目录以绝对路径存储，与具体机器相关。因此建议把 `.kimi-code/local.toml` 加入项目的 `.gitignore`，避免被提交。

## 下一步

- [平台与模型](./providers.md) — 各供应商类型（Kimi、Claude、OpenAI、Gemini）的接入示例
- [配置覆盖](./overrides.md) — CLI 选项、配置文件、环境变量的优先级规则
- [环境变量](./env-vars.md) — `KIMI_CODE_HOME` 等运行时变量的完整列表
