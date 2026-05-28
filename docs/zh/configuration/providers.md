# 平台与模型

Kimi Code CLI 通过统一的供应商抽象对接多家 LLM 平台。每个供应商负责一种 API 协议，模型则在供应商之上声明自己的名称、上下文长度和能力。本页介绍当前支持的所有供应商类型，以及如何在 `~/.kimi-code/config.toml` 中配置它们。

## 概述

`providers` 表里的 `type` 字段决定使用哪一种实现。目前支持的类型有：

| 类型 | 协议 | 典型平台 |
| --- | --- | --- |
| `kimi` | OpenAI 兼容（chat completions 风格） | Kimi Code、Moonshot AI 开放平台 |
| `anthropic` | Anthropic Messages | Claude API |
| `openai` | OpenAI Chat Completions | OpenAI 及其兼容服务 |
| `openai_responses` | OpenAI Responses API | OpenAI 较新的 Responses 接口 |
| `google-genai` | Google GenAI | Gemini API |
| `vertexai` | Google GenAI on Vertex | Google Cloud Vertex AI |

所有供应商默认以流式方式与模型交互；thinking、视觉、工具调用等能力按模型名前缀自动匹配，无需在配置里手写。

API 密钥可以写在 `api_key` 字段，也可以放在 `[providers.<name>.env]` 子表里。优先级为 `api_key` > 子表键 > 若均未配置，启动时将报错。**Kimi Code CLI 不会从 shell 环境变量自动取后备值**——仅在终端里 `export KIMI_API_KEY` 不会让某个供应商自动获得凭证，需要显式写入 `config.toml`（详见 [配置覆盖：供应商凭证](./overrides.md#供应商凭证)）。`api_key` 与 `oauth` 在同一个供应商上互斥，同时设置会在解析模型时报错；OAuth 由内置登录流程自动注入，无需手写。

`[providers.<name>.env]` 子表可以在 `config.toml` 内直接提供凭证或端点覆盖，这些值仅对当前供应商生效，不会泄漏到全局 shell 环境：

```toml
[providers.my-anthropic.env]
ANTHROPIC_API_KEY = "sk-ant-xxxxx"
ANTHROPIC_BASE_URL = "https://my-proxy.example.com"
```

切换供应商最常见的方式有两种：在 TUI 里用 `/model` 斜杠命令选择已配置的模型，或者直接编辑 `config.toml` 调整 `[providers.*]` 与 `[models.*]` 表。完整字段说明见 [配置文件](./config-files.md)。

## `/connect` 与模型目录

除了在 `config.toml` 中手写 `[providers.*]` 与 `[models.*]` 表，你也可以在 TUI 中运行 `/connect` 斜杠命令，从 **模型目录**（model catalog）添加供应商。模型目录记录了已知的供应商和模型，以及它们的上下文长度、输出长度和能力。`/connect` 会引导你选择供应商，然后选择一个或多个模型：输入关键词可过滤列表，按 `Space` 勾选想要的每个模型，按 `Tab` 将当前高亮的模型设为默认模型。如果重新连接一个已配置的供应商，且旧模型仍存在于当前模型目录中，它们会在选择器里预先勾选；如果 API 密钥输入框留空并按 `Enter`，则会保留已有密钥。输入或保留 API 密钥后，它会把 `[providers.<name>]` 配置块，以及每个被勾选模型对应的 `[models.<alias>]` 写入 `config.toml`，并以你指定的默认模型（若未指定，则取第一个被勾选的模型）作为默认模型；未勾选的模型不会被写入。

CLI 已经内置了默认的模型目录，因此 `/connect` 无需联网即可使用。如果想换用别的来源，可以传入以下参数：

- `/connect --refresh`：在打开选择器之前，从 [models.dev](https://models.dev/) 拉取最新模型目录。
- `/connect --url=<catalog-url>`：从自定义地址读取模型目录（格式需与默认目录一致），只接受 `http://` 或 `https://` 的 URL。

`/connect` 只能配置上表列出的供应商类型；不在目录范围内的供应商类型，请按下面各小节的说明，在 `config.toml` 中手写配置。

对通过 `/connect` 配置的供应商，`/logout` 同样有效：它会从 `config.toml` 中删除对应的 `[providers.<name>]` 配置块。

## `kimi`

`kimi` 通过 OpenAI 兼容协议对接 Moonshot AI。

- 默认 `base_url`：`https://api.moonshot.ai/v1`
- 环境变量：`KIMI_API_KEY`、`KIMI_BASE_URL`
- 额外能力：支持视频上传

```toml
[providers.kimi]
type = "kimi"
base_url = "https://api.moonshot.ai/v1"
api_key = "sk-xxxxx"
```

Kimi Code 托管服务在 OAuth 登录后会自动配置 `base_url` 与凭证，无需手动填写；详见 [OAuth 与凭证注入](#oauth-与凭证注入) 与 [环境变量](./env-vars.md)。

## `anthropic`

`anthropic` 用于对接 Claude API。标准 Claude 模型会自动启用视觉、工具调用及 Thinking（如支持）。若使用自定义或尚未覆盖的模型，需在 `[models.<alias>]` 中显式声明 `capabilities`。

Thinking 可通过 `/model`、`/settings` 或配置控制。

- 默认 `base_url`：跟随 Anthropic SDK 默认值
- 环境变量：`ANTHROPIC_API_KEY`、`ANTHROPIC_BASE_URL`
- 默认 `max_tokens`：按模型自动设置。如需覆盖（例如测试或为尚未识别的别名指定值），在模型别名上设置 `max_output_size`（详见 [`config-files.md`](./config-files.md#models)）。已识别别名的覆盖值会被限制在服务端允许的上限内。

```toml
[providers.anthropic]
type = "anthropic"
api_key = "sk-ant-xxxxx"

[models."claude-opus-4-7"]
provider = "anthropic"
model = "claude-opus-4-7"
max_context_size = 200000
# 可选：在测试时降低输出预算，或为本 CLI 尚未识别的模型指定一个值。
# 省略则使用上述按模型推导出的默认值。
# max_output_size = 32000
```

## `openai`

`openai` 对应 OpenAI Chat Completions 协议，也可用来连接任何兼容该协议的第三方服务（自行覆盖 `base_url` 即可）。thinking、视觉、工具调用等能力按模型名自动推断。

第三方推理模型（DeepSeek、Qwen、One API 等网关托管服务）开箱即用：思考内容会以约定字段 `reasoning_content` 回传给服务端，且当对话历史中已有思考片段时会自动注入 `reasoning_effort`，避免严格校验的网关返回错误。如果你的网关使用非标准字段名，可以在模型别名上设置 `reasoning_key` 覆盖 —— 详见 [`config-files.md`](./config-files.md#models)。

- 默认 `base_url`：`https://api.openai.com/v1`
- 环境变量：`OPENAI_API_KEY`、`OPENAI_BASE_URL`

```toml
[providers.openai]
type = "openai"
base_url = "https://api.openai.com/v1"
api_key = "sk-xxxxx"
```

## `openai_responses`

`openai_responses` 对应 OpenAI 较新的 Responses API。它始终以流式方式工作，能力按模型名自动推断。

- 默认 `base_url`：`https://api.openai.com/v1`
- 环境变量：`OPENAI_API_KEY`、`OPENAI_BASE_URL`

```toml
[providers.openai-responses]
type = "openai_responses"
base_url = "https://api.openai.com/v1"
api_key = "sk-xxxxx"
```

## `google-genai`

`google-genai` 用于直连 Google Gemini API。thinking、视觉及多模态能力按模型名自动推断。

- 环境变量：`GOOGLE_API_KEY`

```toml
[providers.gemini]
type = "google-genai"
api_key = "xxxxx"
```

## `vertexai`

`vertexai` 与 `google-genai` 共用同一份实现，`type = "vertexai"` 时切换到 Vertex AI 的访问路径。

认证遵循 Google Cloud 的标准流程：通过 `gcloud auth application-default login` 或设置 `GOOGLE_APPLICATION_CREDENTIALS` 指向服务账号 JSON 完成鉴权（这一步是 Google SDK 的通用机制，与 Kimi Code 配置无关）。**项目与区域必须写在 `[providers.vertexai.env]` 子表中**——直接 `export GOOGLE_CLOUD_PROJECT`、`export GOOGLE_CLOUD_LOCATION` 不会被 CLI 读取。`GOOGLE_CLOUD_LOCATION` 缺失时，CLI 会尝试从 `base_url` 自动推断。API 密钥（`VERTEXAI_API_KEY` 或 `GOOGLE_API_KEY`）同样写在子表内。

```toml
[providers.vertexai]
type = "vertexai"

[providers.vertexai.env]
GOOGLE_CLOUD_PROJECT = "my-gcp-project"
GOOGLE_CLOUD_LOCATION = "us-central1"
```

```sh
gcloud auth application-default login   # 一次性
kimi
```

## OAuth 与凭证注入

部分平台（如 Kimi Code 托管服务）使用 OAuth 而非静态 API 密钥。凭证由内置的 kimi-oauth 工具链在运行时注入，登录流程会自动负责写入与刷新，普通配置文件无需手工配置这部分内容。
