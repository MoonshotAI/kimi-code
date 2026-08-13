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
default_model = "kimi-code/k3"
default_permission_mode = "manual"
default_plan_mode = false
merge_all_available_skills = true
telemetry = true

[providers."managed:kimi-code"]
type = "kimi"
base_url = "https://api.kimi.com/coding/v1"
api_key = ""

[models."kimi-code/k3"]
provider = "managed:kimi-code"
model = "k3"
max_context_size = 1048576
capabilities = [ "thinking", "always_thinking", "image_in", "video_in", "tool_use" ]
display_name = "K3"
support_efforts = [ "max" ]
default_effort = "max"

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
max_attempts_per_step = 10
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
| `default_permission_mode` | `string` | `manual` | Default permission mode for new sessions; one of `manual` (prompt each time), `yolo` (auto-approve tool actions, but the agent may still ask questions), or `auto` (fully autonomous — the agent decides everything without asking) |
| `default_plan_mode` | `boolean` | `false` | Whether new sessions start in Plan mode (produce a plan before executing) by default |
| `merge_all_available_skills` | `boolean` | `true` | Whether to merge Agent Skills from all available directories |
| `extra_skill_dirs` | `array<string>` | — | Extra skill search directories, layered on top of the default directories |
| `extra_agent_dirs` | `array<string>` | — | Extra custom agent search directories, layered on top of the default directories |
| `builtin_product_skills` | `boolean` | `true` | Whether the built-in skills that document Kimi Code itself are offered to the model: `update-config`, `custom-theme`, `mcp-config`, `check-kimi-code-docs`, and `import-from-cc-codex`. Turning them off trims their names and descriptions from the system prompt, at the cost of the guided flows for those tasks. Read by the default `agent-core-v2` engine; ignored when `KIMI_CODE_LEGACY_FLAG=1` selects the legacy engine |
| `telemetry` | `boolean` | `true` | Whether anonymous telemetry is enabled; disabled only when explicitly set to `false` |
| `providers` | `table` | `{}` | API provider table → [`providers`](#providers) |
| `models` | `table` | — | Model alias table → [`models`](#models) |
| `thinking` | `table` | — | Default parameters for Thinking mode → [`thinking`](#thinking) |
| `loop_control` | `table` | — | Agent loop control parameters → [`loop_control`](#loop-control) |
| `background` | `table` | — | Background task runtime parameters → [`background`](#background) |
| `tools` | `table` | — | Global tool switch → [`tools`](#tools) |
| `image` | `table` | — | Image compression parameters → [`image`](#image) |
| `services` | `table` | — | Built-in external service configuration → [`services`](#services) |
| `permission` | `table` | — | Initial permission rules → [`permission`](#permission) |
| `hooks` | `array<table>` | — | Lifecycle hooks; see [Hooks](../customization/hooks.md) |
| `identity` | `table` | — | Custom agent identity → [`identity`](#identity) |

The following sections cover each of the nested tables in turn: `providers`, `models`, `thinking`, `loop_control`, `background`, `tools`, `image`, `services`, and `permission`.

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
| `max_input_size` | `integer` | No | Declared per-request input limit when it sits below the total window (e.g. gpt-5: 400k window, 272k input). Compaction, context-overflow checks, and usage ratios prefer it; completion budgeting keeps the total window. Resolution clamps it to `max_context_size` |
| `max_output_size` | `integer` | No | Per-request output token cap (maps to `max_tokens`). Currently only the `anthropic` provider honors it. When set for a Claude model, this explicit value overrides the built-in server-side maximum |
| `capabilities` | `array<string>` | No | Capability tags to add explicitly: `thinking`, `always_thinking`, `image_in`, `video_in`, `audio_in`, `tool_use`. Unioned with the capabilities auto-detected by the provider — entries can only be added, never removed |
| `support_efforts` | `array<string>` | No | Thinking effort levels the model accepts. For `kimi`, selecting another value at runtime fails; when model resolution carries an unsupported configured or previous value, the session falls back to the target model's `default_effort` and reports that effective value to the UI. A Thinking-capable Kimi model without this field uses boolean `on` / `off`. Other providers pass concrete values unchanged when their protocol has a native effort field; protocols that expose only levels or token budgets perform the required format conversion. Managed and open-platform refreshes may rewrite this field; to pin it manually, set `[models."<alias>".overrides] support_efforts` instead |
| `default_effort` | `string` | No | Default thinking effort for the model. Managed and open-platform refreshes may rewrite this field; to pin it manually, set `[models."<alias>".overrides] default_effort` instead |
| `off_effort` | `string` | No | Effort value sent on the wire to disable thinking (e.g. `none` for xai grok). Only meaningful for models that declare such an encoding (catalog imports set it): turning thinking Off then sends this value instead of omitting the effort field — the only way to actually stop reasoning on models that reason by default |
| `base_url` | `string` | No | Per-model endpoint override (written by catalog imports for gateway models served away from the provider default). Resolution prefers it over the provider's `base_url`; only takes effect together with `protocol` |
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

`[models."<alias>".overrides]` accepts ordinary model fields such as `max_context_size`, `max_input_size`, `max_output_size`, `capabilities`, `display_name`, `reasoning_key`, `adaptive_thinking`, `support_efforts`, `default_effort`, and `off_effort`. It does not accept identity / routing fields: `provider`, `model`, `protocol`, `beta_api`, and `base_url`.

You can also switch models temporarily without touching the config file — by setting `KIMI_MODEL_*` environment variables, the CLI synthesizes a temporary provider in memory that does not persist after restart. See [Define a model from environment variables](./env-vars.md#define-a-model-from-environment-variables-kimi-model).

## `secondary_model`

The secondary model is a second model configuration alongside the main model — typically a cheaper one, for features that do not need the main model's capability. Its consumer today is subagent spawning. Both engines read this section, but different keys from it, and both gate the feature behind the secondary-model experiment:

- The default `agent-core-v2` engine (`kimi`, `kimi -p`, and `kimi web`) reads the [subagent model pool](#subagent-model-pool): `default_model` and the `[secondary_model.models]` table, and also honors a lone recipe `model` key as a fallback default.
- The legacy `agent-core` engine, selected for `kimi` / `kimi -p` with `KIMI_CODE_LEGACY_FLAG=1`, reads the [recipe keys](#secondary-model-recipe) (`model`, `default_effort`, and the patch fields).

### Subagent model pool

This feature is experimental and disabled by default. Enable it with `KIMI_CODE_EXPERIMENTAL_SECONDARY_MODEL=1`, or the master `KIMI_CODE_EXPERIMENTAL_FLAG=1`. It takes effect in every launch mode, including the interactive TUI. While the experiment is off, the pool keys stay inert: subagents inherit the caller's model and session startup skips the pool validation.

The pool is read by the `agent-core-v2` engine only; the legacy `agent-core` engine selected with `KIMI_CODE_LEGACY_FLAG=1` ignores `default_model` and `[secondary_model.models]`, and resolves subagent models through the [recipe keys](#secondary-model-recipe) instead.

To simply point every subagent at one model by default, no models table is needed — a single `default_model` line is a pool with a single entry:

```toml
[secondary_model]
default_model = "kimi-code/kimi-for-coding-highspeed"
```

In the interactive TUI, the [`/secondary-model`](../reference/slash-commands.md) command (alias `/subagent-model`) opens a model selector for this: the choice is written to `default_model` (when a models table exists and the picked alias is not in it, an entry with an empty description is added), and newly spawned subagents pick up the new default immediately — no session restart needed.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `default_model` | `string` | — | Default subagent model. Required when `[secondary_model.models]` is configured, and must be one of its keys; written on its own (without a models table) it is equivalent to a pool containing only that entry |
| `models` | `table<string, string>` | — | Subagent model pool. Each key is the alias of a configured [`[models]`](#models) entry; each value is the description the main agent sees when picking a subagent model (Chinese or English; an empty string lists the alias with no hint) |
| `force` | `boolean` | `false` | Pin every subagent to `default_model`: the `model` parameter is not advertised, so the main agent cannot pick another model or `"primary"`. Requires `default_model` (or a lone `model` key); cannot be combined with `[secondary_model.models]` |

A configured pool — an explicit `[secondary_model.models]` table or a lone `default_model` — enables model selection: the `Agent` / `AgentSwarm` tools gain a `model` parameter, and the tool description lists the pool (the default marked `[default]`) so the main agent can choose per spawn (unless `force` is set — see below). The pool only references configured [`[models]`](#models) entries — the `kimi-code/*` aliases below are provisioned by `/login` — and attaches the selection hints:

```toml
[secondary_model]
default_model = "kimi-code/kimi-for-coding-highspeed"
[secondary_model.models]
"kimi-code/k3" = "Pick this for hard problems. Strong at complex reasoning, algorithm design, deep debugging, math, and systematic challenges."
"kimi-code/kimi-for-coding-highspeed" = "Fast and cheap. Good for daily refactoring, code explanation, small edits, summaries, and simple batch tasks."
"kimi-code/kimi-for-coding" = "A balanced coding workhorse. Good for most feature development and code-change tasks."
```

A spawn resolves the subagent's model in this order: an explicit tool-call `model` → `default_model`. The `model` parameter accepts any pool alias, or `"primary"` — the model the caller itself is running, always valid even when that model is not in the pool. When neither `default_model` nor `[secondary_model.models]` is configured, the parameter is not advertised and subagents inherit the caller's model. Binding a pool alias carries no explicit thinking effort — the subagent resolves it naturally (global `[thinking]` config → the bound model's default effort) instead of inheriting the caller's level, while `"primary"` inherits both the model and the level from the caller.

To take the choice away from the main agent entirely — every subagent runs on one fixed model — add `force = true`:

```toml
[secondary_model]
default_model = "kimi-code/kimi-for-coding-highspeed"
force = true
```

With `force` set, the `model` parameter is not advertised (just like when nothing is configured) and every spawn binds `default_model`; an explicit `model` argument, `"primary"` included, is rejected with an error. `force` requires `default_model` (or a lone `model` key) and cannot be combined with a `[secondary_model.models]` table — the table exists to offer a choice, and force removes it.

Because natural resolution lands on the bound model's default effort, different pool entries can carry different thinking levels: register a second `[models]` entry as a "variant" of the same underlying model, override only its `default_effort` via [`[models."<alias>".overrides]`](#model-overrides), and list both aliases in the pool — the main agent picks the thinking level together with the alias:

```toml
# "kimi-code/kimi-for-coding-highspeed" is provisioned by /login; this
# registers a higher-effort variant of the same model
[models.kimi-for-coding-highspeed-deep]
provider = "managed:kimi-code"
model = "kimi-for-coding-highspeed"

[models.kimi-for-coding-highspeed-deep.overrides]
default_effort = "high"

[secondary_model]
default_model = "kimi-code/kimi-for-coding-highspeed"
[secondary_model.models]
"kimi-code/kimi-for-coding-highspeed" = "Fast and cheap. Good for daily refactoring, code explanation, small edits, summaries, and simple batch tasks."
kimi-for-coding-highspeed-deep = "The same model at a high thinking level. Good for harder subtasks."
```

Note that `default_effort` stays a model-level default: once a global `[thinking].effort` is set, it wins for the main agent and subagents alike, and the variant's default only applies when no global effort is set. Value and fallback rules follow the [`[models]` entry's `default_effort`](#models).

Configuration errors fail loudly instead of falling back silently: session creation, resume, and fork all fail at startup when `default_model` is missing, is not a pool key, or a pool key does not resolve to a configured `[models]` entry — and likewise when `force` is set without `default_model` or combined with a `[secondary_model.models]` table. The alias `primary` is reserved — it always binds the caller's own model — and is rejected as a pool key. A spawn whose `model` is neither a pool alias nor `"primary"` fails with an error listing the available choices.

When only the recipe `model` key is set — no `default_model`, no `[secondary_model.models]` table — the v2 engine reads it compatibly as the pool default: an implicit single-entry pool ranked below `default_model`, so a recipe setup keeps working unchanged. The compatibility only takes the model alias, though: the recipe patch fields (`default_effort`, `max_output_size`, …) do not carry over — write those settings onto the `[models]` entry the alias points to, for example via [`[models."<alias>".overrides]`](#model-overrides). Once a `[secondary_model.models]` table is configured, `default_model` stays required and `model` does not substitute for it.

To migrate explicitly, point the pool default at the same alias:

```toml
# Before
[secondary_model]
model = "kimi-code/kimi-for-coding-highspeed"

# After
[secondary_model]
default_model = "kimi-code/kimi-for-coding-highspeed"
```

The recipe keys can stay in the section: the legacy engine keeps reading them.

### Secondary-model recipe

This reading is used by the legacy `agent-core` engine selected with `KIMI_CODE_LEGACY_FLAG=1`; the default v2 engine ignores the recipe keys. When set, newly spawned subagents (`Agent` / `AgentSwarm`) bind to it by default instead of inheriting the main agent's model; when unset, subagents inherit the main agent's model.

This is a default binding, not a forced one. With the experiment enabled, the `Agent` / `AgentSwarm` tools gain a `model` parameter (accepting only the symbolic values `"secondary"` / `"primary"`), and the tool description lists the available models with the default marked. A spawn resolves the subagent's model in this order: an explicit tool-call `model` → the profile's [`model_preference`](../customization/agents.md#agent-file-format) → the configured secondary model (the default). Here `"primary"` means the model the main agent is currently running, not necessarily `default_model` — for example after a mid-session `/model` switch.

Because overriding the default is the main agent's own decision (the tool description merely suggests `"secondary"` for routine tasks and `"primary"` for hard, quality-sensitive ones), there is no per-spawn switch on the user side. To steer a specific subagent to the main model, ask the main agent in your prompt to pass `model: "primary"`, or set `model_preference: "primary"` in the corresponding profile.

This feature is experimental and disabled by default. Enable it with `KIMI_CODE_EXPERIMENTAL_SECONDARY_MODEL=1`, or the master `KIMI_CODE_EXPERIMENTAL_FLAG=1`. It takes effect in every launch mode, including the interactive TUI.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `model` | `string` | — | The alias of a configured [`[models]`](#models) entry, e.g. `kimi-code/kimi-for-coding` (any provider, not limited to Kimi models) |
| `default_effort` | `string` | — | Thinking effort applied when subagents bind to the secondary model. Unset, the effort resolves naturally (global `[thinking]` config → the bound model's default effort) instead of inheriting the main agent's effort. Follows the main model's thinking-effort semantics: models with strict effort validation (e.g. Kimi models) fall back to their default effort for unsupported values; other providers receive the value as-is |
| Other fields | — | — | Accepts every field of [`[models."<alias>".overrides]`](#models) (`max_context_size`, `max_output_size`, `support_efforts`, …) as a model patch applied only to subagents |

Every field besides `model` forms a patch: when at least one patch field is set, the runtime synthesizes a derived model entry in memory (a copy of the pointed entry with the patch merged into its overrides, patch winning conflicts) and subagents bind that derived entry; with no patch fields, subagents bind the pointed entry directly. The derived entry lives only in memory (never written back to `config.toml`) and is hidden from model-selection lists.

```toml
[secondary_model]
model = "kimi-code/kimi-for-coding"
default_effort = "low"
max_output_size = 8192
```

`model` / `default_effort` can be overridden by the `KIMI_SECONDARY_MODEL` / `KIMI_SECONDARY_EFFORT` environment variables, which take higher priority than `config.toml`.

When the experiment is enabled, the configuration is validated as the session starts: an unresolvable `model`, or a `default_effort` not listed by the (patched) model, produces a startup warning (also returned by the session-warnings API). The check is advisory — a broken secondary model still fails at spawn time, with the same source hint attached to the spawn error.

## `thinking`

`thinking` sets the global default behavior for Thinking mode.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `enabled` | `boolean` | `true` | Whether Thinking is enabled by default for new sessions; set to `false` to force Thinking off |
| `effort` | `string` | — | Thinking effort level (for example `low`, `medium`, `high`, `xhigh`, `max`). Non-Kimi providers do not remap concrete effort values when the upstream protocol accepts them; if the provider rejects the value, choose one that the model supports. Protocols that expose only levels or token budgets still require format conversion. Kimi models with `support_efforts` fall back to their model default when this configured value is not listed; Kimi models without that list treat every enabled value as boolean `on` |
| `keep` | `string` | `"all"` | Preserved Thinking passthrough. On `kimi` it is sent as `thinking.keep`; on `anthropic` (Claude and Kimi's Anthropic-compatible mode) it is sent as a `context_management` `clear_thinking_20251015` edit (enabling keep routes Anthropic requests to the beta Messages API; an off-value disables keep and returns to the standard endpoint). `"all"` preserves prior turns' reasoning (`reasoning_content` / Anthropic thinking blocks); set to an off-value (`false`/`0`/`no`/`off`/`none`/`null`) to disable. Overridden by `KIMI_MODEL_THINKING_KEEP`; only injected while Thinking is on |

### Deprecated fields

| Field | Deprecated in | Description |
| --- | --- | --- |
| `default_thinking` | 0.21.0 | Top-level boolean, replaced by `[thinking] enabled`. Migrate `default_thinking = true` to `enabled = true`, and `default_thinking = false` to `enabled = false`. |
| `thinking.mode` | 0.21.0 | One of `auto` / `on` / `off`, replaced by `[thinking] enabled`. `mode = "off"` becomes `enabled = false`; `mode = "on"` and `mode = "auto"` are equivalent to `enabled = true` (the default) and can be removed. |
| `loop_control.max_retries_per_step` | 0.32.0 | Replaced by `loop_control.max_attempts_per_step` (the value was always a total-attempt limit, including the first try). The old key is ignored and reports a warning on startup; rename it in `config.toml`. |
| `loop_control.max_steps_per_run` | 0.32.0 | Replaced by `loop_control.max_steps_per_turn`. The old key is ignored and reports a warning on startup; rename it in `config.toml`. |

## `loop_control`

`loop_control` governs the step count limit, the per-step attempt limit, and the threshold that triggers automatic context compaction in the Agent execution loop.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `max_steps_per_turn` | `integer` | — | Maximum steps per turn; unset or `0` means unlimited |
| `max_attempts_per_step` | `integer` | `10` | Maximum total attempts for a failing step, including the initial attempt |
| `reserved_context_size` | `integer` | — | Number of tokens reserved for model output; automatic compaction is triggered when the remaining context window falls below this value |

`max_steps_per_turn` can be overridden by the `KIMI_LOOP_MAX_STEPS_PER_TURN` environment variable, and `max_attempts_per_step` by `KIMI_LOOP_MAX_ATTEMPTS_PER_STEP`; both take higher priority than the config file. The former `KIMI_LOOP_MAX_RETRIES_PER_STEP` variable is deprecated but still honored (with a startup warning) when the new one is unset.

Retries only apply to transient failures — connection errors, timeouts, HTTP 429 rate limits, and 5xx server errors. A 429 caused by an exhausted quota or insufficient account balance is not retried and fails immediately, since it cannot succeed until the account is recharged.

## `token_counting`

`token_counting` selects which context token count is reported externally — the value behind the context-size display. Internal logic (automatic compaction triggers, budgets, and overflow backoff) always uses both provider-reported usage and estimates, regardless of this setting.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `strategy` | `"measured+estimated" \| "measured" \| "estimated"` | `"measured+estimated"` | `measured+estimated` reports the live size — the provider-reported usage of each exchange plus an estimate of the not-yet-measured tail — floored by the last measured total; `measured` reports provider usage alone, so the display only moves when an exchange completes; `estimated` reports a pure estimate with provider usage ignored — the fallback for providers that do not report usage or report it unreliably |

`strategy` can be overridden by the `KIMI_TOKEN_COUNTING_STRATEGY` environment variable, which takes higher priority than `config.toml`.

## `background`

`background` controls the concurrency behavior of background tasks (launched via the `Bash` tool or the `Agent` tool's `run_in_background=true` parameter).

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `max_running_tasks` | `integer` | — | Maximum number of background tasks running concurrently |
| `keep_alive_on_exit` | `boolean` | `false` | Whether to keep still-running background tasks when the session closes. By default, Kimi Code requests that all background tasks stop before the process exits; set this to `true` only when you want tasks to outlive the session. In print mode (`kimi -p`), this is only a legacy fallback used when `print_background_mode` is unset: `true` is equivalent to `print_background_mode = "drain"` |
| `kill_grace_period_ms` | `integer` | `5000` | Grace period in milliseconds after session close, a manual stop, or a task timeout requests graceful termination. If a task is still running after this period, Kimi Code attempts to force-stop it |
| `bash_auto_background_on_timeout` | `boolean` | `true` | When a foreground `Bash` command hits its timeout, move it to a background task instead of killing it — the agent is notified when it completes, and the backgrounded command is bounded by the `bash_task_timeout_s` default background timeout. Set to `false` to kill timed-out foreground commands instead |
| `bash_task_timeout_s` | `integer` | `600` | Default timeout (seconds) for background `Bash` tasks when the call omits `timeout`; also used to re-arm foreground commands moved to the background on timeout. `0` means no timeout — the task runs until it exits or the model stops it. Explicit per-call `timeout` values are unaffected. In print mode (`kimi -p`) the default is `0` unless explicitly set |
| `print_background_mode` | `"exit" \| "drain" \| "steer"` | `"steer"` | Print mode (`kimi -p`) only. Governs how pending background tasks are handled once the main agent's turn ends: `"exit"` exits immediately; `"drain"` waits for every background task to reach a terminal state before exiting (results are not fed back to the main agent); `"steer"` stays alive so a completing background task — like a background subagent — injects a synthetic user message that steers the main agent into a new turn, looping until a turn ends with no pending background tasks or a limit is hit. Takes precedence over the `keep_alive_on_exit` print fallback |
| `print_wait_ceiling_s` | `integer` | `2147483` | In print mode (`kimi -p`), the wall-clock ceiling (seconds) for the wait/steer loop when `print_background_mode` is `"drain"` or `"steer"` (the default is ~24.8 days — effectively unbounded). Has no effect outside print mode or when it is `"exit"` |
| `print_max_turns` | `integer` | `100000` | In print mode (`kimi -p`) with `print_background_mode = "steer"`, the maximum number of new turns that may be triggered by background-task completions, to keep the steering loop bounded (the default is effectively unbounded) |

`keep_alive_on_exit` can be overridden by the `KIMI_CODE_BACKGROUND_KEEP_ALIVE_ON_EXIT` environment variable, and `max_running_tasks` by `KIMI_CODE_BACKGROUND_MAX_RUNNING_TASKS`; both take higher priority than `config.toml`.

In print mode (`kimi -p "<prompt>"`), Kimi Code stays alive after the main agent's turn as long as background tasks are still pending: each completion is fed back to the main agent as a synthetic user message, steering it into a new turn (`print_background_mode = "steer"` by default), and the run exits once a turn ends with nothing pending. The loop is bounded by `print_wait_ceiling_s` and `print_max_turns`, both effectively unbounded by default. Background work is never killed by a wall-clock cap in print mode either: background `Bash` tasks default to no timeout (`bash_task_timeout_s = 0`), and subagents run without a timeout (`[subagent] timeout_ms = 0`), so only the model itself stops a task. Set `print_background_mode` to `"drain"` to wait for tasks without feeding results back, or `"exit"` to end the run as soon as the main agent finishes.

## `subagent`

`subagent` controls how spawned subagents (`Agent` / `AgentSwarm`) run.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `timeout_ms` | `integer` | `7200000` (2 hours) | Maximum wall-clock time (milliseconds) a single subagent (`Agent` / `AgentSwarm`) is allowed to run before it is settled as `timed_out`. `0` means no timeout — the subagent runs until it finishes or the model stops it. This is the background-task manager's per-task timeout for each subagent task, so it applies to both foreground and background subagents. In print mode (`kimi -p`) the default is `0` unless explicitly set. Note: any value above `2147483647` (about 24.8 days) is clamped to roughly 24.8 days by the runtime |

`timeout_ms` can be overridden by the `KIMI_SUBAGENT_TIMEOUT_MS` environment variable, which takes higher priority than `config.toml`.

## `mcp`

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `startup_timeout_ms` | `integer` | `30000` (30 seconds) | Global default connection (startup + tool discovery) timeout in milliseconds for all MCP servers. Accepts `1`–`2147483647`. A per-server `startupTimeoutMs` in `mcp.json` always wins over this section and the environment variable; when neither is set, the default applies |
| `tool_timeout_ms` | `integer` | `60000` (60 seconds) | Global default single tool-call timeout in milliseconds for all MCP servers. Accepts `1`–`2147483647`. A per-server `toolTimeoutMs` in `mcp.json` always wins over this section and the environment variable; when neither is set, the client built-in default applies |

`startup_timeout_ms` and `tool_timeout_ms` can be overridden by the `KIMI_MCP_STARTUP_TIMEOUT_MS` and `KIMI_MCP_TOOL_TIMEOUT_MS` environment variables respectively, which take higher priority than `config.toml`. See [MCP](../customization/mcp.md) for the full MCP server configuration.

## `identity`

Customizes how the agent identifies itself. Leave it unset and nothing changes.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `name` | `string` | — | Display name the agent calls itself in the system prompt (fills the `${product_name}` slot, including in your own `SYSTEM.md` and agent files) |
| `slug` | `string` | derived from `name` | Machine identifier used in protocol fields: the `User-Agent` product token sent to third-party providers, and the client name announced to MCP servers. Derived from `name` when omitted: lowercased, with every run of non-alphanumeric characters folded to `-` |

```toml
[identity]
name = "Acme Dev Agent"
slug = "acme-dev"        # optional
```

Both fields can be set through the `KIMI_CODE_IDENTITY_NAME` and `KIMI_CODE_IDENTITY_SLUG` environment variables, which take higher priority than `config.toml` and are never written back to it — convenient for containers and CI, where writing a config file is awkward.

A name that contains no ASCII letters or digits (for example a purely Chinese name) leaves nothing to derive a slug from and falls back to `agent`; write `slug` explicitly if you need a specific protocol token.

The identity is resolved once at startup and holds for the life of the process — it is announced to MCP servers and providers when connections are made, so it cannot change midway. Edits to this section take effect on the next start, for new sessions: a resumed session keeps the system prompt it was recorded with, since its past turns already speak under that identity. Likewise, an MCP OAuth authorization keeps the client registration it was granted under; reset that server's authentication to register under the new identity.

This section is read by the default `agent-core-v2` engine. It is ignored by the legacy `kimi` / `kimi -p` path selected with `KIMI_CODE_LEGACY_FLAG=1`; `kimi web` always uses `agent-core-v2`.

## `tools`

`tools` is the global tool switch: it applies to every agent in all sessions and intersects with each agent's own `tools` / `disallowedTools` policy.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `enabled` | `array<string>` | — | Global allowlist: when non-empty, only the listed tools are available; omitting the field or setting an empty array imposes no constraint |
| `disabled` | `array<string>` | — | Global denylist, applied after `enabled` |

Name matching follows the same rules as the same-named fields in an agent file: built-in tools match by exact name (such as `Read`), and MCP tools match with globs (such as `mcp__github__*`). Three entry shapes never match anything and are reported with a warning: a wildcard outside an `mcp__` pattern (`enabled = ["*"]` disables every tool, `disabled = ["*"]` disables none), an `mcp__` literal missing the tool segment (`mcp__github` — use `mcp__github__*` for a whole server), and a name no registered or built-in tool has (matching is case-sensitive).

```toml
[tools]
disabled = ["EnterPlanMode", "ExitPlanMode", "mcp__github__*"]
```

::: warning Note
Like the `tools` / `disallowedTools` fields of an agent file, this section shapes the tools shown to the model and is enforced again before execution. [Permission rules](#permission) remain a separate control for operations that require approval.
:::

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

`base_url` and `api_key` can also come from environment variables, which take priority over the config file: `KIMI_WEB_SEARCH_BASE_URL` / `KIMI_WEB_SEARCH_API_KEY` for `moonshot_search`, and `KIMI_WEB_FETCH_BASE_URL` / `KIMI_WEB_FETCH_API_KEY` for `moonshot_fetch`. An env base URL defines a separate service endpoint, so the persisted API key, OAuth reference, and custom headers are not forwarded to it; set the matching env API key when that endpoint requires authentication. An env API key without an env base URL keeps the configured endpoint and custom headers but replaces both configured credential forms. Setting the base URL and API key through env without any config section also enables the service.

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
| `theme` | `string` | `auto` | Color theme: `auto` (follow the terminal), `dark`, `light`, or the name of a [custom theme](../customization/themes.md) |
| `render_latex` | `boolean` | `true` | Render LaTeX math expressions (`$…$`, `$$…$$`) in Markdown messages as Unicode text; `false` keeps the raw source |
| `disable_paste_burst` | `boolean` | `false` | Disable the non-bracketed paste-burst fallback that keeps rapid multi-line pastes from submitting line by line |
| `cache_expiry_hint` | `boolean` | `true` | Show a dialog when resuming a long-idle session or submitting after a long idle stretch, warning that the context cache has likely expired and offering to compact or start a new session (v2 engine only) |
| `[editor].command` | `string` | `""` | External editor command for composing long input; empty falls back to `$VISUAL` / `$EDITOR` |
| `[notifications].enabled` | `boolean` | `true` | Whether desktop notifications are sent |
| `[notifications].notification_condition` | `string` | `unfocused` | When to notify: `unfocused` (only when the terminal is not focused) or `always` |
| `[upgrade].auto_install` | `boolean` | `true` | Whether new versions are installed automatically |
| `[status_line].items` | `string[]` | `[]` | Built-in slots to show on the first footer line and their order: `mode`, `goal`, `model`, `tasks`, `cwd`, `git`, `tips`. Unset keeps the default layout; unknown ids are skipped with a warning |
| `[status_line].command` | `string` | `""` | Custom status line command. Its first stdout line replaces the first footer line, with a JSON snapshot (model, cwd, git branch, permission mode, plan mode, context usage, session id, version) passed on stdin. Runs are capped at 300ms and throttled to once per second; failures fall back to the built-in layout |

```toml
# ~/.kimi-code/tui.toml
theme = "auto" # "auto" | "dark" | "light" | custom theme name
render_latex = true # false keeps LaTeX math in messages as raw source
disable_paste_burst = false # true disables non-bracketed paste-burst fallback
cache_expiry_hint = true # false disables the "cache expired" dialog on resume / idle submit

[editor]
command = "" # empty uses $VISUAL / $EDITOR

[notifications]
enabled = true
notification_condition = "unfocused" # "unfocused" | "always"

[upgrade]
auto_install = true

# [status_line]
# items = ["mode", "goal", "model", "tasks", "cwd", "git", "tips"]
# command = "~/.kimi-code/statusline.sh"
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
