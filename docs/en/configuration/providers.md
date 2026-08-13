# Providers and models

Kimi Code CLI supports connecting to multiple LLM platforms simultaneously — one-click login via the Kimi Code managed service, connecting Claude with an Anthropic API key, or connecting third-party inference services via the OpenAI-compatible protocol. Each provider corresponds to a specific API protocol; models are declared on top of providers with their own name, context length, and capabilities. This page explains how to configure each type of provider in `config.toml`.

## Supported provider types

The `type` field in the `providers` table determines which protocol implementation to use:

| Type | Protocol | Typical use |
| --- | --- | --- |
| `kimi` | OpenAI-compatible | Kimi Code managed service, Kimi Platform API key |
| `anthropic` | Anthropic Messages | Claude model family |
| `openai` | OpenAI Chat Completions | OpenAI and compatible services, DeepSeek, Qwen, etc. |
| `openai_responses` | OpenAI Responses API | OpenAI's newer Responses interface |
| `google-genai` | Google GenAI | Gemini API |
| `vertexai` | Google GenAI on Vertex | Google Cloud Vertex AI |

All providers communicate with models in streaming mode by default. Capabilities such as thinking, vision, and tool use are matched automatically by model name prefix — you typically do not need to declare them manually.

**Credential priority**: `api_key` direct field > `[providers.<name>.env]` sub-table key > if both are absent, startup fails with an error. The CLI does not fall back to shell environment variables for credentials — see [Config overrides: provider credentials](./overrides.md#provider-credentials).

## `/provider` — interactive provider management

Prefer not to edit TOML by hand? Type `/provider` in the TUI to open the **provider manager**, where you can interactively add or remove providers.

The manager displays providers as a list of entries grouped by source. Navigation:

- ↑/↓ to move the cursor, ←/→ to page
- `d` to delete the current provider (with `[y/N]` confirmation)
- Press Enter on the `[ Add New Platform ]` row to add a new provider

Two paths when adding:

- **Known third-party provider**: fetches the model catalog from [models.dev](https://models.dev/), select a provider → enter an API key → select a default model. Vendors whose protocol the catalog does not declare (e.g. xai, openrouter, and other vendor-specific SDKs) are imported as OpenAI-compatible with a "guessed" note; when the catalog provides no usable endpoint, a base URL prompt appears first; proprietary protocols (Amazon Bedrock, Cohere) and unrecognized explicit protocols are refused. Deprecated and alpha-status models are excluded from the import list. If the public catalog is unreachable, the CLI falls back to a built-in snapshot of the catalog, so the import still works offline or in blocked networks
- **[Custom registry (`api.json`)](#custom-registry-format)**: paste a custom registry URL and Bearer token; the CLI automatically creates the `providers` / `models` entries. On later startup, providers from the same registry URL are refreshed together, so upstream provider additions, removals, and model metadata changes are synced.

::: warning
Kimi Code OAuth managed accounts logged in via `/login` do not appear in `/provider`. Use `/login` and `/logout` to manage them.
:::

The same operations are also available in non-interactive environments via the shell command: [`kimi provider`](../reference/kimi-command.md#kimi-provider).

## Custom registry format

A custom registry is a hosted JSON catalog that describes one or more providers and their models. Serve the file from an HTTPS URL, then import it through `/provider` or `kimi provider add`.

### Minimal example

The smallest useful registry defines one provider and one model:

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

After publishing that file, import it with a neutral placeholder API key:

```sh
kimi provider add https://registry.example.com/api.json --api-key YOUR_API_KEY
```

The key is sent to the registry as `Authorization: Bearer YOUR_API_KEY` and is also saved as the API key for every provider imported from the file. The top-level `example` key identifies the registry record, while the nested `id` becomes the provider ID. Likewise, the model object key creates the model alias `example/example-model` (the model name users select or reference in Kimi Code), and the nested model `id` is sent to the upstream API.

### Provider fields

Each top-level value is a provider object. Missing or invalid required fields, or an unsupported `type`, cause that provider entry to be skipped; invalid optional fields are ignored.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | `string` | Yes | Non-empty, stable provider ID used in generated configuration and model aliases |
| `name` | `string` | Yes | Non-empty display name |
| `api` | `string` | Yes | Non-empty base URL used for model requests |
| `type` | `string` | Yes | API protocol; must be one of the four values below |
| `models` | `object` | Yes | Object keyed by the alias suffix for each model |
| `env` | `string[]` | No | Compatibility metadata listing credential environment-variable names; the importer accepts it but uses the supplied Bearer token for credentials |

Custom registries support these four provider types. The `google-genai` and `vertexai` types available in `config.toml` are not accepted in `api.json`.

| `type` | Protocol |
| --- | --- |
| `kimi` | Kimi's OpenAI-compatible protocol |
| `anthropic` | Anthropic Messages |
| `openai` | OpenAI Chat Completions |
| `openai_responses` | OpenAI Responses API |

### Model fields

Each value under `models` is a model object. A model entry without a non-empty string `id` is skipped without rejecting the rest of its provider.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | `string` | Yes | Model ID sent to the provider API |
| `name` | `string` | No | Display name; defaults to `id` |
| `limit` | `object` | No | Positive numeric `context` and `output` limits. `context` becomes `max_context_size`; when it is absent, `output` is used as the fallback. If neither is valid, the default is `131072`. `output` does not currently create `max_output_size` |
| `tool_call` | `boolean` | No | Whether the model supports tool calls |
| `reasoning` | `boolean` | No | Whether the model supports Thinking |
| `modalities` | `object` | No | String arrays under `input` and `output` that describe supported media |
| `support_efforts` | `string[]` | No | Available Thinking effort names, such as `low`, `medium`, and `high` |
| `default_effort` | `string` | No | Non-empty default Thinking effort; normally one of `support_efforts` |

### Capability mapping

Capability metadata is translated into the generated model alias as follows:

| Registry value | Generated model metadata |
| --- | --- |
| `limit.context: 200000` | `max_context_size = 200000` |
| `tool_call: true` | `tool_use` capability |
| `reasoning: true` | `thinking` capability |
| `modalities.input` contains `image` / `video` | `image_in` / `video_in` capability |
| `modalities.output` contains `image` / `audio` | `image_out` / `audio_out` capability |
| Non-empty `support_efforts` | `thinking` capability plus the listed effort levels |
| `default_effort: "medium"` | Default effort `medium` |

When any of `tool_call`, `reasoning`, `modalities`, or `support_efforts` is present, the importer derives the complete capability list from those fields. Include `tool_call: true` alongside the other hints when the model supports tools. If all four fields are omitted, the importer falls back to `tool_use`; `default_effort` by itself does not enable Thinking.

### Refresh behavior

Every imported provider stores the registry source. On a normal startup refresh, Kimi Code groups providers by the exact source URL; the URL remains the registry identity even if its API key changes. After a successful fetch, Kimi Code:

- adds provider and model entries newly published at that URL
- removes providers no longer present and every alias that references them; removes generated aliases for deleted models; clears default provider or model selections when their target disappears
- updates provider protocol, base URL, credential, model ID, display name, context size, capabilities, and effort metadata
- preserves unrelated providers, hand-created aliases outside the generated `<providerId>/...` namespace for providers that remain, and extra model fields that the registry does not own

If the registry fetch fails, the existing provider configuration is left unchanged and the refresh reports the failure.

## `kimi`

For connecting to Moonshot AI's OpenAI-compatible interface, including the Kimi Code managed service and Kimi Platform API keys.

- Default `base_url`: `https://api.moonshot.ai/v1`
- Credential key names: `KIMI_API_KEY`, `KIMI_BASE_URL`
- Additional capability: supports video upload

```toml
[providers.kimi]
type = "kimi"
base_url = "https://api.moonshot.ai/v1"
api_key = "sk-xxxxx"
```

> When using the Kimi Code managed service, running `/login` automatically configures `base_url` and credentials — no manual setup needed.

## `anthropic`

For connecting to the Claude API. Standard Claude models automatically enable vision, tool use, and Thinking (where supported); custom or uncovered models need `capabilities` declared explicitly on `[models.<alias>]`.

- Default `base_url`: follows Anthropic SDK default
- Credential key names: `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`
- Default `max_tokens`: inferred per model. To override, set `max_output_size` on the model alias

```toml
[providers.anthropic]
type = "anthropic"
api_key = "sk-ant-xxxxx"

[models."claude-opus-4-7"]
provider = "anthropic"
model = "claude-opus-4-7"
max_context_size = 200000
# max_output_size = 32000  # optional; omit to use the model-inferred default
```

## `openai`

For connecting to the OpenAI Chat Completions protocol, as well as any third-party service compatible with that protocol (override `base_url` as needed).

Third-party reasoning models (DeepSeek, Qwen, One API, etc.) work out of the box: the CLI automatically handles the `reasoning_content` field and `reasoning_effort` injection. If your gateway returns reasoning content under a non-standard field name, set `reasoning_key` on the model alias to override.

- Default `base_url`: `https://api.openai.com/v1`
- Credential key names: `OPENAI_API_KEY`, `OPENAI_BASE_URL`

```toml
[providers.openai]
type = "openai"
base_url = "https://api.openai.com/v1"
api_key = "sk-xxxxx"
```

## `openai_responses`

Corresponds to OpenAI's newer Responses API, always operating in streaming mode. Configuration is the same as `openai`.

- Default `base_url`: `https://api.openai.com/v1`
- Credential key names: `OPENAI_API_KEY`, `OPENAI_BASE_URL`

```toml
[providers.openai-responses]
type = "openai_responses"
base_url = "https://api.openai.com/v1"
api_key = "sk-xxxxx"
```

## `google-genai`

For connecting directly to the Google Gemini API. Thinking, vision, and multimodal capabilities are auto-detected by model name.

- Credential key name: `GOOGLE_API_KEY`

```toml
[providers.gemini]
type = "google-genai"
api_key = "xxxxx"
```

To route through a Gemini-compatible proxy or gateway, set `base_url` (or the `GOOGLE_GEMINI_BASE_URL` env var); when omitted, the SDK default `https://generativelanguage.googleapis.com` is used.

> Give the **host root only**. The Google GenAI SDK appends the API version and path itself (e.g. `/v1beta/models/<model>:generateContent`), so a trailing `/v1beta` would produce a doubled `/v1beta/v1beta/…`.

```toml
[providers.gemini]
type = "google-genai"
api_key = "xxxxx"
base_url = "https://your-gateway.example"
```

## `vertexai`

Shares the same implementation as `google-genai`; setting `type = "vertexai"` switches to the Vertex AI access path.

Authentication follows the standard Google Cloud ADC flow (`gcloud auth application-default login` or a `GOOGLE_APPLICATION_CREDENTIALS` service account JSON) — this part is unrelated to Kimi Code. **The project ID and region must be written in the `[providers.vertexai.env]` sub-table** — simply `export GOOGLE_CLOUD_PROJECT` in the shell will not be read by the CLI.

```toml
[providers.vertexai]
type = "vertexai"

[providers.vertexai.env]
GOOGLE_CLOUD_PROJECT = "my-gcp-project"
GOOGLE_CLOUD_LOCATION = "us-central1"
```

```sh
gcloud auth application-default login   # one-time authentication
kimi
```

To route Vertex requests through a custom (e.g. proxied) endpoint, set `base_url` (or the `GOOGLE_VERTEX_BASE_URL` env var); when omitted, the SDK default regional `*-aiplatform.googleapis.com` host is used. As with `google-genai`, give the host root only — the SDK appends `/v1beta1/publishers/google/models/…` itself.

## OAuth and credential injection

The Kimi Code managed service uses OAuth rather than static API keys. After running `/login`, the built-in authentication toolchain automatically writes and refreshes credentials — no manual configuration is needed in `config.toml` for this.

## Next steps

- [Configuration files](./config-files.md) — full field reference for the `providers` and `models` tables
- [Config overrides](./overrides.md) — credential resolution priority rules for providers
- [Environment variables](./env-vars.md) — credential key names per provider type
