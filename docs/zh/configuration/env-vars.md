# 环境变量

Kimi Code CLI 通过环境变量控制少数运行时行为——迁移数据目录、关闭遥测、不改配置文件临时切换模型。

::: warning 重要：API 密钥不在这里配置
`KIMI_API_KEY`、`ANTHROPIC_API_KEY`、`OPENAI_API_KEY` 等密钥变量**不会**从 shell 环境变量自动读取。在终端里 `export KIMI_API_KEY=xxx` 不会让任何供应商获得密钥——必须写在 `config.toml` 的 `[providers.<name>]` 段或 `[providers.<name>.env]` 子表里。

唯一的例外是 `KIMI_MODEL_*` 系列，它是一个显式通道，*确实*会从 shell 读取凭证——详见[用环境变量定义模型](#用环境变量定义模型-kimi-model)。

背景说明见[配置覆盖：供应商凭证](./overrides.md#供应商凭证)。
:::

## 核心路径

### `KIMI_CODE_HOME`

覆盖数据根目录，默认 `~/.kimi-code`。设置后，配置文件、会话、日志、OAuth 凭据等全部数据都落到新路径下：

```sh
export KIMI_CODE_HOME="/path/to/custom/kimi-code"
```

> 确保目录可写。多个 `kimi` 实例共用同一个 `KIMI_CODE_HOME` 会共享配置和凭证。

数据目录的完整结构见[数据路径](./data-locations.md)。

### `KIMI_DISABLE_TELEMETRY`

设为 `1` 关闭匿名遥测上报（也接受 `true`/`yes`/`y`，不区分大小写）：

```sh
export KIMI_DISABLE_TELEMETRY=1
```

### `KIMI_MODEL_*` 系列

不修改 `config.toml` 临时切换模型——设置 `KIMI_MODEL_NAME` 后，CLI 在内存里合成一个临时供应商，重启后失效。详见[用环境变量定义模型](#用环境变量定义模型kimi_model)。

## 供应商凭证键（写在 config.toml 里）

下面这些键名不是直接从 shell 读取的——它们是写在 `config.toml` 的 `[providers.<name>.env]` 子表里、作为 `api_key` / `base_url` 备用来源的键名。CLI 只从配置文件读取，不从 `process.env` 读取。

这样设计是为了让你保留熟悉的键名写法，同时把密钥放在配置文件里统一管理：

```toml
[providers.kimi.env]
KIMI_API_KEY = "sk-xxx"
KIMI_BASE_URL = "https://api.moonshot.ai/v1"
```

各供应商对应的键名：

| 键名 | 适用供应商 | 默认值 |
| --- | --- | --- |
| `KIMI_API_KEY` | Kimi / Moonshot | 无 |
| `KIMI_BASE_URL` | Kimi / Moonshot | `https://api.moonshot.ai/v1` |
| `ANTHROPIC_API_KEY` | Anthropic | 无 |
| `ANTHROPIC_BASE_URL` | Anthropic | Anthropic SDK 默认值 |
| `OPENAI_API_KEY` | OpenAI（`openai` 和 `openai_responses`） | 无 |
| `OPENAI_BASE_URL` | OpenAI（`openai` 和 `openai_responses`） | `https://api.openai.com/v1` |
| `GOOGLE_API_KEY` | Google GenAI、Vertex AI | 无 |
| `VERTEXAI_API_KEY` | Vertex AI | 无 |
| `GOOGLE_CLOUD_PROJECT` | Vertex AI | 无 |
| `GOOGLE_CLOUD_LOCATION` | Vertex AI | 无 |

::: warning
`GOOGLE_APPLICATION_CREDENTIALS`（服务账号 JSON 路径）是唯一走系统环境变量的例外——它由 Google SDK 自身通过 ADC 流程读取，CLI 不参与。其他所有键名都必须写在 `[providers.<name>.env]` 子表里。
:::

供应商类型与字段的完整说明见[平台与模型](./providers.md)。

## OAuth 与托管端点

这组变量用于将 OAuth 认证和托管服务端点指向自建或测试环境，日常使用不需要设置。

| 环境变量 | 用途 | 默认值 |
| --- | --- | --- |
| `KIMI_CODE_OAUTH_HOST` | OAuth 认证 host，优先级最高 | 未设时回退到 `KIMI_OAUTH_HOST` |
| `KIMI_OAUTH_HOST` | OAuth 认证 host，作为上一个的 fallback | 未设时使用 `https://auth.kimi.com` |
| `KIMI_CODE_BASE_URL` | OAuth 登录后的托管 API base URL | `https://api.kimi.com/coding/v1` |

::: warning
`KIMI_CODE_BASE_URL`（OAuth 托管服务，指向 `kimi.com`）和 `KIMI_BASE_URL`（API 密钥直连，指向 `moonshot.ai`）是两个不同的变量，请按场景区分。
:::

## 用环境变量定义模型（`KIMI_MODEL_*`）

测试时想换个模型但不想动 `config.toml`？设置 `KIMI_MODEL_NAME` 后，CLI 会从 `KIMI_MODEL_*` 系列变量在内存里合成出一个临时供应商和模型别名，不写回配置文件。优先级高于 `config.toml` 的 `default_model`，但低于启动时 `-m <alias>` 选项。

```sh
export KIMI_MODEL_NAME="kimi-for-coding"
export KIMI_MODEL_API_KEY="YOUR_API_KEY"
export KIMI_MODEL_BASE_URL="https://api.example.com/v1"
export KIMI_MODEL_MAX_CONTEXT_SIZE="262144"
export KIMI_MODEL_CAPABILITIES="image_in,thinking"
kimi
```

完整变量列表：

| 环境变量 | 必填 | 用途 | 默认值 |
| --- | --- | --- | --- |
| `KIMI_MODEL_NAME` | 是（同时是启用开关） | 发送给 API 的模型 ID | — |
| `KIMI_MODEL_API_KEY` | 是 | API 密钥 | — |
| `KIMI_MODEL_PROVIDER_TYPE` | 否 | 供应商类型：`kimi`、`anthropic`、`openai` | `kimi` |
| `KIMI_MODEL_BASE_URL` | 否 | API 基础 URL | 各类型有各自默认值 |
| `KIMI_MODEL_MAX_CONTEXT_SIZE` | 否 | 最大上下文长度（token 数） | `262144`（256K） |
| `KIMI_MODEL_CAPABILITIES` | 否 | 逗号分隔的能力标签，与自动探测的能力取并集 | `image_in,thinking` |
| `KIMI_MODEL_DISPLAY_NAME` | 否 | 在 `/model` 中显示的名称 | 回退到 `KIMI_MODEL_NAME` |
| `KIMI_MODEL_MAX_OUTPUT_SIZE` | 否 | 单次输出上限（仅 `anthropic`） | 模型默认值 |
| `KIMI_MODEL_REASONING_KEY` | 否 | 推理字段名覆盖（仅 `openai`） | 自动探测 |
| `KIMI_MODEL_DEFAULT_THINKING` | 否 | 新会话的默认 Thinking 开关 | 跟随全局默认 |
| `KIMI_MODEL_THINKING_MODE` | 否 | Thinking 触发策略：`auto`/`on`/`off` | — |
| `KIMI_MODEL_THINKING_EFFORT` | 否 | Thinking 强度：`low`/`medium`/`high`/`xhigh`/`max` | — |
| `KIMI_MODEL_ADAPTIVE_THINKING` | 否 | 强制开启或关闭 adaptive thinking（仅 `anthropic`） | 按模型名推断 |

设置了 `KIMI_MODEL_NAME` 但缺少必填变量时，启动会立即失败并给出明确提示。

## 运行时开关

控制遥测、后台任务、plugin marketplace 等子系统行为的开关变量：

| 环境变量 | 用途 | 合法值 |
| --- | --- | --- |
| `KIMI_DISABLE_TELEMETRY` | 关闭匿名遥测上报 | `1`、`true`、`yes`、`y`（不区分大小写） |
| `KIMI_CODE_BACKGROUND_KEEP_ALIVE_ON_EXIT` | 会话关闭时是否保留后台任务，优先级高于 `config.toml`。默认会在退出时停止后台任务 | 真值：`1`/`true`/`yes`/`on`；假值：`0`/`false`/`no`/`off` |
| `KIMI_CODE_PLUGIN_MARKETPLACE_URL` | 替换 `/plugins` 加载的 marketplace JSON | URL 或本地路径 |
| `KIMI_CODE_EXPERIMENTAL_FLAG` | 在当前进程启用所有已注册的实验功能；`micro_compaction` 已默认开启 | `1`、`true`、`yes`、`on` |
| `KIMI_CODE_EXPERIMENTAL_MICRO_COMPACTION` | 覆盖当前进程的 [`[experimental].micro_compaction`](./config-files.md#experimental) | 真值或假值 |
| `KIMI_SHELL_PATH` | Windows 上覆盖 Git Bash 路径（自动探测失败时使用） | 绝对路径 |
| `KIMI_MODEL_MAX_COMPLETION_TOKENS` | 单步 LLM 请求的 `max_completion_tokens` 硬上限，仅对 `kimi` 供应商生效 | 正整数；`0` 或负数禁用 clamp |
| `KIMI_MODEL_TEMPERATURE` | 每次请求的采样温度，仅对 `kimi` 供应商生效（全局生效，不依赖 `KIMI_MODEL_NAME`） | 数字，如 `0.3` |
| `KIMI_MODEL_TOP_P` | 每次请求的核采样 `top_p`，仅对 `kimi` 供应商生效（全局生效） | 数字，如 `0.95` |
| `KIMI_MODEL_THINKING_KEEP` | Moonshot 保留思考透传（`thinking.keep`），仅对 `kimi` 供应商生效，且仅在 Thinking 开启时注入 | API 接受的值，如 `all` |
| `KIMI_CODE_NO_AUTO_UPDATE` | 完全禁用更新预检——不检查、不后台安装、不提示。同时兼容旧名 `KIMI_CLI_NO_AUTO_UPDATE` | 真值：`1`/`true`/`yes`/`on` |
| `KIMI_DISABLE_CRON` | 禁用定时任务工具（`CronCreate` 拒绝新计划，已有任务不触发） | `1` 表示禁用 |

## 诊断日志

这组变量控制日志级别和文件滚动，进程启动时读取一次：

| 环境变量 | 用途 | 默认值 |
| --- | --- | --- |
| `KIMI_LOG_LEVEL` | 日志级别：`off`、`error`、`warn`、`info`、`debug` | `info` |
| `KIMI_LOG_GLOBAL_MAX_BYTES` | 全局日志文件单个最大字节数 | `6291456`（6 MB） |
| `KIMI_LOG_GLOBAL_FILES` | 全局日志文件保留份数 | `5` |
| `KIMI_LOG_SESSION_MAX_BYTES` | 会话级日志文件单个最大字节数 | `5242880`（5 MB） |
| `KIMI_LOG_SESSION_FILES` | 会话级日志文件保留份数 | `3` |

## 系统环境变量

CLI 还会读取一些标准系统变量来检测运行环境，不会修改它们：

- `HOME`：解析默认数据路径
- `VISUAL`、`EDITOR`：外部编辑器命令（`VISUAL` 优先）
- `PATH`：定位 `rg`、`fd`、`fdfind`、`git` 等依赖；在 Windows 上，Git Bash 探测会检查 `PATH` 中找到的每个 `git.exe`，包括 Scoop 等包管理器提供的 shim
- `NO_COLOR`、`FORCE_COLOR`：控制颜色输出（遵循 [no-color.org](https://no-color.org) 约定）
- `CI`：非空且非 `"0"` 时关闭主题检测，回退深色主题
- `TERM_PROGRAM`、`TERM`、`TMUX`：检测终端特性和通知支持
- `DISPLAY`、`WAYLAND_DISPLAY`、`XDG_SESSION_TYPE`：检测 Linux 图形会话（用于剪贴板和图片功能）
- `WSL_DISTRO_NAME`、`WSLENV`：检测 WSL，用于剪贴板 PowerShell 桥接
- `LOCALAPPDATA`：Windows 上探测 Git Bash 安装路径时作为 fallback 使用

## HTTP 代理

Kimi Code 会遵循标准代理环境变量，让所有出网流量——模型 API 调用、MCP 服务、网络工具、遥测、登录、更新检查——都走代理：

- `HTTP_PROXY` / `http_proxy`：用于 `http://` 请求的代理
- `HTTPS_PROXY` / `https_proxy`：用于 `https://` 请求的代理
- `ALL_PROXY` / `all_proxy`：当对应 scheme 的变量未设置时使用的兜底代理；SOCKS 代理通常设在这里
- `NO_PROXY` / `no_proxy`：以逗号分隔的、绕过代理的主机列表

同时支持 HTTP(S) 代理和 SOCKS 代理。SOCKS 代理通过 scheme 识别——`socks5://`、`socks5h://`、`socks4://` 或 `socks://`（`socks5://` 的别名）——通常设在 `ALL_PROXY`（Clash、V2RayN 等工具使用的形式）。对 HTTP/HTTPS 流量，HTTP(S) 代理优先于 `ALL_PROXY`。

仅当设置了其中任一变量时才启用代理，否则直连。回环地址（`localhost`、`127.0.0.1`、`::1`）始终绕过代理，因此配置了代理后，本地服务（例如 localhost 上的 MCP 服务）仍能正常工作——你也可以把自己的内网主机加入 `NO_PROXY` 一并放行。

以 Node 子进程运行的 stdio MCP 服务，在其 Node 版本支持 `NODE_USE_ENV_PROXY` 时（Node ≥ 22.21 或 ≥ 24.5）会自动遵循 `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`；SOCKS 代理仅作用于 Kimi Code 自身的流量。

## 下一步

- [配置覆盖](./overrides.md) — 环境变量、CLI 选项、配置文件的优先级关系
- [数据路径](./data-locations.md) — `KIMI_CODE_HOME` 影响的完整目录结构
- [平台与模型](./providers.md) — 各供应商类型的完整接入示例
