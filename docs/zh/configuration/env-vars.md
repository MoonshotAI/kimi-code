# 环境变量

Kimi Code CLI 通过环境变量来覆盖默认路径、切换 OAuth 端点以及调整运行时行为。大部分变量在 `kimi` 进程启动时读取，少数（如遥测开关、OAuth 锁、诊断日志）在相关子系统初始化时读取。Kimi 自有变量使用 `KIMI_*` 前缀；此外，CLI 也会读取若干系统标准变量。

::: warning 注意
**供应商凭证不在此列**：`KIMI_API_KEY`、`ANTHROPIC_API_KEY`、`OPENAI_API_KEY`、`GOOGLE_API_KEY` 等密钥变量**不会**从 `process.env` 自动读取。它们必须写在 `config.toml` 的 `[providers.<name>]` 段（`api_key` / `base_url`）或 `[providers.<name>.env]` 子表中；仅在 shell 中 `export` 不会让某个供应商自动获得凭证。详见 [配置覆盖](./overrides.md#供应商凭证) 与 [供应商](./providers.md)。**例外：** `KIMI_MODEL_*` 这组变量是一个显式通道，*确实*会从 shell 读取一个模型及其凭证 —— 详见 [用环境变量定义模型](#用环境变量定义模型-kimi-model)。
:::

## 核心路径

`KIMI_CODE_HOME` 用于覆盖 Kimi Code CLI 的数据根目录，默认值是 `~/.kimi-code`。CLI 自身的应用数据、`kimi-core` 的配置、ripgrep 缓存以及 OAuth 凭证都会落在这个目录下。

```sh
export KIMI_CODE_HOME="/path/to/custom/kimi-code"
```

数据布局的详细说明请参阅 [数据路径](./data-locations.md)。

::: warning 注意
设置后请确保目录可写。多个 `kimi` 实例如果共享同一个 `KIMI_CODE_HOME`，会共享配置与凭证文件。
:::

## 供应商凭证键名

下列键名出现在 `config.toml` 的 `[providers.<name>.env]` 子表中，用作供应商 `api_key` / `base_url` 的回退来源。**`kimi` 主进程不会从 `process.env` 直接读取它们**；只有 `[providers.<name>.env]` 子表内对应键的值才会被供应商客户端识别。详细解析顺序见 [配置覆盖：供应商凭证](./overrides.md#供应商凭证)。

| 键名 | 适用供应商 | 用途 | 默认值 |
| --- | --- | --- | --- |
| `KIMI_API_KEY` | Kimi / Moonshot | API 密钥 | 无 |
| `KIMI_BASE_URL` | Kimi / Moonshot | API 基础 URL | `https://api.moonshot.ai/v1` |
| `ANTHROPIC_API_KEY` | Anthropic | API 密钥 | 无 |
| `ANTHROPIC_BASE_URL` | Anthropic | API 基础 URL | 跟随 Anthropic SDK 默认值 |
| `OPENAI_API_KEY` | OpenAI（`openai` 与 `openai_responses` 均使用） | API 密钥 | 无 |
| `OPENAI_BASE_URL` | OpenAI（`openai` 与 `openai_responses` 均使用） | API 基础 URL | `https://api.openai.com/v1` |
| `GOOGLE_API_KEY` | Google GenAI、Vertex AI（作为 `VERTEXAI_API_KEY` 的备用） | API 密钥 | 无 |
| `VERTEXAI_API_KEY` | Vertex AI | API 密钥（未使用 ADC 时） | 无 |
| `GOOGLE_CLOUD_PROJECT` | Vertex AI | GCP 项目 ID | 无 |
| `GOOGLE_CLOUD_LOCATION` | Vertex AI | GCP 区域 | 无 |

例如在 `config.toml` 中预置 Kimi 凭证：

```toml
[providers.kimi.env]
KIMI_API_KEY = "sk-xxx"
KIMI_BASE_URL = "https://api.moonshot.ai/v1"
```

::: warning 注意
`GOOGLE_APPLICATION_CREDENTIALS`（服务账号 JSON 路径）由 Google SDK 自身从终端环境变量中读取，是这组键名中**唯一**走系统环境变量的；它走的是 Google Cloud 标准的 ADC 流程，CLI 不参与解析。其它键名都需要写在 `[providers.<name>.env]` 子表里才会生效。
:::

供应商类型与字段的完整说明请参阅 [供应商](./providers.md)。

## OAuth 与托管服务

OAuth 流程默认连接 Kimi 官方的认证与托管端点，下列变量可以将它们指向自建或测试环境。

| 环境变量 | 用途 | 默认值 |
| --- | --- | --- |
| `KIMI_CODE_OAUTH_HOST` | OAuth 认证 host，优先级最高 | —（未设置时回退到 `KIMI_OAUTH_HOST`，再回退到下面的硬编码默认） |
| `KIMI_OAUTH_HOST` | OAuth 认证 host，作为 `KIMI_CODE_OAUTH_HOST` 的 fallback | —（未设置时回退到下面的硬编码默认） |
| `KIMI_CODE_BASE_URL` | 托管 Kimi API 的 base URL，用于 OAuth 登录后的 API 调用 | `https://api.kimi.com/coding/v1` |

当 `KIMI_CODE_OAUTH_HOST` 和 `KIMI_OAUTH_HOST` 都未设置时，OAuth 认证 host 使用硬编码常量 `https://auth.kimi.com`。

::: warning 注意
`KIMI_CODE_BASE_URL` 与上一节的 `KIMI_BASE_URL` 是两个不同变量：前者面向 OAuth 登录的托管服务，默认指向 `kimi.com`；后者面向直接使用 Kimi API 密钥的供应商，默认指向 `moonshot.ai`。请按场景区分。
:::

## 用环境变量定义模型(`KIMI_MODEL_*`)

为了便于测试，你可以**完全不修改 `config.toml`** 就让 Kimi Code 使用指定的模型。当设置了 `KIMI_MODEL_NAME` 时，CLI 会从 `KIMI_MODEL_*` 变量合成出一个供应商和一个模型别名 —— 仅存在于内存中，不会写回 `config.toml` —— 并将其选为默认模型。这些变量的优先级高于 `config.toml` 中的 `default_model`；而 `-m <alias>` 选项在本次启动中仍然优先。

| 环境变量 | 必填 | 用途 | 默认值 |
| --- | --- | --- | --- |
| `KIMI_MODEL_NAME` | 是（同时是启用开关） | 发送给 API 的模型 id | — |
| `KIMI_MODEL_API_KEY` | 是 | API 密钥 | — |
| `KIMI_MODEL_PROVIDER_TYPE` | 否 | 供应商类型，可选 `kimi`、`anthropic`、`openai` | `kimi` |
| `KIMI_MODEL_BASE_URL` | 否 | API 基础 URL | `kimi` → `https://api.moonshot.ai/v1`；`openai` → `https://api.openai.com/v1`；`anthropic` → SDK 默认值 |
| `KIMI_MODEL_MAX_CONTEXT_SIZE` | 否 | 最大上下文长度（token 数，正整数） | `262144`（256K） |
| `KIMI_MODEL_CAPABILITIES` | 否 | 逗号分隔的能力标签（如 `image_in,thinking`）；与自动探测的能力做并集 | `image_in,thinking` |
| `KIMI_MODEL_DISPLAY_NAME` | 否 | 在 `/model` 中显示的名称 | 回退到 `KIMI_MODEL_NAME` |
| `KIMI_MODEL_MAX_OUTPUT_SIZE` | 否 | 单次请求的输出上限（仅 `anthropic`） | 模型默认值 |
| `KIMI_MODEL_REASONING_KEY` | 否 | 推理字段名覆盖（仅 `openai`） | 自动探测 |
| `KIMI_MODEL_DEFAULT_THINKING` | 否 | 新会话的默认 Thinking 开关 | 未设时跟随全局默认（Thinking 开启） |
| `KIMI_MODEL_THINKING_MODE` | 否 | Thinking 触发策略，可选 `auto`/`on`/`off` | — |
| `KIMI_MODEL_THINKING_EFFORT` | 否 | Thinking 强度（如 `low`/`medium`/`high`/`xhigh`/`max`；实际可用等级由供应商决定） | — |
| `KIMI_MODEL_ADAPTIVE_THINKING` | 否 | 强制开启或关闭 adaptive thinking（`thinking: { type: 'adaptive' }`），覆盖按模型名推断版本的逻辑（仅 `anthropic`） | 按模型名推断（Claude ≥ 4.6 使用 adaptive） |

合成出的条目使用保留键 `__kimi_env__`（供应商）和 `__kimi_env_model__`（模型别名）。当设置了 `KIMI_MODEL_NAME` 但缺少必填变量或变量取值非法时，启动会以清晰的错误信息失败。

当某个自定义命名的 Anthropic 兼容端点背后的模型支持 adaptive thinking、但其模型名无法解析出可识别的 Claude 版本（否则自动推断会回退到 budget 模式）时，设置 `KIMI_MODEL_ADAPTIVE_THINKING=true`。若对**不支持** adaptive thinking 的端点强制开启，API 会直接拒绝请求；因此在不确定背后模型是否支持时，请保持该变量为未设置。

```sh
export KIMI_MODEL_NAME="kimi-for-coding"
export KIMI_MODEL_BASE_URL="https://api-staff.msh.team/v1"
export KIMI_MODEL_API_KEY="$MOONSHOT_STAFF_KEY"
export KIMI_MODEL_MAX_CONTEXT_SIZE="262144"
export KIMI_MODEL_CAPABILITIES="image_in,thinking"
kimi
```

## 运行时开关

| 环境变量 | 用途 | 合法值 / 默认值 |
| --- | --- | --- |
| `KIMI_DISABLE_TELEMETRY` | 关闭遥测上报 | `1`、`true`、`t`、`yes`、`y`（不区分大小写） |
| `KIMI_CODE_BACKGROUND_KEEP_ALIVE_ON_EXIT` | 覆盖 `[background].keep_alive_on_exit`，控制会话关闭时是否保留仍在运行的后台任务 | 真值：`1`、`true`、`yes`、`on`；假值：`0`、`false`、`no`、`off`；未设置时读取 `config.toml`，再回退到 `true` |
| `KIMI_CODE_PLUGIN_MARKETPLACE_URL` | 覆盖 `/plugins` 加载的 plugin marketplace JSON，适合 dev loopback server、测试 CDN 文件或替换 marketplace 目录 | `https://cdn.kimi.com/kimi-code/plugins/marketplace.json`；也接受 `http://`、`file://` URL 和本地路径 |
| `KIMI_SHELL_PATH` | 覆盖 Windows 上 Git Bash (`bash.exe`) 的绝对路径，仅在 Windows 自动探测失败时需要 | 无 |
| `KIMI_MODEL_MAX_COMPLETION_TOKENS` | 单步 LLM 请求 `max_completion_tokens` 的显式硬上限。未设置时，对于已知上下文窗口的模型，Kimi Code 会使用安全的剩余上下文窗口；设为 `0` 或负数则完全禁用 clamp。**目前只对 `kimi` 类型的供应商生效**；Anthropic 等其它供应商请改用 `[models.<alias>].max_output_size`（详见 [配置文件](./config-files.md#models)） | 未设置：按剩余上下文计算；未知上下文窗口时回退到 `loop_control.reserved_context_size`，再回退到 32000 |
| `KIMI_DISABLE_CRON` | 整体禁用定时任务工具。设为 `1` 时 `CronCreate` 会拒绝新计划，调度器的 tick 循环也会立即短路；磁盘上已有的任务保留，但只要变量仍然生效就不会触发。详见 [定时任务](../reference/tools.md#定时任务) | `1` 表示禁用；默认未设置 |

例如在共享主机上禁用遥测：

```sh
export KIMI_DISABLE_TELEMETRY="1"
```

`KIMI_CODE_BACKGROUND_KEEP_ALIVE_ON_EXIT` 的优先级高于 `config.toml`。例如临时运行 `KIMI_CODE_BACKGROUND_KEEP_ALIVE_ON_EXIT=0 kimi -p "..."` 时，即使配置文件里写了 `keep_alive_on_exit = true`，本次进程退出前也会请求停止后台任务。

## 诊断日志

下列变量控制 `kimi` 的诊断日志。日志会写入两个位置：全局诊断日志在 `$KIMI_CODE_HOME/logs/kimi-code.log`，每个会话自身的诊断日志在 `<sessionDir>/logs/kimi-code.log`（路径细节见 [数据路径](./data-locations.md#日志与更新状态)）。所有变量都只在进程启动时读取一次。

| 环境变量 | 用途 | 默认值 |
| --- | --- | --- |
| `KIMI_LOG_LEVEL` | 日志级别，可选 `off`、`error`、`warn`、`info`、`debug` | `info` |
| `KIMI_LOG_GLOBAL_MAX_BYTES` | 全局日志文件单个最大字节数 | `6291456`（6 MB） |
| `KIMI_LOG_GLOBAL_FILES` | 全局日志文件保留份数 | `5` |
| `KIMI_LOG_SESSION_MAX_BYTES` | 会话级日志文件单个最大字节数 | `5242880`（5 MB） |
| `KIMI_LOG_SESSION_FILES` | 会话级日志文件保留份数 | `3` |

整数类变量解析失败（非正整数、非数字）时静默回落到默认值。

## 剪贴板桥接

`KIMI_WSL_CLIPBOARD_IMAGE_PATH` 由 CLI 在调用 WSL 剪贴板辅助子进程时自动注入，用于传递临时图片路径。该变量写入到 PowerShell 子进程的环境中，由子进程脚本内部读取；kimi 主进程自身不读取此变量。在外部 shell 中设置它对 kimi 主进程**无效**，用户无需手动管理此变量。

## 系统环境变量

Kimi Code CLI 也会读取一些标准的系统环境变量，用于检测运行环境与默认行为：

- `HOME`：用户主目录，用于解析默认数据路径。
- `VISUAL`、`EDITOR`：调用外部编辑器时的可执行命令，`VISUAL` 优先。
- `PATH`：定位 `rg`、`git` 等外部依赖。
- `NO_COLOR`：设置且非空时，强制关闭颜色与主题检测，界面回退到深色主题。遵循 [no-color.org](https://no-color.org) 约定。
- `FORCE_COLOR`：值为 `"0"` 时，同样关闭颜色与主题检测，界面回退到深色主题。
- `CI`：非空且非 `"0"` 时，关闭主题检测并回退到深色主题；遥测模块也会读取此变量以标记 CI 环境。
- `LANG`：用于在遥测上下文中标记 locale（仅作为标记，不改变 CLI 行为）。
- `TERM_PROGRAM`：用于检测终端对 OSC 9 通知的支持（iTerm2、WezTerm、ghostty、WarpTerminal 等）；也会写入遥测上下文。
- `TERM`：用于检测终端对 OSC 9 通知的支持（xterm-kitty、xterm-ghostty 等）。
- `TMUX`：检测是否运行在 tmux 内，用于终端通知路径的判断。
- `COLORFGBG`：检测终端配色（深色 / 浅色）。
- `DISPLAY`、`WAYLAND_DISPLAY`、`XDG_SESSION_TYPE`：检测 Linux 图形会话，用于剪贴板与图片相关功能。`XDG_SESSION_TYPE` 值为 `wayland` 时也判定为 Wayland 会话。
- `WSL_DISTRO_NAME`、`WSLENV`：检测是否运行在 WSL 内，用于剪贴板的 PowerShell 桥接回退。
- `TERMUX_VERSION`：检测是否运行在 Termux 中。
- `LOCALAPPDATA`：Windows 上探测 Git Bash 安装路径时使用。
- `HTTP_PROXY` / `http_proxy`：用于 LLM 供应商和 OAuth 对外请求的 HTTP 代理服务器 URL。
- `HTTPS_PROXY` / `https_proxy`：用于 LLM 供应商和 OAuth 对外请求的 HTTPS 代理服务器 URL。
- `NO_PROXY` / `no_proxy`：逗号分隔的不走代理的主机名或 IP 列表。当设置了任意代理变量时，默认值为 `localhost,127.0.0.1`。

这些变量遵循各操作系统的常规约定，`kimi` 仅读取不修改。
