# Environment variables

Kimi Code CLI uses environment variables to override default paths, switch OAuth endpoints, and adjust runtime behavior. Most variables are read when the `kimi` process starts up; a few (such as the telemetry switch, the OAuth lock, and diagnostic logging) are read when the relevant subsystem initializes. Kimi's own variables use the `KIMI_*` prefix; in addition, the CLI also reads a number of standard system variables.

::: warning Note
**Provider credentials are not in this list**: key variables such as `KIMI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and `GOOGLE_API_KEY` are **not** read automatically from `process.env`. They must be written into the `[providers.<name>]` section of `config.toml` (as `api_key` / `base_url`) or into the `[providers.<name>.env]` subtable; merely `export`ing them in your shell will not give a provider credentials automatically. See [Configuration overrides](./overrides.md#provider-credentials) and [Providers](./providers.md) for details. **Exception:** the `KIMI_MODEL_*` variables are an explicit channel that *does* read a model and its credentials from the shell — see [Define a model from environment variables](#define-a-model-from-environment-variables-kimi-model).
:::

## Core paths

`KIMI_CODE_HOME` overrides Kimi Code CLI's data root directory, defaulting to `~/.kimi-code`. The CLI's own application data, `kimi-core`'s config, the ripgrep cache, and OAuth credentials all land under this directory.

```sh
export KIMI_CODE_HOME="/path/to/custom/kimi-code"
```

For details on the data layout, see [Data locations](./data-locations.md).

::: warning Note
Make sure the directory is writable once you set it. Multiple `kimi` instances that share the same `KIMI_CODE_HOME` will share both the config and credential files.
:::

## Provider credential key names

The following key names appear in the `[providers.<name>.env]` subtable of `config.toml`, where they serve as fallback sources for the provider's `api_key` / `base_url`. **The main `kimi` process does not read them directly from `process.env`**; only the values keyed under a `[providers.<name>.env]` subtable are recognized by the provider clients. See [Configuration overrides: provider credentials](./overrides.md#provider-credentials) for the full resolution order.

| Key name | Applicable provider | Purpose | Default |
| --- | --- | --- | --- |
| `KIMI_API_KEY` | Kimi / Moonshot | API key | None |
| `KIMI_BASE_URL` | Kimi / Moonshot | API base URL | `https://api.moonshot.ai/v1` |
| `ANTHROPIC_API_KEY` | Anthropic | API key | None |
| `ANTHROPIC_BASE_URL` | Anthropic | API base URL | Follows the Anthropic SDK default |
| `OPENAI_API_KEY` | OpenAI (used by both `openai` and `openai_responses`) | API key | None |
| `OPENAI_BASE_URL` | OpenAI (used by both `openai` and `openai_responses`) | API base URL | `https://api.openai.com/v1` |
| `GOOGLE_API_KEY` | Google GenAI, Vertex AI (as a fallback for `VERTEXAI_API_KEY`) | API key | None |
| `VERTEXAI_API_KEY` | Vertex AI | API key (when not using ADC) | None |
| `GOOGLE_CLOUD_PROJECT` | Vertex AI | GCP project ID | None |
| `GOOGLE_CLOUD_LOCATION` | Vertex AI | GCP region | None |

For example, to pre-populate Kimi credentials in `config.toml`:

```toml
[providers.kimi.env]
KIMI_API_KEY = "sk-xxx"
KIMI_BASE_URL = "https://api.moonshot.ai/v1"
```

::: warning Note
`GOOGLE_APPLICATION_CREDENTIALS` (the path to a service-account JSON file) is read by the Google SDK itself from the shell environment, making it the **only** key in this group that goes through a system environment variable. It follows Google Cloud's standard ADC flow, and the CLI is not involved in resolving it. Every other key only takes effect when written into a `[providers.<name>.env]` subtable.
:::

For the full description of provider types and fields, see [Providers](./providers.md).

## OAuth and the hosted service

The OAuth flow connects to Kimi's official authentication and hosted endpoints by default. The variables below can point them at a self-hosted or test environment.

| Environment variable | Purpose | Default |
| --- | --- | --- |
| `KIMI_CODE_OAUTH_HOST` | OAuth authentication host; takes the highest precedence | — (falls back to `KIMI_OAUTH_HOST`, then to the hardcoded default below) |
| `KIMI_OAUTH_HOST` | OAuth authentication host; used as a fallback for `KIMI_CODE_OAUTH_HOST` | — (falls back to the hardcoded default below) |
| `KIMI_CODE_BASE_URL` | Base URL of the hosted Kimi API, used for API calls after OAuth login | `https://api.kimi.com/coding/v1` |

