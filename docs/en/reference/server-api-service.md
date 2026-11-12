# Service and configuration endpoints

This page lists the service-level endpoints that are not bound to a single session, plus the configuration endpoints. Session endpoints are in [Session endpoints](./server-api-sessions.md), and file endpoints are in [File endpoints](./server-api-files.md). Shared conventions such as authentication, the response envelope, error codes, and pagination are in [Server API](./server-api.md).

A `:{action}` suffix in a path is the action convention: POST to `path:action` on a single resource or a resource collection to run a non-CRUD operation (such as `:fork` and `:archive` on a session, or `:refresh` on the provider collection).

## Server and metadata

These endpoints report information about the server instance itself and provide liveness and shutdown entry points.

| Method and path | Description |
| --- | --- |
| `GET /api/v1/healthz` | Liveness probe; auth-exempt |
| `GET /api/v1/meta` | Server version, capability map, `server_id`, experimental flags |
| `POST /api/v1/shutdown` | Graceful shutdown (replies 200 first); mounted only on a loopback bind or with `--allow-remote-shutdown` |

### `GET /api/v1/healthz`

Liveness probe for scripts and process supervisors. It is the only `/api` endpoint that does not require the bearer token (see [Authentication](./server-api.md#authentication)), and it answers without touching config or the engine.

On success, `data` is `{ "ok": true }`.

### `GET /api/v1/meta`

Returns this instance's identity and capability map. Most fields are frozen at boot. `experimental_flags` and `features` are resolved on every request, so a flag flip or a failed feature shows up in the next response.

| Field | Type | Description |
| --- | --- | --- |
| `server_version` | string | Server version |
| `capabilities` | object | Capability map: `websocket`, `file_upload`, `fs_query`, `mcp`, `tasks`, all always `true` |
| `server_id` | string | Unique id of this server instance |
| `started_at` | string | Boot time, ISO 8601 |
| `open_in_apps` | array | Host apps usable as `open-in` targets: `finder` / `cursor` / `vscode` / `iterm` / `terminal`. Currently always empty |
| `dangerous_bypass_auth` | boolean | Whether the server was started with `--dangerous-bypass-auth` (when `true`, clients may skip the token prompt) |
| `backend` | string | Engine backend: `v1` / `v2`. Always `v2` for this server |
| `web_title` | string | Custom browser tab title from `--web-title`; omitted when unset |
| `experimental_flags` | object | Experimental flag id → enabled, resolved at request time |
| `features` | array | Engine features, each `{ name, state, meta }`. `state` is `Pending` / `Activating` / `Active` / `Unloading` / `Failed` |

### `POST /api/v1/shutdown`

Asks the server to shut down gracefully. The server sends the response first and shuts down immediately after, so the caller can trust the response it received.

The route is mounted only when the server is bound to a loopback address or was started with `--allow-remote-shutdown`. Otherwise the route is not registered and requests get a 404.

On success, `data` is `{ "ok": true }`.

## Login and usage

These endpoints drive the managed Kimi OAuth login lifecycle and read account-level information. The managed provider is named `managed:kimi-code`, and the optional `provider` parameter on every endpoint below defaults to it.

| Method and path | Description |
| --- | --- |
| `GET /api/v1/auth` | Auth status snapshot |
| `POST /api/v1/oauth/login` | Start the OAuth device-code login flow |
| `GET /api/v1/oauth/login` | Poll the login flow state |
| `DELETE /api/v1/oauth/login` | Cancel a pending login flow |
| `POST /api/v1/oauth/logout` | Log out the managed provider |
| `GET /api/v1/oauth/usage` | Plan quota and booster wallet |
| `GET /api/v1/oauth/userinfo` | Account profile |
| `GET /api/v1/oauth/region` | Resolve the client region (`mainland-cn` / `global`) |

### `GET /api/v1/auth`

Returns an auth status snapshot: whether the default model resolves to a usable provider configuration, and the managed provider's login state.

`models_ready` is `true` when the global `default_model` alias exists in the model table and resolves to a configured provider. Providerless flat models that carry their own `base_url` and models injected through `KIMI_MODEL_*` environment variables both count. The server does not verify credentials, so later conversation requests can still fail with `40111` / `40112`.

| Field | Type | Description |
| --- | --- | --- |
| `models_ready` | boolean | Whether the default model resolves to a configured provider; see the rule above |
| `providers_count` | integer | Number of configured providers |
| `managed_provider` | object \| null | Login state of the managed provider |
| `managed_provider.name` | string | Managed provider name |
| `managed_provider.status` | string | `authenticated` / `expired` / `revoked` / `unauthenticated` |

This endpoint does not return the global default model alias. Read it from `default_model` in [`GET /api/v1/config`](#configuration) instead.

### `POST /api/v1/oauth/login`

Starts an OAuth device-code login flow for the managed provider. Starting a new flow aborts any pending flow for the same provider. When the account is already logged in, no user interaction is needed and the response reports `authenticated` directly.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `provider` | body | string | Managed provider name. Default `managed:kimi-code` |
| `region` | body | string | `mainland-cn` / `global`. Overrides the region resolved by [`GET /api/v1/oauth/region`](#get-api-v1-oauth-region) for this flow only |

On success, `data.status` is `pending` or `authenticated`. When the account is already logged in, `data` has only `flow_id`, `provider`, and `status: "authenticated"`. For a pending flow, `data` has these fields:

| Field | Type | Description |
| --- | --- | --- |
| `flow_id` | string | Flow id |
| `provider` | string | Managed provider name |
| `status` | string | `pending` |
| `verification_uri` | string | Verification page URL; open it and enter `user_code` |
| `verification_uri_complete` | string | Verification page URL that can be opened directly, without entering `user_code` |
| `user_code` | string | User code to enter on the `verification_uri` page |
| `expires_in` | integer | Flow deadline in seconds. The same deadline as `expires_at` |
| `interval` | integer | Polling interval in seconds |
| `expires_at` | string | Flow expiry time |

With a pending flow, open `verification_uri_complete` (or open `verification_uri` and enter `user_code`), then poll `GET /api/v1/oauth/login` every `interval` seconds until the flow resolves or `expires_at` passes.

### `GET /api/v1/oauth/login`

Polls the login flow state for a provider.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `provider` | query | string | Managed provider name. Default `managed:kimi-code` |

When no flow has been started, `data` is `null`. Otherwise `data` is a flow snapshot with every field of the pending shape of `POST /api/v1/oauth/login`. These fields differ in value or are added:

| Field | Type | Description |
| --- | --- | --- |
| `status` | string | `pending` / `authenticated` / `denied` / `expired` / `cancelled` |
| `resolved_at` | string | Present once the flow leaves `pending`; records when the flow reached its terminal state |
| `error_message` | string | Describes a failed flow; may be omitted |

### `DELETE /api/v1/oauth/login`

Cancels the pending login flow for a provider. When no flow is pending, the call does nothing and returns the last known state.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `provider` | query | string | Managed provider name. Default `managed:kimi-code` |

On success, `data` is `{ cancelled, status }`. `cancelled` is `true` only when a `pending` flow was actually aborted. `status` is the flow state after the call.

### `POST /api/v1/oauth/logout`

Logs out the managed provider: discards the stored OAuth credential, aborts any pending login flow, and removes the managed provider from the configuration. OAuth-managed providers cannot be edited or deleted manually (see [`PUT` / `DELETE /api/v1/providers/{provider_id}`](#models-and-providers)), so the only way to remove one is to log out first.

When you log out the default Kimi provider (`managed:kimi-code`), the server also tears down this machine's Remote Control and clears cached Remote Control cloud sessions. Logging out any other provider does not affect Remote Control. The teardown order depends on who hosts the tunnel:

- **No tunnel is running, or another process on this machine hosts it**: the server first takes this machine's device offline and holds the machine lock, so no process on this machine can start Remote Control again before the credential is discarded. If the cleanup fails, the logout is aborted.
- **This server hosts the tunnel**: the server discards the credential first and tears down the tunnel right after the response is sent, so a logout sent through the Remote Control link still receives its response.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `provider` | body | string | Managed provider name. Default `managed:kimi-code` |

On success, `data` is `{ logged_out: true, provider }`.

- `50001`: logging out the default Kimi provider failed, either in the Remote Control cleanup or in the logout itself

### `GET /api/v1/oauth/usage`

Reads the plan quota and booster wallet of the managed account, fetched live from the account service. When the account service fails, the envelope still succeeds and the error comes back inside `data`.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `provider` | query | string | Managed provider name. Default `managed:kimi-code` |

On success, `data.kind` is `ok` or `error`:

| Field | Type | Description |
| --- | --- | --- |
| `quota.usages` | object | `ok` only: usage per time window, keyed by `limit5h`, `limit7d`, `monthTotal`, `monthCode`; clients render whichever keys are present. Each entry is `{ usedRatio, resetAt? }`: `usedRatio` is the used fraction from 0 to 1 (a float), and `resetAt` is the reset time in RFC3339 format |
| `quota.extraUsage` | object \| null | `ok` only: the pay-as-you-go wallet, with fields `balanceCents`, `totalCents`, `monthlyChargeLimitEnabled`, `monthlyChargeLimitCents`, `monthlyUsedCents`, `currency` |
| `message` | string | `error` only: error message |
| `status` | integer | `error` only: HTTP status code returned by the account service; omitted when there is none |

### `GET /api/v1/oauth/userinfo`

Reads the managed account's profile. Account service failures are handled the same way as in [`GET /api/v1/oauth/usage`](#get-api-v1-oauth-usage): the envelope still succeeds and the error comes back inside `data`.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `provider` | query | string | Managed provider name. Default `managed:kimi-code` |

On success, `data.kind` is `ok` or `error`:

| Field | Type | Description |
| --- | --- | --- |
| `userInfo` | object | `ok` only: account profile. Always contains `userId`, `nickname`, `status`, `region`, `userLevel`, `userLevelName`, `domain`, `domainName`; may add `globalId`, `bio`, `avatar`, `username`, `email`, `phone` (`{ countryCode, number }`), `createdTime`, and `lastLoginTime` |
| `message` | string | `error` only: error message |
| `status` | integer | `error` only: HTTP status code returned by the account service; omitted when there is none |

### `GET /api/v1/oauth/region`

Resolves which Kimi region the client belongs to. The result is derived locally, without network probes. The server takes the first input that decides the region, in this order: an OAuth host pinned by environment variable or config, the configured OAuth key, and the install-channel marker in `<home>/region`.

When the client is logged out and none of those inputs decides the region, the server infers it from the device time zone and locale. When the inference gives a definite result, the server caches it in `<home>/region.json` and uses the cache from then on; the cache is cleared after the client logs in. Raw time zone and locale values are not uploaded.

When signals are missing or conflicting, the current process falls back to `mainland-cn` without persisting that result, and the next start decides again. Set `KIMI_CODE_REGION_MARKER=off` to disable both the install-channel marker and local inference. Local inference is also skipped when `KIMI_CODE_BASE_URL` is set.

On success, `data` is `{ region }`, where `region` is `mainland-cn` / `global`.

## Remote Control

These endpoints manage the machine-wide Remote Control tunnel (see the [Remote Control guide](../guides/remote-control.md)) and the account's device registry. Tunnel state is per machine. The device registry is per account and stored in the cloud, so device endpoints require a Kimi login; the server holds the login session and proxies requests to the relay, so OAuth credentials never reach the caller.

| Method and path | Description |
| --- | --- |
| `GET /api/v1/remote-control` | Read the tunnel status |
| `POST /api/v1/remote-control` | Start or stop the tunnel |
| `GET /api/v1/remote-control/devices` | List the account's devices |
| `PATCH /api/v1/remote-control/devices/{id}` | Rename a device |
| `POST /api/v1/remote-control/devices/{id}/deactivate` | Take a device offline |
| `DELETE /api/v1/remote-control/devices/{id}` | Remove a device from the registry |

### `GET /api/v1/remote-control`

Returns the current tunnel status. When the tunnel is off but another live process on this machine holds the single-instance lock, `data.conflict` carries the lock holder's information. While the tunnel is off, every read re-checks the lock; once the holder process exits, `conflict` and any stored `error` are cleared together.

On success, `data` is the tunnel status object:

| Field | Type | Description |
| --- | --- | --- |
| `enabled` | boolean | Remote Control switch |
| `state` | string | `off` / `starting` / `on` / `stopping` |
| `url` | string | Tunnel URL; may be omitted |
| `device_id` | string | This machine's device identifier; may be omitted |
| `device_name` | string | This machine's device name; may be omitted |
| `error` | string | Error message; may be omitted |
| `conflict` | object | Lock holder information, present only in the conflict case above: `{ pid, local_origin, device_id, url, started_at }` |

### `POST /api/v1/remote-control`

Starts or stops the tunnel.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `enabled` | body | boolean | `true` to start the tunnel, `false` to stop it |

On success, `data` is the tunnel status object, the same as `GET /api/v1/remote-control`.

- `40001` (`VALIDATION_FAILED`): on start, the server is not bound to a loopback address, or it was started with `--dangerous-bypass-auth`
- `40928` (`REMOTE_CONTROL_ALREADY_RUNNING`): on start, another live process on this machine holds the single-instance lock. `details` carries the lock holder information, in the same shape as `conflict`
- `50001` (`INTERNAL_ERROR`): starting or stopping the tunnel failed

### `GET /api/v1/remote-control/devices`

Lists the account's Remote Control devices from the cloud registry.

On success, `data` is `{ devices, max_devices? }`, where `max_devices` is the device limit. Each item in `devices` has these fields:

| Field | Type | Description |
| --- | --- | --- |
| `device_id` | string | Device identifier |
| `alias` | string | Display name |
| `status` | string | `online` / `offline` |
| `platform` | string | Device platform |
| `client_version` | string | Client version |
| `local_base_url` | string | Device's local server URL |
| `created_at` | string | Creation time |
| `updated_at` | string | Update time |
| `last_remote_access_at` | string | Time of the most recent remote access |

- `50001` (`INTERNAL_ERROR`): the request to the cloud registry failed

### `PATCH /api/v1/remote-control/devices/{id}`

Renames a device.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `id` | path | string | Device identifier |
| `alias` | body | string | New display name, 1–50 characters after trimming leading and trailing whitespace |

On success, `data` is `{ ok: true }`.

- `40001` (`VALIDATION_FAILED`): the name is blank or too long. The server returns this before contacting the cloud
- `50001` (`INTERNAL_ERROR`): the request to the cloud registry failed

### `POST /api/v1/remote-control/devices/{id}/deactivate`

Marks a device offline in the cloud registry. Offline devices stay in the list and do not consume the plan's device quota; a device comes back online the next time it turns on Remote Control.

When the target device is this machine, the server first stops the local tunnel (an in-flight start is cancelled), then holds the machine lock while deactivating, so a concurrent start cannot re-register the device after the success response.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `id` | path | string | Device identifier |

On success, `data` is `{ ok: true }`.

- `50001` (`INTERNAL_ERROR`): the request to the cloud registry failed. Also returned instead of success when the target device is this machine and the lock holder does not stop within the time limit

### `DELETE /api/v1/remote-control/devices/{id}`

Removes a device from the cloud registry: the device disappears from the list, and a tunnel that is still connected is disconnected. Unlike [deactivating](#post-api-v1-remote-control-devices-id-deactivate), deleting does not keep the device in the list.

When the target device is this machine, the server first stops the local tunnel, then holds the machine lock while deleting, so the device cannot re-register after the success response.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `id` | path | string | Device identifier |

On success, `data` is `{ ok: true }`.

- `50001` (`INTERNAL_ERROR`): the request to the cloud registry failed. Also returned when the target device is this machine and the lock holder does not stop within the time limit

## Configuration

These endpoints read and write the global configuration (`config.toml`) and read client configurations delivered remotely by the Kimi Code service.

| Method and path | Description |
| --- | --- |
| `GET /api/v1/config` | Read the global config (secret fields redacted) |
| `POST /api/v1/config` | Merge-patch the config and broadcast `event.config.changed` |
| `POST /api/v1/client_configs` | Read a named client configuration controlled remotely by the Kimi Code service |

### `GET /api/v1/config`

Returns the resolved global configuration: the effective result of `config.toml` plus overlays. Secrets are redacted: each provider reports only `has_api_key`, never the stored key.

On success, `data` is the config object. Its fields map one-to-one to the top-level domains in [Top-level fields](../configuration/config-files.md#top-level-fields):

| Field | Type | Description |
| --- | --- | --- |
| `providers` | object | Map of provider id → `{ type, base_url?, default_model?, api_key_env?, has_api_key }` |
| `default_provider` | string | Global default provider id |
| `default_model` | string | Global default model alias |
| `models` | object | Map of model alias → model record |
| `thinking` | object | Default parameters for Thinking mode |
| `plan_mode` | boolean | Plan mode switch |
| `yolo` | boolean | Derived: `true` when `default_permission_mode` is `yolo` |
| `default_permission_mode` | string | Default permission mode for new sessions |
| `default_plan_mode` | boolean | Whether new sessions start in Plan mode |
| `permission` | object | Initial permission rules |
| `hooks` | array | Lifecycle hooks |
| `services` | object | Built-in external service configuration |
| `merge_all_available_skills` | boolean | Whether to merge Agent Skills from all available directories |
| `extra_skill_dirs` | array | Extra skill search directories |
| `loop_control` | object | Agent loop control parameters |
| `background` | object | Background task runtime parameters |
| `subagent` | object | Subagent configuration |
| `secondary_model` | object | Secondary model pool for subagents |
| `experimental` | object | Experimental flag id → enabled |
| `telemetry` | boolean | Whether anonymous telemetry is enabled |
| `auto_session_title` | boolean | Whether clients may automatically generate session titles |
| `disable_feedback_survey` | boolean | Whether the session rating prompt is turned off |
| `raw` | object | Raw parsed `config.toml` content, unmodeled fields included |

### `POST /api/v1/config`

Merge-patches the global configuration. Each top-level domain in the request body is deep-merged into the matching domain, and domains absent from the body stay unchanged.

The request body is a partial config object: it may contain any top-level domain of the [`GET /api/v1/config`](#get-api-v1-config) response except `raw`, all optional, with the same types and meanings as the response table. Two domains have extra write rules:

- **`yolo`**: `true` is shorthand for `default_permission_mode: "yolo"`; `false` is ignored.
- **`default_permission_mode`**: one of `manual` / `yolo` / `auto`.

On success, `data` is the full updated config, in the same shape as `GET /api/v1/config`.

Every config change broadcasts the global event `event.config.changed` (see [Global events](./server-api-conversation.md#global-events)). This covers a successful update through this endpoint, an edit of `config.toml` outside the process, and server-side writes such as an OAuth login refresh. Changes within a short window are merged into one event: `changedFields` carries the affected domain names (camelCase config domains, for example `defaultModel`), and `config` carries the full current config projection (same shape as the `GET /api/v1/config` response).

- `40001`: the patch was rejected (invalid value or persistence failure); the response carries the underlying error message

### `POST /api/v1/client_configs`

Reads a named client configuration that the Kimi Code service controls remotely, including which model or thinking-effort switches ask the user to confirm, and the client upgrade policy. The server reads it from the Kimi Code service of the account's region (or from `KIMI_CODE_BASE_URL` when that is set) and normalizes the result to the shape that name expects.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `name` | body | string | Required. `model_switch_confirm` / `effort_switch_confirm` / `client_upgrade_policy` |

On success, `data` is `{ name, config }`. When the name is outside that list or the read fails, `config` is `null` and the client falls back to its built-in behavior.

A value that was read never becomes `null`: fields that are missing or malformed take their off defaults. For example, a malformed `model_switch_confirm` comes back as `{ enable: false, rules: [] }`.

## Models and providers

These endpoints manage the two halves of model configuration in `config.toml`: the [providers](../configuration/providers.md) table and the model alias table. A server-proxied models.dev directory is also available for one-shot provider imports.

A model alias id is the alias key in the configuration. Aliases created through the provider-management endpoints take the form `provider_id/model` (for example `my-provider/kimi-for-coding`), while a bare key in the model alias table (such as `turbo`) is used as-is. Anywhere the API takes a `model_id`, including the global `default_model`, it means this alias id.

An unsupported action on a `:{action}` route returns `40001`.

| Method and path | Description |
| --- | --- |
| `GET /api/v1/models` | List configured model aliases |
| `POST /api/v1/models/{model_id}:set_default` | Set the global default model |
| `GET /api/v1/providers` | List providers |
| `POST /api/v1/providers` | Create a provider (201) |
| `GET /api/v1/providers/{provider_id}` | Read a provider (includes the stored key) |
| `PUT /api/v1/providers/{provider_id}` | Replace a provider's configuration |
| `DELETE /api/v1/providers/{provider_id}` | Delete a provider (204) |
| `POST /api/v1/providers/{provider_id}:refresh` | Refresh this provider's model metadata |
| `POST /api/v1/providers:{action}` | Collection actions: `refresh` / `refresh_oauth` / `import_catalog` (201) / `import_registry` (201) |
| `GET /api/v1/catalog/providers` | Browse the models.dev directory (server-proxied) |
| `GET /api/v1/catalog/providers/{catalog_id}` | Read one directory entry |

### `GET /api/v1/models`

Lists the configured model aliases across all providers.

On success, `data.items` is an array of models, each with these fields:

| Field | Type | Description |
| --- | --- | --- |
| `provider` | string | Owning provider id |
| `model` | string | Alias id: `provider_id/model` for provider-managed aliases, otherwise the bare key |
| `display_name` | string | Display name; may be omitted |
| `max_context_size` | integer | Context window in tokens |
| `capabilities` | array | Capability flags; may be omitted |
| `support_efforts` | array | Supported Thinking mode effort levels; may be omitted |
| `default_effort` | string | Default effort level; may be omitted |
| `upgrade` | object | May be present on custom registry models, to guide users toward a replacement model |
| `upgrade.model` | string | Replacement model |
| `upgrade.migration_markdown` | string | Migration notes, with placeholders already replaced by model ids |
| `upgrade.retirement_at` | string | Retirement time; may be omitted |

### `POST /api/v1/models/{model_id}:set_default`

Sets the global `default_model` to an existing alias. `model_id` is the exact alias key from the configuration. For a bare key the call is `POST /api/v1/models/turbo:set_default`; URL-encode the id when it contains `/`, as in `POST /api/v1/models/my-provider%2Fkimi-for-coding:set_default`.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `model_id` | path | string | Required. The exact model alias key from the configuration; URL-encode it when it contains `/` |

On success, `data` is `{ default_model, model }`: `default_model` is the alias now in effect, and `model` is its catalog item (same shape as a `GET /api/v1/models` item).

- `40001`: malformed or unsupported action suffix in the path
- `40413`: no model alias with that id

### `GET /api/v1/providers`

Lists every configured provider with its credential and model-discovery state, without revealing any key. This item shape is also the "provider item" referenced by the other provider endpoints.

On success, `data.items` is an array of provider items:

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | Provider id |
| `type` | string | Wire protocol, returned as the value in the configuration (for values written through these endpoints, see `type` in `POST /api/v1/providers`); `openai` when the configuration does not set it |
| `base_url` | string | API base URL; omitted when unset |
| `default_model` | string | The provider's default model alias. When the provider does not set one but the global `default_model` belongs to this provider, the global value is used; otherwise omitted |
| `api_key_env` | string | Name of the environment variable the API key is read from; omitted when unset |
| `has_api_key` | boolean | Whether a usable API key exists: a non-empty `api_key` is configured, the environment variable named by `api_key_env` has a value, or the provider's `env` supplies a key |
| `status` | string | `error` when the credential configuration conflicts (`api_key` and `api_key_env` both present, or either one present together with OAuth); otherwise `connected` when an API key or a cached OAuth token exists, and `unconfigured` when neither does |
| `models` | array | The provider's model alias ids |

### `POST /api/v1/providers`

Creates a provider and its model aliases in one save. On success, the reply is HTTP 201 with the standard envelope. When no global `default_model` is configured at all (a fresh install), the server seeds it with the new provider's `default_model` (or first model); an existing default is never modified.

Credentials are one of two forms: `api_key` stores the key directly, while `api_key_env` records the name of the environment variable to read the key from. A request that passes non-empty values for both is rejected.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `id` | body | string | Required. Provider id. Only letters, digits, `-`, `_`, and spaces; must start with a letter or digit |
| `type` | body | string | Required. Wire protocol: `kimi` / `openai` / `openai_responses` / `anthropic` / `google-genai` / `vertexai` |
| `api_key` | body | string | API key, stored in `config.toml` |
| `api_key_env` | body | string | Name of the environment variable to read the API key from. The server stores only the variable name, not the key |
| `base_url` | body | string | API base URL; must not contain an environment variable placeholder (`${...}`) |
| `default_model` | body | string | The provider's default model; must be one of `models[].model` |
| `models` | body | array | Required. At least one entry, no duplicate `model` values; entry shape below |

Each `models[]` entry declares one alias whose id is `id/model`:

| Field | Type | Description |
| --- | --- | --- |
| `model` | string | Required. Upstream model name |
| `max_context_size` | integer | Required. Context window in tokens, ≥ 1 |
| `display_name` | string | Display name |
| `capabilities` | array | Capability flags such as `thinking` or `image_in` |
| `max_output_size` | integer | Max output tokens, ≥ 1 |
| `support_efforts` | array | Supported Thinking mode effort levels |
| `adaptive_thinking` | boolean | Adaptive thinking switch |

On success, `data` is the created provider item (same shape as a `GET /api/v1/providers` item).

- `40001`: body validation failed, or both `api_key` and `api_key_env` were passed with non-empty values
- `40921`: a provider with this `id` already exists

### `GET /api/v1/providers/{provider_id}`

Reads one provider. Unlike the list endpoint, the response includes the stored `api_key` when one is set, so a local edit form can prefill it. Keep this in mind when exposing the server port.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `provider_id` | path | string | Required. Provider id |

On success, `data` is the provider item, plus `api_key` when a key is stored.

- `40412`: provider not found

### `PUT /api/v1/providers/{provider_id}`

Replaces a provider in one save. `type`, `base_url`, and the model list are rewritten, and the provider's aliases are rebuilt from `models`: aliases no longer listed disappear from `config.toml`, while other providers' aliases are untouched. Apart from the migration caused by a `new_id` rename, this endpoint does not modify the global default pointers.

`api_key` and `api_key_env` each accept three forms: omitted keeps the stored value, `""` clears it, and any other value replaces it. The two are mutually exclusive: a non-empty value for one clears the other, and a request with non-empty values for both is rejected.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `provider_id` | path | string | Required. Current provider id |
| `new_id` | body | string | Rename the provider. The providers key, model aliases, `default_provider`, a `default_model` pointing at an old alias, and the subagent secondary model pool all migrate. Same id rules as `POST /api/v1/providers` |
| `type` | body | string | Required. Wire protocol: `kimi` / `openai` / `openai_responses` / `anthropic` / `google-genai` / `vertexai` |
| `api_key` | body | string | API key; three forms, see above |
| `api_key_env` | body | string | Name of the environment variable to read the API key from; three forms, see above |
| `base_url` | body | string | API base URL; must not contain an environment variable placeholder (`${...}`) |
| `default_model` | body | string | The provider's default model; must be one of `models[].model` |
| `models` | body | array | Required. At least one entry, no duplicate `model` values; same entry shape as `POST /api/v1/providers` |

On success, `data` is `{ provider }`, where `provider` is the saved provider item.

- `40001`: body validation failed, both `api_key` and `api_key_env` were passed with non-empty values, or a renamed alias id would collide with another provider's alias
- `40003`: the provider is OAuth-managed; log out with `POST /api/v1/oauth/logout` instead
- `40412`: provider not found
- `40921`: `new_id` is already taken

### `DELETE /api/v1/providers/{provider_id}`

Deletes a provider and all of its model aliases, and cascades the cleanup to the subagent secondary model pool. The global `default_provider` / `default_model` pointers stay unchanged, even when they point at the deleted provider. These two values are the user's settings, and this endpoint does not reclaim them.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `provider_id` | path | string | Required. Provider id |

On success, the server returns HTTP 204 with no body; the status code itself reports the successful delete (see [Response envelope](./server-api.md#response-envelope)).

- `40003`: the provider is OAuth-managed; log out with `POST /api/v1/oauth/logout` instead
- `40412`: provider not found

### `POST /api/v1/providers/{provider_id}:refresh`

Re-discovers one provider's model metadata from its upstream source and rewrites the provider's aliases. A provider with a static model source makes no network request and is reported as `unchanged` directly.

This endpoint and the collection-level `:refresh` and `:refresh_oauth` follow the same broadcast rule. When the refresh report's `changed` is non-empty (at least one provider's aliases or managed model metadata changed), the server broadcasts the global event `event.model_catalog.changed` (see [Global events](./server-api-conversation.md#global-events)), with the same content as the refresh report.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `provider_id` | path | string | Required. Provider id |

On success, `data` is a refresh report:

| Field | Type | Description |
| --- | --- | --- |
| `changed` | array | Providers that changed, each `{ provider_id, provider_name, added, removed }`; `added` / `removed` are the numbers of aliases added / removed |
| `unchanged` | array | Ids of providers with no diff |
| `failed` | array | Providers whose refresh failed, each `{ provider, reason }` |
| `retired_default` | object | Optional. Present when the refresh finds that the registry dropped the current default model and that model had declared an `upgrade` replacement: `{ from, to, from_display_name }` |

When `retired_default` is present, the default model has been redirected to `to`, and open sessions still bound to `from` have also been switched to `to`. `from_display_name` is the dropped model's display name, for use in notices. The same field also appears in the `event.model_catalog.changed` event.

- `40001`: malformed or unsupported action suffix in the path
- `40412`: provider not found

### `POST /api/v1/providers:refresh`

Refreshes the model metadata of every provider. The request body is optional, and its content is ignored.

On success, `data` is a refresh report with the same structure as [`POST /api/v1/providers/{provider_id}:refresh`](#post-api-v1-providers-provider-id-refresh), and it can also carry `retired_default`.

### `POST /api/v1/providers:refresh_oauth`

Refreshes only the model list of the managed provider `managed:kimi-code`. When that provider does not exist or is not OAuth-managed, nothing is refreshed and an empty report is returned. The request body is optional, and its content is ignored.

On success, `data` is a refresh report with only `changed` / `unchanged` / `failed`, without `retired_default`.

### `POST /api/v1/providers:import_catalog`

Imports one models.dev directory entry as a configured provider. On success, the reply is HTTP 201 with the standard envelope. The wire protocol and endpoint come from the catalog resolution, and every model in the entry is written as an alias.

Importing an id that already exists is a refresh: the provider entry and its aliases are rewritten from the catalog, and an omitted `api_key` keeps the stored key. This endpoint does not modify existing global default pointers. Only when no default model is configured at all is `default_model` seeded with the first imported model.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `catalog_id` | body | string | Required. Directory entry id from `GET /api/v1/catalog/providers` |
| `id` | body | string | Local provider id, overriding the catalog id. Same id rules as `POST /api/v1/providers` |
| `api_key` | body | string | API key for the imported provider |
| `base_url` | body | string | Overrides the catalog-resolved endpoint. Required when the entry's `needs_base_url` is `true` |

On success, `data` is `{ provider, models_imported }`: `provider` is the provider item, and `models_imported` is the number of aliases written.

- `40001`: `catalog_id` is missing, or another body validation failed
- `40003`: the target provider already exists and is OAuth-managed
- `40004`: the entry cannot be imported (it is rejected, requires a `base_url`, has no importable models, or its id cannot be used as a provider id)
- `40417`: no directory entry with that `catalog_id`
- `50004`: the models.dev directory is unavailable

### `POST /api/v1/providers:import_registry`

Imports a models.dev-shaped private registry (an `api.json` URL plus an optional Bearer key) as configured providers. On success, the reply is HTTP 201 with the standard envelope. Every provider the registry lists is written with a `source` record, so scheduled refreshes can rediscover it.

Re-importing the same URL removes providers that have disappeared upstream. The URL is the registry's stable identity, so rotating the key is safe. Global default pointers follow the same rules as [`:import_catalog`](#post-api-v1-providers-import-catalog).

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `url` | body | string | Required. URL of the registry's `api.json` |
| `api_key` | body | string | Bearer key for the registry. When omitted, the key from the previous import of the same URL is reused |

On success, `data` has these fields:

| Field | Type | Description |
| --- | --- | --- |
| `providers` | array | Imported provider items |
| `models_imported` | integer | Total number of aliases written |
| `credential_env` | object | Map of provider id → environment variable name. When the registry declares API key environment variables for a provider, this is the first non-empty variable name among them |

- `40001`: `url` is missing, or another body validation failed
- `40003`: a listed provider already exists and is OAuth-managed
- `40005`: the registry cannot be fetched or parsed, or lists no importable providers

### `GET /api/v1/catalog/providers`

Browses the models.dev directory. The server proxies the request with a 10-minute in-memory cache and falls back to a built-in snapshot. Entries keep the upstream directory order.

Entries the server cannot import carry `rejected: true` and a machine-readable `reject_reason`. Entries with `needs_base_url: true` require a base URL at import time.

On success, `data.items` is an array of directory entries:

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | Directory entry id |
| `name` | string | Entry name |
| `wire_type` | string \| null | Resolved protocol, same enum as a provider `type` |
| `base_url` | string \| null | Resolved endpoint. `null` for entries whose `needs_base_url` is `true` or that are rejected |
| `guessed` | boolean | Whether the resolution is heuristic |
| `needs_base_url` | boolean | Whether a base URL is required at import time |
| `rejected` | boolean | Whether the server cannot import this entry |
| `reject_reason` | string \| null | Machine-readable rejection reason |
| `env_key` | string \| null | The upstream's conventional API key environment variable |
| `models` | array | Each item is `{ id, name?, max_context_size, capabilities?, reasoning }` |

- `50004`: the directory is unavailable (both the live fetch and the built-in snapshot failed)

### `GET /api/v1/catalog/providers/{catalog_id}`

Reads one models.dev directory entry by catalog id.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `catalog_id` | path | string | Required. Directory entry id |

On success, `data` is the directory entry, in the same shape as a `GET /api/v1/catalog/providers` item.

- `40417`: no directory entry with that `catalog_id`
- `50004`: the directory is unavailable

## Skills, tools, and MCP

These endpoints show the skill catalog a workspace sees, the tool list and MCP servers of the effective agent, and restart MCP servers. For the per-session skill catalog and skill activation (the REST equivalent of the `/<skill>` slash command), see [Session skills](./server-api-sessions.md#session-skills).

| Method and path | Description |
| --- | --- |
| `GET /api/v1/workspaces/{workspace_id}/skills` | Session-less skill catalog for a workspace |
| `GET /api/v1/tools` | List tools of the effective agent |
| `GET /api/v1/mcp/servers` | List MCP servers |
| `POST /api/v1/mcp/servers/{mcp_server_id}:restart` | Restart an MCP server |

### `GET /api/v1/workspaces/{workspace_id}/skills`

Lists the skill catalog that a session in this workspace would see, without creating or resuming a session. The catalog is computed for the workspace's primary directory and extra source folders, and merges the same sources as a session: built-in, plugin, extra, user, and project.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `workspace_id` | path | string | Required. Registered workspace id |

On success, `data` is `{ skills }`. Each item is a skill descriptor, in the same shape returned by [Session skills](./server-api-sessions.md#session-skills):

| Field | Type | Description |
| --- | --- | --- |
| `name` | string | Skill name. Same-name skills can be returned as multiple variants with distinct `path` values |
| `description` | string | Skill description |
| `path` | string | Path of the skill |
| `source` | string | `project` / `user` / `extra` / `builtin` |
| `workspace_dir` | string | Root directory of a project skill; omitted for other sources |
| `type` | string | Optional. Skill category; only user-activatable types can be activated |
| `disable_model_invocation` | boolean | Optional. When `true`, the skill is hidden from the model |
| `scopes` | string[] | Optional. Clients the skill declares it applies to: `tui` / `web` |

- `40410`: workspace not found

### `GET /api/v1/tools`

Lists the tools of the effective agent. The effective agent is the main agent of the selected session, and the session is picked in one of two ways:

- **`session_id` passed**: the server resumes that session on demand, loading a cold session into this server process as well. When the session does not exist, the list is empty.
- **`session_id` omitted**: the most recently created session is used, but it is not resumed. When that session is not live in this server process, the list is empty; there is no fallback to an older live session.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | query | string | Session whose main agent to inspect. Default the most recently created session |

On success, `data` is `{ tools }`, each item with these fields:

| Field | Type | Description |
| --- | --- | --- |
| `name` | string | Tool name |
| `description` | string | Tool description |
| `input_schema` | null | Currently always `null` |
| `source` | string | `builtin` / `skill` / `mcp` |
| `mcp_server_id` | string | Present only on MCP tools, parsed from the `mcp__<server>__<tool>` tool name |
| `active` | boolean | Optional. The tool policy's verdict |

### `GET /api/v1/mcp/servers`

Lists the MCP servers configured for the effective agent. The effective agent is picked the same way as [`GET /api/v1/tools`](#get-api-v1-tools) with `session_id` omitted: the main agent of the most recently created session. When that session is not live in this server process, the list is empty; there is no fallback to an older live session.

On success, `data` is `{ servers }`, each item with these fields:

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | MCP server id |
| `name` | string | MCP server name |
| `transport` | string | `stdio` / `http` / `sse` |
| `status` | string | `connected` / `connecting` / `disconnected` / `error`. Disabled or removed servers report `disconnected`; servers whose connection failed or that need OAuth authorization report `error` |
| `last_error` | string | Optional. Message of the most recent failure |
| `tool_count` | integer | Number of tools the server provides |
| `next_retry_at` | number | Optional. Present while the server waits for an automatic reconnect: the time of the next reconnect (epoch milliseconds) |

### `POST /api/v1/mcp/servers/{mcp_server_id}:restart`

Reconnects one MCP server of the effective agent. The server dispatches through the route `POST /api/v1/mcp/servers/{tail}`, and `restart` is the only action. A bare server id or an unknown action returns `40001`.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `mcp_server_id` | path | string | Required. MCP server id, which is its configured name |

On success, `data` is `{ restarting: true }`.

- `40001`: missing or unknown action suffix
- `40408`: no MCP server with that id (also returned when no session is live)

## Capabilities and plugins

These endpoints query the readiness of built-in capabilities and install them, and manage the full plugin lifecycle from marketplace browsing and installation to removal.

Capabilities are built-in features made of detection steps and a background install, with graded readiness (see `state` in [Capability status object](#capability-status-object)). The current build registers `kimi-cu` (Kimi Computer Use) and `kimi-webbridge` (Kimi Browser Extension). Plugins are installed bundles of skills, MCP servers, hooks, and commands.

| Method and path | Description |
| --- | --- |
| `GET /api/v1/capabilities` | List built-in capabilities with their readiness status |
| `GET /api/v1/capabilities/{capability_id}` | Read one capability's status |
| `POST /api/v1/capabilities/{capability_id}:install` | Start a capability install (runs in the background; poll GET for progress) |
| `GET /api/v1/plugins` | List installed plugins |
| `GET /api/v1/plugins/{plugin_id}` | Read an installed plugin and its declared capabilities |
| `POST /api/v1/plugins` | Install a custom plugin, or a marketplace entry at an expected version |
| `POST /api/v1/plugins/preview` | Inspect a marketplace entry's capabilities read-only, without installing it |
| `GET /api/v1/plugins/marketplace` | Plugin marketplace catalog merged with live install state |
| `POST /api/v1/plugins/{plugin_id}:enable` | Enable a plugin |
| `POST /api/v1/plugins/{plugin_id}:disable` | Disable a plugin |
| `POST /api/v1/plugins/{plugin_id}:remove` | Remove a plugin |

### Capability status object

Every capability endpoint returns this structure.

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | Capability id |
| `pluginId` | string | Optional. Plugin id |
| `displayName` | string | Display name |
| `description` | string | Description |
| `supported` | boolean | Whether the current platform is supported |
| `state` | string | `ready` (every required detection step is `ok`) / `partial` (some steps are `ok`) / `not_installed` / `unsupported` (not available on the current platform / architecture) |
| `version` | string | Optional. Version |
| `steps` | array | Detection steps, each `{ id, state, detail?, optional? }`, where `state` is `ok` / `missing` / `failed` |
| `install.running` | boolean | Whether an install is running |
| `install.step` | string | Optional. Current install step |
| `install.percent` | number | Optional. Install progress, from 0 to 100 |
| `install.error` | string | Optional. Install error |
| `install.note` | string | Optional. Install note |
| `install.confirmationRequired` | string | Optional. When `stop-processes`, the install stopped because related processes are still running; after the user confirms, install again with `stopRunningProcesses: true` |

### `GET /api/v1/capabilities`

Lists every registered capability with its readiness status.

On success, `data` is `{ capabilities }`, where each item is a [capability status object](#capability-status-object).

### `GET /api/v1/capabilities/{capability_id}`

Reads one capability's readiness status. After starting an install, clients poll this endpoint for progress.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `capability_id` | path | string | Required. Capability id |

On success, `data` is a [capability status object](#capability-status-object).

- `40418`: no capability with that id

### `POST /api/v1/capabilities/{capability_id}:install`

Starts installing a capability in the background and immediately returns the current status (with `install.running` set to `true`). Clients poll [`GET /api/v1/capabilities/{capability_id}`](#get-api-v1-capabilities-capability-id) for progress.

The server dispatches through the route `POST /api/v1/capabilities/{tail}`, and `install` is the only action. A bare id or an unknown action returns `40001`.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `capability_id` | path | string | Required. Capability id |
| `stopRunningProcesses` | body | boolean | Optional. When `true`, the install may stop related processes that are still running. The request body may be omitted |

On success, `data` is a [capability status object](#capability-status-object).

Currently only `kimi-cu` on Windows checks for running processes. When related processes exist and `stopRunningProcesses: true` was not passed, the background install ends with `install.confirmationRequired` set to `stop-processes`.

- `40001`: missing or unknown action suffix
- `40418`: no capability with that id
- `40924`: an install of this capability is already running
- `40925`: the capability is not supported on the current platform / architecture

### Plugin summary

Listing and installing plugins return this structure. Plugin details add fields on top of it.

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | Plugin id |
| `displayName` | string | Display name |
| `description` | string | Optional. Description |
| `shortDescription` | string | Optional. Short description |
| `longDescription` | string | Optional. Long description |
| `version` | string | Optional. Version |
| `enabled` | boolean | Whether the plugin is enabled |
| `state` | string | `ok` / `error`. A load failure also sets `hasErrors` |
| `skillCount` | integer | Number of skills |
| `mcpServerCount` | integer | Number of MCP servers |
| `enabledMcpServerCount` | integer | Number of enabled MCP servers |
| `hookCount` | integer | Number of hooks |
| `commandCount` | integer | Number of commands |
| `hasErrors` | boolean | Whether there are errors |
| `source` | string | `local-path` / `zip-url` / `github` |
| `originalSource` | string | Optional. Original source |
| `github` | object | Optional. GitHub-sourced plugins carry the provenance `{ owner, repo, ref, installedSha? }`, where `ref` is `{ kind, value }` and `kind` is `branch` / `tag` / `sha` |
| `origin` | string | `marketplace` / `custom` / `unknown` |
| `catalogId` | string | Optional. Catalog id |
| `installedAt` | string | Install time, ISO timestamp |

### `GET /api/v1/plugins`

Lists installed plugins.

On success, `data` is `{ plugins }`, where each item is a [plugin summary](#plugin-summary).

### `GET /api/v1/plugins/{plugin_id}`

Reads an installed plugin's details and capabilities. Both the `skills` and `mcpServers` lists come from the plugin's actual files and manifest. `interface.skillOverrides` and `interface.mcpOverrides` override display information only; they do not change invocation names or runtime configuration.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `plugin_id` | path | string | Required. Installed plugin id |
| `locale` | query | string | Optional. For example `en-US` or `zh-CN`. Selects the matching translation from `interface.locales` and affects only the display text of capabilities; fields without a match fall back to the default `interface` |

On success, `data` is a [plugin summary](#plugin-summary) plus these fields:

| Field | Type | Description |
| --- | --- | --- |
| `root` | string | Plugin root directory |
| `updatedAt` | string | Optional. Update time |
| `manifestKind` | string | Optional. Manifest kind: `kimi-plugin-root` / `kimi-plugin-dir` |
| `manifestPath` | string | Optional. Manifest path |
| `skills` | array | Skills actually discovered: the invocation name `name`, plus the optional display name `displayName` and description `description` |
| `mcpServers` | array | MCP servers declared in the manifest: name, runtime name, enabled state, transport, non-secret connection settings, and optional display name, description, and icon URL |
| `shadowedManifestPath` | string | Optional. Path of the shadowed manifest |
| `diagnostics` | array | Diagnostics, each `{ severity, message }`, where `severity` is `error` / `warn` / `info` |

- `40419`: no installed plugin with that id

### `POST /api/v1/plugins`

Installs a plugin and returns its summary. The request body takes one of two forms: a custom install passes only `source`; a marketplace install passes `marketplaceId` plus the expected version information, and does not pass `source` directly. Neither form accepts other fields.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `source` | body | string | Required for a custom install. An absolute local path, an http(s) ZIP URL, or a GitHub URL. A GitHub URL can pin a version with `/tree/<branch-or-sha>`, `/releases/tag/<tag>`, or `/commit/<sha>` |
| `marketplaceId` | body | string | Required for a marketplace install. Catalog entry id |
| `expectedVersion` | body | string | For marketplace installs. The version shown to the user; custom entries without a version may omit it |
| `expectedSha256` | body | string | For marketplace installs. The `sha256sum` shown to the user (64 hex characters). When a ZIP entry declares `sha256sum`, it must be passed and must match the catalog; local-directory and GitHub entries do not need it |

For a marketplace install, the server resolves `source`, `sha256sum`, and the expected plugin ID from the same catalog snapshot, verifies the archive before extraction, and checks the manifest ID.

On success, `data` is a [plugin summary](#plugin-summary).

- `40001`: validation failed, for example `source` is neither a URL nor an absolute path, or the plugin failed to load
- `40409`: the local path does not exist
- `40419`: no marketplace entry with that id
- `40934`: the catalog entry has changed since the version shown to the user (refresh the catalog and retry)

### `POST /api/v1/plugins/preview`

Inspects a marketplace entry's capabilities read-only, without installing the plugin. The server downloads the archive into a temporary directory, verifies its SHA-256 before extraction, checks the manifest ID, and discovers the skills and MCP servers inside. A preview writes no install record, installs no runtime, and does not keep the extracted plugin.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `marketplaceId` | body | string | Required. Catalog entry id |
| `expectedVersion` | body | string | The version shown to the user |
| `expectedSha256` | body | string | Optional. The `sha256sum` shown to the user (64 hex characters); when given, it must match the current catalog |
| `locale` | body | string | Optional. Language of the display text, selected by the same rules as `locale` in [`GET /api/v1/plugins/{plugin_id}`](#get-api-v1-plugins-plugin-id) |

On success, `data` is `{ skills, mcpServers }`, for example:

```json
{
  "skills": [{ "name": "<skill name>", "description": "<optional description>" }],
  "mcpServers": [{ "name": "<name in manifest>", "runtimeName": "<runtime name>", "enabled": true, "transport": "stdio" }]
}
```

Both entry types can also include `displayName` and `description` from overrides, and MCP entries can also include `iconUrl`. MCP entries use the same field structure as [`GET /api/v1/plugins/{plugin_id}`](#get-api-v1-plugins-plugin-id); the example lists only the common fields.

- `40001`: the request, archive, SHA-256, or manifest is invalid
- `40419`: no marketplace entry with that id
- `40934`: the catalog entry has changed since the version shown to the user (refresh the catalog and retry)

### `GET /api/v1/plugins/marketplace`

Lists the plugin marketplace catalog merged with live install state. The default catalog URL is derived from the current managed `baseURL` as `${baseURL}/plugins/marketplace`, and built-in capability entries are no longer injected.

The server filters entries by two conditions, and an entry must meet both:

- **Host**: the catalog's `clients` limits an entry to `desktop`, `cli`, or both; when omitted, both hosts can use it. Web and Remote Control use the host identity of the connected server.
- **Operating system**: `platforms` filters independently by the operating system the server runs on. An entry is kept when `platforms` is unset, includes the server's platform, or contains only `cloud`. Other entries are filtered out, including entries that list `cloud` together with other platforms but not the server's platform.

Cloud-only entries cannot be installed locally. The legacy `kimi-webbridge` entry is no longer returned, and Computer Use returns only the wiring plugin for the current platform.

Install records and managed files are still shared under the server's data directory. Entries unavailable to the current host are also hidden from that host's installed list and runtime capabilities.

The server caches the last successfully fetched availability configuration in `plugins/availability.json`. After a successful catalog refresh, changed client rules hide or restore existing installs without reinstalling them or deleting plugin files.

On success, `data` is `{ entries }`, each item with the fields below. For the request form of a marketplace install, see [`POST /api/v1/plugins`](#post-api-v1-plugins).

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | Catalog entry id, passed as `marketplaceId` for a marketplace install |
| `tier` | string | Entry tier: `official` / `curated` / `third-party`. When the entry declares `distribution`, it is `official` if `distribution.category` is `official`, otherwise `curated`; without `distribution`, it is the entry's `tier`, defaulting to `third-party` |
| `classification` | string | Entry classification: `official` / `third_party`. When the entry declares `distribution`, it is `distribution.category`; otherwise it is derived from `tier`: `official` gives `official`, anything else gives `third_party` |
| `displayName` | string | Display name |
| `description` | string | Optional. Description, in the language declared by `defaultLocale` |
| `shortDescription` | string | Optional. Short description |
| `longDescription` | string | Optional. Long description |
| `cliDescription` | string | Optional. CLI description, in the language declared by `defaultLocale` |
| `homepage` | string | Optional. Homepage |
| `keywords` | string[] | Optional. Keywords |
| `version` | string | Optional. Version |
| `source` | string | Entry source |
| `iconUrl` | string | Optional. Icon URL |
| `sha256sum` | string | Optional. Archive digest |
| `filename` | string | Optional. File name |
| `locale` | object | Optional. Per-language translations of `displayName`, `shortDescription`, `longDescription`, and `cliDescription` |
| `defaultLocale` | string | Optional. Language of the top-level `description` / `cliDescription` |
| `platforms` | string[] | Optional. `darwin` / `win32` / `linux` / `cloud` |
| `distribution` | object | Optional. Distribution info: `category` is `official` / `third_party`; the optional `region` (string), `defaultInstall` (boolean), `weight` (number), and `userLevel` are taken as-is from the catalog |
| `billing` | object | Optional. Billing info, taken as-is from the catalog |
| `installed` | object | Optional. Present when installed, with the live install state `{ version?, enabled }` |
| `updateAvailable` | boolean | Optional. `true` when an update is available, otherwise omitted |
| `capabilityId` | string | Optional. Set only by the server, and only when the default marketplace is used: `kimi-browser-extension` maps to the `kimi-webbridge` capability, and `kimi-cu` / `kimi-cu-win` map to the `kimi-cu` capability |

- `50001`: the marketplace is unreachable or returned an invalid catalog

### `POST /api/v1/plugins/{plugin_id}:enable`

Enables an installed plugin. Plugin actions dispatch through one route, `POST /api/v1/plugins/{tail}`: the tail is parsed as `{plugin_id}:{action}`, with `enable` / `disable` / `remove` as the actions. A bare id or an unknown action returns `40001` (`unsupported action: ...`).

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `plugin_id` | path | string | Required. Installed plugin id |

On success, `data` is `{ ok: true }`.

- `40001`: missing or unknown action suffix
- `40419`: no installed plugin with that id

### `POST /api/v1/plugins/{plugin_id}:disable`

Disables an installed plugin without removing it. Dispatch works as in [`:enable`](#post-api-v1-plugins-plugin-id-enable).

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `plugin_id` | path | string | Required. Installed plugin id |

On success, `data` is `{ ok: true }`.

- `40001`: missing or unknown action suffix
- `40419`: no installed plugin with that id

### `POST /api/v1/plugins/{plugin_id}:remove`

Removes an installed plugin. Dispatch works as in [`:enable`](#post-api-v1-plugins-plugin-id-enable).

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `plugin_id` | path | string | Required. Installed plugin id |

On success, `data` is `{ ok: true }`.

- `40001`: missing or unknown action suffix
- `40419`: no installed plugin with that id

## Workspaces

These endpoints manage the workspace registry and read and write each workspace's trust state. A workspace is a registered project directory that sessions live in; the trust state decides whether the workspace's project-level MCP config loads. Endpoints that return a workspace use the [workspace object](#workspace-object).

| Method and path | Description |
| --- | --- |
| `GET /api/v1/workspaces` | List registered workspaces |
| `POST /api/v1/workspaces` | Register a workspace (each call creates a new entry; retries are deduplicated with `idempotency_key`) |
| `PATCH /api/v1/workspaces/{workspace_id}` | Rename, or replace the source folders as a whole |
| `POST /api/v1/workspaces/{workspace_id}/primary` | Promote a source folder to the primary directory |
| `GET /api/v1/workspaces/project-config-dirs` | Read the additional directories in a project's `local.toml`, read-only |
| `DELETE /api/v1/workspaces/{workspace_id}` | Unregister a workspace (keeps on-disk content) |
| `GET /api/v1/workspaces/{workspace_id}/trust` | Read the trust state |
| `POST /api/v1/workspaces/{workspace_id}/trust` | Grant trust |
| `POST /api/v1/workspaces/{workspace_id}/untrust` | Revoke trust |

### Workspace object

When a workspace is registered or updated, the server broadcasts the [global events](./server-api-conversation.md#global-events) `event.workspace.created` / `event.workspace.updated`.

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | Workspace id. `wd_<slug>_<hash12>` for implicit channels (CLI / VS Code entering a directory), `wm_<uuid>` when created explicitly through `POST /api/v1/workspaces` |
| `root` | string | Absolute path of the primary directory |
| `name` | string | Display name, 1–100 characters; defaults to the base name of the primary directory |
| `kind` | string | `managed`: created explicitly, `wm_` id; sessions do not merge the project `local.toml`. `implicit`: registered implicitly by directory, `wd_` id; sessions merge the project `local.toml` for compatibility with legacy config |
| `additional_dirs` | string[] | Absolute paths of the registry-managed extra source folders, excluding the project `local.toml` and ephemeral sources |
| `created_at` | string | Registration time, ISO 8601 |
| `last_opened_at` | string | Last time the workspace was opened or re-registered, ISO 8601 |
| `session_count` | integer | Number of sessions in the workspace |

### `GET /api/v1/workspaces`

Lists every registered workspace.

On success, `data` is `{ items }`, where each item is a [workspace object](#workspace-object).

### `POST /api/v1/workspaces`

Registers a new workspace and returns it. Every call creates a new entry (`wm_<uuid>` id). Even when the same path is already another workspace's primary directory, the call does not merge into the existing entry or warn.

When a client resubmits (network retry, double click), it should send the same `idempotency_key`. The server deduplicates by key and returns the entry created the first time.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `root` | body | string | Required. Absolute path of an existing directory, used as the primary directory |
| `name` | body | string | Display name, 1–100 characters. Default the base name of the primary directory |
| `additional_dirs` | body | string[] | Extra source folders, at most 64 items. Each item resolves by the `add-dir` rules (absolute path, relative to the primary directory, or `~` expansion), must exist and be a directory, and must not duplicate the primary directory or another item |
| `idempotency_key` | body | string | Client-generated idempotency key, 1–200 characters. Retries with the same key return the workspace created the first time |

On success, `data` is a [workspace object](#workspace-object).

- `40001`: `root` is missing or not an absolute path, or another request validation failed (`details` lists the field)
- `40006`: `additional_dirs` contains duplicates or the primary directory itself. `msg` is `Duplicate source folder: <actual path>`; `details` is `[{ "path": "additional_dirs.N", "directory": "<resolved absolute path>" }]`, where `path` is the location of the request field and `directory` is the duplicated directory
- `40409`: `root` or a path in `additional_dirs` does not exist or is not a directory

### `PATCH /api/v1/workspaces/{workspace_id}`

Updates a workspace's display name and/or source folders; the primary directory cannot be changed. At least one of `name` and `additional_dirs` is required. `additional_dirs` is a whole-list replacement: submit the full edited list, or omit the field to keep it unchanged.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `workspace_id` | path | string | Required. Workspace id |
| `name` | body | string | New display name, 1–100 characters |
| `additional_dirs` | body | string[] | Full replacement list of extra source folders, resolved and validated as in [`POST /api/v1/workspaces`](#post-api-v1-workspaces) |

On success, `data` is a [workspace object](#workspace-object).

- `40001`: both fields are missing, or another request validation failed (`details` explains each field)
- `40006`: duplicate entries, or an entry equal to the primary directory; `msg`, `details.path`, and `details.directory` mean the same as in [`POST /api/v1/workspaces`](#post-api-v1-workspaces)
- `40409`: a path in `additional_dirs` does not exist or is not a directory
- `40410`: workspace not found

### `POST /api/v1/workspaces/{workspace_id}/primary`

Promotes a source folder in the directory set to the primary directory. The server performs an atomic swap: the path becomes the new `root`, and the previous primary directory moves into `additional_dirs`. The workspace id and session bucket do not change, and all sessions are kept. `local.toml` follows the primary directory, so after the swap the additional directories in the previous primary directory's `local.toml` are no longer merged.

For existing sessions that run on the `local` environment without an explicit `environmentCwd`, the default working directory and relative paths of later tool calls follow the new primary directory. An explicit `environmentCwd` and remote environment bindings keep their configured directory.

Additional directories only widen the allowed access scope; they are not candidate roots for relative paths, so access them with absolute paths or an explicit `cwd`. Registered tools stay available during the swap, and the workspace's existing trust decision is kept across restarts.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `workspace_id` | path | string | Required. Workspace id |
| `path` | body | string | Required. Directory to promote, resolved by the `add-dir` rules; must be in the current directory set (`root` ∪ `additional_dirs`) |

On success, `data` is a [workspace object](#workspace-object).

- `40001`: `path` is not in the directory set
- `40409`: `path` does not exist or is not a directory
- `40410`: workspace not found

### `GET /api/v1/workspaces/project-config-dirs`

Returns `workspace.additional_dir` from the given project's `local.toml`, read-only. The result is resolved to absolute paths, deduplicated, and excludes `root` itself. The endpoint modifies neither the registry nor `local.toml`. Clients can use it to merge a project's legacy config into the create or edit workspace form, taking effect on save.

The server walks up from `root` to the first directory that contains `.git` and uses it as the project root (or `root` itself when none is found), then reads `.kimi-code/local.toml` there. A missing `local.toml` returns an empty array. Malformed TOML or a configured directory that no longer exists fails the request instead of returning an empty config.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `root` | query | string | Required. Absolute path of the project's primary directory |

On success, `data` is `{ additional_dirs: string[] }`.

- `40001`: `root` is missing or empty; the structure of `local.toml` is invalid (for example `workspace.additional_dir` is not an array of strings); or a directory configured there does not exist or is not a directory
- `50001`: `local.toml` is not valid TOML, or reading it failed

### `DELETE /api/v1/workspaces/{workspace_id}`

Unregisters a workspace. Only the registry entry is removed; the directory on disk is untouched.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `workspace_id` | path | string | Required. Workspace id |

On success, `data` is `{ deleted: true }`.

- `40410`: workspace not found

### `GET /api/v1/workspaces/{workspace_id}/trust`

Reads the workspace's trust state. The trust state decides whether project-level MCP config loads for the workspace.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `workspace_id` | path | string | Required. Workspace id |

On success, `data` is `{ trusted }`.

- `40410`: workspace not found

### `POST /api/v1/workspaces/{workspace_id}/trust`

Marks the workspace as trusted and loads its project-level MCP config.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `workspace_id` | path | string | Required. Workspace id |

On success, `data` is `{ trusted: true }`.

- `40410`: workspace not found

### `POST /api/v1/workspaces/{workspace_id}/untrust`

Revokes the persisted trust records associated with the current directory set. Unless a process or config override keeps the workspace trusted, its project-level MCP config is also unloaded.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `workspace_id` | path | string | Required. Workspace id |

On success, `data` is `{ trusted }`, the effective trust state after revocation. It is normally `false`, but stays `true` when `KIMI_CODE_TRUST_WORKSPACE` or [`[workspace] require_trust = false`](../configuration/config-files.md#workspace-trust) applies.

- `40410`: workspace not found

## File uploads

These endpoints upload files for later reference (for example as prompt attachments), and download or delete uploaded files.

| Method and path | Description |
| --- | --- |
| `POST /api/v1/files` | Multipart upload (`file` field, optional `name` and `expires_in_sec`); returns file metadata |
| `GET /api/v1/files/{file_id}` | Download (binary; errors use real HTTP status codes) |
| `DELETE /api/v1/files/{file_id}` | Delete |

### `POST /api/v1/files`

Uploads a file as `multipart/form-data`.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `file` | body | binary | Required. The multipart file part |
| `name` | body | string | Stored display name. Default the uploaded file name |
| `expires_in_sec` | body | number | Seconds until the file expires (non-negative). Default never expires |

On success, `data` is the file metadata:

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | File id, used to download and delete the file |
| `name` | string | Display name |
| `media_type` | string | Taken from the upload's content type |
| `size` | integer | File size |
| `created_at` | string | Upload time |
| `expires_at` | string | Optional. Expiry time |

- `40001`: the multipart body has no `file` field

### `GET /api/v1/files/{file_id}`

Downloads an uploaded file. The response is a binary stream that supports range requests but does not handle `If-None-Match`. Failures use real HTTP status codes; see [Binary and streaming endpoints](./server-api-files.md#binary-and-streaming-endpoints).

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `file_id` | path | string | Required. File id from the upload response |

- `40407` (HTTP 404): no file with that id (including an expired file)

### `DELETE /api/v1/files/{file_id}`

Deletes an uploaded file.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `file_id` | path | string | Required. File id from the upload response |

On success, `data` is `{ deleted: true }`.

- `40407` (HTTP 404): no file with that id

## GUI store

A server-backed key/value store persisted at `gui.json` under the server's home directory (with a cross-process file lock, durable atomic replacement, and corrupt-file quarantine). Used to synchronize cross-client UI state such as pinned sessions and workspace ordering; values are strings with monotonic per-key `revision` numbers, optional optimistic concurrency checks (`if_revision`), and live `event.gui_store.updated` WebSocket broadcasts.

| Method and path | Description |
| --- | --- |
| `GET /api/v1/gui/store` | Read a versioned snapshot of stored entries (optionally filtered by `prefix` or `keys`) |
| `PATCH /api/v1/gui/store` | Atomically upsert or delete entries with optional per-key `if_revision` checks |

### `GET /api/v1/gui/store`

Reads the persisted snapshot and store revision. Returns `{ revision: 0, entries: {} }` when `gui.json` does not exist yet.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `prefix` | query | string | Optional. Only return entries whose key starts with this prefix, up to 256 characters |
| `keys` | query | string \| string[] | Optional. Only return entries matching these keys, up to 16 items and 4,096 URL-encoded query bytes |

On success, `data` is `{ revision, entries }`, where `entries` maps each key to `{ value, revision }`. If `gui.json` on disk is corrupt or truncated to zero bytes, it is quarantined to `gui.json.corrupt-*` and error code `50003` is returned with `details.quarantine_path`; subsequent writes recover with a monotonically higher revision floor.

### `PATCH /api/v1/gui/store`

Atomically upserts or deletes a batch of entries under a cross-process lock, with optional per-key optimistic concurrency checks.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `mutations` | body | array | Required. 1–128 unique-key mutations totaling at most 512 KiB of UTF-8 key/value bytes, each `{ key, value, if_revision? }`: `key` is 1–256 characters; `value` is a string (up to 65,536 characters) to upsert or `null` to delete; `if_revision` is a non-negative integer (`0` asserts the key is currently absent) |

On success, `data` is `{ applied, revision, entries, conflicts }`:
- When every `if_revision` check matches, `applied` is `true`, `entries` holds the resulting `{ value, revision }` (or `null` when deleted) for each mutated key, `conflicts` is `{}`, and `event.gui_store.updated` is broadcast when any value changed.
- When any `if_revision` mismatches, nothing is written, `applied` is `false`, and `conflicts` holds the current server `{ value, revision }` (or `null` when absent) for each conflicting key so the caller can merge and retry.

## Global search and other endpoints

Cross-session full-text search, the list of live WebSocket connections, and entry points to other endpoints.

| Method and path | Description |
| --- | --- |
| `POST /api/v1/search` | Cross-session full-text search; `mode` is `terms` (default) or `literal` (exact substring); paginated with `page_token` |
| `GET /api/v1/connections` | List live WebSocket connections |
| `GET /api/v2/sessions` | Next-generation session list; see [`GET /api/v2/sessions`](./server-api-sessions.md#get-api-v2-sessions) |
| `POST /api/v2/sessions:archive` | Batch-archive sessions; see [`POST /api/v2/sessions:archive`](./server-api-sessions.md#post-api-v2-sessions-archive) |
| `POST /api/v2/sessions:restore` | Batch-restore archived sessions; see [`POST /api/v2/sessions:restore`](./server-api-sessions.md#post-api-v2-sessions-restore) |
| `/api/v2/mcp/*` | Unified MCP management plane; see [MCP management](#mcp-management) |
| `/api/v1/debug/*` | Reflection debug RPC; mounted only with `--debug-endpoints` on loopback, not part of the stable protocol |

### `POST /api/v1/search`

Cross-session full-text search over user messages, assistant replies, and session titles, backed by the server's persistent search index.

A search scoped to one session with `container.session_id` also uses the index. So text that a running step is still generating becomes searchable only after the step is saved and the index catches up; a view that is still catching up is marked by `index_state.stale`.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `query` | body | string | Required. Search text |
| `mode` | body | string | `terms` (default) / `literal` |
| `op` | body | string | How terms combine in `terms` mode: `AND` (default) / `OR` |
| `container` | body | object | Restrict the search to `{ session_id?, agent_id? }` |
| `role` | body | string | Only `user` / `assistant` / `title` hits |
| `start_time` | body | integer | Only hits at or after this time (epoch milliseconds) |
| `end_time` | body | integer | Only hits at or before this time (epoch milliseconds) |
| `sort` | body | string | `score` (default) / `time_desc` / `time_asc`; `literal` mode ignores it and always returns newest first |
| `page_size` | body | integer | Hits per page, 1–50. Default `20` |
| `page_token` | body | string | Token returned by the previous page's response |

`terms` mode tokenizes the query (ASCII words plus CJK n-grams), deduplicates the terms, and matches at most 32 terms against the inverted index. `literal` mode is an exact substring search with zero false positives.

Page tokens pin the index generation and the query conditions, so an index rebuild or a changed query invalidates them.

On success, `data` has these fields:

| Field | Type | Description |
| --- | --- | --- |
| `items` | array | Hits; item fields in the table below |
| `has_more` | boolean | Whether there is a next page |
| `page_token` | string | Optional. Token for the next page |
| `incomplete` | string | Present only on over-budget pages: `candidate_cap` / `postings_budget` / `deadline` |
| `index_state.state` | string | `building` / `ready` / `readonly` |
| `index_state.indexed_sessions` | integer | Number of indexed sessions |
| `index_state.total_sessions` | integer | Total number of sessions |
| `index_state.documents` | integer | Number of documents |
| `index_state.stale` | boolean | Optional. Marks a lagging view that is still catching up |
| `index_state.degraded` | string | Optional. Message of the most recent refresh failure |

Fields of each `items` entry:

| Field | Type | Description |
| --- | --- | --- |
| `session_id` | string | Session id |
| `workspace_id` | string | Workspace id |
| `session_title` | string | Session title |
| `agent_id` | string | Agent id |
| `role` | string | `user` / `assistant` / `title` |
| `snippet` | string | Matched snippet |
| `time` | number | Hit time |
| `turn` | integer | Optional. Turn |
| `step_id` | string | Optional. Step id |
| `score` | number | Relevance score |

- `40001`: body validation failed, the query is unusable (empty, or more than 32 terms), or the page token is invalid

### `GET /api/v1/connections`

Lists the WebSocket clients currently connected to this server, oldest connection first. No parameters.

On success, `data` is `{ connections }`, each item with these fields:

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | Connection id |
| `connected_at` | string | Connection time, ISO 8601 |
| `remote_address` | string \| null | Remote address; `null` when unknown |
| `user_agent` | string \| null | User-Agent; `null` when unknown |
| `subscriptions` | string[] | Ids of the sessions this connection subscribes to |

## MCP management

`/api/v2/mcp/*` is the server's unified MCP management plane. It is independent of any session and manages the MCP server registry itself. It covers CRUD on user-level config (each entry is validated before it is written), connection tests, a locator-addressed inspection catalog, per-server auth status, and the full OAuth flow.

| Method and path | Description |
| --- | --- |
| `GET /api/v2/mcp/servers` | List every known MCP server |
| `GET /api/v2/mcp/servers/{name}` | Get one MCP server by runtime name |
| `POST /api/v2/mcp/servers` | Add an MCP server to the user-level `mcp.json` |
| `PUT /api/v2/mcp/servers/{name}` | Replace a user-level entry |
| `DELETE /api/v2/mcp/servers/{name}` | Delete a user-level entry |
| `POST /api/v2/mcp/servers:test` | Probe a real connection to one MCP server |
| `POST /api/v2/mcp/servers:inspect` | Locator-addressed catalog with batched connection probes |
| `GET /api/v2/mcp/auth-statuses` | OAuth state of each MCP server in the catalog |
| `POST /api/v2/mcp/auth:begin` | Begin an interactive OAuth flow |
| `POST /api/v2/mcp/auth:complete` | Wait for the browser callback and finish the code exchange |
| `POST /api/v2/mcp/auth:cancel` | Terminate a begun OAuth flow |
| `POST /api/v2/mcp/auth:reset` | Clear an MCP server's stored credentials |

The management plane uses two addressing schemes:

- **Runtime name**: the CRUD endpoints and `servers:test` use a plain runtime `name`.
- **Locator**: the inspection and OAuth endpoints use a locator, because a plugin entry and a file entry can share one runtime name. A file-layer entry's locator is `{ "source": "global", "name" }`, and a plugin-manifest entry's is `{ "source": "plugin", "pluginId", "serverName" }`.

Inspection results also carry a stable `serverId`: `global:<name>` or `plugin:<pluginId>:<serverName>` (URL-encoded).

Every endpoint except `auth:complete` and `auth:cancel` accepts an optional `cwd`: in the request body for `servers:test` and `servers:inspect`, and as a query parameter for the rest (including `auth:begin` and `auth:reset`). Without it, the catalog covers only the user-level file and plugin manifests. With it, the project-root and project-local layers of that directory join in, but only when the workspace is [trusted](#get-api-v1-workspaces-workspace-id-trust); otherwise the project layers are skipped. For `servers:test` on a stdio server, `cwd` is also the child process's working directory.

Connection probes and OAuth calls wait until the server configuration has finished loading.

### `GET /api/v2/mcp/servers`

Lists every MCP server the management plane knows about.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `cwd` | query | string | Include the project layers of this directory (must be trusted) |

On success, `data` is an array of managed MCP servers, each with these fields:

| Field | Type | Description |
| --- | --- | --- |
| `name` | string | Runtime name |
| `config` | object | Mutable entries carry the full config so edit UIs can prefill it; read-only entries are redacted to sorted key lists (`envKeys` / `headerKeys`) and never disclose secret values |
| `source` | string | `global` (a config-file layer, including the user-level file and project layers) or `plugin` (a plugin manifest). The schema also has `caller`, which is currently never returned |
| `origin` | string | Where the entry is defined: a file path or a plugin id |
| `mutable` | boolean | Only user-level entries are mutable; plugin and project-layer entries are read-only |
| `plugin` | object | Present only on plugin entries: `{ id, name }` |

- `40001`: validation failure

### `GET /api/v2/mcp/servers/{name}`

Gets one MCP server by runtime name.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `name` | path | string | Required. Runtime name of the MCP server |
| `cwd` | query | string | Include the project layers of this directory (must be trusted) |

On success, `data` is a single managed MCP server, with the same fields as [`GET /api/v2/mcp/servers`](#get-api-v2-mcp-servers).

- `40001`: validation failure
- `40408`: no MCP server with that name

### `POST /api/v2/mcp/servers`

Adds an MCP server to the user-level `mcp.json`. The request body is a full server config including `name`. `transport` (`stdio` / `http` / `sse`) determines the config shape, and the config is validated before it is written.

A write that collides with a same-named project-layer entry is rejected because that entry is read-only; edit the file that defines it instead. Project layers join in only when `cwd` is passed and that directory is trusted, so this collision is checked only then. A collision with a same-named plugin entry does not block the write, and the new file entry shadows the plugin entry.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `cwd` | query | string | Include the project layers of this directory (must be trusted); the returned list also includes project layers |

On success, `data` is the refreshed MCP server list, with the same fields as [`GET /api/v2/mcp/servers`](#get-api-v2-mcp-servers).

- `40001`: validation failure, or the target entry is read-only

### `PUT /api/v2/mcp/servers/{name}`

Replaces a user-level entry. The request body is the same config as in [`POST /api/v2/mcp/servers`](#post-api-v2-mcp-servers), but without `name`, because the path names the entry. Collisions with same-named entries follow the same rules.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `name` | path | string | Required. Runtime name of the entry to replace |
| `cwd` | query | string | Include the project layers of this directory (must be trusted) |

On success, `data` is the refreshed MCP server list.

- `40001`: validation failure, or the target entry is read-only
- `40408`: no MCP server with that name

### `DELETE /api/v2/mcp/servers/{name}`

Deletes a user-level entry. No request body.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `name` | path | string | Required. Runtime name of the entry to delete |
| `cwd` | query | string | Include the project layers of this directory (must be trusted) |

On success, `data` is the refreshed MCP server list.

- `40001`: validation failure, or the target entry is read-only
- `40408`: no MCP server with that name

### `POST /api/v2/mcp/servers:test`

Probes a real connection to one MCP server and persists nothing. Pass `name` to probe a registry entry (plugin and trusted project layers included), or pass `server` to probe an inline config as-is. Exactly one of the two must be passed.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `name` | body | string | Runtime name of a registry entry |
| `server` | body | object | Inline config to probe as-is; must include `name` |
| `cwd` | body | string | Used to include project layers; also the working directory of a stdio child process |

On success, `data` is `{ success, output }`: when the connection succeeds, `output` lists the server's available tools; otherwise it carries the failure message.

- `40001`: both or neither target form passed, the inline config is invalid, or the runtime name is shared by multiple enabled MCP servers
- `40408`: no MCP server with that name

### `POST /api/v2/mcp/servers:inspect`

Returns the locator-addressed catalog (with redacted configs) and runs a batched real-connection probe of every OAuth candidate. A probe that hits an expired grant may refresh or invalidate the stored credentials.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `targets` | body | array | Locators that narrow the catalog; when omitted, every MCP server is inspected |
| `cwd` | body | string | Include the project layers of this directory (must be trusted) |

On success, `data` is an array of inspection results, each with these fields:

| Field | Type | Description |
| --- | --- | --- |
| `serverId` | string | Stable identifier; format in [MCP management](#mcp-management) |
| `locator` | object | The entry's locator |
| `runtimeName` | string | Runtime name |
| `canonicalUrl` | string | Optional. Credential URL of a remote server |
| `origin` | string | Entry source, with the same values as `source` in [`GET /api/v2/mcp/servers`](#get-api-v2-mcp-servers) |
| `config` | object | Redacted config |
| `enabled` | boolean | Whether the entry is enabled |
| `editable` | boolean | Whether the entry is editable |
| `authStatus` | string | `not-applicable` / `bearer-token` / `oauth-required` / `oauth-authorized` / `oauth-expired` / `unavailable`. A runtime name shared by multiple enabled MCP servers cannot be probed unambiguously and reports `unavailable` |
| `checkedAt` | number | Optional. Check time |
| `error` | string | Optional. Error explanation, for example when the runtime name is shared |

- `40001`: validation failure
- `40408`: a locator in `targets` matches no entry

### `GET /api/v2/mcp/auth-statuses`

Reads the OAuth state of each MCP server in the registry catalog. When only the auth dimension is needed, it is lighter than [`servers:inspect`](#post-api-v2-mcp-servers-inspect). Verification probes may refresh or invalidate stored credentials.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `cwd` | query | string | Include the project layers of this directory (must be trusted) |
| `verify` | query | string | `true`: verify every OAuth candidate through a real connection. `false`: fully offline, classifying only from config and stored tokens. Omitted: keep implicit OAuth detection, probing only unpinned remote servers without stored credentials |

On success, `data` is an array of `{ name, authStatus }`, with the same `authStatus` values as [`servers:inspect`](#post-api-v2-mcp-servers-inspect).

### `POST /api/v2/mcp/auth:begin`

Begins an interactive OAuth flow for a remote MCP server. The target must use a remote transport (`http` / `sse`) and must not carry a static bearer token; static headers are allowed only when the config explicitly sets `auth: "oauth"`.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| locator | body | object | Required. The whole request body is the target's [locator](#mcp-management) |
| `cwd` | query | string | Optional. Include the project layers of this directory (must be trusted) |

On success, `data.status` is one of two values:

| Field | Type | Description |
| --- | --- | --- |
| `status` | string | `authorization-required`: authorization is needed. `already-authorized`: a grant already exists, and no other fields are present |
| `flowId` | string | `authorization-required` only: flow id, used by `auth:complete` and `auth:cancel` |
| `authorizationUrl` | string | `authorization-required` only: open this URL in a browser to grant access |

- `40001`: validation failure; the MCP server cannot use OAuth (stdio transport, a static bearer token, or static headers without `auth: "oauth"`); or the runtime name is shared by multiple enabled MCP servers
- `40408`: the locator matches no entry
- `40929`: the OAuth flow itself failed

### `POST /api/v2/mcp/auth:complete`

Waits for the browser callback of a begun flow and finishes the code exchange. The wait defaults to 15 minutes and can be overridden with `timeoutMs`; an idle flow expires after 15 minutes regardless. Closing the HTTP connection on the client side aborts the wait.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `flowId` | body | string | Required. Flow id returned by `auth:begin` |
| `timeoutMs` | body | integer | Wait time in milliseconds, from 1 to 2³¹−1. Default 15 minutes |

On success, `data` is `null`.

- `40001`: validation failure, including an unknown `flowId` or an out-of-range `timeoutMs`
- `40929`: the OAuth flow itself failed

### `POST /api/v2/mcp/auth:cancel`

Terminates a begun flow without finishing it. Unknown flows are ignored.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `flowId` | body | string | Required. Id of the flow to terminate |

On success, `data` is `null`.

- `40001`: validation failure
- `40929`: the OAuth flow itself failed

### `POST /api/v2/mcp/auth:reset`

Clears an MCP server's stored credentials. The invalidation event reaches live sessions.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| locator | body | object | Required. The whole request body is the target's [locator](#mcp-management) |
| `cwd` | query | string | Optional. Include the project layers of this directory (must be trusted) |

On success, `data` is `null`.

- `40001`: validation failure; the target uses stdio transport; or the runtime name is shared by multiple enabled MCP servers
- `40408`: the locator matches no entry
- `40929`: the OAuth flow itself failed
