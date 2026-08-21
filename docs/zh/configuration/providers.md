# 平台与模型

Kimi Code CLI 支持同时接入多家 LLM 平台——用 Kimi Code 托管服务一键登录、用 Anthropic API key 接 Claude、用 OpenAI 兼容协议连接第三方推理服务。每个供应商对应一种 API 协议，模型在供应商之上声明自己的名称、上下文长度和能力。本页介绍如何在 `config.toml` 里配置各种供应商。

## 支持的供应商类型

`providers` 表里的 `type` 字段决定使用哪种协议实现：

| 类型 | 协议 | 典型用途 |
| --- | --- | --- |
| `kimi` | OpenAI 兼容 | Kimi Code 托管服务、Kimi Platform API 密钥 |
| `anthropic` | Anthropic Messages | Claude 系列模型 |
| `openai` | OpenAI Chat Completions | OpenAI 及兼容服务、DeepSeek、Qwen 等 |
| `openai_responses` | OpenAI Responses API | OpenAI 较新的 Responses 接口 |
| `google-genai` | Google GenAI | Gemini API |
| `vertexai` | Google GenAI on Vertex | Google Cloud Vertex AI |

所有供应商默认以流式方式与模型交互。thinking、视觉、工具调用等能力按模型名前缀自动匹配，通常不需要手动声明。