When neither `KIMI_CODE_OAUTH_HOST` nor `KIMI_OAUTH_HOST` is set, the OAuth authentication host uses the hardcoded constant `https://auth.kimi.com`.

::: warning Note
`KIMI_CODE_BASE_URL` and the `KIMI_BASE_URL` from the previous section are two different variables: the former targets the OAuth-logged-in hosted service and defaults to `kimi.com`; the latter targets providers that use a Kimi API key directly and defaults to `moonshot.ai`. Distinguish them by use case.
:::

## Define a model from environment variables (`KIMI_MODEL_*`)

For testing you can make Kimi Code use a specific model **without editing `config.toml` at all**. When `KIMI_MODEL_NAME` is set, the CLI synthesizes one provider and one model alias from the `KIMI_MODEL_*` variables — in memory only, nothing is written back to `config.toml` — and selects it as the default model. These variables take priority over `default_model` in `config.toml`; a `-m <alias>` flag still wins for that launch.

| Environment variable | Required | Purpose | Default |
| --- | --- | --- | --- |
| `KIMI_MODEL_NAME` | Yes (also the enable switch) | Model id sent to the API | — |
| `KIMI_MODEL_API_KEY` | Yes | API key | — |
| `KIMI_MODEL_PROVIDER_TYPE` | No | Provider type; one of `kimi`, `anthropic`, `openai` | `kimi` |
| `KIMI_MODEL_BASE_URL` | No | API base URL | `kimi` → `https://api.moonshot.ai/v1`; `openai` → `https://api.openai.com/v1`; `anthropic` → SDK default |
| `KIMI_MODEL_MAX_CONTEXT_SIZE` | No | Max context length in tokens (positive integer) | `262144` (256K) |
| `KIMI_MODEL_CAPABILITIES` | No | Comma-separated capability tags (e.g. `image_in,thinking`); unioned with auto-detected capabilities | `image_in,thinking` |
| `KIMI_MODEL_DISPLAY_NAME` | No | Name shown in `/model` | Falls back to `KIMI_MODEL_NAME` |
| `KIMI_MODEL_MAX_OUTPUT_SIZE` | No | Per-request output cap (`anthropic` only) | Per-model default |
| `KIMI_MODEL_REASONING_KEY` | No | Reasoning field-name override (`openai` only) | Auto-detected |
| `KIMI_MODEL_DEFAULT_THINKING` | No | Default Thinking toggle for new sessions | Unset follows the global default (Thinking on) |
| `KIMI_MODEL_THINKING_MODE` | No | Thinking trigger policy; `auto`/`on`/`off` | — |
| `KIMI_MODEL_THINKING_EFFORT` | No | Thinking effort (e.g. `low`/`medium`/`high`/`xhigh`/`max`; available levels depend on the provider) | — |

The synthesized entries use the reserved keys `__kimi_env__` (provider) and `__kimi_env_model__` (model alias). When `KIMI_MODEL_NAME` is set but a required variable is missing or invalid, startup fails with a clear error.

```sh
export KIMI_MODEL_NAME="kimi-for-coding"
export KIMI_MODEL_BASE_URL="https://api-staff.msh.team/v1"
export KIMI_MODEL_API_KEY="$MOONSHOT_STAFF_KEY"
export KIMI_MODEL_MAX_CONTEXT_SIZE="262144"
export KIMI_MODEL_CAPABILITIES="image_in,thinking"
kimi
```

## Runtime switches

