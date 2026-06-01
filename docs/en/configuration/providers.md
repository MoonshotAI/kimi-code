# Providers and models

Kimi Code CLI integrates with multiple LLM platforms through a unified provider abstraction. Each provider handles one API protocol, and models are declared on top of a provider with their own name, context length, and capabilities. This page describes every provider type currently supported and how to configure them in `~/.kimi-code/config.toml`.

## Overview

The `type` field of each entry in the `providers` table determines which implementation is used. The currently supported types are:

| Type | Protocol | Typical platforms |
| --- | --- | --- |
| `kimi` | OpenAI-compatible (chat completions style) | Kimi Code, Moonshot AI Open Platform |
| `anthropic` | Anthropic Messages | Claude API |
| `openai` | OpenAI Chat Completions | OpenAI and compatible services |
| `openai_responses` | OpenAI Responses API | OpenAI's newer Responses endpoint |
| `google-genai` | Google GenAI | Gemini API |
| `vertexai` | Google GenAI on Vertex | Google Cloud Vertex AI |

All providers stream model interactions by default. Thinking, vision, and tool-call capabilities are matched automatically by model name prefix, so you do not need to spell them out in the config.

API keys may be written into the `api_key` field, or supplied under the `[providers.<name>.env]` sub-table. The lookup order is `api_key` > sub-table key > missing error. **Kimi Code CLI does not automatically fall back to shell environment variables** — `export KIMI_API_KEY` in your terminal alone will not give a provider credentials; you must write them into `config.toml` (see [Configuration overrides: provider credentials](./overrides.md#provider-credentials) for details). `api_key` and `oauth` are mutually exclusive on the same provider; setting both causes an error when the model is resolved. OAuth credentials are handled by the built-in login flow and do not need to be configured manually.

The `[providers.<name>.env]` sub-table lets you supply credentials or endpoint overrides directly inside `config.toml`. These values are scoped to the provider and do not leak into the global shell environment:

```toml
[providers.my-anthropic.env]
ANTHROPIC_API_KEY = "sk-ant-xxxxx"
ANTHROPIC_BASE_URL = "https://my-proxy.example.com"
```

The most common ways to switch providers are: use the `/model` slash command inside the TUI to pick from already-configured models, or edit `config.toml` directly to adjust the `[providers.*]` and `[models.*]` tables. See [Config files](./config-files.md) for the full field reference.

## `/provider` and provider management

Run the `/provider` slash command inside the TUI to open the **provider manager**, an interactive view of every configured provider grouped by source. From this screen you can add new providers or delete existing ones without editing `config.toml` by hand.

The manager lists each platform source — open platform logins, custom registry imports, and standalone providers — as a single row. Navigate with ↑/↓ and page with ←/→. Press `d` on a row to delete that source; a `[y/N]` confirmation appears before anything is removed. Press `Enter` on the `[ Add New Platform ]` row to add a provider.

Adding a provider offers two paths:

- **Known third-party provider** — fetches the latest catalog from [models.dev](https://models.dev/), lets you pick a provider and enter its API key, then opens the model selector so you can choose the default model.
- **Custom registry (api.json)** — imports one or more providers from a custom registry URL. Paste the registry address and its Bearer token; the CLI fetches the registry, creates the corresponding `[providers.<name>]` and `[models.<alias>]` entries, and refreshes the available model list automatically.

When you add a provider or switch models, the **tabbed model selector** splits the available models into per-provider tabs. Press `Tab` / `Shift-Tab` to cycle between tabs, then use the usual ↑/↓ and `Enter` to pick the model you want.

::: warning Note
The Kimi Code OAuth provider (the account you sign into with `/login`) is intentionally hidden from `/provider`; manage that account with `/login` and `/logout` instead.
:::

## `kimi`

`kimi` connects to the Moonshot AI API using the OpenAI-compatible protocol.

- Default `base_url`: `https://api.moonshot.ai/v1`
- Environment variables: `KIMI_API_KEY`, `KIMI_BASE_URL`
- Extra capability: video upload

```toml
[providers.kimi]
type = "kimi"
base_url = "https://api.moonshot.ai/v1"
api_key = "sk-xxxxx"
```

The Kimi Code hosted service configures its `base_url` and credentials automatically after OAuth login; see [OAuth and credential injection](#oauth-and-credential-injection) and [Environment variables](./env-vars.md) for details.

## `anthropic`

`anthropic` integrates with the Claude API. Standard Claude models automatically enable vision, tool calls, and thinking where supported. For custom or unreleased models, declare `capabilities` explicitly under `[models.<alias>]`.

Thinking can be controlled via `/model`, `/settings`, or configuration.

- Default `base_url`: follows the Anthropic SDK default
- Environment variables: `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`
- Default `max_tokens`: set automatically per model. To override it (for example for testing or for an unrecognized alias), set `max_output_size` on the model alias (see [`config-files.md`](./config-files.md#models)). Recognized aliases are capped at the documented server-side ceiling.

```toml
[providers.anthropic]
type = "anthropic"
api_key = "sk-ant-xxxxx"

[models."claude-opus-4-7"]
provider = "anthropic"
model = "claude-opus-4-7"
max_context_size = 200000
# Optional: lower the output budget for testing, or set one for a model
# this CLI doesn't know about yet. Omit to use the per-model default
# above.
# max_output_size = 32000
```

## `openai`

`openai` corresponds to the OpenAI Chat Completions protocol and can also be used to connect to any third-party service that speaks the same protocol (simply override `base_url`). Thinking, vision, and tool-call capabilities are inferred automatically from the model name.

Third-party reasoner models (DeepSeek, Qwen, One API and other gateway-fronted services) work out of the box: thinking content is round-tripped under the de facto `reasoning_content` field, and `reasoning_effort` is auto-injected when the conversation contains prior thinking so gateways with strict validation accept the request. If a gateway uses a non-standard field name, override it via `reasoning_key` on the model alias — see [`config-files.md`](./config-files.md#models).

- Default `base_url`: `https://api.openai.com/v1`
- Environment variables: `OPENAI_API_KEY`, `OPENAI_BASE_URL`

```toml
[providers.openai]
type = "openai"
base_url = "https://api.openai.com/v1"
api_key = "sk-xxxxx"
```

## `openai_responses`

`openai_responses` corresponds to OpenAI's newer Responses API. It always operates in streaming mode; capabilities are inferred automatically from the model name.

- Default `base_url`: `https://api.openai.com/v1`
- Environment variables: `OPENAI_API_KEY`, `OPENAI_BASE_URL`

```toml
[providers.openai-responses]
type = "openai_responses"
base_url = "https://api.openai.com/v1"
api_key = "sk-xxxxx"
```

## `google-genai`

`google-genai` connects directly to the Google Gemini API. Thinking, vision, and multimodal capabilities are inferred automatically from the model name.

- Environment variable: `GOOGLE_API_KEY`

```toml
[providers.gemini]
type = "google-genai"
api_key = "xxxxx"
```

## `vertexai`

`vertexai` shares the same implementation as `google-genai`; setting `type = "vertexai"` switches it to the Vertex AI access path.

Authentication follows the standard Google Cloud flow: authenticate via `gcloud auth application-default login`, or set `GOOGLE_APPLICATION_CREDENTIALS` to a service-account JSON (this step is a generic Google SDK mechanism unrelated to Kimi Code configuration). **The project and region must be written into the `[providers.vertexai.env]` sub-table** — `export GOOGLE_CLOUD_PROJECT` or `export GOOGLE_CLOUD_LOCATION` in the shell will not be read by the CLI. When `GOOGLE_CLOUD_LOCATION` is missing, the CLI tries to infer it from `base_url`. API keys (`VERTEXAI_API_KEY` or `GOOGLE_API_KEY`) likewise go into the sub-table.

```toml
[providers.vertexai]
type = "vertexai"

[providers.vertexai.env]
GOOGLE_CLOUD_PROJECT = "my-gcp-project"
GOOGLE_CLOUD_LOCATION = "us-central1"
```

```sh
gcloud auth application-default login   # one-time
kimi
```

## OAuth and credential injection

Some platforms (such as the Kimi Code hosted service) use OAuth instead of static API keys. Credentials are injected at runtime by the built-in kimi-oauth toolchain, and the login flow takes care of writing and refreshing them automatically — there is nothing to configure by hand for this in your config file.