**凭证优先级**：`api_key` 直接字段 > `[providers.<name>.env]` 子表键 > 两者都缺时启动报错。CLI 不会从 shell 环境变量自动取凭证——详见[配置覆盖：供应商凭证](./overrides.md#供应商凭证)。

## `/provider` — 交互式供应商管理

不想手动编辑 TOML？在 TUI 里输入 `/provider` 打开**供应商管理器**，可以以交互方式添加或删除供应商。

管理器按来源把供应商显示为一行行条目。操作方式：

- ↑/↓ 移动光标，←/→ 翻页
- `d` 键删除当前供应商（有 `[y/N]` 确认）
- 在 `[ Add New Platform ]` 行按 Enter 添加新供应商

添加时有两条路径：

- **Known third-party provider**：从 [models.dev](https://models.dev/) 拉取模型目录，选供应商 → 输入 API 密钥 → 选默认模型。目录未声明协议类型的供应商（如 xai、openrouter 这类厂商专用 SDK）会按 OpenAI 兼容协议导入并显示 "guessed" 提示；目录没有可用端点时会先弹出 base URL 输入框；Amazon Bedrock / Cohere 等专有协议和无法识别的显式协议会被拒绝导入。已下线（deprecated）和 alpha 状态的模型不会出现在导入列表中。如果公共目录不可达，CLI 会回退到内置目录快照，离线或网络受限环境下也能完成导入
- **[Custom registry（`api.json`）](#自定义-registry-格式)**：粘贴自定义 registry 地址和 Bearer token，CLI 自动创建 `providers` / `models` 条目。后续启动时，同一个 registry 地址下的供应商会一起刷新，因此上游新增、删除供应商以及模型元数据变化都会同步。

::: warning
通过 `/login` 登录的 Kimi Code OAuth 托管账号不会在 `/provider` 里显示，请用 `/login` 和 `/logout` 管理。
:::

非交互环境下也可以用 shell 命令完成同样操作：[`kimi provider`](../reference/kimi-command.md#kimi-provider)。

## 自定义 registry 格式

自定义 registry 是托管在网络上的 JSON 目录，用于描述一个或多个供应商及其模型。将文件放在 HTTPS 地址，然后通过 `/provider` 或 `kimi provider add` 导入。

### 最小示例

最小可用 registry 只需定义一个供应商和一个模型：

```json
{
  "example": {
    "id": "example",
    "name": "Example provider",
    "api": "https://api.example.com/v1",
    "type": "openai",
    "models": {
      "example-model": {
        "id": "example-model"
      }
    }
  }
}
```

发布文件后，用中性的占位 API 密钥导入：

```sh
kimi provider add https://registry.example.com/api.json --api-key YOUR_API_KEY
```

该密钥会以 `Authorization: Bearer YOUR_API_KEY` 发给 registry，并保存为该文件所导入每个供应商的 API 密钥。顶层的 `example` 键用于标识 registry 记录，内部的 `id` 则成为供应商 ID。同样，模型对象的键会生成模型别名 `example/example-model`（用户在 Kimi Code 中选择或引用模型时使用的名称），内部的模型 `id` 会发送给上游 API。

### 供应商字段

每个顶层值都是一个供应商对象。必填字段缺失或无效，或 `type` 不受支持时，该供应商条目会被跳过；无效的可选字段会被忽略。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | `string` | 是 | 非空且稳定的供应商 ID，用于生成配置和模型别名 |
| `name` | `string` | 是 | 非空显示名称 |
| `api` | `string` | 是 | 发送模型请求时使用的非空 base URL |
| `type` | `string` | 是 | API 协议，必须是下列四种值之一 |
| `models` | `object` | 是 | 以每个模型的别名后缀为键的对象 |
| `env` | `string[]` | 否 | 列出凭证环境变量名的兼容元数据；导入器接受该字段，但凭证使用导入时提供的 Bearer token |

自定义 registry 支持以下四种供应商类型。`config.toml` 支持的 `google-genai` 和 `vertexai` 类型不能用于 `api.json`。

| `type` | 协议 |
| --- | --- |
| `kimi` | Kimi 的 OpenAI 兼容协议 |
| `anthropic` | Anthropic Messages |
| `openai` | OpenAI Chat Completions |
| `openai_responses` | OpenAI Responses API |

### 模型字段

`models` 下的每个值都是一个模型对象。模型条目若没有非空字符串 `id`，会被跳过，但不会导致其余供应商内容导入失败。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | `string` | 是 | 发送给供应商 API 的模型 ID |
| `name` | `string` | 否 | 显示名称，默认使用 `id` |
| `limit` | `object` | 否 | 包含正数 `context` 和 `output` 上限。`context` 会生成 `max_context_size`；缺少时用 `output` 回退。两者都无效时默认值为 `131072`。当前不会由 `output` 生成 `max_output_size` |
| `tool_call` | `boolean` | 否 | 模型是否支持工具调用 |
| `reasoning` | `boolean` | 否 | 模型是否支持 Thinking |
| `modalities` | `object` | 否 | `input` 和 `output` 下的字符串数组，用于描述支持的媒体类型 |
| `support_efforts` | `string[]` | 否 | 可用的 Thinking effort 名称，如 `low`、`medium`、`high` |
| `default_effort` | `string` | 否 | 非空的默认 Thinking effort，通常是 `support_efforts` 中的一项 |

### 能力映射

能力元数据会按下表转换到生成的模型别名：

| registry 值 | 生成的模型元数据 |
| --- | --- |
| `limit.context: 200000` | `max_context_size = 200000` |
| `tool_call: true` | `tool_use` 能力 |
| `reasoning: true` | `thinking` 能力 |
| `modalities.input` 包含 `image` / `video` | `image_in` / `video_in` 能力 |
| `modalities.output` 包含 `image` / `audio` | `image_out` / `audio_out` 能力 |
| 非空 `support_efforts` | `thinking` 能力及列出的 effort 等级 |
| `default_effort: "medium"` | 默认 effort `medium` |

只要出现 `tool_call`、`reasoning`、`modalities`、`support_efforts` 中任一能力提示字段，导入器就会完全根据这些字段生成能力列表。如果模型同时支持工具调用，请显式写入 `tool_call: true`。四个字段全部省略时，导入器会回退到 `tool_use`；单独设置 `default_effort` 不会启用 Thinking。

### 刷新行为

每个导入的供应商都会保存 registry 来源。正常启动刷新时，Kimi Code 会按完全一致的来源 URL 对供应商分组；即使 API 密钥变化，该 URL 仍是 registry 的身份标识。成功拉取后，Kimi Code 会：

- 添加该 URL 新发布的供应商和模型条目
- 删除已不存在的供应商及所有引用它的别名；删除已下线模型对应的生成别名；默认供应商或模型的目标消失时清除默认选择
- 更新供应商协议、base URL、凭证、模型 ID、显示名称、上下文大小、能力和 effort 元数据
- 保留无关供应商、仍存在供应商在自动生成的 `<providerId>/...` 命名空间之外的手动别名，以及 registry 不负责管理的额外模型字段

如果拉取 registry 失败，现有供应商配置会保持不变，刷新结果会报告该失败。

## `kimi`

用于对接 Moonshot AI 的 OpenAI 兼容接口，包括 Kimi Code 托管服务和 Kimi Platform API 密钥。

- 默认 `base_url`：`https://api.moonshot.ai/v1`
- 凭证键名：`KIMI_API_KEY`、`KIMI_BASE_URL`
- 额外能力：支持视频上传

```toml
[providers.kimi]
type = "kimi"
base_url = "https://api.moonshot.ai/v1"
api_key = "sk-xxxxx"
```

> 使用 Kimi Code 托管服务时，`/login` 登录后会自动配置 `base_url` 和凭证，无需手动填写。

## `anthropic`

用于对接 Claude API。标准 Claude 模型自动启用视觉、工具调用及 Thinking（如支持）；自定义或未覆盖的模型需在 `[models.<alias>]` 里显式声明 `capabilities`。

- 默认 `base_url`：跟随 Anthropic SDK 默认值
- 凭证键名：`ANTHROPIC_API_KEY`、`ANTHROPIC_BASE_URL`
- 默认 `max_tokens`：按模型自动推断。如需覆盖，在模型别名上设 `max_output_size`

```toml
[providers.anthropic]
type = "anthropic"
api_key = "sk-ant-xxxxx"

[models."claude-opus-4-7"]
provider = "anthropic"
model = "claude-opus-4-7"
max_context_size = 200000
# max_output_size = 32000  # 可选，省略时使用模型推断的默认值
```

## `openai`

用于对接 OpenAI Chat Completions 协议，也可连接任何兼容该协议的第三方服务（覆盖 `base_url` 即可）。

第三方推理模型（DeepSeek、Qwen、One API 等）开箱即用：CLI 自动处理 `reasoning_content` 字段和 `reasoning_effort` 注入。如果你的网关用非标准字段名返回推理内容，在模型别名上设 `reasoning_key` 覆盖。

- 默认 `base_url`：`https://api.openai.com/v1`
- 凭证键名：`OPENAI_API_KEY`、`OPENAI_BASE_URL`

```toml
[providers.openai]
type = "openai"
base_url = "https://api.openai.com/v1"
api_key = "sk-xxxxx"
```

## `openai_responses`

对应 OpenAI 较新的 Responses API，始终以流式方式工作。配置方式与 `openai` 相同。

- 默认 `base_url`：`https://api.openai.com/v1`
- 凭证键名：`OPENAI_API_KEY`、`OPENAI_BASE_URL`

```toml
[providers.openai-responses]
type = "openai_responses"
base_url = "https://api.openai.com/v1"
api_key = "sk-xxxxx"
```

## `google-genai`

用于直连 Google Gemini API。thinking、视觉及多模态能力按模型名自动识别。

- 凭证键名：`GOOGLE_API_KEY`

```toml
[providers.gemini]
type = "google-genai"
api_key = "xxxxx"
```

如需经由兼容 Gemini 协议的代理/网关访问，可设置 `base_url`（或 `GOOGLE_GEMINI_BASE_URL` 环境变量）；不填时使用 SDK 默认地址 `https://generativelanguage.googleapis.com`。

> 只填**主机根地址**。Google GenAI SDK 会自行追加 API 版本与路径（如 `/v1beta/models/<model>:generateContent`），所以结尾带 `/v1beta` 会导致路径重复成 `/v1beta/v1beta/…`。

```toml
[providers.gemini]
type = "google-genai"
api_key = "xxxxx"
base_url = "https://your-gateway.example"
```

## `vertexai`

与 `google-genai` 共用实现，`type = "vertexai"` 时切换到 Vertex AI 访问路径。

认证走 Google Cloud 标准 ADC 流程（`gcloud auth application-default login` 或 `GOOGLE_APPLICATION_CREDENTIALS` 服务账号 JSON），这部分与 Kimi Code 无关。**项目 ID 和区域必须写在 `[providers.vertexai.env]` 子表里**——直接在 shell 里 `export GOOGLE_CLOUD_PROJECT` 不会被 CLI 读取。

```toml
[providers.vertexai]
type = "vertexai"

[providers.vertexai.env]
GOOGLE_CLOUD_PROJECT = "my-gcp-project"
GOOGLE_CLOUD_LOCATION = "us-central1"
```

```sh
gcloud auth application-default login   # 一次性完成认证
kimi
```

如需让 Vertex 请求走自定义（如代理）端点，可设置 `base_url`（或 `GOOGLE_VERTEX_BASE_URL` 环境变量）；不填时使用 SDK 默认的区域化 `*-aiplatform.googleapis.com` 地址。与 `google-genai` 一样，只填主机根地址——SDK 会自行追加 `/v1beta1/publishers/google/models/…`。

## OAuth 与凭证注入

Kimi Code 托管服务使用 OAuth 而非静态 API 密钥。运行 `/login` 后，内置的认证工具链会自动写入并刷新凭证，`config.toml` 里无需手动配置这部分内容。

## 下一步

- [配置文件](./config-files.md) — `providers` 和 `models` 表的完整字段参考
- [配置覆盖](./overrides.md) — 供应商凭证的解析优先级规则
- [环境变量](./env-vars.md) — 各供应商对应的凭证键名列表