| Environment variable | Purpose | Valid values / Default |
| --- | --- | --- |
| `KIMI_DISABLE_TELEMETRY` | Disable telemetry reporting | `1`, `true`, `t`, `yes`, `y` (case-insensitive) |
| `KIMI_CODE_BACKGROUND_KEEP_ALIVE_ON_EXIT` | Override `[background].keep_alive_on_exit`, controlling whether still-running background tasks are kept when the session closes | True values: `1`, `true`, `yes`, `on`; false values: `0`, `false`, `no`, `off`; when unset, reads `config.toml`, then falls back to `true` |
| `KIMI_CODE_PLUGIN_MARKETPLACE_URL` | Override the plugin marketplace JSON loaded by `/plugins`; useful for dev loopback servers, staging CDN files, or alternate marketplace directories | `https://cdn.kimi.com/kimi-code/plugins/marketplace.json`; also accepts `http://`, `file://` URLs, and local paths |
| `KIMI_SHELL_PATH` | Override the absolute path to Git Bash (`bash.exe`) on Windows; only needed when auto-detection fails on Windows | None |
| `KIMI_MODEL_MAX_COMPLETION_TOKENS` | Explicit hard cap for `max_completion_tokens` in a single-step LLM request. When unset, Kimi Code uses the safe remaining context window for models with a known context size. Set to `0` or a negative value to disable clamping entirely. **Currently effective only for providers of type `kimi`**; for Anthropic and other providers, use `[models.<alias>].max_output_size` instead (see [Config files](./config-files.md#models)) | Unset: computed from remaining context; unknown context falls back to `loop_control.reserved_context_size`, then 32000 |
| `KIMI_DISABLE_CRON` | Disable the scheduled-task tools entirely. Set to `1` to make `CronCreate` reject new schedules and short-circuit the scheduler's tick loop; existing tasks remain on disk but never fire while the variable is set. See [Scheduled tasks](../reference/tools.md#scheduled-tasks) | `1` to disable; unset by default |

For example, to disable telemetry on a shared host:

```sh
export KIMI_DISABLE_TELEMETRY="1"
```

`KIMI_CODE_BACKGROUND_KEEP_ALIVE_ON_EXIT` has higher priority than `config.toml`. For example, running `KIMI_CODE_BACKGROUND_KEEP_ALIVE_ON_EXIT=0 kimi -p "..."` temporarily requests stopping background tasks before this process exits, even if the config file sets `keep_alive_on_exit = true`.
## Diagnostic logging

The variables below control `kimi`'s diagnostic logs. Logs are written to two locations: the global diagnostic log at `$KIMI_CODE_HOME/logs/kimi-code.log`, and each session's own diagnostic log at `<sessionDir>/logs/kimi-code.log` (see [Data locations](./data-locations.md#logs-and-update-state) for path details). All of these variables are read only once at process startup.

| Environment variable | Purpose | Default |
| --- | --- | --- |
| `KIMI_LOG_LEVEL` | Log level; one of `off`, `error`, `warn`, `info`, `debug` | `info` |
| `KIMI_LOG_GLOBAL_MAX_BYTES` | Maximum bytes per global log file | `6291456` (6 MB) |
| `KIMI_LOG_GLOBAL_FILES` | Number of global log files to retain | `5` |
| `KIMI_LOG_SESSION_MAX_BYTES` | Maximum bytes per session log file | `5242880` (5 MB) |
| `KIMI_LOG_SESSION_FILES` | Number of session log files to retain | `3` |

When an integer variable fails to parse (non-positive integer or non-numeric), it silently falls back to the default value.

## Clipboard bridge

`KIMI_WSL_CLIPBOARD_IMAGE_PATH` is injected automatically by the CLI when it spawns the WSL clipboard helper subprocess, used to pass a temporary image path. The variable is written into the PowerShell subprocess's environment and read by the subprocess script internally; the main `kimi` process does not read this variable itself. Setting it in an external shell has **no effect** on the main `kimi` process — users do not need to manage this variable manually.

## System environment variables

Kimi Code CLI also reads a handful of standard system environment variables to detect the runtime environment and pick default behavior:

- `HOME`: the user's home directory, used to resolve the default data path.
- `VISUAL`, `EDITOR`: the executable invoked as the external editor, with `VISUAL` taking precedence.
- `PATH`: used to locate external dependencies such as `rg` and `git`.
- `NO_COLOR`: when set and non-empty, forces color and theme detection off, falling back to the dark theme. Follows the [no-color.org](https://no-color.org) convention.
- `FORCE_COLOR`: when set to `"0"`, also disables color and theme detection, falling back to the dark theme.
- `CI`: when non-empty and not `"0"`, disables theme detection and falls back to the dark theme; the telemetry module also reads this variable to mark the CI environment.
- `LANG`: used to tag the locale in the telemetry context (purely as a tag; it does not change CLI behavior).
- `TERM_PROGRAM`: used to detect terminal support for OSC 9 notifications (iTerm2, WezTerm, ghostty, WarpTerminal, etc.); also written into the telemetry context.
- `TERM`: used to detect terminal support for OSC 9 notifications (xterm-kitty, xterm-ghostty, etc.).
- `TMUX`: detects whether the CLI is running inside tmux, used for the terminal notification path.
- `COLORFGBG`: detects the terminal color scheme (dark / light).
- `DISPLAY`, `WAYLAND_DISPLAY`, `XDG_SESSION_TYPE`: detect a Linux graphical session, used by clipboard and image-related features. A `XDG_SESSION_TYPE` value of `wayland` is also treated as a Wayland session.
- `WSL_DISTRO_NAME`, `WSLENV`: detect whether the CLI is running inside WSL, used for the PowerShell-bridged clipboard fallback.
- `TERMUX_VERSION`: detects whether the CLI is running inside Termux.
- `LOCALAPPDATA`: used on Windows when probing for the Git Bash installation path.

These variables follow the usual conventions of each operating system; `kimi` only reads them and never modifies them.
