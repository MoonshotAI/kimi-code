# Environment variables

Kimi Code CLI uses environment variables to control a small number of runtime behaviors — relocating the data directory, turning off telemetry, and temporarily switching models without touching the config file.

::: warning Important: API keys are not configured here
Credential variables such as `KIMI_API_KEY`, `ANTHROPIC_API_KEY`, and `OPENAI_API_KEY` are **not** read automatically from shell environment variables. Running `export KIMI_API_KEY=xxx` in the terminal does not give any provider its key — they must be written in `config.toml` under `[providers.<name>]` or the `[providers.<name>.env]` sub-table.

The only exception is the `KIMI_MODEL_*` family, which is an explicit channel that *does* read credentials from the shell — see [Define a model from environment variables](#define-a-model-from-environment-variables-kimi-model).

For background, see [Config overrides: provider credentials](./overrides.md#provider-credentials).
:::

## Core paths

### `KIMI_CODE_HOME`

Overrides the data root directory; the default is `~/.kimi-code`. Once set, the config file, sessions, logs, OAuth credentials, and all other data land under the new path:

```sh
export KIMI_CODE_HOME="/path/to/custom/kimi-code"
```

> Make sure the directory is writable. Multiple `kimi` instances sharing the same `KIMI_CODE_HOME` will share config and credential files.

For the complete data directory structure, see [Data locations](./data-locations.md).

### `KIMI_DISABLE_TELEMETRY`

Set to `1` to turn off anonymous telemetry reporting (also accepts `true`, `yes`, `y`, case-insensitive):

```sh
export KIMI_DISABLE_TELEMETRY=1
```

### `KIMI_MODEL_*` family

Switch models temporarily without modifying `config.toml` — when `KIMI_MODEL_NAME` is set, the CLI synthesizes a temporary provider in memory; the change does not persist after restart. See [Define a model from environment variables](#define-a-model-from-environment-variables-kimi_model).

## Provider credential key names (written in config.toml)

The key names below are not read directly from the shell — they are key names written inside the `[providers.<name>.env]` sub-table of `config.toml`, serving as fallback values for `api_key` / `base_url`. The CLI reads only from the config file, not from `process.env`.

This design lets you keep familiar key name conventions while centralizing secret management in the config file:

```toml
[providers.kimi.env]
KIMI_API_KEY = "sk-xxx"
KIMI_BASE_URL = "https://api.moonshot.ai/v1"
```

Key names per provider:

| Key | Applicable provider | Default |
| --- | --- | --- |
| `KIMI_API_KEY` | Kimi / Moonshot | None |
| `KIMI_BASE_URL` | Kimi / Moonshot | `https://api.moonshot.ai/v1` |
| `ANTHROPIC_API_KEY` | Anthropic | None |
| `ANTHROPIC_BASE_URL` | Anthropic | Follows Anthropic SDK default |
| `OPENAI_API_KEY` | OpenAI (`openai` and `openai_responses`) | None |
| `OPENAI_BASE_URL` | OpenAI (`openai` and `openai_responses`) | `https://api.openai.com/v1` |
| `GOOGLE_API_KEY` | Google GenAI, Vertex AI | None |
| `VERTEXAI_API_KEY` | Vertex AI | None |
| `GOOGLE_CLOUD_PROJECT` | Vertex AI | None |
| `GOOGLE_CLOUD_LOCATION` | Vertex AI | None |

::: warning
`GOOGLE_APPLICATION_CREDENTIALS` (path to a service account JSON file) is the only exception that goes through the system environment variable mechanism — it is read by the Google SDK directly via the standard ADC flow, and the CLI does not participate. All other key names must be placed in the `[providers.<name>.env]` sub-table to take effect.
:::

For the full provider type and field reference, see [Providers and models](./providers.md).

## OAuth and managed services

This group of variables redirects OAuth authentication and managed service endpoints to a self-hosted or test environment. They are not needed for everyday use.

| Variable | Purpose | Default |
| --- | --- | --- |
| `KIMI_CODE_OAUTH_HOST` | OAuth auth host; highest priority | Falls back to `KIMI_OAUTH_HOST` when unset |
| `KIMI_OAUTH_HOST` | OAuth auth host; fallback for `KIMI_CODE_OAUTH_HOST` | Falls back to `https://auth.kimi.com` when unset |
| `KIMI_CODE_BASE_URL` | Managed API base URL used after OAuth login | `https://api.kimi.com/coding/v1` |

::: warning
`KIMI_CODE_BASE_URL` (OAuth-managed service, targeting `kimi.com`) and `KIMI_BASE_URL` (direct API key connection, targeting `moonshot.ai`) are two distinct variables. Use each one in its appropriate context.
:::

## Define a model from environment variables (`KIMI_MODEL_*`)

Want to switch models for testing without touching `config.toml`? When `KIMI_MODEL_NAME` is set, the CLI synthesizes a temporary provider and model alias from the `KIMI_MODEL_*` variables in memory — nothing is written back to the config file. These variables take priority over `default_model` in `config.toml`, but the `-m <alias>` option at startup still has the highest priority.

```sh
export KIMI_MODEL_NAME="kimi-for-coding"
export KIMI_MODEL_API_KEY="YOUR_API_KEY"
export KIMI_MODEL_BASE_URL="https://api.example.com/v1"
export KIMI_MODEL_MAX_CONTEXT_SIZE="262144"
export KIMI_MODEL_CAPABILITIES="image_in,thinking"
kimi
```

Complete variable list:

| Variable | Required | Purpose | Default |
| --- | --- | --- | --- |
| `KIMI_MODEL_NAME` | Yes (also the enable switch) | Model id sent to the API | — |
| `KIMI_MODEL_API_KEY` | Yes | API key | — |
| `KIMI_MODEL_PROVIDER_TYPE` | No | Provider type: `kimi`, `anthropic`, `openai` | `kimi` |
| `KIMI_MODEL_BASE_URL` | No | API base URL | Each type has its own default |
| `KIMI_MODEL_MAX_CONTEXT_SIZE` | No | Maximum context length (tokens) | `262144` (256 K) |
| `KIMI_MODEL_CAPABILITIES` | No | Comma-separated capability tags, unioned with auto-detected capabilities | `image_in,thinking` |
| `KIMI_MODEL_DISPLAY_NAME` | No | Name shown in `/model` | Falls back to `KIMI_MODEL_NAME` |
| `KIMI_MODEL_MAX_OUTPUT_SIZE` | No | Per-request output cap (`anthropic` only) | Model default |
| `KIMI_MODEL_REASONING_KEY` | No | Reasoning field name override (`openai` only) | Auto-detected |
| `KIMI_MODEL_THINKING_EFFORT` | No | Thinking effort level: `low`/`medium`/`high`/`xhigh`/`max` | — |
| `KIMI_MODEL_ADAPTIVE_THINKING` | No | Force adaptive thinking on or off (`anthropic` only) | Inferred from model name |

If `KIMI_MODEL_NAME` is set but a required variable is missing, startup fails immediately with a clear error message.

## Runtime switches

Switches that control the behavior of subsystems such as telemetry, background tasks, and the plugin marketplace:

| Variable | Purpose | Valid values |
| --- | --- | --- |
| `KIMI_DISABLE_TELEMETRY` | Disable anonymous telemetry reporting | `1`, `true`, `yes`, `y` (case-insensitive) |
| `KIMI_CODE_BACKGROUND_KEEP_ALIVE_ON_EXIT` | Whether to keep background tasks when the session closes; takes higher priority than `config.toml`. The default is to stop them on exit | Truthy: `1`/`true`/`yes`/`on`; falsy: `0`/`false`/`no`/`off` |
| `KIMI_CODE_PLUGIN_MARKETPLACE_URL` | Override the plugin marketplace JSON loaded by `/plugins`; useful for dev loopback servers, staging CDN files, or alternate marketplace directories | `https://code.kimi.com/kimi-code/plugins/marketplace.json`; also accepts `http://`, `file://` URLs, and local paths |
| `KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY` | Cap how many AgentSwarm subagents run concurrently during the initial ramp; leave unset for no cap | Positive integer; invalid values fail fast |
| `KIMI_CODE_EXPERIMENTAL_FLAG` | Enable all registered experimental features for this process | `1`, `true`, `yes`, `on` |
| `KIMI_CODE_EXPERIMENTAL_MICRO_COMPACTION` | Override [`[experimental].micro_compaction`](./config-files.md#experimental) for this process | Truthy or falsy |
| `KIMI_SHELL_PATH` | Override the Git Bash path on Windows (used when auto-detection fails) | Absolute path |
| `KIMI_MODEL_MAX_COMPLETION_TOKENS` | Hard cap on `max_completion_tokens` per LLM step; applies to the `kimi` provider only | Positive integer; `0` or negative disables clamping |
| `KIMI_MODEL_TEMPERATURE` | Sampling temperature for every request; applies to the `kimi` provider only (global — independent of `KIMI_MODEL_NAME`) | Number, e.g. `0.3` |
| `KIMI_MODEL_TOP_P` | Nucleus-sampling `top_p` for every request; applies to the `kimi` provider only (global) | Number, e.g. `0.95` |
| `KIMI_MODEL_THINKING_EFFORT` | Force a specific thinking effort on the wire (`thinking.effort`), bypassing the model's declared `support_efforts`; applies to the `kimi` provider only, and only while Thinking is on | An effort value, e.g. `max` |
| `KIMI_MODEL_THINKING_KEEP` | Moonshot preserved-thinking passthrough (`thinking.keep`); applies to the `kimi` provider only, and only while Thinking is on | A value the API accepts, e.g. `all` |
| `KIMI_CODE_NO_AUTO_UPDATE` | Fully disable the update preflight — no check, background install, or prompt. Legacy alias `KIMI_CLI_NO_AUTO_UPDATE` is also honored | Truthy: `1`/`true`/`yes`/`on` |
| `KIMI_DISABLE_CRON` | Disable the scheduled-task tool (`CronCreate` rejects new schedules; existing tasks do not fire) | `1` to disable |

## Diagnostic logs

These variables control log level and file rotation, read once at process startup:

| Variable | Purpose | Default |
| --- | --- | --- |
| `KIMI_LOG_LEVEL` | Log level: `off`, `error`, `warn`, `info`, `debug` | `info` |
| `KIMI_LOG_GLOBAL_MAX_BYTES` | Maximum bytes per global log file | `6291456` (6 MB) |
| `KIMI_LOG_GLOBAL_FILES` | Number of global log files to retain | `5` |
| `KIMI_LOG_SESSION_MAX_BYTES` | Maximum bytes per session log file | `5242880` (5 MB) |
| `KIMI_LOG_SESSION_FILES` | Number of session log files to retain | `3` |

## System environment variables

The CLI also reads several standard system variables to detect the runtime environment; it does not modify them:

- `HOME`: used to resolve the default data path
- `VISUAL`, `EDITOR`: external editor command (`VISUAL` takes precedence)
- `PATH`: used to locate dependencies such as `rg`, `fd`, `fdfind`, and `git`; on Windows, Git Bash detection checks each `git.exe` found on `PATH`, including package-manager shims such as Scoop
- `NO_COLOR`, `FORCE_COLOR`: control color output (following the [no-color.org](https://no-color.org) convention)
- `CI`: when non-empty and not `"0"`, disables theme detection and falls back to the dark theme
- `TERM_PROGRAM`, `TERM`, `TMUX`: detect terminal features and notification support
- `DISPLAY`, `WAYLAND_DISPLAY`, `XDG_SESSION_TYPE`: detect Linux graphical sessions (for clipboard and image features)
- `WSL_DISTRO_NAME`, `WSLENV`: detect WSL for the clipboard PowerShell bridge
- `LOCALAPPDATA`: used on Windows as a fallback when probing for the Git Bash installation path

## HTTP proxy

Kimi Code honors the standard proxy environment variables for all outbound traffic — model API calls, MCP servers, web tools, telemetry, sign-in, and update checks:

- `HTTP_PROXY` / `http_proxy`: proxy for `http://` requests
- `HTTPS_PROXY` / `https_proxy`: proxy for `https://` requests
- `ALL_PROXY` / `all_proxy`: fallback proxy used when the scheme-specific variable is unset; this is where a SOCKS proxy is usually set
- `NO_PROXY` / `no_proxy`: comma-separated hosts that bypass the proxy

Both HTTP(S) and SOCKS proxies are supported. A SOCKS proxy is recognized by its scheme — `socks5://`, `socks5h://`, `socks4://`, or `socks://` (an alias for `socks5://`) — and is typically set via `ALL_PROXY` (the form used by tools like Clash and V2RayN). An HTTP(S) proxy takes precedence over `ALL_PROXY` for HTTP/HTTPS traffic.

The proxy is applied only when one of these variables is set; otherwise connections are made directly. Loopback hosts (`localhost`, `127.0.0.1`, `::1`) always bypass the proxy, so a local server such as a localhost MCP server keeps working when a proxy is configured — add your own internal hosts to `NO_PROXY` to exempt them too.

Stdio MCP servers that run as Node child processes honor `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` automatically when the child's Node version supports `NODE_USE_ENV_PROXY` (Node ≥ 22.21 or ≥ 24.5); SOCKS proxying applies to Kimi Code's own traffic only.

## Next steps

- [Config overrides](./overrides.md) — how environment variables, CLI options, and the config file interact by priority
- [Data locations](./data-locations.md) — directory structure affected by `KIMI_CODE_HOME`
- [Providers and models](./providers.md) — full connection examples per provider type
