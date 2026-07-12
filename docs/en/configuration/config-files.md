# Configuration files

Kimi Code CLI writes all long-term preferences — which model to use, which API key to fill in, how many steps an Agent can run per turn — into TOML (a plain-text configuration format with a clear structure) files. Change them once and they take effect on every startup. Agent and runtime settings live in `config.toml`; terminal-UI and client preferences (theme, editor, notifications, auto-update) live in a companion `tui.toml`.

Default location: `~/.kimi-code/config.toml`, created automatically on first run.

## Config file location

The CLI reads configuration from `~/.kimi-code/config.toml`. To relocate the data directory, override it with the `KIMI_CODE_HOME` environment variable:

```sh
export KIMI_CODE_HOME=/path/to/kimi-home
```

The config file path then becomes `$KIMI_CODE_HOME/config.toml`. Regardless of where the directory lives, the file name is always `config.toml`.

::: tip
TOML field names always use snake_case, for example `default_model` and `max_context_size`. If a key contains `.`, you must quote it — for example `[models."gpt-4.1"]` — otherwise TOML treats `.` as a nested table separator.
:::

## Complete example

The following example covers the most commonly used configuration fields. You can copy it and adjust as needed:

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

## Top-level fields

Fields in the config file fall into two categories: **top-level scalars** that directly control default behavior, and **nested tables** (`providers`, `models`, `thinking`, etc.) that each have their own structure, described individually in the sections below.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `default_model` | `string` | — | Default model alias; must be defined in `models` |
| `default_permission_mode` | `string` | `manual` | Default permission mode for new sessions; one of `manual` (prompt each time), `auto` (auto-approve read operations), or `yolo` (auto-approve everything) |
| `default_plan_mode` | `boolean` | `false` | Whether new sessions start in Plan mode (produce a plan before executing) by default |
| `merge_all_available_skills` | `boolean` | `true` | Whether to merge Agent Skills from all available directories |
| `extra_skill_dirs` | `array<string>` | — | Extra skill search directories, layered on top of the default directories |
| `telemetry` | `boolean` | `true` | Whether anonymous telemetry is enabled; disabled only when explicitly set to `false` |
| `providers` | `table` | `{}` | API provider table → [`providers`](#providers) |
| `models` | `table` | — | Model alias table → [`models`](#models) |
| `thinking` | `table` | — | Default parameters for Thinking mode → [`thinking`](#thinking) |
| `loop_control` | `table` | — | Agent loop control parameters → [`loop_control`](#loop_control) |
| `background` | `table` | — | Background task runtime parameters → [`background`](#background) |
| `image` | `table` | — | Image compression parameters → [`image`](#image) |
| `services` | `table` | — | Built-in external service configuration → [`services`](#services) |
| `permission` | `table` | — | Initial permission rules → [`permission`](#permission) |
| `hooks` | `array<table>` | — | Lifecycle hooks; see [Hooks](../customization/hooks.md) |

The following sections cover each of the nested tables in turn: `providers`, `models`, `thinking`, `loop_control`, `background`, `image`, `services`, and `permission`.

## `providers`

Each entry in the `providers` table defines an API provider, keyed by a unique name. The CLI reads credentials only from here — it does **not** fall back to shell environment variables automatically. Running `export KIMI_API_KEY` in the terminal does not give any provider its key; you must write it explicitly in the config file (see [Config overrides](./overrides.md#provider-credentials)).

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `type` | `string` | Yes | Provider type: `kimi`, `anthropic`, `openai`, `openai_responses`, `google-genai`, `vertexai` |
| `api_key` | `string` | No | API key, written in plain text in the config file |
| `base_url` | `string` | No | API base URL |
| `oauth` | `table` | No | OAuth credential reference (`storage` and `key` fields); injected automatically by the login flow — normally no need to write this by hand |
| `env` | `table<string, string>` | No | Fallback source for provider credentials; see below |
| `custom_headers` | `table<string, string>` | No | Custom HTTP headers attached to each request |

**`env` sub-table**: You can write provider-conventional key names (such as `KIMI_API_KEY`) inside `[providers.<name>.env]` as a fallback source for `api_key` / `base_url`. This sub-table is **read only from the config file** and does not modify the shell environment:

```toml
[providers.kimi.env]
KIMI_API_KEY = "sk-xxx"
KIMI_BASE_URL = "https://api.moonshot.ai/v1"
```

Priority: `api_key` field > `env` sub-table key > if both are absent, startup fails with an error.

## `models`

Each entry in the `models` table defines a model alias (the name used in `default_model` or the `-m` flag), keyed by a unique name.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `provider` | `string` | Yes | Name of the provider to use; must be defined in `providers` |
| `model` | `string` | Yes | Model identifier sent to the server when calling the API |
| `max_context_size` | `integer` | Yes | Maximum context length in tokens; must be at least 1 |
| `max_output_size` | `integer` | No | Per-request output token cap (maps to `max_tokens`). Currently only the `anthropic` provider honors it. When set for a Claude model, this explicit value overrides the built-in server-side maximum |
| `capabilities` | `array<string>` | No | Capability tags to add explicitly: `thinking`, `always_thinking`, `image_in`, `video_in`, `audio_in`, `tool_use`. Unioned with the capabilities auto-detected by the provider — entries can only be added, never removed |
| `support_efforts` | `array<string>` | No | Thinking effort levels declared by the model catalog. Managed and open-platform refreshes may rewrite this field; to pin it manually, set `[models."<alias>".overrides] support_efforts` instead |
| `default_effort` | `string` | No | Default thinking effort for the model. Managed and open-platform refreshes may rewrite this field; to pin it manually, set `[models."<alias>".overrides] default_effort` instead |
| `display_name` | `string` | No | Name shown in the UI; falls back to `model` when unset |
| `reasoning_key` | `string` | No | `openai` provider only. Override the field name used for reasoning content when the gateway returns it under a non-standard name; by default `reasoning_content`, `reasoning_details`, and `reasoning` are auto-detected |
| `adaptive_thinking` | `boolean` | No | `anthropic` provider only. Force adaptive thinking on or off, overriding the version inference based on the model name. Omit to infer automatically (Claude ≥ 4.6 uses adaptive) |

When an alias contains `.`, use a quoted key:

```toml
[models."gpt-4.1"]
provider = "openai"
model = "gpt-4.1"
max_context_size = 1047576
```

### Model overrides

Use `[models."<alias>".overrides]` for user overrides that must survive provider-model refreshes. Runtime consumers read the effective value: the override when present, otherwise the top-level field.

```toml
[models."kimi-code/kimi-for-coding"]
provider = "managed:kimi-code"
model = "kimi-for-coding"
max_context_size = 262144

[models."kimi-code/kimi-for-coding".overrides]
max_context_size = 131072
display_name = "Kimi for Coding (custom)"
```

`[models."<alias>".overrides]` accepts ordinary model fields such as `max_context_size`, `max_output_size`, `capabilities`, `display_name`, `reasoning_key`, `adaptive_thinking`, `support_efforts`, and `default_effort`. It does not accept identity / routing fields: `provider`, `model`, `protocol`, and `beta_api`.

You can also switch models temporarily without touching the config file — by setting `KIMI_MODEL_*` environment variables, the CLI synthesizes a temporary provider in memory that does not persist after restart. See [Define a model from environment variables](./env-vars.md#define-a-model-from-environment-variables-kimi_model).

## `thinking`

`thinking` sets the global default behavior for Thinking mode.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `enabled` | `boolean` | `true` | Whether Thinking is enabled by default for new sessions; set to `false` to force Thinking off |
| `effort` | `string` | — | Thinking effort level (for example `low`, `medium`, `high`, `xhigh`, `max`); the levels actually available depend on the model's declared `support_efforts`, and unrecognized values are ignored by the provider |
| `keep` | `string` | `"all"` | Preserved Thinking passthrough. On `kimi` it is sent as `thinking.keep`; on `anthropic` (Claude and Kimi's Anthropic-compatible mode) it is sent as a `context_management` `clear_thinking_20251015` edit (enabling keep routes Anthropic requests to the beta Messages API; an off-value disables keep and returns to the standard endpoint). `"all"` preserves prior turns' reasoning (`reasoning_content` / Anthropic thinking blocks); set to an off-value (`false`/`0`/`no`/`off`/`none`/`null`) to disable. Overridden by `KIMI_MODEL_THINKING_KEEP`; only injected while Thinking is on |

### Deprecated fields

| Field | Deprecated in | Description |
| --- | --- | --- |
| `default_thinking` | 0.21.0 | Top-level boolean, replaced by `[thinking] enabled`. Migrate `default_thinking = true` to `enabled = true`, and `default_thinking = false` to `enabled = false`. |
| `thinking.mode` | 0.21.0 | One of `auto` / `on` / `off`, replaced by `[thinking] enabled`. `mode = "off"` becomes `enabled = false`; `mode = "on"` and `mode = "auto"` are equivalent to `enabled = true` (the default) and can be removed. |

## `loop_control`

`loop_control` governs the step count limit, per-step retry count, and the threshold that triggers automatic context compaction in the Agent execution loop.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `max_steps_per_turn` | `integer` | — | Maximum steps per turn; unset or `0` means unlimited |
| `max_retries_per_step` | `integer` | `3` | Maximum retries after a step failure |
| `reserved_context_size` | `integer` | — | Number of tokens reserved for model output; automatic compaction is triggered when the remaining context window falls below this value |

## `background`

`background` controls the concurrency behavior of background tasks (launched via the `Bash` tool or the `Agent` tool's `run_in_background=true` parameter).

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `max_running_tasks` | `integer` | — | Maximum number of background tasks running concurrently |
| `keep_alive_on_exit` | `boolean` | `false` | Whether to keep still-running background tasks when the session closes. By default, Kimi Code requests that all background tasks stop before the process exits; set this to `true` only when you want tasks to outlive the session. In print mode (`kimi -p`), this is only a legacy fallback used when `print_background_mode` is unset: `true` is equivalent to `print_background_mode = "drain"` |
| `print_background_mode` | `"exit" \| "drain" \| "steer"` | `"exit"` | Print mode (`kimi -p`) only. Governs how pending background tasks are handled once the main agent's turn ends: `"exit"` exits immediately; `"drain"` waits for every background task to reach a terminal state before exiting (results are not fed back to the main agent); `"steer"` stays alive so a completing background task — like a background subagent — injects a synthetic user message that steers the main agent into a new turn, looping until a turn ends with no pending background tasks or a limit is hit. Takes precedence over the `keep_alive_on_exit` print fallback |
| `print_wait_ceiling_s` | `integer` | `3600` | In print mode (`kimi -p`), the wall-clock ceiling (seconds) for the wait/steer loop when `print_background_mode` is `"drain"` or `"steer"`. Has no effect outside print mode or when it is `"exit"` |
| `print_max_turns` | `integer` | `50` | In print mode (`kimi -p`) with `print_background_mode = "steer"`, the maximum number of new turns that may be triggered by background-task completions, to keep the steering loop bounded |

`keep_alive_on_exit` can be overridden by the `KIMI_CODE_BACKGROUND_KEEP_ALIVE_ON_EXIT` environment variable, which takes higher priority than `config.toml`.

In print mode (`kimi -p "<prompt>"`), Kimi Code by default runs a single non-interactive turn and exits as soon as the main agent finishes (`print_background_mode = "exit"`). If you launch background tasks (for example, concurrent subagents via `Agent(run_in_background=true)`, or a long command via `Bash(run_in_background=true)`) and need them to run to completion, set `print_background_mode` to `"drain"` (wait for them to finish, without feeding results back) or `"steer"` (feed each completion back to the main agent, starting a new turn so it can act on the result). `"steer"` is useful when the main agent should keep working based on the outcome of a long background task (e.g. training or evaluation); its total wall-clock is bounded by `print_wait_ceiling_s` and the number of extra turns by `print_max_turns`.

## `subagent`

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `timeout_ms` | `integer` | `7200000` (2 hours) | Maximum wall-clock time (milliseconds) a single subagent (`Agent` / `AgentSwarm`) is allowed to run before it is settled as `timed_out`. Set a very large value (e.g. `259200000`, i.e. 3 days) to effectively lift the cap. This is the background-task manager's per-task timeout for each subagent task, so it applies to both foreground and background subagents. Note: any value above `2147483647` (about 24.8 days) is clamped to 1ms by the runtime. |

`timeout_ms` can be overridden by the `KIMI_SUBAGENT_TIMEOUT_MS` environment variable, which takes higher priority than `config.toml`.

## `image`

`image` controls how images are compressed before being sent to the model, across every ingestion point (pasted images, `ReadMediaFile` reads, images in MCP tool results, and so on).

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `max_edge_px` | `integer` | `2000` | Longest-edge ceiling in pixels. Larger images are scaled down proportionally to fit; raising it preserves more detail at the cost of larger request bodies |
| `read_byte_budget` | `integer` | `262144` (256 KB) | Per-image byte budget for images the model reads for itself (`ReadMediaFile` default reads). It bounds the accumulated request-body size when the model keeps screenshotting and reading images; fine detail stays reachable through the `region` parameter, which reads a crop back at full fidelity (`region` and `full_resolution` are not subject to this budget) |

`max_edge_px` can be overridden by the `KIMI_IMAGE_MAX_EDGE_PX` environment variable and `read_byte_budget` by `KIMI_IMAGE_READ_BYTE_BUDGET`; both take higher priority than `config.toml`.

<!--
## `experimental`

`experimental` stores persistent overrides for experimental-feature flags. Currently, `micro_compaction` is the only user-facing entry and defaults to `false`; set it to `true` to enable automatic trimming of older large tool results.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `micro_compaction` | `boolean` | `false` | Trim older large tool results from context while preserving recent conversation |
-->

## `services`

`services` configures two built-in services: web search (`moonshot_search`) and web fetch (`moonshot_fetch`). Only these two fixed keys are recognized; other keys are ignored. Both entries share the same fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `base_url` | `string` | No | Service API URL |
| `api_key` | `string` | No | API key |
| `oauth` | `table` | No | OAuth credential reference, same structure as `providers.*.oauth` |
| `custom_headers` | `table<string, string>` | No | Custom HTTP headers attached to each request |

```toml
[services.moonshot_search]
base_url = "https://api.moonshot.cn/v1/search"
api_key = "sk-xxx"

[services.moonshot_fetch]
base_url = "https://api.moonshot.cn/v1/fetch"
api_key = "sk-xxx"
```

## `permission`

`permission` sets permission rules that are automatically loaded when a session starts, controlling whether the Agent needs user confirmation before calling a tool. Rules are written as a `[[permission.rules]]` array of tables, matched in order — the first matching rule takes effect.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `decision` | `string` | Yes | Action on match: `allow` (permit immediately), `deny` (reject immediately), `ask` (prompt each time) |
| `scope` | `string` | No | Rule scope: `turn-override`, `session-runtime`, `project`, `user`; defaults to `user` |
| `pattern` | `string` | Yes | Match pattern in the form `ToolName` or `ToolName(arg-pattern)`, e.g. `Read` or `Bash(rm -rf*)` |
| `reason` | `string` | No | Rule description for debugging and auditing |

Built-in tool names are listed in [Built-in tools](../reference/tools.md). Most built-in tools that accept rule arguments define their own matching subject, such as `Bash(command-pattern)` or `Read(path-pattern)`. `AgentSwarm`, MCP tools, and custom tools can only be matched by tool name — argument patterns are not supported for them.

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
MCP server declarations are configured in `~/.kimi-code/mcp.json` or the project-local `.kimi-code/mcp.json`, not in `config.toml`. The interactive configuration entry point is `/mcp-config`; see [Model Context Protocol](../customization/mcp.md).
:::

## `tui.toml`

Alongside `config.toml`, the CLI keeps terminal-UI and client preferences in a companion `tui.toml` in the same directory (`~/.kimi-code/tui.toml`, or `$KIMI_CODE_HOME/tui.toml` when overridden). It is created with defaults on first run, and the interactive commands `/config`, `/theme`, and `/editor` write to it for you — so you rarely need to edit it by hand. If the file is malformed, the CLI falls back to defaults and shows a notice instead of failing to start.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `theme` | `string` | `auto` | Color theme: `auto` (follow the terminal), `dark`, `light`, or the name of a [custom theme](../customization/themes) |
| `disable_paste_burst` | `boolean` | `false` | Disable the non-bracketed paste-burst fallback that keeps rapid multi-line pastes from submitting line by line |
| `[editor].command` | `string` | `""` | External editor command for composing long input; empty falls back to `$VISUAL` / `$EDITOR` |
| `[notifications].enabled` | `boolean` | `true` | Whether desktop notifications are sent |
| `[notifications].notification_condition` | `string` | `unfocused` | When to notify: `unfocused` (only when the terminal is not focused) or `always` |
| `[upgrade].auto_install` | `boolean` | `true` | Whether new versions are installed automatically |

```toml
# ~/.kimi-code/tui.toml
theme = "auto" # "auto" | "dark" | "light" | custom theme name
disable_paste_burst = false # true disables non-bracketed paste-burst fallback

[editor]
command = "" # empty uses $VISUAL / $EDITOR

[notifications]
enabled = true
notification_condition = "unfocused" # "unfocused" | "always"

[upgrade]
auto_install = true
```

Changes apply on the next start, or immediately with `/reload-tui` (which reloads only `tui.toml`); `/reload` reloads both `config.toml` and `tui.toml`.

## Project-local configuration

In addition to the user-level files under `~/.kimi-code`, Kimi Code reads a project-local configuration file at `<project-root>/.kimi-code/local.toml`. It holds settings that are specific to one project checkout and typically should not be shared with teammates.

The file is created automatically when you add an extra workspace directory with [`/add-dir`](../reference/slash-commands.md) and choose to remember it for the project. You rarely need to edit it by hand.

### `[workspace]`

The `[workspace]` table groups project-level workspace settings:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `additional_dir` | `array<string>` | No | Additional workspace directories, stored as absolute paths. Written automatically when you confirm "remember this directory" in `/add-dir`; read back on startup so the directories are available in every session of this project |

```toml
[workspace]
additional_dir = ["/absolute/path/to/shared"]
```

Because directories are stored as absolute paths, which are specific to your machine, we recommend adding `.kimi-code/local.toml` to your project's `.gitignore` so it is not committed.

## Next steps

- [Providers and models](./providers.md) — connection examples for each provider type (Kimi, Claude, OpenAI, Gemini)
- [Config overrides](./overrides.md) — priority rules for CLI options, config file, and environment variables
- [Environment variables](./env-vars.md) — complete list of runtime variables like `KIMI_CODE_HOME`
