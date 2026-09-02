# 服务 API

此页面记录 kap-server 的 API 接口类型，分为 REST API 与 WebSocket 事件流两种。

## 基础约定

### 鉴权

REST 请求在请求头携带 bearer token（持有方令牌）：`Authorization: Bearer <token>`；WebSocket 升级请求接受同一请求头，或子协议 `kimi-code.bearer.<token>`。

鉴权失败返回 HTTP 401，响应体为 [`ResponseType`](#responsetype)，`code` 为 `40101`。在非 loopback 绑定上，同一来源 60 秒内鉴权失败 10 次会被封禁 60 秒，期间每个请求都返回 HTTP 429（`code` 为 `42901`）。

例外接口（不要求鉴权）：

| 接口 | 说明 |
| --- | --- |
| `OPTIONS` 预检请求 | 全部路径 |
| `GET /api/v1/healthz` | 探活 |
| 静态 web 资源 | 非 `/api/` 路径 |

### ResponseType

除下方例外外，所有 JSON 响应返回同一个泛型 `ResponseType<T>`；HTTP 状态码几乎总是 200，业务结果以 `code` 为准。

```ts
type ResponseType<T> = {
  code: number // 0 = 成功；非零 = 业务错误码（段位见错误码）
  msg: string // 成功恒 "success"；失败为错误消息
  data: T | null // code = 0 为端点数据；非零一般为 null（特例见下）
  request_id: string // 请求 id（ULID）；可用 X-Request-Id 请求头指定，非法值由服务端重新生成
  stack?: string // 服务端 Error.stack，多数错误路径携带
  details?: unknown // 结构化详情，形态按 code 分派（见各端点条目）
}
```

HTTP 状态码例外（非 200）：

| 场景 | HTTP 状态 |
| --- | --- |
| 鉴权失败 / 触发限流 / Host 检查失败 | 401 / 429 / 403 |
| 创建供应商、导入供应商目录成功 | 201（响应体仍是 `ResponseType`） |
| 删除供应商成功 | 204（无响应体） |
| 二进制与流式端点 | 200 / 206（Range 分段）/ 304（ETag 未变），能力见 [二进制与流式端点](#二进制与流式端点) |
| `GET /api/v1/files/{file_id}`、`GET .../media/{file_id}` 下载错误 | 真实 404 / 500（响应体仍为 `ResponseType`） |

不返回 `ResponseType` 的端点：四个二进制下载与 zip 导出（见 [二进制与流式端点](#二进制与流式端点)）、`DELETE /api/v1/providers/{provider_id}`（204 空体）、web 静态资源（非 `/api` 路径）。

### 错误码

错误码按段位分组：

| 段位 | 含义 | 示例 |
| --- | --- | --- |
| `0` | 成功 | |
| `400xx` | 请求参数错误 | `40001` 校验失败（`details` 逐字段说明）、`40003` 供应商由 OAuth 托管 |
| `401xx` | 鉴权与就绪状态 | `40101` 未授权、`40110` 未配置供应商、`40113` 模型未解析 |
| `404xx` | 资源不存在 | `40401` 会话、`40408` MCP 服务、`40409` 文件路径 |
| `409xx` | 状态冲突 | `40901` 会话忙、`40902` 审批已解决、`40922` 分页条件与 `page_token` 不符 |
| `410xx` | 资源已过期 | `41001` 审批超时、`41002` 提问超时、`41003` 临时文件过期 |
| `413xx` | 体积或边界超限 | `41302` 读取文件超 10 MB、`41304` 路径越出会话目录 |
| `429xx` | 限流 | `42901` 鉴权失败封禁、`42902` 文件监听数超限 |
| `500xx` | 服务端内部错误 | `50001` 未捕获异常、`50003` 持久化失败 |
| `6xxxx` / `7xxxx` / `8xxxx` | 工具运行时 / LLM 供应商 / MCP 透传错误，`msg` 保留上游原文 | |

逐个错误码的详情见 [完整错误码](#完整错误码)。

### null 与缺省语义

字段表中的「可缺省」与「可空」不等价：

| 形态 | 语义 | 实例 |
| --- | --- | --- |
| key 缺省（`undefined` 被序列化丢弃） | 「无值 / 不适用」 | `archived_at`、`last_prompt`、大部分可选事件字段 |
| 显式 `null` | 「有键、值为空」 | `GET /api/v1/oauth/login` 无进行中流程、`GET .../goal` 无目标、快照的 `in_flight_turn` |
| 空串 `""` | 「未设置但键存在」 | session 的 `title`、`agent_config.model`、冷会话快照的 `epoch` |
| 空数组 / 空对象 | 「确定为空」 | `permission_rules: []`、`open_in_apps: []`、`queued: []` |
| 恒 0 占位 | 「字段保留但未接线」 | session 的 `usage`（快照除外）、`message_count` |

### 分页

列表端点有两种分页风格：

- **游标式**：`before_id` / `after_id`（互斥）加 `page_size`（1–100），响应为 `{ items, has_more }`。用于会话列表、消息列表、子会话列表；转录分页的游标为 `before_turn` / `after_turn`。
- **`page_token`**：不透明令牌（绑定了查询条件的指纹），用于 `POST /api/v1/search` 与 `GET /api/v2/sessions`。翻页途中改变任何查询条件会使令牌失效：v2 返回 `40922`，search 返回 `40001`。`GET /api/v2/sessions` 另提供无状态的 `page` 页码模式作为替代。

## REST API

下文按业务域分组列出全部端点，覆盖 `/api/v1` 与 `/api/v2`（路径前缀区分版本）。路径里的 `:{action}` 后缀是动作约定——对单个资源 POST 到 `路径:动作` 执行非 CRUD 操作（如会话的 `:fork`、`:archive`）；动作缺失或未知时返回 `40001`。共享类型（T-Session 等）不在条目内展开，统一见 [类型汇总](#类型汇总)；「可缺省」「可空」的语义区分见 [null 与缺省语义](#null-与缺省语义)。

### 服务

服务自身的探活、身份、关停与连接管理。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/v1/healthz` | 探活，免鉴权 |
| `GET /api/v1/meta` | 服务版本、能力集、`server_id`、实验开关 |
| `POST /api/v1/shutdown` | 优雅退出（先回 200 再关闭）；仅 loopback 绑定时挂载 |
| `GET /api/v1/connections` | 列出当前在线的 WebSocket 连接 |

#### `GET /api/v1/healthz`

供脚本与进程管理器使用的探活端点，应答时不触碰配置与引擎。免鉴权（见 [例外接口](#鉴权)）。

**响应体**：`ResponseType<{ ok: boolean }>`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `ok` | boolean | 恒 `true` |

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": { "ok": true },
  "request_id": "01JZX4..."
}
```

#### `GET /api/v1/meta`

返回本实例的身份信息与能力集。大多数字段在启动时即固定；`experimental_flags` 与 `features` 按请求实时解析。

**响应体**：`ResponseType<`[T-MetaResponse](#t-metaresponse)`>`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `data` | [T-MetaResponse](#t-metaresponse) | 实例身份与能力集；字段见类型汇总 |

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "server_version": "0.40.0",
    "capabilities": { "websocket": true, "...": true },
    "server_id": "01JZX4...",
    "started_at": "2026-09-02T08:00:00.000Z",
    "open_in_apps": [],
    "dangerous_bypass_auth": false,
    "backend": "v2",
    "experimental_flags": { "search_worker": true },
    "features": [ { "name": "fileHistory", "state": "Active", "meta": {} } ]
  },
  "request_id": "01JZX4..."
}
```

#### `POST /api/v1/shutdown`

请求服务优雅退出；响应先发出，随后立即执行关闭。仅在 loopback 绑定时挂载——非 loopback 绑定时不会注册（请求得到 404），除非服务以 `--allow-remote-shutdown` 启动。

**响应体**：`ResponseType<{ ok: boolean }>`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `ok` | boolean | 恒 `true` |

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": { "ok": true },
  "request_id": "01JZX4..."
}
```

#### `GET /api/v1/connections`

列出当前连接到本服务的 WebSocket 客户端，按连接时间最早在前。

**响应体**：`ResponseType<{ connections: `[T-Connection](#t-connection)`[] }>`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `connections` | [T-Connection](#t-connection)`[]` | 当前在线的 WebSocket 连接 |

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "connections": [
      {
        "id": "conn_01JZX4...",
        "connected_at": "2026-09-02T08:00:00.000Z",
        "remote_address": "127.0.0.1",
        "user_agent": "Mozilla/5.0 ...",
        "has_client_hello": true,
        "subscriptions": [ "session_..." ]
      }
    ]
  },
  "request_id": "01JZX4..."
}
```

### 配置

全局配置的读取与合并式更新；密钥字段一律脱敏。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/v1/config` | 读取全局配置（密钥字段脱敏） |
| `POST /api/v1/config` | 合并式更新配置，并广播 `event.config.changed` |

#### `GET /api/v1/config`

返回解析后的全局配置——`config.toml` 叠加覆盖层后的生效结果。密钥已脱敏：供应商与模型只报告 `has_api_key`，绝不返回存储的密钥。

**响应体**：`ResponseType<`[T-ConfigResponse](#t-configresponse)`>`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `data` | [T-ConfigResponse](#t-configresponse) | 生效的全量配置；字段见类型汇总 |

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "providers": {
      "my-provider": { "type": "openai", "base_url": "https://api.example.com/v1", "has_api_key": true }
    },
    "default_provider": "my-provider",
    "default_model": "my-provider/kimi-for-coding",
    "models": { "...": {} }
  },
  "request_id": "01JZX4..."
}
```

#### `POST /api/v1/config`

合并式更新全局配置：请求体中的每个顶层域被深合并进对应域，未出现的域保持不动。把 `yolo` 设为 `true` 是 `default_permission_mode: "yolo"` 的简写（`false` 被忽略）。每一次配置变更——经本端点、在进程外编辑 `config.toml`，或服务端内部写入——都会广播全局 `event.config.changed` 事件。

**触发事件**：`event.config.changed`

**请求体**：部分配置对象——[T-ConfigResponse](#t-configresponse) 中除 `raw` 外的任意子集，均为可选。

**响应体**：`ResponseType<`[T-ConfigResponse](#t-configresponse)`>`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `data` | [T-ConfigResponse](#t-configresponse) | 合并写入后的全量配置；字段见类型汇总 |

**非零 code**：`40001`（值非法或持久化失败；`details` 为 `{ path, message }[]`）。

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "default_model": "my-provider/kimi-for-coding",
    "yolo": true,
    "providers": { "...": {} }
  },
  "request_id": "01JZX4..."
}
```

### 模型与供应商

模型配置的两半——`config.toml` 的 [供应商](../configuration/providers.md) 表与模型别名表——外加一个由服务端代理的 models.dev 目录。模型别名 id 就是配置中的别名键：通过供应商管理端点创建的别名形如 `provider_id/model`（例如 `my-provider/kimi-for-coding`），模型别名表中的裸键（如 `turbo`）原样使用；API 中任何接收 `model_id` 的地方指的都是这个别名 id。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/v1/models` | 列出已配置的模型别名 |
| `POST /api/v1/models/{model_id}:set_default` | 设置全局默认模型 |
| `GET /api/v1/providers` | 列出供应商 |
| `POST /api/v1/providers` | 创建供应商（201） |
| `GET /api/v1/providers/{provider_id}` | 读取供应商（含已存密钥） |
| `PUT /api/v1/providers/{provider_id}` | 整体替换供应商配置 |
| `DELETE /api/v1/providers/{provider_id}` | 删除供应商（204） |
| `POST /api/v1/providers/{provider_id}:refresh` | 刷新该供应商的模型元数据 |
| `POST /api/v1/providers:{action}` | 集合级动作：`refresh` / `refresh_oauth` / `import_catalog` / `import_registry` |
| `GET /api/v1/catalog/providers` | 浏览 models.dev 目录（服务端代理） |
| `GET /api/v1/catalog/providers/{catalog_id}` | 读取目录中单个条目 |

#### `GET /api/v1/models`

列出所有供应商下已配置的模型别名。

**响应体**：`ResponseType<{ items: `[T-ModelCatalogItem](#t-modelcatalogitem)`[] }>`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `items` | [T-ModelCatalogItem](#t-modelcatalogitem)`[]` | 已配置的模型别名 |

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "items": [
      {
        "provider": "my-provider",
        "model": "my-provider/kimi-for-coding",
        "max_context_size": 262144,
        "capabilities": [ "thinking", "image_in" ]
      }
    ]
  },
  "request_id": "01JZX4..."
}
```

#### `POST /api/v1/models/{model_id}:set_default`

把全局 `default_model` 设为一个已存在的别名。`model_id` 是配置中的别名键原样——裸键如 `POST /api/v1/models/turbo:set_default`；id 含 `/` 时需 URL 编码，如 `POST /api/v1/models/my-provider%2Fkimi-for-coding:set_default`。

**触发事件**：`event.config.changed`

**响应体**：`ResponseType<{ default_model: string, model: `[T-ModelCatalogItem](#t-modelcatalogitem)` }>`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `default_model` | string | 当前生效的别名 |
| `model` | [T-ModelCatalogItem](#t-modelcatalogitem) | 别名对应的模型条目 |

**非零 code**：`40001`（动作后缀非法；`details` 为 `{ path, message }[]`）、`40413`（模型别名不存在）。

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "default_model": "turbo",
    "model": { "provider": "my-provider", "model": "turbo", "max_context_size": 262144 }
  },
  "request_id": "01JZX4..."
}
```

#### `GET /api/v1/providers`

列出每个已配置供应商及其凭据与模型发现状态，不泄露任何密钥。

**响应体**：`ResponseType<{ items: `[T-ProviderCatalogItem](#t-providercatalogitem)`[] }>`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `items` | [T-ProviderCatalogItem](#t-providercatalogitem)`[]` | 已配置的供应商 |

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "items": [
      {
        "id": "my-provider",
        "type": "openai",
        "base_url": "https://api.example.com/v1",
        "has_api_key": true,
        "status": "connected",
        "models": [ "my-provider/kimi-for-coding" ]
      }
    ]
  },
  "request_id": "01JZX4..."
}
```

#### `POST /api/v1/providers`

一次保存创建供应商及其模型别名；响应为 HTTP 201 加 `ResponseType`。当全局 `default_model` 完全未配置时，会以新供应商的 `default_model`（或第一个模型）播种；已有默认值绝不被修改。

**触发事件**：`event.config.changed`

**请求体**：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | string | 是 | 供应商 id——字母、数字、`-`、`_` 与空格；必须以字母或数字开头 |
| `type` | string | 是 | 通信协议：`kimi` / `openai` / `openai_responses` / `anthropic` / `google-genai` / `vertexai` |
| `api_key` | string | 否 | API 密钥，存储于 `config.toml` |
| `base_url` | string | 否 | API 基础 URL；不得包含环境变量占位符（`${...}`） |
| `default_model` | string | 否 | 该供应商的默认模型；必须是 `models[].model` 之一 |
| `models` | `{ model: string, max_context_size: number, … }[]` | 是 | 至少一条，不允许重复的 `model` 值；条目结构见下 |

`models[]` 条目（每个声明一个别名，其 id 为 `id/model`）：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `model` | string | 是 | 上游模型名 |
| `max_context_size` | integer | 是 | 以 token 计的上下文窗口，≥ 1 |
| `display_name` | string | 否 | 显示名 |
| `capabilities` | `string[]` | 否 | 能力标志，如 `thinking` 或 `image_in` |
| `max_output_size` | integer | 否 | 最大输出 token 数，≥ 1 |
| `support_efforts` | `string[]` | 否 | 支持的 Thinking 模式 effort 档位 |
| `adaptive_thinking` | boolean | 否 | 自适应 thinking 开关 |

**响应体**：`ResponseType<`[T-ProviderCatalogItem](#t-providercatalogitem)`>`（新建对象，HTTP 201）。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `data` | [T-ProviderCatalogItem](#t-providercatalogitem) | 新建的供应商；字段见类型汇总 |

**非零 code**：`40001`（校验失败；`details` 为 `{ path, message }[]`）、`40921`（已存在该 `id` 的供应商）。

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "id": "my-provider",
    "type": "openai",
    "has_api_key": true,
    "status": "connected",
    "models": [ "my-provider/kimi-for-coding" ]
  },
  "request_id": "01JZX4..."
}
```

#### `GET /api/v1/providers/{provider_id}`

读取单个供应商。与列表路由不同，设置了密钥时响应会附带存储的 `api_key`，以便本地编辑表单预填——这是唯一回显密钥的端点，暴露端口时请牢记这一点。

**响应体**：`ResponseType<`[T-ProviderCatalogItem](#t-providercatalogitem)`>`，存有密钥时附带 `api_key: string`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `data` | [T-ProviderCatalogItem](#t-providercatalogitem) | 供应商；字段见类型汇总 |
| `data.api_key` | string | 可缺省：存储的密钥，仅本端点回显 |

**非零 code**：`40001`（校验失败；`details` 为 `{ path, message }[]`）、`40412`。

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "id": "my-provider",
    "type": "openai",
    "base_url": "https://api.example.com/v1",
    "has_api_key": true,
    "status": "connected",
    "api_key": "sk-..."
  },
  "request_id": "01JZX4..."
}
```

#### `PUT /api/v1/providers/{provider_id}`

一次保存整体替换供应商：`type`、`base_url` 与模型列表被重写，不再列出的别名从 `config.toml` 中消失。`api_key` 是三态的：省略表示保留已存密钥，`""` 表示清除，其他值表示替换。除 `new_id` 重命名迁移外，全局默认指针绝不被修改。

**触发事件**：`event.config.changed`

**请求体**：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `new_id` | string | 否 | 重命名供应商；providers 键、模型别名、`default_provider`、指向旧别名的 `default_model` 与 subagent 次级模型池随之迁移。id 规则同 `POST /api/v1/providers` |
| `type` | string | 是 | 通信协议，取值同 `POST /api/v1/providers` |
| `api_key` | string | 否 | 三态，见上文 |
| `base_url` | string | 否 | API 基础 URL；不得包含环境变量占位符 |
| `default_model` | string | 否 | 该供应商的默认模型；必须是 `models[].model` 之一 |
| `models` | `{ model: string, max_context_size: number, … }[]` | 是 | 至少一条，条目结构与 `POST /api/v1/providers` 相同 |

**响应体**：`ResponseType<{ provider: `[T-ProviderCatalogItem](#t-providercatalogitem)` }>`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `provider` | [T-ProviderCatalogItem](#t-providercatalogitem) | 替换后的供应商 |

**非零 code**：`40001`（重命名后的别名 id 冲突；`details` 为 `{ path, message }[]`）、`40003`（供应商由 OAuth 托管，改用 `POST /api/v1/oauth/logout`）、`40412`、`40921`（`new_id` 已被占用）。

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "provider": { "id": "my-provider", "type": "openai", "has_api_key": true, "status": "connected" }
  },
  "request_id": "01JZX4..."
}
```

#### `DELETE /api/v1/providers/{provider_id}`

删除供应商及其全部模型别名；subagent 次级模型池会级联清理。全局 `default_provider` / `default_model` 指针保持不动，即使它们指向被删的供应商。

**触发事件**：`event.config.changed`

**响应体**：HTTP 204 空体——状态行本身即表示删除成功，无 `ResponseType`。

**非零 code**：`40001`（校验失败；`details` 为 `{ path, message }[]`）、`40003`、`40412`。

#### `POST /api/v1/providers/{provider_id}:refresh`

从上游来源重新发现单个供应商的模型元数据，并重写该供应商的别名；模型来源为静态的供应商不经网络调用直接报告 `unchanged`。

**触发事件**：`event.model_catalog.changed`（至少一个供应商的别名发生变化时；配置写入同时触发 `event.config.changed`）

**响应体**：`ResponseType<`[T-RefreshProviderModelsResponse](#t-refreshprovidermodelsresponse)`>`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `data` | [T-RefreshProviderModelsResponse](#t-refreshprovidermodelsresponse) | 按供应商分组的刷新结果；字段见类型汇总 |

**非零 code**：`40001`（校验失败；`details` 为 `{ path, message }[]`）、`40412`。

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "changed": [ { "provider_id": "my-provider", "provider_name": "my-provider", "added": 2, "removed": 0 } ],
    "unchanged": [],
    "failed": []
  },
  "request_id": "01JZX4..."
}
```

#### `POST /api/v1/providers:{action}`

集合级动作路由；请求体按动作校验。四个动作：

**触发事件**：`:refresh` / `:refresh_oauth` → `event.model_catalog.changed`（至少一个供应商的别名发生变化时；配置写入同时触发 `event.config.changed`）；`:import_catalog` / `:import_registry` → `event.config.changed`

**响应体**：统一 `ResponseType` 信封，`data` 形态随动作（见下表）。

| 动作 | 请求体 | `data`（code = 0） | HTTP 状态 |
| --- | --- | --- | --- |
| `:refresh` | 可选，被忽略 | [T-RefreshProviderModelsResponse](#t-refreshprovidermodelsresponse)（刷新每个供应商） | 200 |
| `:refresh_oauth` | 可选，被忽略 | 同上，仅限 OAuth 凭据的供应商 | 200 |
| `:import_catalog` | 见下 | `{ provider: `[T-ProviderCatalogItem](#t-providercatalogitem)`, models_imported: number }` | 201 |
| `:import_registry` | 见下 | `{ providers: `[T-ProviderCatalogItem](#t-providercatalogitem)`[]`, models_imported: number }` | 201 |

`:import_catalog` 把一个 models.dev 目录条目导入为已配置供应商：通信协议与端点来自目录解析，目录中的每个模型都写为一个别名；导入已存在的 id 等同于刷新，省略 `api_key` 表示保留已存密钥。全局默认指针绝不被修改，仅在完全未配置默认模型时以第一个导入的模型播种 `default_model`。请求体：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `catalog_id` | string | 是 | 来自 `GET /api/v1/catalog/providers` 的目录条目 id |
| `id` | string | 否 | 覆盖目录 id 作为本地供应商 id |
| `api_key` | string | 否 | 导入供应商的 API 密钥 |
| `base_url` | string | 否 | 覆盖目录解析出的端点；条目的 `needs_base_url` 为 `true` 时必填 |

`:import_registry` 把一个 models.dev 形态的私有注册表（一个 `api.json` URL 加可选的 Bearer key）导入：每个列出的供应商都带 `source` 记录写入，以便定时刷新重新发现；重复导入同一 URL 会移除上游已消失的供应商——URL 是注册表的稳定身份，因此轮换 key 是安全的。全局默认指针遵循与 `:import_catalog` 相同的规则。请求体：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `url` | string | 是 | 注册表 `api.json` 的 URL |
| `api_key` | string | 否 | 注册表的 Bearer key；省略时复用上一次导入同一 URL 所用的 key |

**非零 code**：`40001`（校验失败；`details` 为 `{ path, message }[]`）、`40003`、`40004`（目录条目无法导入）、`40005`（注册表无法获取或解析）、`40417`、`50004`（models.dev 目录不可用）。

**响应示例**（`:import_catalog`）：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "provider": { "id": "my-provider", "type": "openai", "has_api_key": true, "status": "connected" },
    "models_imported": 3
  },
  "request_id": "01JZX4..."
}
```

#### `GET /api/v1/catalog/providers`

浏览 models.dev 目录，由服务端代理，带 10 分钟内存缓存与内置快照兜底；条目保持上游目录顺序。服务无法导入的条目携带 `rejected: true` 与机器可读的 `reject_reason`。

**响应体**：`ResponseType<{ items: `[T-CatalogProviderItem](#t-catalogprovideritem)`[] }>`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `items` | [T-CatalogProviderItem](#t-catalogprovideritem)`[]` | 目录条目，保持上游顺序 |

**非零 code**：`50004`（在线拉取与内置快照均失败）。

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "items": [
      {
        "id": "openai",
        "name": "OpenAI",
        "wire_type": "openai",
        "guessed": false,
        "needs_base_url": false,
        "rejected": false,
        "reject_reason": null,
        "env_key": "OPENAI_API_KEY",
        "models": [ { "id": "gpt-5", "max_context_size": 400000, "reasoning": true } ]
      }
    ]
  },
  "request_id": "01JZX4..."
}
```

#### `GET /api/v1/catalog/providers/{catalog_id}`

按 catalog id 读取单个 models.dev 目录条目。

**响应体**：`ResponseType<`[T-CatalogProviderItem](#t-catalogprovideritem)`>`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `data` | [T-CatalogProviderItem](#t-catalogprovideritem) | 目录条目；字段见类型汇总 |

**非零 code**：`40417`、`50004`。

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "id": "openai",
    "name": "OpenAI",
    "wire_type": "openai",
    "guessed": false,
    "needs_base_url": false,
    "rejected": false,
    "reject_reason": null,
    "env_key": "OPENAI_API_KEY",
    "models": [ "..." ]
  },
  "request_id": "01JZX4..."
}
```

### 账号

托管 Kimi OAuth 登录的生命周期与账号级信息。托管供应商名为 `managed:kimi-code`；下面每个端点上可选的 `provider` 参数都默认取它。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/v1/auth` | 鉴权状态快照 |
| `POST /api/v1/oauth/login` | 发起 OAuth device-code 登录流程 |
| `GET /api/v1/oauth/login` | 轮询登录流程状态 |
| `DELETE /api/v1/oauth/login` | 取消进行中的登录流程 |
| `POST /api/v1/oauth/logout` | 登出托管供应商 |
| `GET /api/v1/oauth/usage` | 套餐用量与限额 |
| `GET /api/v1/oauth/userinfo` | 账号资料 |
| `GET /api/v1/oauth/region` | 解析客户端所属区域 |

#### `GET /api/v1/auth`

鉴权状态快照：默认模型能否解析到可用的供应商配置，以及托管供应商的登录状态。它不做凭据校验，此后的对话请求仍可能以 `40111` / `40112` 失败。

**响应体**：`ResponseType<`[T-AuthSummary](#t-authsummary)`>`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `data` | [T-AuthSummary](#t-authsummary) | 鉴权状态快照；字段见类型汇总 |

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "models_ready": true,
    "providers_count": 1,
    "managed_provider": { "name": "managed:kimi-code", "status": "authenticated" }
  },
  "request_id": "01JZX4..."
}
```

#### `POST /api/v1/oauth/login`

为托管供应商发起 OAuth device-code（设备码）登录流程；发起新流程会中止同一供应商进行中的流程。账号已登录时无需用户交互，响应会立即报告 `authenticated`。

**请求体**：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `provider` | string | 否 | 托管供应商名称。默认 `managed:kimi-code` |
| `region` | string | 否 | `mainland-cn` 或 `global`；覆盖区域解析结果，仅对本次流程生效 |

**响应体**：`ResponseType<`[T-OAuthFlowStart](#t-oauthflowstart)`>`——进行中的流程报告 `status: "pending"`，打开 `verification_uri_complete`（或打开 `verification_uri` 并输入 `user_code`），然后每隔 `interval` 秒轮询 `GET /api/v1/oauth/login`；已登录的快速路径报告 `status: "authenticated"`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `data` | [T-OAuthFlowStart](#t-oauthflowstart) | 流程发起结果；字段见类型汇总 |

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "flow_id": "01JZX4...",
    "provider": "managed:kimi-code",
    "status": "pending",
    "verification_uri": "https://www.kimi.com/code/device",
    "verification_uri_complete": "https://www.kimi.com/code/device?code=ABCD-EFGH",
    "user_code": "ABCD-EFGH",
    "expires_in": 600,
    "interval": 5,
    "expires_at": "2026-09-02T08:10:00.000Z"
  },
  "request_id": "01JZX4..."
}
```

#### `GET /api/v1/oauth/login`

轮询某供应商的登录流程状态；尚未发起过流程时 `data` 为 `null`。

**查询参数**：

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `provider` | string | 托管供应商名称。默认 `managed:kimi-code` |

**响应体**：`ResponseType<`[T-OAuthFlowSnapshot](#t-oauthflowsnapshot)` | null>`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `data` | [T-OAuthFlowSnapshot](#t-oauthflowsnapshot) \| null | 流程状态快照；未发起过流程时为 `null` |

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "flow_id": "01JZX4...",
    "provider": "managed:kimi-code",
    "status": "authenticated",
    "verification_uri": "...",
    "verification_uri_complete": "...",
    "user_code": "ABCD-EFGH",
    "expires_in": 600,
    "expires_at": "2026-09-02T08:10:00.000Z",
    "interval": 5,
    "resolved_at": "2026-09-02T08:02:00.000Z"
  },
  "request_id": "01JZX4..."
}
```

#### `DELETE /api/v1/oauth/login`

取消某供应商进行中的登录流程；没有进行中的流程时为空操作，返回最近一次已知状态。

**查询参数**：

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `provider` | string | 托管供应商名称。默认 `managed:kimi-code` |

**响应体**：`ResponseType<{ cancelled: boolean, status: string }>`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `cancelled` | boolean | 只有确实中止了一个 `pending` 流程时才为 `true` |
| `status` | string | 调用后的流程状态，取值同 [T-OAuthFlowSnapshot](#t-oauthflowsnapshot) 的 `status` |

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": { "cancelled": true, "status": "cancelled" },
  "request_id": "01JZX4..."
}
```

#### `POST /api/v1/oauth/logout`

登出托管供应商：丢弃已存储的 OAuth 凭据、中止进行中的登录流程，并把托管供应商从配置中移除。OAuth 托管的供应商拒绝手动编辑与删除，因此要移除它需先登出。

**触发事件**：`event.config.changed`

**请求体**：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `provider` | string | 否 | 托管供应商名称。默认 `managed:kimi-code` |

**响应体**：`ResponseType<{ logged_out: boolean, provider: string }>`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `logged_out` | boolean | 恒 `true` |
| `provider` | string | 被登出的供应商名 |

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": { "logged_out": true, "provider": "managed:kimi-code" },
  "request_id": "01JZX4..."
}
```

#### `GET /api/v1/oauth/usage`

托管账号的套餐用量与限额，实时取自账号服务。上游失败不会让响应失败——以 `kind: "error"` 带内返回。

**查询参数**：

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `provider` | string | 托管供应商名称。默认 `managed:kimi-code` |

**响应体**：`ResponseType<`[T-ManagedUsageResult](#t-managedusageresult)`>`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `data` | [T-ManagedUsageResult](#t-managedusageresult) | 用量与限额；字段见类型汇总 |

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "kind": "ok",
    "summary": {
      "name": "每周额度",
      "window": { "duration": 1, "unit": "week" },
      "used": 42,
      "limit": 100,
      "reset_at": "2026-09-09T00:00:00.000Z"
    },
    "limits": [ "..." ],
    "extra_usage": null
  },
  "request_id": "01JZX4..."
}
```

#### `GET /api/v1/oauth/userinfo`

托管账号的资料；带内 `kind: "error"` 约定与 `GET /api/v1/oauth/usage` 相同。

**查询参数**：

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `provider` | string | 托管供应商名称。默认 `managed:kimi-code` |

**响应体**：`ResponseType<`[T-ManagedUserInfoResult](#t-manageduserinforesult)`>`（camelCase 载荷）。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `data` | [T-ManagedUserInfoResult](#t-manageduserinforesult) | 账号资料（camelCase）；字段见类型汇总 |

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "kind": "ok",
    "userInfo": {
      "userId": "u_...",
      "nickname": "dev",
      "status": "active",
      "region": "mainland-cn",
      "userLevel": 2,
      "userLevelName": "...",
      "domain": 1,
      "domainName": "..."
    }
  },
  "request_id": "01JZX4..."
}
```

#### `GET /api/v1/oauth/region`

解析该客户端所属的 Kimi 区域。结果在本地推导，不经网络探测：优先取环境变量或配置固定的 OAuth host，其次是已配置的 OAuth key，再次是 home 目录中的区域标记文件；默认为 `mainland-cn`。无参数。

**响应体**：`ResponseType<{ region: string }>`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `region` | string | `mainland-cn` / `global` |

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": { "region": "mainland-cn" },
  "request_id": "01JZX4..."
}
```

### 工作区与会话

路径前缀区分版本：`/api/v1` 与 `/api/v2`。

**工作区。**

工作区是已注册的项目目录，会话都落在其中。这组端点管理注册表与每工作区信任状态（控制项目级 MCP 配置是否加载），以及附加目录。返回的工作区对象统一为 [T-Workspace](#t-workspace)。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/v1/workspaces` | 列出已注册工作区 |
| `POST /api/v1/workspaces` | 注册工作区（按根路径幂等） |
| `PATCH /api/v1/workspaces/{workspace_id}` | 重命名 |
| `DELETE /api/v1/workspaces/{workspace_id}` | 注销（保留磁盘内容） |
| `GET /api/v1/workspaces/{workspace_id}/trust` | 读取信任状态 |
| `POST /api/v1/workspaces/{workspace_id}/trust` | 授予信任 |
| `POST /api/v1/workspaces/{workspace_id}/untrust` | 撤销信任 |
| `POST /api/v1/workspaces/{workspace_id}/add-dir` | 添加附加目录 |

#### `GET /api/v1/workspaces`

列出所有已注册工作区。无参数。

**响应体**：`ResponseType<{ items: `[T-Workspace](#t-workspace)`[] }>`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `items` | [T-Workspace](#t-workspace)`[]` | 全部已注册工作区 |

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "items": [
      {
        "id": "wd_my-app_a1b2c3d4e5f6",
        "root": "/Users/dev/my-app",
        "name": "my-app",
        "created_at": "2026-09-01T10:00:00.000Z",
        "last_opened_at": "2026-09-02T08:00:00.000Z",
        "session_count": 3
      }
    ]
  },
  "request_id": "01JZX4..."
}
```

#### `POST /api/v1/workspaces`

注册工作区并返回它。注册按根路径幂等：重复注册同一根路径会返回已存在的工作区，仅刷新 `last_opened_at`（保留已存名称），并广播 `event.workspace.updated` 而非 `event.workspace.created`。

**触发事件**：`event.workspace.created`（根路径首次注册）或 `event.workspace.updated`（重复注册同一根路径）

**请求体**：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `root` | string | 是 | 已存在目录的绝对路径 |
| `name` | string | 否 | 显示名，1–100 个字符。默认根目录的基名 |

**响应体**：`ResponseType<`[T-Workspace](#t-workspace)`>`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `data` | [T-Workspace](#t-workspace) | 工作区对象；字段见类型汇总 |

**非零 code**：`40001`（`root` 缺失或不是绝对路径；`details` 为 `{ path, message }[]`）、`40409`（`root` 不存在或不是目录）。

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "id": "wd_my-app_a1b2c3d4e5f6",
    "root": "/Users/dev/my-app",
    "name": "my-app",
    "created_at": "2026-09-02T08:00:00.000Z",
    "last_opened_at": "2026-09-02T08:00:00.000Z",
    "session_count": 0
  },
  "request_id": "01JZX4..."
}
```

#### `PATCH /api/v1/workspaces/{workspace_id}`

重命名工作区——仅修改显示名，根路径不变。

**触发事件**：`event.workspace.updated`

**请求体**：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | string | 是 | 新的显示名，1–100 个字符 |

**响应体**：`ResponseType<`[T-Workspace](#t-workspace)`>`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `data` | [T-Workspace](#t-workspace) | 重命名后的工作区；字段见类型汇总 |

**非零 code**：`40001`（校验失败；`details` 为 `{ path, message }[]`）、`40410`。

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "id": "wd_my-app_a1b2c3d4e5f6",
    "root": "/Users/dev/my-app",
    "name": "My App",
    "created_at": "2026-09-01T10:00:00.000Z",
    "last_opened_at": "2026-09-02T08:00:00.000Z",
    "session_count": 3
  },
  "request_id": "01JZX4..."
}
```

#### `DELETE /api/v1/workspaces/{workspace_id}`

注销工作区。只移除注册表条目——磁盘上的目录不受影响。无请求体。

**触发事件**：`event.workspace.deleted`

**响应体**：`ResponseType<{ deleted: true }>`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `deleted` | boolean | 恒 `true` |

**非零 code**：`40410`。

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": { "deleted": true },
  "request_id": "01JZX4..."
}
```

#### `GET /api/v1/workspaces/{workspace_id}/trust`

读取工作区信任状态。信任状态决定是否为该工作区加载项目级 MCP 配置。无参数。

**响应体**：`ResponseType<{ trusted: boolean }>`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `trusted` | boolean | 当前信任状态 |

**非零 code**：`40410`。

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": { "trusted": true },
  "request_id": "01JZX4..."
}
```

#### `POST /api/v1/workspaces/{workspace_id}/trust`

将工作区标记为信任，并加载其项目级 MCP 配置。无请求体。

**响应体**：`ResponseType<{ trusted: true }>`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `trusted` | boolean | 恒 `true` |

**非零 code**：`40410`。

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": { "trusted": true },
  "request_id": "01JZX4..."
}
```

#### `POST /api/v1/workspaces/{workspace_id}/untrust`

撤销工作区信任，并卸载其项目级 MCP 配置。无请求体。

**响应体**：`ResponseType<{ trusted: false }>`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `trusted` | boolean | 恒 `false` |

**非零 code**：`40410`。

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": { "trusted": false },
  "request_id": "01JZX4..."
}
```

#### `POST /api/v1/workspaces/{workspace_id}/add-dir`

为工作区添加附加目录，语义与 CLI `--add-dir` 及 TUI `/add-dir` 一致。路径支持绝对路径、相对路径（相对工作区根目录解析）与 `~` 展开。

**请求体**：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `path` | string | 是 | 要添加的目录 |
| `persist` | boolean | 否 | 缺省 `true`：追加到 `<项目根>/.kimi-code/local.toml` 的 `workspace.additional_dir`；为 `false` 时仅加入内存中的临时集合（同一工作区所有会话共享），不写盘 |

**响应体**：`ResponseType<{ project_root: string, config_path: string, additional_dirs: string[], persisted: boolean }>`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `project_root` | string | 项目根目录 |
| `config_path` | string | 写入的本地配置文件路径 |
| `additional_dirs` | `string[]` | 全部附加目录（含既有目录） |
| `persisted` | boolean | 本次是否写盘 |

**非零 code**：`40001`（校验失败，或项目本地配置损坏等引擎校验错误；`details` 为 `{ path, message }[]`）、`40409`（`path` 不存在或不是目录）、`40410`。

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "project_root": "/Users/dev/my-app",
    "config_path": "/Users/dev/my-app/.kimi-code/local.toml",
    "additional_dirs": [ "/Users/dev/shared-lib" ],
    "persisted": true
  },
  "request_id": "01JZX4..."
}
```

**会话。**

创建、列出和查看会话，执行会话级动作，并读取会话级汇总。返回的会话对象统一为 [T-Session](#t-session)；其实时状态字段（`busy`、`main_turn_active`、`pending_interaction`、`last_turn_reason`）由会话的活动聚合解析——未加载到本服务进程中的会话（冷会话）始终上报为不忙碌且无待处理交互。

| 方法与路径 | 说明 |
| --- | --- |
| `POST /api/v1/sessions` | 创建会话（需 `workspace_id` 或 `metadata.cwd`） |
| `GET /api/v1/sessions` | 列出会话，游标分页，支持 `busy` / `archived_only` 等过滤 |
| `GET /api/v1/sessions/{session_id}` | 读取单个会话（`last_seq` 为真实事件水位） |
| `GET /api/v1/sessions/{session_id}/profile` | 读取会话档案 |
| `POST /api/v1/sessions/{session_id}/profile` | 更新标题、元数据、Agent 配置 |
| `POST /api/v1/sessions/{session_id}/title/generate` | 通过托管的 `chat_title` 工具生成标题 |
| `POST /api/v1/sessions/{session_id}:{action}` | 会话动作：`fork` / `compact` / `undo` / `abort` / `btw` / `archive` / `restore` |
| `GET /api/v1/sessions/{session_id}/children` | 列出子会话 |
| `POST /api/v1/sessions/{session_id}/children` | 创建子会话（fork 并打标） |
| `GET /api/v1/sessions/{session_id}/status` | 实时状态汇总 |
| `GET /api/v1/sessions/{session_id}/goal` | 当前目标快照（无则 `null`） |
| `GET /api/v1/sessions/{session_id}/warnings` | 会话级告警 |

#### `POST /api/v1/sessions`

创建会话并返回。目标目录来自 `workspace_id`（已注册的工作区）或 `metadata.cwd`（首次使用时注册该工作区）；两者同时提供时必须一致。

**触发事件**：`event.session.created`；触碰工作区另触发 `event.workspace.updated`（首次经 `metadata.cwd` 注册时为 `event.workspace.created`）

**请求体**：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `workspace_id` | string | 条件 | 未提供 `metadata.cwd` 时必填。已注册的工作区 id |
| `metadata` | `Record<string, unknown>` | 条件 | 自定义元数据。`metadata.cwd` 为工作目录，未提供 `workspace_id` 时必填；同时提供时必须等于工作区根目录 |
| `title` | string | 否 | 初始标题（至少 1 个字符） |
| `agent_config` | `{ model?: string, … }` | 否 | schema 接受但当前不会应用——模型与各模式请经 `POST .../profile` 设置 |

**响应体**：`ResponseType<`[T-Session](#t-session)`>`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `data` | [T-Session](#t-session) | 新建的会话；字段见类型汇总 |

**非零 code**：`40001`（`workspace_id` 与 `metadata.cwd` 二缺一，或不一致；`details` 为 `{ path, message }[]`）、`40409`（工作目录不存在或不是目录）、`40410`（工作区未注册）。

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "id": "session_01JZX4...",
    "workspace_id": "wd_my-app_a1b2c3d4e5f6",
    "title": "",
    "created_at": "2026-09-02T08:00:00.000Z",
    "updated_at": "2026-09-02T08:00:00.000Z",
    "busy": false,
    "main_turn_active": false,
    "pending_interaction": "none",
    "archived": false,
    "metadata": { "cwd": "/Users/dev/my-app" },
    "agent_config": { "model": "" },
    "usage": { "...": 0 },
    "permission_rules": [],
    "message_count": 0,
    "last_seq": 0
  },
  "request_id": "01JZX4..."
}
```

#### `GET /api/v1/sessions`

跨工作区列出会话，按 `updated_at` 最新在前。特例：不提供 `page_size`（且不提供 `archived_only`）时，响应是单个不分页的窗口，`has_more` 恒为 `false`——要真正翻页请传入 `page_size`。

**查询参数**：

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `before_id` | string | 只保留早于该 id 的会话；与 `after_id` 互斥 |
| `after_id` | string | 只保留晚于该 id 的会话；与 `before_id` 互斥 |
| `page_size` | integer | 1–100。分页生效时默认 `20` |
| `busy` | boolean | 只保留忙碌（或只保留空闲）的会话 |
| `include_archive` | boolean | 同时包含已归档会话。默认 `false` |
| `archived_only` | boolean | 只保留已归档会话；与 `include_archive` 互斥；即使不提供 `page_size` 也启用游标分页 |
| `exclude_empty` | boolean | 去掉没有任何用户提示词的会话 |
| `workspace_id` | string | 限定到单个工作区（别名会被解析） |

**响应体**：`ResponseType<{ items: `[T-Session](#t-session)`[]`, has_more: boolean }>`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `items` | [T-Session](#t-session)`[]` | 一页会话，按 `updated_at` 最新在前 |
| `has_more` | boolean | 是否还有更早的会话 |

**非零 code**：`40001`（互斥参数同用；`details` 为 `{ path, message }[]`）、`40410`（未知的 `workspace_id`）。

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "items": [
      {
        "id": "session_01JZX4...",
        "workspace_id": "wd_my-app_a1b2c3d4e5f6",
        "title": "Fix the login page",
        "...": "..."
      }
    ],
    "has_more": false
  },
  "request_id": "01JZX4..."
}
```

#### `GET /api/v1/sessions/{session_id}`

从索引中读取单个会话。`last_seq` 携带真实的事件水位（watermark）：存活会话为当前事件日志的序列号，冷会话为最后持久化的水位——用它作为 `subscribe` 的 `cursors` 起点时回放为空。其余会话端点的 `last_seq` 均为 `0` 占位。

**响应体**：`ResponseType<`[T-Session](#t-session)`>`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `data` | [T-Session](#t-session) | 会话对象；字段见类型汇总 |

**非零 code**：`40401`（会话不存在，或其工作区已无法解析）。

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "id": "session_01JZX4...",
    "workspace_id": "wd_my-app_a1b2c3d4e5f6",
    "title": "Fix the login page",
    "busy": false,
    "main_turn_active": false,
    "pending_interaction": "none",
    "last_turn_reason": "completed",
    "archived": false,
    "last_prompt": "adjust the button spacing",
    "metadata": { "cwd": "/Users/dev/my-app" },
    "agent_config": { "model": "kimi-for-coding" },
    "usage": { "...": 0 },
    "permission_rules": [],
    "message_count": 0,
    "last_seq": 128
  },
  "request_id": "01JZX4..."
}
```

#### `GET /api/v1/sessions/{session_id}/profile`

读取会话档案——与 `GET /api/v1/sessions/{session_id}` 相同的线上载荷（`last_seq` 为 `0` 占位）。

**响应体**：`ResponseType<`[T-Session](#t-session)`>`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `data` | [T-Session](#t-session) | 会话档案；字段见类型汇总 |

**非零 code**：`40401`。

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": { "id": "session_01JZX4...", "...": "..." },
  "request_id": "01JZX4..."
}
```

#### `POST /api/v1/sessions/{session_id}/profile`

更新会话档案：标题、自定义元数据以及 main agent 的配置。设置的标题会成为自定义标题，优先级高于生成的标题。

**触发事件**：`session.meta.updated`（设置标题时）、`goal.updated`（`goal_objective` / `goal_control` 变更目标时）

**请求体**：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `title` | string | 否 | 新标题（至少 1 个字符）；会成为自定义标题 |
| `metadata` | `Record<string, unknown>` | 否 | 合并进会话自定义元数据的键 |
| `agent_config` | `{ model?: string, thinking?: string, … }` | 否 | main agent 的部分配置；字段见下，均为可选，且都会立即应用 |
| `permission_rules` | `{ id: string, tool_name: string, … }[]` | 否 | 被接受但不回显（T-Session 恒 `permission_rules: []`） |

`agent_config` 字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `model` | string | 模型别名 id；空字符串会被忽略 |
| `thinking` | string | Thinking 强度等级 |
| `permission_mode` | string | `manual` / `yolo` / `auto` |
| `plan_mode` | boolean | 进入或退出 Plan 模式 |
| `swarm_mode` | boolean | 进入或退出 swarm 模式 |
| `tower_mode` | boolean | 进入或退出 tower 模式 |
| `tower_base` | string | 配合 `tower_mode: true` 的 tower 基础引用 |
| `goal_objective` | string | 以该文本为内容创建一个目标 |
| `goal_control` | string | `pause` / `resume` / `cancel` 当前目标 |

schema 还接受 `agent_config` 内的 `system_prompt`、`tools`、`mcp_servers`，但更新路由当前不会应用它们。

**响应体**：`ResponseType<`[T-Session](#t-session)`>`（更新后）。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `data` | [T-Session](#t-session) | 更新后的会话；字段见类型汇总 |

**非零 code**：`40001`（校验失败；`details` 为 `{ path, message }[]`）、`40401`。

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": { "id": "session_01JZX4...", "title": "Fix the login page", "...": "..." },
  "request_id": "01JZX4..."
}
```

#### `POST /api/v1/sessions/{session_id}/title/generate`

通过托管供应商的 `chat_title` 工具根据会话的提示词生成标题并应用。生成需要托管 OAuth 登录和 `auto_session_title` 实验开关；未提供 `force` 时，已有自定义标题或已生成标题的会话会上报为不可用。

**触发事件**：`session.meta.updated`

**请求体**：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `force` | boolean | 否 | 即使已有自定义或生成的标题也重新生成。默认 `false` |
| `source` | string | 否 | 标题输入：`user_prompts`（默认）/ `first_turn` / `digest` |

**响应体**：`ResponseType<{ title: string }>`——当前应用到会话的标题。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `title` | string | 应用到会话的标题 |

**非零 code**：`40401`、`40923`（开关未开启、没有托管登录或尚无提示词内容、已有标题但未提供 `force`，或后端请求失败）。

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": { "title": "Fix the login page" },
  "request_id": "01JZX4..."
}
```

#### `POST /api/v1/sessions/{session_id}:{action}`

会话动作经同一条路由分发：路径尾部解析为 `{session_id}:{action}`，请求体按动作的 schema 校验。每个动作都会先解析会话，因此会话未知时都可能返回 `40401`。

**触发事件**：`:fork` → `event.session.created`；`:compact` → `compaction.started`（随后进入 compaction 事件流，见 [agent 事件](#agent-事件)）；`:undo` → `session.meta.updated`；`:btw` → `agent.created`；`:archive` → `event.session.archived`；`:abort` / `:restore` 无

**响应体**：统一 `ResponseType` 信封，`data` 形态随动作（见下表）。

| 动作 | 请求体 | `data`（code = 0） | 特有非零 code |
| --- | --- | --- | --- |
| `:fork` | `{ title?, metadata? }` | [T-Session](#t-session)（新会话） | `40901`（有进行中的轮次） |
| `:compact` | `{ instruction? }` | `{}`（空对象；进度经 `compaction.*` 事件投递） | `40910`（有轮次或上下文变更进行中，或无可压缩内容） |
| `:undo` | `{ count?=1, page_size?≤100 }` | `{ messages: { items: `[T-Message](#t-message)`[]`, has_more: boolean }, status: `[T-SessionStatus](#t-sessionstatus)` }`——剩余上下文消息最新在前；回退 main agent 的对话 `count` 个轮次，并同步修正派生的会话状态（包括 `last_prompt`） | `40901`、`40911`（`data` 为引擎 details 或 `null`，形态不定） |
| `:abort` | 无 | `{ aborted: true }` | — |
| `:btw` | 无 | `{ agent_id: string }`——把 main agent fork 成一个禁用工具调用的子 Agent，让快速的临时问题在隔离环境中运行，不触碰工作上下文；需要可用的模型配置 | — |
| `:archive` | 无 | `{ archived: true }`——会话从默认列表中消失（`include_archive` / `archived_only` 仍会列出） | — |
| `:restore` | 无 | [T-Session](#t-session)（`archived: false`） | — |

共有非零 code：`40001`（动作缺失或未知；`details` 为 `{ path, message }[]`）、`40401`。

**响应示例**（`:fork`）：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "id": "session_01JZX5...",
    "workspace_id": "wd_my-app_a1b2c3d4e5f6",
    "title": "Fork: Fix the login page",
    "...": "..."
  },
  "request_id": "01JZX4..."
}
```

#### `GET /api/v1/sessions/{session_id}/children`

列出会话的子会话——即通过 `POST .../children` 创建的会话。游标分页遵循 [分页](#分页)。

**查询参数**：

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `before_id` | string | 只保留早于该 id 的子会话；与 `after_id` 互斥 |
| `after_id` | string | 只保留晚于该 id 的子会话；与 `before_id` 互斥 |
| `page_size` | integer | 1–100。默认 `100` |
| `busy` | boolean | 只保留忙碌（或只保留空闲）的子会话 |

**响应体**：`ResponseType<{ items: `[T-Session](#t-session)`[]`, has_more: boolean }>`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `items` | [T-Session](#t-session)`[]` | 一页子会话 |
| `has_more` | boolean | 是否还有更早的子会话 |

**非零 code**：`40401`。

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "items": [ { "id": "session_01JZX5...", "...": "..." } ],
    "has_more": false
  },
  "request_id": "01JZX4..."
}
```

#### `POST /api/v1/sessions/{session_id}/children`

创建子会话：fork 当前会话并记录为其子会话。适用与 `:fork` 相同的进行中轮次限制。

**触发事件**：`event.session.created`

**请求体**：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `title` | string | 否 | 子会话的标题（至少 1 个字符）。默认 `Child: <source title>` |
| `metadata` | `Record<string, unknown>` | 否 | 子会话的自定义元数据 |

**响应体**：`ResponseType<`[T-Session](#t-session)`>`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `data` | [T-Session](#t-session) | 新建的子会话；字段见类型汇总 |

**非零 code**：`40001`（校验失败；`details` 为 `{ path, message }[]`）、`40401`、`40901`。

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": { "id": "session_01JZX6...", "title": "Child: Fix the login page", "...": "..." },
  "request_id": "01JZX4..."
}
```

#### `GET /api/v1/sessions/{session_id}/status`

main agent 的实时状态汇总；读取它会在会话为冷态时将其恢复。无参数。

**响应体**：`ResponseType<`[T-SessionStatus](#t-sessionstatus)`>`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `data` | [T-SessionStatus](#t-sessionstatus) | 实时状态汇总；字段见类型汇总 |

**非零 code**：`40401`。

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "busy": false,
    "model": "kimi-for-coding",
    "thinking_level": "medium",
    "permission": "manual",
    "plan_mode": false,
    "swarm_mode": false,
    "tower_mode": false,
    "context_tokens": 15230,
    "max_context_tokens": 262144,
    "context_usage": 0.058
  },
  "request_id": "01JZX4..."
}
```

#### `GET /api/v1/sessions/{session_id}/goal`

读取会话当前的目标快照；没有活跃目标时为 `null`。注意该载荷使用 camelCase 键。无参数。

**响应体**：`ResponseType<`[T-GoalSnapshot](#t-goalsnapshot)` | null>`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `data` | [T-GoalSnapshot](#t-goalsnapshot) \| null | 目标快照（camelCase）；无活跃目标时为 `null` |

**非零 code**：`40401`。

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "goalId": "goal_...",
    "objective": "Ship the release",
    "status": "active",
    "turnsUsed": 3,
    "tokensUsed": 152000,
    "wallClockMs": 540000,
    "budget": {
      "tokenBudget": 1000000,
      "turnBudget": 50,
      "wallClockBudgetMs": null,
      "remainingTokens": 848000,
      "remainingTurns": 47,
      "remainingWallClockMs": null,
      "tokenBudgetReached": false,
      "turnBudgetReached": false,
      "wallClockBudgetReached": false,
      "overBudget": false
    }
  },
  "request_id": "01JZX4..."
}
```

#### `GET /api/v1/sessions/{session_id}/warnings`

读取会话级告警。目前的产生者只有 `AGENTS.md` 过大检查（`agents-md-oversized`），因此大多数会话的列表为空。无参数。

**响应体**：`ResponseType<{ warnings: { code: string, message: string, severity: 'info' | 'warning' | 'error' }[] }>`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `warnings` | `{ code: string, message: string, severity: 'info' \| 'warning' \| 'error' }[]` | 会话级告警；大多数会话为空 |

**非零 code**：`40401`。

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "warnings": [
      { "code": "agents-md-oversized", "message": "AGENTS.md is ...", "severity": "warning" }
    ]
  },
  "request_id": "01JZX4..."
}
```

**运行时绑定。**

main agent 的 Agent 循环运行在哪个运行时上的读取与切换。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/v1/sessions/{session_id}/runtime` | 读取 main agent 的运行时绑定 |
| `POST /api/v1/sessions/{session_id}/runtime` | 切换 main agent 的运行时绑定 |

#### `GET /api/v1/sessions/{session_id}/runtime`

读取 main agent 的运行时绑定。无参数。

**响应体**：`ResponseType<{ workspace_id: string, runtime_id: string }>`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `workspace_id` | string | 所属工作区 id |
| `runtime_id` | string | 当前绑定的运行时 id |

**非零 code**：`40401`。

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": { "workspace_id": "wd_my-app_a1b2c3d4e5f6", "runtime_id": "local" },
  "request_id": "01JZX4..."
}
```

#### `POST /api/v1/sessions/{session_id}/runtime`

切换 main agent 的运行时绑定。

**请求体**：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `runtime_id` | string | 是 | 目标运行时 id |

**响应体**：`ResponseType<{ workspace_id: string, runtime_id: string }>`（同 `GET .../runtime`）。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `workspace_id` | string | 所属工作区 id |
| `runtime_id` | string | 切换后绑定的运行时 id |

**非零 code**：`40001`（校验失败；`details` 为 `{ path, message }[]`）、`40401`、`40420`（不存在该 `runtime_id` 的运行时）、`40926`（运行时存在但不可用）。

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": { "workspace_id": "wd_my-app_a1b2c3d4e5f6", "runtime_id": "local" },
  "request_id": "01JZX4..."
}
```

**会话快照。**

#### `GET /api/v1/sessions/{session_id}/snapshot`

为重新同步后重建客户端组装一份原子快照：会话、最近的消息、进行中的轮次、存活的 subagent 以及待处理交互，全部盖上 `as_of_seq` 水位与用于重新订阅的 `epoch`——恢复流程见 [断线恢复](#断线恢复)。与普通的会话端点不同，内嵌的会话携带实时的 `agent_config.model` 与真实的 `usage` 总计。无参数。

**响应体**：`ResponseType<`[T-SnapshotResponse](#t-snapshotresponse)`>`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `data` | [T-SnapshotResponse](#t-snapshotresponse) | 原子快照；字段见类型汇总 |

**非零 code**：`40401`、`50001`。

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "as_of_seq": 128,
    "epoch": "01JZX4...",
    "session": {
      "id": "session_01JZX4...",
      "agent_config": { "model": "kimi-for-coding" },
      "usage": { "input_tokens": 152000, "...": 0 },
      "...": "..."
    },
    "messages": { "items": [ "..." ], "has_more": true },
    "in_flight_turn": null,
    "subagents": [],
    "pending_approvals": [],
    "pending_questions": []
  },
  "request_id": "01JZX4..."
}
```

**会话导出。**

#### `POST /api/v1/sessions/{session_id}/export`

将会话连同诊断日志一起导出为 zip 附件（`kimi-session-<id>.zip`）。响应是 `application/zip` 二进制流，不返回 `ResponseType`（`content-disposition: attachment`、`cache-control: no-store`）；客户端断连即中止导出。

**请求体**：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `web_log` | string | 否 | 要包含在归档中的客户端日志文本，最多 256 KB UTF-8 |
| `desktop` | boolean | 否 | 同时包含桌面宿主的日志。默认 `false` |

**非零 code**（`ResponseType`）：`40001`（校验失败；`details` 为 `{ path, message }[]`）、`40401`、`50001`。

**文件历史（实验性）。**

::: info 新增
实验特性：由 `KIMI_CODE_EXPERIMENTAL_FILE_HISTORY` 开关控制（默认关闭），接口形态可能随版本更改。
:::

按轮次记录的文件历史快照：main agent 每个轮次在开始与结束两个检查点版本化所有被 Edit / Write 工具触碰的文件（未变化的文件按内容哈希去重，超过 4 MiB 的文件只记录哨兵指纹）。这两个端点从检查点计算单个轮次的逐文件增删行数与任一检查点的完整内容；冷会话会按需恢复。开关关闭时路由仍注册，但 `changes` 恒返回空列表、`enabled` 恒为 `false`、`content` 恒为 `null`。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/v1/sessions/{session_id}/file-history/changes` | 单个轮次的逐文件增删统计 |
| `GET /api/v1/sessions/{session_id}/file-history/content` | 某文件在指定检查点的完整内容 |

#### `GET /api/v1/sessions/{session_id}/file-history/changes`

返回单个轮次开始与结束检查点之间每个文件的精确增删行数。

**查询参数**：

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `turn_id` | integer | **必填。** 轮次 id（≥ 0） |

**响应体**：`ResponseType<{ changes: { path: string, status: 'added' | 'modified' | 'deleted', additions: number, deletions: number, binary?: boolean, oversize?: boolean }[], enabled: boolean, recorded: boolean }>`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `changes` | `{ path: string, status: 'added' \| 'modified' \| 'deleted', additions: number, deletions: number, binary?: boolean, oversize?: boolean }[]` | 逐文件增删统计；二进制与超大文件的增删行为 `0`，并以 `binary` / `oversize` 标记 |
| `enabled` | boolean | 实验开关是否开启 |
| `recorded` | boolean | 该轮次是否有已记录的检查点 |

**非零 code**：`40401`。

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "changes": [
      { "path": "src/index.ts", "status": "modified", "additions": 12, "deletions": 3 }
    ],
    "enabled": true,
    "recorded": true
  },
  "request_id": "01JZX4..."
}
```

#### `GET /api/v1/sessions/{session_id}/file-history/content`

返回某文件在指定轮次检查点的完整内容；`phase: "end"` 时若该文件在结束检查点没有记录，回退到开始检查点的版本。

**查询参数**：

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `turn_id` | integer | **必填。** 轮次 id（≥ 0） |
| `path` | string | **必填。** 文件路径 |
| `phase` | string | `start`（默认）/ `end`——取轮次开始还是结束检查点 |

**响应体**：`ResponseType<{ content: { version: number, content?: string, binary?: boolean } | null }>`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `content` | `{ version: number, content?: string, binary?: boolean } \| null` | `version` 为该文件在检查点的版本号；二进制文件只携带 `binary: true` 不携带文本；无记录时为 `null` |

**非零 code**：`40401`。

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": { "content": { "version": 2, "content": "import ..." } },
  "request_id": "01JZX4..."
}
```

**v2 会话。**

`/api/v2` 的会话查询与批量管理。与 v1 共享 `ResponseType` 与错误约定；分页为绑定查询指纹的 `page_token`（见 [分页](#分页)）。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/v2/sessions` | 新一代会话列表：筛选、排序、字段组、分组视图 |
| `POST /api/v2/sessions:archive` | 批量归档会话 |
| `POST /api/v2/sessions:restore` | 批量恢复已归档会话 |

#### `GET /api/v2/sessions`

面向列表页的新一代会话查询，筛选、排序、字段组都在查询参数里。

**查询参数**：

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `workspace.id` | string | 按工作区过滤，可重复 |
| `activity.status` | string | 按活动状态过滤：`running` / `approval` / `question` / `failed` / `idle`，可重复 |
| `meta.updated_after` | integer | 只看该时间（epoch 毫秒）之后更新过的会话 |
| `meta.updated_before` | integer | 只看该时间（epoch 毫秒）之前更新过的会话 |
| `meta.archived` | string | `true` / `false`（默认）/ `all` |
| `meta.has_prompt` | string | `true` 只保留有用户 prompt 的会话，`false` 只保留空会话（等价 v1 的 `exclude_empty`） |
| `view` | string | `flat`（默认）/ `by_workspace`（按工作区分组） |
| `group.page_size` | integer | `view=by_workspace` 时每个工作区返回的会话数：1–100，默认 `5`（`id,archived` 投影时上限 10000）；未开分组视图时传入返回 `40001` |
| `sort` | string | `meta.updated_at_desc`（默认）/ `meta.updated_at_asc` / `meta.created_at_desc` |
| `include` | string | 逗号分隔的附加字段组；目前支持 `git`（分支与 PR 信息，按目录去重并缓存 60 秒） |
| `fields` | string | 逗号分隔的字段投影；目前仅支持 `id,archived`，每项裁剪为 `{ id, archived }`。不可与 `include=git` 同传（`40001`） |
| `page_size` | integer | 1–100，默认 `50`；`id,archived` 投影时上限放宽至 10000。`view=by_workspace` 时按组计数 |
| `page` | integer | 无状态的 1 起始页码；与 `page_token` 互斥（同传返回 `40001`） |
| `page_token` | string | 上一页返回的翻页令牌 |

**响应体**：`ResponseType<`[T-V2SessionPage](#t-v2sessionpage)`>`（`view=flat`，默认）或 `ResponseType<`[T-V2SessionGroupPage](#t-v2sessiongrouppage)`>`（`view=by_workspace`）。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `data` | [T-V2SessionPage](#t-v2sessionpage) 或 [T-V2SessionGroupPage](#t-v2sessiongrouppage) | 一页结果；字段见类型汇总 |

每页额外携带 `total`（过滤后的集合大小）；翻页令牌绑定首页查询条件（含投影），中途改条件返回 `40922`；`page` 模式每次请求都是独立快照，不签发令牌，`next_page_token` 恒为 `null`。`by_workspace` 时每组携带该工作区按 `sort` 排序的前 `group.page_size` 条会话及其匹配总数 `total`；只有至少一条匹配会话的工作区才会出现，组间按组内首条会话的 sort key 排序（相同则按工作区 id）。

**非零 code**：`40001`（未知 `include` / `fields`、组合非法；`details` 为 `{ path, message }[]`）、`40922`。

**响应示例**（`view=by_workspace`）：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "groups": [
      {
        "workspace": { "id": "wd_my-app_a1b2c3d4e5f6", "cwd": "/Users/dev/my-app" },
        "sessions": [
          {
            "id": "session_01JZX4...",
            "workspace": { "id": "wd_my-app_a1b2c3d4e5f6", "cwd": "/Users/dev/my-app" },
            "meta": {
              "title": "Fix the login page",
              "last_prompt": "adjust the button spacing",
              "created_at": 1787000000000,
              "updated_at": 1787000100000,
              "archived": false,
              "archived_at": null
            },
            "activity": { "status": "idle", "model": "kimi-for-coding" }
          }
        ],
        "total": 42
      }
    ],
    "total": 7,
    "has_more": true,
    "next_page_token": "eyJ2IjoxLCJmIjoi..."
  },
  "request_id": "01JZX4..."
}
```

#### `POST /api/v2/sessions:archive` 与 `POST /api/v2/sessions:restore`

面向会话管理页的批量归档 / 恢复。仍在线的会话走完整生命周期；未加载的冷会话直接改写磁盘上的元数据，不会被加载。只有请求体校验失败才会让整个请求失败（`40001`）；其余情况按条返回。

**触发事件**：`:archive` → `event.session.archived`（每个成功归档的会话一条）；`:restore` 无

**请求体**：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `ids` | `string[]` | 是 | 会话 id 数组——非空、去重后不超过 5000 条 |

**响应体**：`ResponseType<`[T-V2BatchSessionResponse](#t-v2batchsessionresponse)`>`——`results` 保持输入顺序，不存在的 id 在自身条目里报 `40401`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `data` | [T-V2BatchSessionResponse](#t-v2batchsessionresponse) | 批量结果；字段见类型汇总 |

**非零 code**：`40001`（校验失败；`details` 为 `{ path, message }[]`）。

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "results": [
      { "id": "session_a", "ok": true },
      {
        "id": "session_b",
        "ok": false,
        "error": { "code": 40401, "message": "session session_b does not exist" }
      }
    ],
    "succeeded": 1,
    "failed": 1
  },
  "request_id": "01JZX4..."
}
```

### 对话

**提示词。**

提示词是一次用户输入的单位：提交一条提示词会把它排入会话的 main agent（或指定 Agent）的队列；轮次进度通过 [WebSocket 帧](#websocket-帧) 推送，不经过这些端点。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/v1/sessions/{session_id}/prompts` | 进行中与排队中的提示词 |
| `POST /api/v1/sessions/{session_id}/prompts` | 提交提示词（内容块数组，可带模型 / 权限模式覆盖） |
| `POST /api/v1/sessions/{session_id}/prompts:steer` | 把排队的提示词插入进行中的轮次 |
| `POST /api/v1/sessions/{session_id}/prompts/{prompt_id}:{action}` | 单条提示词动作：`abort` / `steer` |

#### `GET /api/v1/sessions/{session_id}/prompts`

读取 main agent 的提示词队列快照。无参数。

**响应体**：`ResponseType<{ active: `[T-PromptItem](#t-promptitem)` | null, queued: `[T-PromptItem](#t-promptitem)`[]` }>`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `active` | [T-PromptItem](#t-promptitem) \| null | 运行中的提示词，空闲时为 `null` |
| `queued` | [T-PromptItem](#t-promptitem)`[]` | 等待中的提示词，按顺序 |

**非零 code**：`40401`。

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "active": {
      "prompt_id": "prompt_01J...",
      "user_message_id": "msg_session_..._000007",
      "status": "running",
      "content": [ { "type": "text", "text": "..." } ],
      "created_at": "2026-09-02T08:04:00.000Z"
    },
    "queued": []
  },
  "request_id": "01JZX4..."
}
```

#### `POST /api/v1/sessions/{session_id}/prompts`

向会话提交一条用户提示词。先校验媒体引用，然后把可选的覆盖项应用到目标 Agent——`profile`（与 `model` / `thinking` 一起绑定），接着是 `model`、`thinking`、`permission_mode` 和 `disabled_tools`——随后提示词入队；响应在提示词被接受后立即返回，不等待轮次执行。提供 `skills` 时，提示词以打包的 Skill 激活方式运行，而不是普通用户提示词。

**触发事件**：`prompt.submitted`（随后进入轮次事件流，见 [agent 事件](#agent-事件)）、`session.meta.updated`

**请求体**：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `content` | `{ type: string, … }[]` | 是 | 非空的内容块数组；变体见下 |
| `agent_id` | string | 否 | 目标 Agent。默认为 main agent |
| `prompt_id` | string | 否 | 客户端选定的提示词 id，用于幂等提交；已被进行中提示词占用的 id 返回 `40927`，已完成的返回 `40903`。不能与 `skills` 同用 |
| `skills` | `{ name: string, args?: string }[]` | 否 | 打包的 Skill 激活，至少 1 个条目；每个 Skill 必须存在且可由用户激活 |
| `profile` | string | 否 | 提交前要绑定的 Agent 档案 |
| `model` | string | 否 | 要切换到的模型别名 |
| `thinking` | string | 否 | Thinking 强度等级 |
| `permission_mode` | string | 否 | `manual` / `yolo` / `auto` |
| `disabled_tools` | `string[]` | 否 | 要为会话禁用的工具名 |

schema 还接受 `metadata`、`plan_mode`、`swarm_mode`、`goal_objective` 和 `goal_control`，但提交路由当前不会应用它们。每个 `content` 内容块是按 `type` 区分的对象：

| 内容块 | 字段 | 说明 |
| --- | --- | --- |
| `text` | `text` | 纯文本 |
| `image` / `video` | `source` | 媒体输入；`source` 为 `{ kind: "url", url, id? }`、`{ kind: "base64", media_type, data }`、`{ kind: "file", file_id }`（来自 `POST /api/v1/files` 的上传）或 `{ kind: "session_media", file_id }`（已提交到本会话的媒体）之一 |
| `file` | `file_id`、`name`、`media_type`、`size` | 通过 `POST /api/v1/files` 上传的文件附件 |

schema 还接受共享消息格式中的 `tool_use`、`tool_result` 和 `thinking` 内容块，但它们在用户提示词中没有意义。未知或 kind 不匹配的 `file_id` 引用会在提示词创建之前、任何覆盖项应用之前被拒绝。

**响应体**：`ResponseType<`[T-PromptItem](#t-promptitem)`>`（被接受的提示词）。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `data` | [T-PromptItem](#t-promptitem) | 被接受的提示词；字段见类型汇总 |

**非零 code**（鉴权错误族的 `data` / `details` 形态各异）：

- `40001`（校验失败；`details` 为 `{ path, message }[]`）、`40401`、`40407`（引用的 `file_id` 不存在或 kind 不匹配）、`40415`（未知的 Skill）、`40901`（会话忙）、`40912`（Skill 无法由用户激活）、`40927`（`prompt_id` 冲突）
- `40110`（尚未配置供应商）：`data: null`，`details: null`
- `40111` / `40112`（供应商没有凭据 / 凭据被拒绝）：`data: null`，`details: { provider_id }`（缺 `provider_id` 时降级为 `50001`）
- `40113`（模型无法解析）：`data: null`，`details: { model_id?, provider_id? }` 或 `null`
- `40903`（`prompt_id` 属于已完成的提示词）：`data: { "aborted": false }`

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "prompt_id": "prompt_01J...",
    "user_message_id": "msg_session_..._000008",
    "status": "running",
    "content": [ { "type": "text", "text": "用一句话介绍这个仓库" } ],
    "created_at": "2026-09-02T08:06:00.000Z"
  },
  "request_id": "01JZX4..."
}
```

#### `POST /api/v1/sessions/{session_id}/prompts:steer`

把排队的提示词插入进行中的轮次，让运行中的轮次立即消费它们，而不是先运行结束。

**触发事件**：`prompt.steered`

**请求体**：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `prompt_ids` | `string[]` | 是 | 非空的排队提示词 id 数组 |

**响应体**：`ResponseType<{ steered: true, prompt_ids: string[] }>`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `steered` | boolean | 恒 `true` |
| `prompt_ids` | `string[]` | 被插入轮次的提示词 id |

**非零 code**：`40001`（校验失败；`details` 为 `{ path, message }[]`）、`40401`、`40402`（所列提示词 id 不在队列中）。

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": { "steered": true, "prompt_ids": [ "prompt_01J..." ] },
  "request_id": "01JZX4..."
}
```

#### `POST /api/v1/sessions/{session_id}/prompts/{prompt_id}:{action}`

单条提示词动作，经 `POST .../prompts/{tail}` 分发：`:abort` 中止运行中的提示词；`:steer` 把单条排队的提示词插入进行中的轮次（集合形式的单提示词版）。无请求体。

**触发事件**：`:abort` → `prompt.aborted`；`:steer` → `prompt.steered`

**响应体**：统一 `ResponseType` 信封：`:abort` → `{ aborted: true }`；`:steer` → `{ steered: true, prompt_ids: [prompt_id] }`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `aborted` | boolean | 仅 `:abort`：恒 `true` |
| `steered` | boolean | 仅 `:steer`：恒 `true` |
| `prompt_ids` | `string[]` | 仅 `:steer`：被插入轮次的提示词 id（单条） |

**非零 code**：`40001`（动作缺失或未知；`details` 为 `{ path, message }[]`）、`40401`、`40402`、`40903`（提示词已完成，`data: { "aborted": false }`）。

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": { "aborted": true },
  "request_id": "01JZX4..."
}
```

**消息。**

`messages` 端点分页返回 main agent 的扁平化消息历史；按 Agent 组织的结构化转录见「对话」域的 [转录](#对话) 部分。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/v1/sessions/{session_id}/messages` | 消息分页（`before_id` / `after_id` / `role`） |
| `GET /api/v1/sessions/{session_id}/messages/{message_id}` | 读取单条消息 |

#### `GET /api/v1/sessions/{session_id}/messages`

分页返回 main agent 的消息历史，最新在前；读取历史会在会话为冷态时将其恢复。

**查询参数**：

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `before_id` | string | 只保留早于该消息 id 的消息；与 `after_id` 互斥 |
| `after_id` | string | 只保留晚于该消息 id 的消息；与 `before_id` 互斥 |
| `page_size` | integer | 1–100。默认 `50` |
| `role` | string | 只保留单一角色：`user` / `assistant` / `tool` / `system`。过滤在分页切片之后应用，因此过滤后的一页可能少于 `page_size` 条而 `has_more` 仍为 `true`——持续翻页直到 `has_more` 为 `false` |

**响应体**：`ResponseType<{ items: `[T-Message](#t-message)`[]`, has_more: boolean }>`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `items` | [T-Message](#t-message)`[]` | 一页消息，最新在前 |
| `has_more` | boolean | 是否还有更早的消息 |

**非零 code**：`40001`（校验失败；`details` 为 `{ path, message }[]`）、`40401`。

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "items": [
      {
        "id": "msg_session_..._000007",
        "session_id": "session_01JZX4...",
        "role": "assistant",
        "content": [ { "type": "text", "text": "..." } ],
        "created_at": "2026-09-02T08:05:00.000Z"
      }
    ],
    "has_more": true
  },
  "request_id": "01JZX4..."
}
```

#### `GET /api/v1/sessions/{session_id}/messages/{message_id}`

按 id 从同一历史中读取单条消息。无参数。

**响应体**：`ResponseType<`[T-Message](#t-message)`>`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `data` | [T-Message](#t-message) | 消息对象；字段见类型汇总 |

**非零 code**：`40401`、`40403`（该会话中不存在此 id 的消息）。

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "id": "msg_session_..._000007",
    "session_id": "session_01JZX4...",
    "role": "user",
    "content": [ { "type": "text", "text": "..." } ],
    "created_at": "2026-09-02T08:04:00.000Z"
  },
  "request_id": "01JZX4..."
}
```

**审批。**

审批是为工具调用请求许可的待处理交互。新的请求通过 WebSocket 以 `event.approval.requested` 到达；这两个端点用于列出和答复。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/v1/sessions/{session_id}/approvals` | 列出待处理的审批请求（必须 `status=pending`） |
| `POST /api/v1/sessions/{session_id}/approvals/{approval_id}` | 答复审批 |

#### `GET /api/v1/sessions/{session_id}/approvals`

列出会话待处理的审批请求；读取列表会在会话为冷态时将其恢复。

**查询参数**：

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `status` | string | **必填。** 必须为 `pending`，缺省或其他值返回 `40001` |

**响应体**：`ResponseType<{ items: `[T-ApprovalRequest](#t-approvalrequest)`[]` }>`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `items` | [T-ApprovalRequest](#t-approvalrequest)`[]` | 待处理的审批请求 |

**非零 code**：`40001`（校验失败；`details` 为 `{ path, message }[]`）、`40401`。

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "items": [
      {
        "approval_id": "approval_01J...",
        "session_id": "session_01JZX4...",
        "turn_id": 3,
        "tool_call_id": "toolu_01J...",
        "tool_name": "Bash",
        "action": "run",
        "tool_input_display": { "kind": "command", "command": "pnpm test" },
        "created_at": "2026-09-02T08:06:30.000Z",
        "expires_at": "2026-09-03T08:06:30.000Z"
      }
    ]
  },
  "request_id": "01JZX4..."
}
```

#### `POST /api/v1/sessions/{session_id}/approvals/{approval_id}`

答复一个待处理的审批请求，让等待中的工具调用继续执行（或不执行）。

**触发事件**：`event.approval.resolved`

**请求体**：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `decision` | string | 是 | `approved` / `rejected` / `cancelled` |
| `scope` | string | 否 | 配合 `approved` 使用，`session`（唯一取值）还会让该审批规则在会话的剩余时间内被记住 |
| `feedback` | string | 否 | 回传给 Agent 的自由文本反馈 |
| `selected_label` | string | 否 | 当请求提供了带标签的选项时（例如计划审阅），所选选项的标签 |

**响应体**：`ResponseType<{ resolved: true, resolved_at: string }>`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `resolved` | boolean | 恒 `true` |
| `resolved_at` | string | ISO 8601 时间 |

**非零 code**：`40001`（校验失败；`details` 为 `{ path, message }[]`）、`40401`、`40404`（没有该 id 的待处理审批）、`40902`（已被答复，`data: { "resolved": false }`）。

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": { "resolved": true, "resolved_at": "2026-09-02T08:07:00.000Z" },
  "request_id": "01JZX4..."
}
```

**提问。**

提问是请求带标签选项的结构化输入的待处理交互。新的请求通过 WebSocket 以 `event.question.requested` 到达。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/v1/sessions/{session_id}/questions` | 列出待处理的提问（必须 `status=pending`） |
| `POST /api/v1/sessions/{session_id}/questions/{question_id}` | 回答提问 |
| `POST /api/v1/sessions/{session_id}/questions/{question_id}:dismiss` | 忽略提问 |

#### `GET /api/v1/sessions/{session_id}/questions`

列出会话待处理的提问。

**查询参数**：

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `status` | string | **必填。** 必须为 `pending`，缺省或其他值返回 `40001` |

**响应体**：`ResponseType<{ items: `[T-QuestionRequest](#t-questionrequest)`[]` }>`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `items` | [T-QuestionRequest](#t-questionrequest)`[]` | 待处理的提问 |

**非零 code**：`40001`（校验失败；`details` 为 `{ path, message }[]`）、`40401`。

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "items": [
      {
        "question_id": "question_01J...",
        "session_id": "session_01JZX4...",
        "questions": [
          {
            "id": "q_0",
            "question": "选择部署目标",
            "options": [
              { "id": "opt_0_0", "label": "staging" },
              { "id": "opt_0_1", "label": "production" }
            ],
            "allow_other": true
          }
        ],
        "created_at": "2026-09-02T08:06:40.000Z"
      }
    ]
  },
  "request_id": "01JZX4..."
}
```

#### `POST /api/v1/sessions/{session_id}/questions/{question_id}`

回答一个待处理的提问。两个提问端点经同一条路由 `POST .../questions/{tail}` 分发：单独的提问 id 表示回答问题，`{question_id}:dismiss` 尾部表示忽略。

**触发事件**：`event.question.answered`

**请求体**：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `answers` | `Record<string, { kind: string, … }>` | 是 | 提问条目 id（`q_0`……）到答案对象的映射；答案变体见下 |
| `method` | string | 否 | 答案的产生方式：`enter` / `space` / `number_key` / `click` |
| `note` | string | 否 | 附在回答上的自由文本备注 |

每个答案是按 `kind` 区分的对象：

| `kind` | 字段 | 说明 |
| --- | --- | --- |
| `single` | `option_id` | 选中的单个选项 |
| `multi` | `option_ids` | 选中的多个选项（至少 1 个） |
| `other` | `text` | 自由文本回答 |
| `multi_with_other` | `option_ids`、`other_text` | 选项加自由文本 |
| `skipped` | — | 跳过了该条目 |

**响应体**：`ResponseType<{ resolved: true, resolved_at: string }>`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `resolved` | boolean | 恒 `true` |
| `resolved_at` | string | ISO 8601 时间 |

**非零 code**：`40001`（校验失败，`details` 逐字段说明；`details` 为 `{ path, message }[]`）、`40401`、`40405`（没有该 id 的待处理提问）、`40902`（已被答复，`data: { "resolved": false }`）。

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": { "resolved": true, "resolved_at": "2026-09-02T08:07:10.000Z" },
  "request_id": "01JZX4..."
}
```

#### `POST /api/v1/sessions/{session_id}/questions/{question_id}:dismiss`

忽略一个待处理的提问，不作回答。无请求体。

**触发事件**：`event.question.dismissed`

**响应体**：成功时 `ResponseType` 的 `code` 是 `40909` 而不是 `0`，`data` 为 `{ dismissed: true, dismissed_at: string }`——客户端必须特殊处理该端点的成功码。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `dismissed` | boolean | 恒 `true` |
| `dismissed_at` | string | ISO 8601 时间 |

**非零 code**：`40401`、`40405`、`40902`（已被答复，`data: { "resolved": false }`）。

**响应示例**：

```json
{
  "code": 40909,
  "msg": "question dismissed",
  "data": { "dismissed": true, "dismissed_at": "2026-09-02T08:07:20.000Z" },
  "request_id": "01JZX4..."
}
```

**转录。**

`transcript` 端点提供按 Agent 组织的结构化转录——轮次、任务、交互、附件——即 WebSocket [transcript 帧](#transcript-帧) 实时流式推送的内容。历史分页与补漏用这些端点，实时尾部用 WebSocket 订阅。转录载荷的类型正本是共享包 `@moonshot-ai/transcript` 的契约（[T-Transcript 族](#t-transcript-族)）。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/v1/sessions/{session_id}/transcript` | 按轮次分页的转录（需 `agent_id`） |
| `GET /api/v1/sessions/{session_id}/transcript/ops` | op 批次补漏（`since_seq`） |
| `GET /api/v1/sessions/{session_id}/transcript/user-messages` | 各轮次起始的用户输入，不分页 |
| `GET /api/v1/sessions/{session_id}/transcript/plan` | ExitPlanMode 计划内容、路径与审阅结果 |

#### `GET /api/v1/sessions/{session_id}/transcript`

返回某个 Agent 的结构化转录中的一页：轮次（含其步骤与帧）以及轮次之间的标记与任务引用。活跃会话从内存存储应答（先回填所请求 Agent 的持久化历史）；冷会话则从持久化的线上记录重建 Agent。

**查询参数**：

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `agent_id` | string | **必填。** 要读取其转录的 Agent；必须是纯文本形式的 agent id（字母、数字、`.`、`_`、`-`，不含路径分隔符） |
| `before_turn` | string | 只保留早于该轮次 id 的轮次；与 `after_turn` 互斥 |
| `after_turn` | string | 只保留晚于该轮次 id 的轮次；与 `before_turn` 互斥 |
| `page_size` | integer | 1–100 个轮次。默认 `20` |

**响应体**：`ResponseType<`[T-TranscriptResponse](#t-transcriptresponse)`>`——分页单位是轮次：不带游标时返回最新的一页，`has_more` 表示还有更早的轮次；`tasks` / `interactions` / `attachments` / `todos` / `meta` / `agents` / `pending_interactions` 是不分页、随每次响应一起返回的全局 Agent 状态；`seq` 是该 Agent 用于恢复流的 op 批次水位（仅活跃会话携带）。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `data` | [T-TranscriptResponse](#t-transcriptresponse) | 一页转录；字段见类型汇总 |

**非零 code**：`40001`（校验失败；`details` 为 `{ path, message }[]`）、`40401`。

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "agent_id": "main",
    "items": [ { "kind": "turn", "turnId": 3, "...": "..." } ],
    "has_more": true,
    "tasks": [],
    "interactions": [],
    "attachments": [],
    "todos": [],
    "prompts": [],
    "meta": { "...": "..." },
    "agents": [ { "agentId": "main", "...": "..." } ],
    "pending_interactions": [],
    "seq": 42
  },
  "request_id": "01JZX4..."
}
```

#### `GET /api/v1/sessions/{session_id}/transcript/ops`

从服务端的 op 日志提供点对点的补漏：某个 Agent 的 `seq > since_seq` 的已记录 op 批次，最旧在前。它是 `transcript_since` 恢复游标的 REST 对应物，共享同一份有界日志，因此适用相同的回退规则。

**查询参数**：

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `agent_id` | string | **必填。** Agent id（纯文本形式） |
| `since_seq` | integer | **必填。** 调用方已应用的最后一个 op 批次 seq，最小为 `0`；返回其之后的批次 |

**响应体**：`ResponseType<`[T-TranscriptOpsCatchupResponse](#t-transcriptopscatchupresponse)`>`——`complete: true` 表示直到 `latest_seq` 的每个批次都在；`complete: false` 表示日志已不再覆盖到 `since_seq`（或会话根本不是活跃状态），调用方必须回退为一次完整的 `GET .../transcript` 刷新。会话存在但非活跃时固定返回 `{ agent_id, batches: [], latest_seq: 0, complete: false }`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `data` | [T-TranscriptOpsCatchupResponse](#t-transcriptopscatchupresponse) | 补漏批次；字段见类型汇总 |

**非零 code**：`40001`（校验失败；`details` 为 `{ path, message }[]`）、`40401`。

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "agent_id": "main",
    "batches": [ { "seq": 41, "ops": [ { "op": "append", "...": "..." } ] } ],
    "latest_seq": 42,
    "complete": true
  },
  "request_id": "01JZX4..."
}
```

#### `GET /api/v1/sessions/{session_id}/transcript/user-messages`

列出会话中每个开启轮次的输入，按 Agent 分组且不分页：真实用户文本、以斜杠命令形式使用的 Skill 与插件命令、以及 cron 提示词——可通过 `origin` 区分——另有仅含附件的提示词，其 `prompt` 投影为空。所列消息引用的附件实体会随响应一起返回（仅元数据，绝不包含字节内容）。

**查询参数**：

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `agent_id` | string | 只读取一个 Agent（纯文本 id）。默认读取所有在册 Agent（冷会话保证含 main agent） |

**响应体**：`ResponseType<`[T-TranscriptUserMessagesResponse](#t-transcriptusermessagesresponse)`>`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `data` | [T-TranscriptUserMessagesResponse](#t-transcriptusermessagesresponse) | 按 Agent 分组的用户输入；字段见类型汇总 |

**非零 code**：`40001`（校验失败；`details` 为 `{ path, message }[]`）、`40401`。

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "agents": [
      {
        "agent_id": "main",
        "messages": [
          {
            "turn_id": 3,
            "ordinal": 0,
            "state": "completed",
            "origin": { "kind": "user" },
            "prompt": "adjust the button spacing",
            "started_at": "2026-09-02T08:04:00.000Z"
          }
        ],
        "attachments": []
      }
    ]
  },
  "request_id": "01JZX4..."
}
```

#### `GET /api/v1/sessions/{session_id}/transcript/plan`

按时间线顺序读取某个 Agent 的 `ExitPlanMode` 工具调用的计划信息——计划内容、计划文件路径、提供的选项以及审阅结果。内容投影自第一个可用的事实来源：关联的审批交互（交互式审阅）、实时工具帧的展示（auto 模式），或工具结果的输出文本；每个条目在 `source` 中记录具体来源。

**查询参数**：

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `agent_id` | string | **必填。** Agent id（纯文本形式） |
| `tool_call_id` | string | 将读取范围限定到单次 `ExitPlanMode` 调用；不提供时列出所有可恢复计划内容的调用 |

**响应体**：`ResponseType<`[T-TranscriptPlanResponse](#t-transcriptplanresponse)`>`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `data` | [T-TranscriptPlanResponse](#t-transcriptplanresponse) | 计划条目列表；字段见类型汇总 |

**非零 code**：`40001`（校验失败；`details` 为 `{ path, message }[]`）、`40401`、`40416`（提供了 `tool_call_id`，但不存在该 id 的 `ExitPlanMode` 调用）。

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "agent_id": "main",
    "plans": [
      {
        "tool_call_id": "toolu_01J...",
        "turn_id": 2,
        "source": "interaction",
        "plan": "# Plan\n ...",
        "path": "/Users/dev/my-app/.kimi-code/plans/....md",
        "options": [ { "label": "实施" } ],
        "review": { "state": "approved", "selected_option": "实施" }
      }
    ]
  },
  "request_id": "01JZX4..."
}
```

### 任务

**后台任务。**

后台任务是会话的异步单元——后台 Shell、subagent 与长时间运行的工具任务。注册表仅包含实时数据：未加载到本服务进程中的会话会返回空列表。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/v1/sessions/{session_id}/tasks` | 列出后台任务 |
| `GET /api/v1/sessions/{session_id}/tasks/{task_id}` | 读取任务（可选输出预览） |
| `POST /api/v1/sessions/{session_id}/tasks/{task_id}:{action}` | 任务动作：`cancel` / `detach` |

#### `GET /api/v1/sessions/{session_id}/tasks`

列出会话的后台任务。

**查询参数**：

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `status` | string | 只保留单一状态：`running` / `completed` / `failed` / `cancelled` |

**响应体**：`ResponseType<{ items: `[T-Task](#t-task)`[]` }>`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `items` | [T-Task](#t-task)`[]` | 后台任务；冷会话为 `[]` |

**非零 code**：`40001`（未知的 `status`；`details` 为 `{ path, message }[]`）、`40401`。

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "items": [
      {
        "id": "task_01J...",
        "session_id": "session_01JZX4...",
        "kind": "bash",
        "description": "pnpm test",
        "status": "running",
        "created_at": "2026-09-02T08:06:00.000Z",
        "started_at": "2026-09-02T08:06:00.000Z",
        "command": "pnpm test",
        "run_in_background": true
      }
    ]
  },
  "request_id": "01JZX4..."
}
```

#### `GET /api/v1/sessions/{session_id}/tasks/{task_id}`

读取单个后台任务，可选携带输出的末尾片段。

**查询参数**：

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `with_output` | boolean | 在响应中包含输出末尾片段。默认 `false` |
| `output_bytes` | integer | 请求的输出末尾片段的字节大小，最小 `0`。默认 `32768` |

**响应体**：`ResponseType<`[T-Task](#t-task)`>`；`with_output=true` 且输出非空时附加 `output_preview` 与 `output_bytes`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `data` | [T-Task](#t-task) | 任务对象；字段见类型汇总 |

**非零 code**：`40001`（校验失败；`details` 为 `{ path, message }[]`）、`40401`、`40406`（没有该 id 的任务；冷会话完全没有实时任务）。

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "id": "task_01J...",
    "session_id": "session_01JZX4...",
    "kind": "bash",
    "description": "pnpm test",
    "status": "completed",
    "created_at": "2026-09-02T08:06:00.000Z",
    "started_at": "2026-09-02T08:06:00.000Z",
    "completed_at": "2026-09-02T08:06:40.000Z",
    "command": "pnpm test",
    "output_preview": "... tail of output ...",
    "output_bytes": 4096,
    "run_in_background": true
  },
  "request_id": "01JZX4..."
}
```

#### `POST /api/v1/sessions/{session_id}/tasks/{task_id}:{action}`

任务动作经 `POST .../tasks/{tail}` 分发：`:cancel` 取消运行中的任务；`:detach` 将运行中的前台任务转入后台而不终止它（等待该任务的工具调用立即以后台任务结果返回，轮次继续推进）。已在后台或已结束的任务上 `:detach` 为幂等空操作。无请求体。

**触发事件**：`:cancel` → `task.terminated`（及派生的 `background.task.terminated`）；`:detach` 无

**响应体**：统一 `ResponseType` 信封：`:cancel` → `{ cancelled: true }`；`:detach` → `{ detached: boolean, status: string }`（本次确实转入后台时 `detached` 为 `true`，`status` 为调用后的任务状态）。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `cancelled` | boolean | 仅 `:cancel`：恒 `true` |
| `detached` | boolean | 仅 `:detach`：本次确实转入后台时为 `true` |
| `status` | string | 仅 `:detach`：调用后的任务状态 |

**非零 code**：`40001`（动作缺失或未知；`details` 为 `{ path, message }[]`）、`40401`、`40406`、`40904`（任务已结束，`data: { "cancelled": false }` 且 `details: { "current_status" }`）。

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": { "detached": true, "status": "running" },
  "request_id": "01JZX4..."
}
```

### 终端

**终端。**

PTY（伪终端）接口；仅在 loopback 绑定时挂载（非 loopback 绑定会跳过它们，除非传入 `--allow-remote-terminals`）。注意：终端输入输出的 `terminal_*` WebSocket 帧当前是死协议（见 [terminal 帧](#terminal-帧)）——REST 侧只管理终端生命周期。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/v1/sessions/{session_id}/terminals` | 列出终端 |
| `POST /api/v1/sessions/{session_id}/terminals` | 创建终端 |
| `GET /api/v1/sessions/{session_id}/terminals/{terminal_id}` | 读取终端 |
| `POST /api/v1/sessions/{session_id}/terminals/{terminal_id}:close` | 关闭终端 |

#### `GET /api/v1/sessions/{session_id}/terminals`

列出会话的终端；读取列表会在会话为冷态时将其恢复。无参数。

**响应体**：`ResponseType<{ items: `[T-Terminal](#t-terminal)`[]` }>`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `items` | [T-Terminal](#t-terminal)`[]` | 会话的终端 |

**非零 code**：`40401`。

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "items": [
      {
        "id": "term_01J...",
        "session_id": "session_01JZX4...",
        "cwd": ".",
        "shell": "/bin/zsh",
        "cols": 80,
        "rows": 24,
        "status": "running",
        "created_at": "2026-09-02T08:08:00.000Z"
      }
    ]
  },
  "request_id": "01JZX4..."
}
```

#### `POST /api/v1/sessions/{session_id}/terminals`

为会话创建一个 PTY 终端。

**请求体**：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `runtime_id` | string | 否 | 生成终端进程的运行时。默认 `local` |
| `cwd` | string | 否 | 工作目录，相对于会话工作区（传绝对路径会校验失败）。默认工作区根目录 |
| `shell` | string | 否 | Shell 可执行文件。默认该运行时的 shell |
| `cols` | integer | 否 | 终端宽度，正数。默认 `80` |
| `rows` | integer | 否 | 终端高度，正数。默认 `24` |

**响应体**：`ResponseType<`[T-Terminal](#t-terminal)`>`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `data` | [T-Terminal](#t-terminal) | 新建的终端；字段见类型汇总 |

**非零 code**：`40001`（校验失败，`details` 逐字段说明；`details` 为 `{ path, message }[]`）、`40401`、`41304`（`cwd` 解析后越出会话工作区）。

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "id": "term_01J...",
    "session_id": "session_01JZX4...",
    "cwd": ".",
    "shell": "/bin/zsh",
    "cols": 80,
    "rows": 24,
    "status": "running",
    "created_at": "2026-09-02T08:08:00.000Z"
  },
  "request_id": "01JZX4..."
}
```

#### `GET /api/v1/sessions/{session_id}/terminals/{terminal_id}`

读取单个终端。无参数。

**响应体**：`ResponseType<`[T-Terminal](#t-terminal)`>`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `data` | [T-Terminal](#t-terminal) | 终端对象；字段见类型汇总 |

**非零 code**：`40401`、`40414`（没有该 id 的终端）。

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "id": "term_01J...",
    "session_id": "session_01JZX4...",
    "cwd": ".",
    "shell": "/bin/zsh",
    "cols": 80,
    "rows": 24,
    "status": "exited",
    "created_at": "2026-09-02T08:08:00.000Z",
    "exited_at": "2026-09-02T08:09:00.000Z",
    "exit_code": 0
  },
  "request_id": "01JZX4..."
}
```

#### `POST /api/v1/sessions/{session_id}/terminals/{terminal_id}:close`

关闭终端并结束其进程。经 `POST .../terminals/{tail}` 分发，`close` 是唯一动作。无请求体。

**响应体**：`ResponseType<{ closed: true }>`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `closed` | boolean | 恒 `true` |

**非零 code**：`40001`（缺少动作后缀或动作未知；`details` 为 `{ path, message }[]`）、`40401`、`40414`。

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": { "closed": true },
  "request_id": "01JZX4..."
}
```

### 扩展

路径前缀区分版本：`/api/v1` 与 `/api/v2`。

**技能。**

会话或工作区可见的技能目录，以及技能激活——激活即斜杠命令 `/<skill>` 的 REST 等价形式。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/v1/sessions/{session_id}/skills` | 会话级技能目录 |
| `GET /api/v1/workspaces/{workspace_id}/skills` | 无会话的工作区技能目录 |
| `POST /api/v1/sessions/{session_id}/skills/{skill_name}:activate` | 激活技能（开启一个轮次） |

#### `GET /api/v1/sessions/{session_id}/skills`

列出单个会话可用的技能，按会话的优先级合并所有来源（内置、插件、extra、用户、项目）；会话处于冷态时读取目录会恢复该会话。无参数。

**响应体**：`ResponseType<{ skills: `[T-SkillDescriptor](#t-skilldescriptor)`[]` }>`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `skills` | [T-SkillDescriptor](#t-skilldescriptor)`[]` | 会话可用的技能 |

**非零 code**：`40401`（会话不存在或未激活）。

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "skills": [
      {
        "name": "review",
        "description": "...",
        "path": "/Users/dev/my-app/.agents/skills/review/SKILL.md",
        "source": "project"
      }
    ]
  },
  "request_id": "01JZX4..."
}
```

#### `GET /api/v1/workspaces/{workspace_id}/skills`

列出该工作区中的会话将看到的技能目录，但不创建或恢复会话。无参数。

**响应体**：`ResponseType<{ skills: `[T-SkillDescriptor](#t-skilldescriptor)`[]` }>`（同 `GET /api/v1/sessions/{session_id}/skills`）。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `skills` | [T-SkillDescriptor](#t-skilldescriptor)`[]` | 工作区会话将看到的技能 |

**非零 code**：`40410`（工作区不存在）。

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "skills": [
      { "name": "review", "description": "...", "path": "...", "source": "project" }
    ]
  },
  "request_id": "01JZX4..."
}
```

#### `POST /api/v1/sessions/{session_id}/skills/{skill_name}:activate`

在会话中激活技能——以技能内容加上 `args` 与附件在 main agent 上开启一个轮次。经 `POST .../skills/{tail}` 分发，`activate` 是唯一动作。

**触发事件**：`skill.activated`（随后进入轮次事件流，见 [agent 事件](#agent-事件)）

**请求体**：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `args` | string | 否 | 传给技能的自由文本参数，相当于斜杠命令后的文本 |
| `attachments` | `{ type: string, … }[]` | 否 | 随激活携带的媒体块。`image` / `video` 块带 `source` 对象（`kind` 为 `url` / `base64` / `file` / `session_media`，与提示词内容块同形）；`file` 块带顶层 `file_id`、`name`、`media_type`、`size` |

**响应体**：`ResponseType<{ activated: true, skill_name: string }>`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `activated` | boolean | 恒 `true` |
| `skill_name` | string | 被激活的技能名 |

**非零 code**：`40001`（校验失败或动作后缀不支持；`details` 为 `{ path, message }[]`）、`40401`、`40407`（引用的附件文件不存在）、`40415`（没有该名称的技能）、`40912`（技能类型不允许用户激活）。

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": { "activated": true, "skill_name": "review" },
  "request_id": "01JZX4..."
}
```

**插件。**

插件是已安装的技能、MCP 服务、hook 与命令的打包集合。这组端点管理插件从市场列表到移除的整个生命周期。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/v1/plugins/marketplace` | 插件市场目录，合并实时安装状态 |
| `GET /api/v1/plugins` | 列出已安装插件 |
| `POST /api/v1/plugins` | 从本地路径、zip URL 或 GitHub 仓库安装插件 |
| `POST /api/v1/plugins/{plugin_id}:{action}` | 插件动作：`enable` / `disable` / `remove` |

#### `GET /api/v1/plugins/marketplace`

列出插件市场目录并合并实时安装状态。目录按请求从配置的市场 URL 拉取（超时 10 秒）；使用默认目录时，目录中缺少的内置能力会作为条目合并进来（带 `capabilityId`），当前平台不支持的能力对应条目会被剔除。无参数。

**响应体**：`ResponseType<{ entries: `[T-PluginMarketplaceEntry](#t-pluginmarketplaceentry)`[]` }>`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `entries` | [T-PluginMarketplaceEntry](#t-pluginmarketplaceentry)`[]` | 市场条目（camelCase）；字段见类型汇总 |

**非零 code**：`50001`（市场不可达或返回了非法目录）。

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "entries": [
      {
        "id": "my-plugin",
        "tier": "official",
        "displayName": "My Plugin",
        "source": "https://github.com/example/my-plugin",
        "installed": { "version": "1.2.0", "enabled": true },
        "updateAvailable": false
      }
    ]
  },
  "request_id": "01JZX4..."
}
```

#### `GET /api/v1/plugins`

列出已安装插件。无参数。

**响应体**：`ResponseType<{ plugins: `[T-PluginSummary](#t-pluginsummary)`[]` }>`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `plugins` | [T-PluginSummary](#t-pluginsummary)`[]` | 已安装插件摘要（camelCase） |

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "plugins": [
      {
        "id": "my-plugin",
        "displayName": "My Plugin",
        "version": "1.2.0",
        "enabled": true,
        "state": "ok",
        "skillCount": 2,
        "mcpServerCount": 1,
        "enabledMcpServerCount": 1,
        "hookCount": 0,
        "commandCount": 1,
        "hasErrors": false,
        "source": "github"
      }
    ]
  },
  "request_id": "01JZX4..."
}
```

#### `POST /api/v1/plugins`

安装插件并返回其摘要。

**触发事件**：`event.plugin.changed`

**请求体**：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `source` | string | 是 | 安装来源：本地绝对路径、指向 zip 压缩包的 `http(s)` URL，或 GitHub URL——`https://github.com/<owner>/<repo>`，可选地用 `/tree/<branch-or-sha>`、`/releases/tag/<tag>` 或 `/commit/<sha>` 锁定版本 |

**响应体**：`ResponseType<`[T-PluginSummary](#t-pluginsummary)`>`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `data` | [T-PluginSummary](#t-pluginsummary) | 安装后的插件摘要；字段见类型汇总 |

**非零 code**：`40001`（`source` 既不是 URL 也不是绝对路径，或插件加载失败；`details` 为 `{ path, message }[]`）、`40409`（本地路径不存在）。

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "id": "my-plugin",
    "displayName": "My Plugin",
    "enabled": true,
    "state": "ok",
    "skillCount": 2,
    "mcpServerCount": 0,
    "enabledMcpServerCount": 0,
    "hookCount": 0,
    "commandCount": 0,
    "hasErrors": false,
    "source": "local-path"
  },
  "request_id": "01JZX4..."
}
```

#### `POST /api/v1/plugins/{plugin_id}:{action}`

插件动作经单一路由分发：尾部按 `{plugin_id}:{action}` 解析，动作为 `enable`（启用）/ `disable`（停用但不移除）/ `remove`（移除）。无请求体。

**触发事件**：`event.plugin.changed`

**响应体**：`ResponseType<{ ok: true }>`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `ok` | boolean | 恒 `true` |

**非零 code**：`40001`（缺少动作后缀或动作未知；`details` 为 `{ path, message }[]`）、`40419`（没有该 id 的已安装插件）。

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": { "ok": true },
  "request_id": "01JZX4..."
}
```

**能力。**

能力是带有分层就绪状态的内置特性——由检测步骤加后台安装组成；当前版本注册了 `kimi-cu`（Kimi Computer Use）与 `kimi-webbridge`（Kimi WebBridge）。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/v1/capabilities` | 列出内置能力及其就绪状态 |
| `GET /api/v1/capabilities/{capability_id}` | 读取单个能力的状态 |
| `POST /api/v1/capabilities/{capability_id}:install` | 开始安装能力（后台进行，轮询 GET 查看进度） |

#### `GET /api/v1/capabilities`

列出所有已注册能力及其就绪状态。无参数。

**响应体**：`ResponseType<{ capabilities: `[T-CapabilityStatus](#t-capabilitystatus)`[]` }>`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `capabilities` | [T-CapabilityStatus](#t-capabilitystatus)`[]` | 各能力的就绪状态（camelCase） |

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "capabilities": [
      {
        "id": "kimi-cu",
        "displayName": "Kimi Computer Use",
        "description": "...",
        "supported": true,
        "state": "ready",
        "steps": [ { "id": "os", "state": "ok" } ],
        "install": { "running": false }
      }
    ]
  },
  "request_id": "01JZX4..."
}
```

#### `GET /api/v1/capabilities/{capability_id}`

读取单个能力的就绪状态——`:install` 动作的轮询对应端点。无参数。

**响应体**：`ResponseType<`[T-CapabilityStatus](#t-capabilitystatus)`>`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `data` | [T-CapabilityStatus](#t-capabilitystatus) | 能力的就绪状态；字段见类型汇总 |

**非零 code**：`40418`（没有该 id 的能力）。

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "id": "kimi-cu",
    "displayName": "Kimi Computer Use",
    "description": "...",
    "supported": true,
    "state": "partial",
    "steps": [ { "id": "app", "state": "missing", "optional": true } ],
    "install": { "running": true, "percent": 40 }
  },
  "request_id": "01JZX4..."
}
```

#### `POST /api/v1/capabilities/{capability_id}:install`

在后台开始安装能力并立即返回当前状态（`install.running` 为 `true`）；轮询 `GET /api/v1/capabilities/{capability_id}` 查看进度。幂等。经 `POST /api/v1/capabilities/{tail}` 分发，`install` 是唯一动作。无请求体。

**触发事件**：`event.capability.changed`（安装进度，易失事件）

**响应体**：`ResponseType<`[T-CapabilityStatus](#t-capabilitystatus)`>`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `data` | [T-CapabilityStatus](#t-capabilitystatus) | 发起安装后的能力状态；字段见类型汇总 |

**非零 code**：`40001`（缺少动作后缀或动作未知；`details` 为 `{ path, message }[]`）、`40418`、`40924`（安装已在进行中）、`40925`（当前平台 / 架构不支持）。

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "id": "kimi-cu",
    "displayName": "Kimi Computer Use",
    "description": "...",
    "supported": true,
    "state": "not_installed",
    "steps": [ "..." ],
    "install": { "running": true, "step": "download", "percent": 0 }
  },
  "request_id": "01JZX4..."
}
```

**工具与 MCP（v1）。**

当前生效 Agent 的工具列表及其 MCP 服务；管理 MCP 服务的完整面在「扩展」域的 [v2 MCP](#扩展) 部分。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/v1/tools` | 列出当前生效 Agent 的工具 |
| `GET /api/v1/mcp/servers` | 列出 MCP 服务 |
| `POST /api/v1/mcp/servers/{mcp_server_id}:restart` | 重启 MCP 服务 |

#### `GET /api/v1/tools`

列出当前生效 Agent 的工具——即 `session_id` 指定会话的 main agent；省略参数时取最近创建的存活会话。会话不在本服务进程中存活时列表为空。

**查询参数**：

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `session_id` | string | 要查看其 main agent 的会话。默认最近创建的存活会话 |

**响应体**：`ResponseType<{ tools: `[T-ToolDescriptor](#t-tooldescriptor)`[]` }>`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `tools` | [T-ToolDescriptor](#t-tooldescriptor)`[]` | 当前生效 Agent 的工具 |

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "tools": [
      {
        "name": "Bash",
        "description": "...",
        "input_schema": null,
        "source": "builtin",
        "active": true
      }
    ]
  },
  "request_id": "01JZX4..."
}
```

#### `GET /api/v1/mcp/servers`

列出当前生效 Agent 配置的 MCP 服务（与 `GET /api/v1/tools` 相同的会话选取规则）；没有存活会话时列表为空。无参数。

**响应体**：`ResponseType<{ servers: `[T-McpServer](#t-mcpserver)`[]` }>`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `servers` | [T-McpServer](#t-mcpserver)`[]` | 当前生效 Agent 的 MCP 服务 |

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "servers": [
      { "id": "my-server", "name": "my-server", "transport": "stdio", "status": "connected", "tool_count": 5 }
    ]
  },
  "request_id": "01JZX4..."
}
```

#### `POST /api/v1/mcp/servers/{mcp_server_id}:restart`

重新连接当前生效 Agent 的某个 MCP 服务。经 `POST /api/v1/mcp/servers/{tail}` 分发，`restart` 是唯一动作。无请求体。

**响应体**：`ResponseType<{ restarting: true }>`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `restarting` | boolean | 恒 `true` |

**非零 code**：`40001`（缺少动作后缀或动作未知；`details` 为 `{ path, message }[]`）、`40408`（没有该 id 的 MCP 服务；无存活会话时同样返回此错误）。

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": { "restarting": true },
  "request_id": "01JZX4..."
}
```

**v2 MCP。**

`/api/v2/mcp/*` 是统一的 MCP 管理面：独立于任何会话，直接管理 MCP server 注册表本身——全局（用户级）CRUD 与逐条校验、连接测试探测、locator 寻址的检查目录、按 server 的授权状态列表，以及完整的 OAuth 流程生命周期。响应该组一律不包 `{ items }`：`data` 直接为数组或对象。

该管理面有两种寻址方式。CRUD 路由与 `servers:test` 使用普通的运行时 `name`；检查与 OAuth 路由使用 **locator**——文件层条目用 `{ "source": "global", "name" }`，插件清单条目用 `{ "source": "plugin", "pluginId", "serverName" }`——因为插件条目和文件条目可能共用同一个运行时名称。检查条目还带有一个稳定的 `serverId` 线上标识：`global:<name>` 或 `plugin:<pluginId>:<serverName>`（URL 编码）。

大多数路由接受可选的 `cwd`（查询参数，`:`-action 路由则为请求体字段）。不传时目录只覆盖用户级文件与插件清单；传入后，该目录的项目根层与项目本地层会并入——但仅当工作区受信任时，否则项目层会被跳过。对 stdio server 执行 `servers:test` 时，`cwd` 同时是子进程的工作目录。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/v2/mcp/servers` | 列出所有已知 MCP server |
| `GET /api/v2/mcp/servers/{name}` | 按运行时名称获取单个 server |
| `POST /api/v2/mcp/servers` | 向用户级 `mcp.json` 添加 server |
| `PUT /api/v2/mcp/servers/{name}` | 替换一个用户级条目 |
| `DELETE /api/v2/mcp/servers/{name}` | 删除一个用户级条目 |
| `POST /api/v2/mcp/servers:test` | 对单个 server 发起真实连接探测 |
| `POST /api/v2/mcp/servers:inspect` | locator 寻址的目录及批量连接探测 |
| `GET /api/v2/mcp/auth-statuses` | 目录中各 server 的 OAuth 状态 |
| `POST /api/v2/mcp/auth:begin` | 开始一次交互式 OAuth 流程 |
| `POST /api/v2/mcp/auth:complete` | 等待浏览器回调并完成 code 交换 |
| `POST /api/v2/mcp/auth:cancel` | 终止已开始的 OAuth 流程 |
| `POST /api/v2/mcp/auth:reset` | 清除某个 server 已存储的凭据 |

#### `GET /api/v2/mcp/servers`

列出管理面已知的全部 MCP server。

**查询参数**：

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `cwd` | string | 并入该（受信任）目录的项目层 |

**响应体**：`ResponseType<`[T-McpManagedServer](#t-mcpmanagedserver)`[]>`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `data` | [T-McpManagedServer](#t-mcpmanagedserver)`[]` | 全部已知 server（camelCase）；字段见类型汇总 |

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": [
    {
      "name": "my-server",
      "config": { "transport": "stdio", "command": "npx", "args": [ "-y", "my-mcp-server" ], "envKeys": [ "API_KEY" ] },
      "source": "global",
      "origin": "/Users/dev/.kimi-code/mcp.json",
      "mutable": true
    }
  ],
  "request_id": "01JZX4..."
}
```

#### `GET /api/v2/mcp/servers/{name}`

按运行时名称获取单个 server。

**查询参数**：

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `cwd` | string | 并入该（受信任）目录的项目层 |

**响应体**：`ResponseType<`[T-McpManagedServer](#t-mcpmanagedserver)`>`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `data` | [T-McpManagedServer](#t-mcpmanagedserver) | 单个 server；字段见类型汇总 |

**非零 code**：`40001`（校验失败；`details` 为 `{ path, message }[]`）、`40408`（不存在该名称的 server）。

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "name": "my-server",
    "config": { "transport": "stdio", "command": "npx", "args": [ "-y", "my-mcp-server" ] },
    "source": "global",
    "origin": "/Users/dev/.kimi-code/mcp.json",
    "mutable": true
  },
  "request_id": "01JZX4..."
}
```

#### `POST /api/v2/mcp/servers`

向用户级 `mcp.json` 添加 server。若写入与项目层的同名条目冲突，会因只读被拒绝；与同名的插件条目冲突并不阻止写入，新的文件条目会将其遮蔽。

**请求体**：包含 `name` 的完整 server 配置——`transport`（`stdio` / `http` / `sse`）决定配置形状（见 [T-McpServerConfigView](#t-mcpserverconfigview) 的输入形态）。

**响应体**：`ResponseType<`[T-McpManagedServer](#t-mcpmanagedserver)`[]>`（刷新后的列表）。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `data` | [T-McpManagedServer](#t-mcpmanagedserver)`[]` | 刷新后的完整列表；字段见类型汇总 |

**非零 code**：`40001`（校验失败，或目标条目为只读；`details` 为 `{ path, message }[]`）。

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": [
    {
      "name": "my-server",
      "config": { "transport": "stdio", "command": "npx" },
      "source": "global",
      "origin": "...",
      "mutable": true
    }
  ],
  "request_id": "01JZX4..."
}
```

#### `PUT /api/v2/mcp/servers/{name}`

替换一个用户级条目；身份由路径指定。

**请求体**：不含 `name` 的完整 server 配置（形态同 `POST /api/v2/mcp/servers`）。

**响应体**：`ResponseType<`[T-McpManagedServer](#t-mcpmanagedserver)`[]>`（刷新后的列表）。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `data` | [T-McpManagedServer](#t-mcpmanagedserver)`[]` | 刷新后的完整列表；字段见类型汇总 |

**非零 code**：`40001`（校验失败；`details` 为 `{ path, message }[]`）、`40408`。

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": [
    {
      "name": "my-server",
      "config": { "transport": "http", "url": "https://mcp.example.com" },
      "source": "global",
      "origin": "...",
      "mutable": true
    }
  ],
  "request_id": "01JZX4..."
}
```

#### `DELETE /api/v2/mcp/servers/{name}`

删除一个用户级条目。无请求体。

**响应体**：`ResponseType<`[T-McpManagedServer](#t-mcpmanagedserver)`[]>`（刷新后的列表）。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `data` | [T-McpManagedServer](#t-mcpmanagedserver)`[]` | 刷新后的完整列表；字段见类型汇总 |

**非零 code**：`40001`（校验失败；`details` 为 `{ path, message }[]`）、`40408`。

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": [],
  "request_id": "01JZX4..."
}
```

#### `POST /api/v2/mcp/servers:test`

对单个 server 发起真实连接探测，不持久化任何内容。传 `name` 探测注册表条目（含插件与受信任的项目层），或传 `server`（包含 `name` 的完整内联配置）按原样探测；两者都传或都不传会报 `40001`。

**请求体**：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | string | 二选一 | 注册表条目的运行时名称 |
| `server` | `{ name: string, transport: string, … }` | 二选一 | 按原样探测的内联 server 配置（含 `name`） |
| `cwd` | string | 否 | 项目层并入解析；同时是 stdio 的工作目录 |

**响应体**：`ResponseType<{ success: boolean, output: string }>`——连接成功时 `output` 列出该 server 的可用工具，否则携带失败信息。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `success` | boolean | 连接是否成功 |
| `output` | string | 成功时列出可用工具，否则为失败信息 |

**非零 code**：`40001`（两种目标形式都传或都不传、内联配置无效，或运行时名称被多个启用的 server 共用；`details` 为 `{ path, message }[]`）、`40408`。

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": { "success": true, "output": "5 tools: search, fetch, ..." },
  "request_id": "01JZX4..."
}
```

#### `POST /api/v2/mcp/servers:inspect`

locator 寻址的目录（脱敏配置），外加对每个 OAuth 候选的批量真实连接探测。运行时名称被多个启用的 server 共用时无法无歧义地探测，会报告 `unavailable` 并在 `error` 中给出说明；探测遇到过期授权时，可能刷新或作废已存储的凭据。

**请求体**：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `targets` | `( { source: 'global', name: string } \| { source: 'plugin', pluginId: string, serverName: string } )[]` | 否 | 缩小目录范围的 locator 数组；不传则检查全部 server |
| `cwd` | string | 否 | 并入该（受信任）目录的项目层 |

**响应体**：`ResponseType<`[T-McpServerInspection](#t-mcpserverinspection)`[]>`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `data` | [T-McpServerInspection](#t-mcpserverinspection)`[]` | 检查目录（camelCase）；字段见类型汇总 |

**非零 code**：`40001`（校验失败；`details` 为 `{ path, message }[]`）、`40408`（`targets` 中有 locator 未匹配到任何条目）。

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": [
    {
      "serverId": "global:my-server",
      "locator": { "source": "global", "name": "my-server" },
      "runtimeName": "my-server",
      "origin": "global",
      "config": { "transport": "http", "url": "https://mcp.example.com" },
      "enabled": true,
      "editable": true,
      "authStatus": "oauth-authorized",
      "checkedAt": 1787000000000
    }
  ],
  "request_id": "01JZX4..."
}
```

#### `GET /api/v2/mcp/auth-statuses`

注册表目录中各 server 的 OAuth 状态——只需要授权维度时，这是比 `servers:inspect` 更轻量的选择。

**查询参数**：

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `cwd` | string | 并入该（受信任）目录的项目层 |
| `verify` | string | `true` 对每个 OAuth 候选发起真实连接验证；`false` 完全离线（仅凭配置与已存储 token 分类）；缺省保留隐式 OAuth 探测，只探测未固定且没有已存储凭据的远程 server |

**响应体**：`ResponseType<`[T-McpServerAuthStatus](#t-mcpserverauthstatus)`[]>`。验证探测可能刷新或作废已存储的凭据。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `data` | [T-McpServerAuthStatus](#t-mcpserverauthstatus)`[]` | 各 server 的授权状态；字段见类型汇总 |

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": [ { "name": "my-server", "authStatus": "oauth-authorized" } ],
  "request_id": "01JZX4..."
}
```

#### `POST /api/v2/mcp/auth:begin`

开始一次交互式 OAuth 流程。目标 server 必须使用远程传输（`http` / `sse`）且不含静态 bearer token；静态请求头仅当配置显式设置 `auth: "oauth"` 时允许。

**请求体**：locator——`{ source: 'global', name: string }` 或 `{ source: 'plugin', pluginId: string, serverName: string }`；另有可选的 `cwd` 查询参数。

**响应体**：`ResponseType<{ status: 'authorization-required', flowId: string, authorizationUrl: string } | { status: 'already-authorized' }>`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `status` | string | `authorization-required`（需在浏览器中打开 `authorizationUrl` 完成授权）/ `already-authorized`（授权已存在） |
| `flowId` | string | 仅 `authorization-required`：流程 id，传给 `auth:complete` |
| `authorizationUrl` | string | 仅 `authorization-required`：授权页 URL |

**非零 code**：`40001`（server 无法使用 OAuth：stdio 传输、静态 bearer token，或未设置 `auth: "oauth"` 的静态请求头；`details` 为 `{ path, message }[]`）、`40408`（locator 未匹配）、`40929`（OAuth 流程本身失败）。

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "status": "authorization-required",
    "flowId": "flow_01J...",
    "authorizationUrl": "https://mcp.example.com/authorize?..."
  },
  "request_id": "01JZX4..."
}
```

#### `POST /api/v2/mcp/auth:complete`

等待已开始流程的浏览器回调并完成 code 交换。等待默认 15 分钟（`timeoutMs` 可覆盖），空闲流程无论如何都会在 15 分钟后过期；关闭 HTTP 连接会中止等待。

**请求体**：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `flowId` | string | 是 | `auth:begin` 返回的流程 id |
| `timeoutMs` | integer | 否 | 等待上限（毫秒）。默认 15 分钟 |

**响应体**：`ResponseType<null>`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `data` | null | 恒 `null` |

**非零 code**：`40001`（`flowId` 未知；`details` 为 `{ path, message }[]`）、`40929`。

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": null,
  "request_id": "01JZX4..."
}
```

#### `POST /api/v2/mcp/auth:cancel`

在未完成的情况下终止已开始的流程；未知流程会被忽略。

**请求体**：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `flowId` | string | 是 | 要终止的流程 id |

**响应体**：`ResponseType<null>`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `data` | null | 恒 `null` |

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": null,
  "request_id": "01JZX4..."
}
```

#### `POST /api/v2/mcp/auth:reset`

清除某个 server 已存储的凭据；失效事件会送达存活的会话。

**请求体**：locator（形态同 `auth:begin`）。

**响应体**：`ResponseType<null>`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `data` | null | 恒 `null` |

**非零 code**：`40001`（校验失败；`details` 为 `{ path, message }[]`）、`40408`（locator 未匹配）、`40929`。

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": null,
  "request_id": "01JZX4..."
}
```

### 文件与其他

**文件系统。**

会话内文件操作走 `POST /api/v1/sessions/{session_id}/fs:{action}`，请求体为 JSON；另有工作区级与本机级的补充端点。每个动作的请求体还接受可选的 `runtime_id`（string，默认 `local`），用于选择执行操作的运行时；`search`、`grep`、`git_status` 与 `diff` 额外要求运行时具备 process capability（进程执行能力），`open`、`open-in` 与 `reveal` 仅在 `local` 运行时上可用。

| 方法与路径 | 说明 |
| --- | --- |
| `POST /api/v1/sessions/{session_id}/fs:{action}` | 会话内文件操作：`list` / `read` / `list_many` / `stat` / `stat_many` / `mkdir` / `search` / `grep` / `git_status` / `diff` / `open` / `open-in` / `reveal` |
| `POST /api/v1/workspace/fs:search` | 无会话的工作区搜索（body 携带工作区引用） |
| `POST /api/v1/workspace/fs:suggest` | 无会话的文件补全候选（用于 `@` 文件提及） |
| `POST /api/v1/fs:suggest` | 跨根目录的文件补全候选（body 携带 `roots`） |
| `GET /api/v1/sessions/{session_id}/fs/{path}:download` | 下载会话文件（二进制） |
| `GET /api/v1/fs:browse` | 列出本机目录（文件夹选择器用） |
| `GET /api/v1/fs:home` | 用户主目录与最近工作区 |
| `GET /api/v1/fs:content` | 读取本机任意文件原始字节（仅受 token 保护，谨慎暴露端口） |
| `POST /api/v1/fs:mkdir` | 按绝对路径创建目录 |

#### `POST /api/v1/sessions/{session_id}/fs:list`

列出会话工作区目录下的条目，可选递归子目录。

**请求体**：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `path` | string | 否 | 要列出的目录，相对于会话工作目录。默认 `.` |
| `depth` | integer | 否 | 递归深度，1–10。默认 `1` |
| `limit` | integer | 否 | 最大条目数，1–1000。默认 `200` |
| `show_hidden` | boolean | 否 | 包含点文件。默认 `false` |
| `follow_gitignore` | boolean | 否 | 跳过 gitignore 的路径。默认 `true` |
| `exclude_globs` | `string[]` | 否 | 额外要跳过的 glob |
| `sort` | string | 否 | `type_first`（默认）/ `name_asc` / `name_desc` / `mtime_desc` / `size_desc` |
| `include_git_status` | boolean | 否 | 附带每个条目的 git 状态。默认 `false` |

**响应体**：`ResponseType<`[T-FsListResponse](#t-fslistresponse)`>`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `data` | [T-FsListResponse](#t-fslistresponse) | 目录条目与截断标记；字段见类型汇总 |

**非零 code**：`40001`（校验失败；`details` 为 `{ path, message }[]`）、`40401`、`40409`（路径不存在或不是目录）、`41304`。

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "items": [
      {
        "path": "src",
        "name": "src",
        "kind": "directory",
        "modified_at": "2026-09-01T10:00:00.000Z",
        "child_count": 12
      },
      {
        "path": "package.json",
        "name": "package.json",
        "kind": "file",
        "size": 1024,
        "modified_at": "2026-09-01T10:00:00.000Z",
        "mime": "application/json"
      }
    ],
    "truncated": false
  },
  "request_id": "01JZX4..."
}
```

#### `POST /api/v1/sessions/{session_id}/fs:read`

以文本或 base64 读取会话文件的一段内容。`encoding: "auto"` 时文本以 `utf-8` 返回（非 UTF-8 文本会被转码），二进制内容以 `base64` 返回；`encoding: "utf-8"` 强制按文本读取并拒绝二进制文件。

**请求体**：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `path` | string | 是 | 文件路径，相对于会话工作目录 |
| `offset` | integer | 否 | 起始字节偏移。默认 `0` |
| `length` | integer | 否 | 读取字节数，1–10485760（10 MiB）。默认 `1048576`（1 MiB） |
| `encoding` | string | 否 | `auto`（默认）/ `utf-8` / `base64` |

**响应体**：`ResponseType<`[T-FsReadResponse](#t-fsreadresponse)`>`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `data` | [T-FsReadResponse](#t-fsreadresponse) | 文件内容片段；字段见类型汇总 |

**非零 code**：`40001`（校验失败；`details` 为 `{ path, message }[]`）、`40401`、`40409`、`40906`（路径是目录）、`40907`（二进制文件却指定 `utf-8`）、`41302`（文件超过 10 MiB 上限）、`41304`。

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "path": "src/index.ts",
    "content": "import ...",
    "encoding": "utf-8",
    "size": 20480,
    "truncated": false,
    "etag": "...",
    "mime": "text/typescript",
    "language_id": "typescript",
    "line_count": 512,
    "is_binary": false
  },
  "request_id": "01JZX4..."
}
```

#### `POST /api/v1/sessions/{session_id}/fs:list_many`

一次调用列出多个会话目录；失败的路径折进响应里，而不是让整个请求失败。

**请求体**：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `paths` | `string[]` | 是 | 要列出的目录，1–100 条 |

其余字段（`depth`、`limit`、`show_hidden`、`follow_gitignore`、`exclude_globs`、`sort`、`include_git_status`）与 `fs:list` 相同。

**响应体**：`ResponseType<`[T-FsListManyResponse](#t-fslistmanyresponse)`>`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `data` | [T-FsListManyResponse](#t-fslistmanyresponse) | 每个路径的条目与局部错误；字段见类型汇总 |

**非零 code**：`40001`（校验失败；`details` 为 `{ path, message }[]`）、`40401`。

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "results": {
      "src": [ { "path": "src/index.ts", "name": "index.ts", "kind": "file", "modified_at": "..." } ]
    },
    "truncated_paths": [ "src" ],
    "partial_errors": { "vendor": { "code": 40409, "msg": "path does not exist" } }
  },
  "request_id": "01JZX4..."
}
```

#### `POST /api/v1/sessions/{session_id}/fs:stat`

查询会话工作区内单个路径的元信息。

**请求体**：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `path` | string | 是 | 要查询的路径，相对于会话工作目录 |

**响应体**：`ResponseType<`[T-FsEntry](#t-fsentry)`>`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `data` | [T-FsEntry](#t-fsentry) | 路径元信息；字段见类型汇总 |

**非零 code**：`40001`（校验失败；`details` 为 `{ path, message }[]`）、`40401`、`40409`、`41304`。

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "path": "src/index.ts",
    "name": "index.ts",
    "kind": "file",
    "size": 20480,
    "modified_at": "2026-09-01T10:00:00.000Z",
    "mime": "text/typescript",
    "is_binary": false
  },
  "request_id": "01JZX4..."
}
```

#### `POST /api/v1/sessions/{session_id}/fs:stat_many`

一次调用查询多个会话路径的元信息；不存在的路径返回 `null`，不会让整个请求失败。

**请求体**：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `paths` | `string[]` | 是 | 要查询的路径，1–1000 条 |

**响应体**：`ResponseType<`[T-FsStatManyResponse](#t-fsstatmanyresponse)`>`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `data` | [T-FsStatManyResponse](#t-fsstatmanyresponse) | 每个路径的条目（不存在时为 `null`）；字段见类型汇总 |

**非零 code**：`40001`（校验失败；`details` 为 `{ path, message }[]`）、`40401`。

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "entries": {
      "src/index.ts": { "path": "src/index.ts", "name": "index.ts", "kind": "file", "modified_at": "..." },
      "vendor": null
    }
  },
  "request_id": "01JZX4..."
}
```

#### `POST /api/v1/sessions/{session_id}/fs:mkdir`

在会话工作区内创建目录。

**请求体**：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `path` | string | 是 | 要创建的目录，相对于会话工作目录 |
| `recursive` | boolean | 否 | 创建缺失的父目录。默认 `false` |

**响应体**：`ResponseType<`[T-FsEntry](#t-fsentry)`>`（所建目录）。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `data` | [T-FsEntry](#t-fsentry) | 所建目录的元信息；字段见类型汇总 |

**非零 code**：`40001`（校验失败；`details` 为 `{ path, message }[]`）、`40401`、`40409`（父目录不存在）、`40919`（路径已存在）、`41304`。

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "path": "docs/api",
    "name": "api",
    "kind": "directory",
    "modified_at": "2026-09-02T08:10:00.000Z"
  },
  "request_id": "01JZX4..."
}
```

#### `POST /api/v1/sessions/{session_id}/fs:search`

在会话工作区内模糊搜索文件与目录名。`query` 为空时改为列出顶层条目。当 `{session_id}` 位置携带的是工作区引用（已注册工作区 id 或绝对根路径）而非会话 id 时，搜索针对该工作区执行——这是为尚未创建的草稿会话准备的无会话形式；正式的无会话端点是 `POST /api/v1/workspace/fs:search`。

**请求体**：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `query` | string | 是 | 搜索文本；`""` 表示列出顶层 |
| `limit` | integer | 否 | 最大命中数，1–200。默认 `50` |
| `include_globs` | `string[]` | 否 | 只保留匹配这些 glob 之一的路径 |
| `exclude_globs` | `string[]` | 否 | 跳过匹配这些 glob 的路径 |
| `follow_gitignore` | boolean | 否 | 跳过 gitignore 的路径。默认 `true` |

**响应体**：`ResponseType<{ items: `[T-FsSearchHit](#t-fssearchhit)`[]`, truncated: boolean }>`（命中按得分排序，同分按路径）。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `items` | [T-FsSearchHit](#t-fssearchhit)`[]` | 搜索命中 |
| `truncated` | boolean | 命中数被 `limit` 截断 |

**非零 code**：`40001`（校验失败；`details` 为 `{ path, message }[]`）、`40401`（该引用既不是会话，也不是可解析的工作区）、`41303`（命中过多）。

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "items": [
      {
        "path": "src/server-api.ts",
        "name": "server-api.ts",
        "kind": "file",
        "score": 0.92,
        "match_positions": [ 4, 5, 6 ]
      }
    ],
    "truncated": false
  },
  "request_id": "01JZX4..."
}
```

#### `POST /api/v1/sessions/{session_id}/fs:grep`

在会话工作区内搜索文件内容——默认按字面字符串，`regex: true` 时按正则表达式。

**请求体**：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `pattern` | string | 是 | 要搜索的文本或正则 |
| `regex` | boolean | 否 | 将 `pattern` 视为正则表达式。默认 `false` |
| `case_sensitive` | boolean | 否 | 默认 `true` |
| `include_globs` | `string[]` | 否 | 只保留匹配这些 glob 之一的文件 |
| `exclude_globs` | `string[]` | 否 | 跳过匹配这些 glob 的文件 |
| `follow_gitignore` | boolean | 否 | 跳过 gitignore 的路径。默认 `true` |
| `max_files` | integer | 否 | 最多扫描的文件数，1–10000。默认 `200` |
| `max_matches_per_file` | integer | 否 | 每个文件保留的匹配数，1–10000。默认 `50` |
| `max_total_matches` | integer | 否 | 总共保留的匹配数，1–100000。默认 `5000` |
| `context_lines` | integer | 否 | 每个匹配携带的上下文行数，0–10。默认 `2` |

**响应体**：`ResponseType<`[T-FsGrepResponse](#t-fsgrepresponse)`>`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `data` | [T-FsGrepResponse](#t-fsgrepresponse) | 按文件分组的匹配；字段见类型汇总 |

**非零 code**：`40001`（校验失败；`details` 为 `{ path, message }[]`）、`40401`、`41303`、`41305`（搜索超时）。

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "files": [
      {
        "path": "src/index.ts",
        "matches": [
          {
            "line": 12,
            "col": 8,
            "text": "const token = ...",
            "before": [ "..." ],
            "after": [ "..." ]
          }
        ]
      }
    ],
    "files_scanned": 87,
    "truncated": false,
    "elapsed_ms": 42
  },
  "request_id": "01JZX4..."
}
```

#### `POST /api/v1/sessions/{session_id}/fs:git_status`

读取会话工作区的 git 状态，可选限定在一组路径内。

**请求体**：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `paths` | `string[]` | 否 | 将状态限定在这些路径；省略表示整个工作区 |

**响应体**：`ResponseType<`[T-FsGitStatusResponse](#t-fsgitstatusresponse)`>`（注意 camelCase `pullRequest`）。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `data` | [T-FsGitStatusResponse](#t-fsgitstatusresponse) | git 状态；字段见类型汇总 |

**非零 code**：`40001`（校验失败；`details` 为 `{ path, message }[]`）、`40401`、`40908`（git 不可用：不是仓库，或没有 git 可执行文件）。

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "branch": "main",
    "ahead": 1,
    "behind": 0,
    "entries": { "src/index.ts": "modified" },
    "additions": 12,
    "deletions": 3,
    "pullRequest": { "number": 3451, "state": "open", "url": "https://github.com/example/repo/pull/3451" }
  },
  "request_id": "01JZX4..."
}
```

#### `POST /api/v1/sessions/{session_id}/fs:diff`

返回会话工作区内单个文件的 unified git diff。

**请求体**：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `path` | string | 是 | 要 diff 的文件，相对于会话工作目录 |

**响应体**：`ResponseType<`[T-FsDiffResponse](#t-fsdiffresponse)`>`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `data` | [T-FsDiffResponse](#t-fsdiffresponse) | unified diff 文本；字段见类型汇总 |

**非零 code**：`40001`（校验失败；`details` 为 `{ path, message }[]`）、`40401`、`40908`、`41304`。

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": { "path": "src/index.ts", "diff": "@@ -1,4 +1,5 @@\n ...", "truncated": false },
  "request_id": "01JZX4..."
}
```

#### `POST /api/v1/sessions/{session_id}/fs:open`

用宿主操作系统的默认程序打开会话文件。仅限 local 运行时。

**请求体**：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `path` | string | 是 | 要打开的文件，相对于会话工作目录 |
| `line` | integer | 否 | 在处理程序支持时跳转到的行号（正整数） |

**响应体**：`ResponseType<{ opened: true }>`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `opened` | boolean | 恒 `true` |

**非零 code**：`40001`（校验失败；`details` 为 `{ path, message }[]`）、`40401`、`40409`、`41304`。

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": { "opened": true },
  "request_id": "01JZX4..."
}
```

#### `POST /api/v1/sessions/{session_id}/fs:open-in`

在指定的宿主应用程序中打开会话文件或目录。仅限 local 运行时。

**请求体**：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `app_id` | string | 是 | 目标应用：`finder` / `cursor` / `vscode` / `iterm` / `terminal` |
| `path` | string | 是 | 要打开的文件或目录，相对于会话工作目录 |
| `line` | integer | 否 | 在应用支持时跳转到的行号（正整数） |

**响应体**：`ResponseType<{ opened: true }>`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `opened` | boolean | 恒 `true` |

**非零 code**：`40001`（校验失败；`details` 为 `{ path, message }[]`）、`40401`、`40409`、`41304`、`50001`（应用启动失败）。

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": { "opened": true },
  "request_id": "01JZX4..."
}
```

#### `POST /api/v1/sessions/{session_id}/fs:reveal`

在宿主操作系统的文件管理器中显示会话文件。仅限 local 运行时。

**请求体**：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `path` | string | 是 | 要显示的文件，相对于会话工作目录 |

**响应体**：`ResponseType<{ revealed: true }>`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `revealed` | boolean | 恒 `true` |

**非零 code**：`40001`（校验失败；`details` 为 `{ path, message }[]`）、`40401`、`40409`、`41304`。

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": { "revealed": true },
  "request_id": "01JZX4..."
}
```

#### `GET /api/v1/sessions/{session_id}/fs/{path}:download`

从会话工作区下载文件；`{path}` 是相对于工作区的文件路径，并带字面量 `:download` 后缀。响应为支持 Range 与 ETag 的二进制流，不返回 `ResponseType`——见 [二进制与流式端点](#二进制与流式端点)。

**查询参数**：

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `runtime_id` | string | 从哪个运行时读取。默认 `local` |

**非零 code**（`ResponseType`）：`40001`（路径缺失或不以 `:download` 结尾；`details` 为 `{ path, message }[]`）、`40401`、`40409`、`41304`。

#### `POST /api/v1/workspace/fs:search`

`fs:search` 的无会话形式：工作区改由请求体而非 URL 携带。

**请求体**：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `workspace` | string | 是 | 已注册工作区 id 或绝对根路径（当场注册） |
| `query` | string | 是 | 搜索文本；`""` 表示列出顶层 |
| `limit` | integer | 否 | 最大命中数，1–200。默认 `50` |
| `include_globs` | `string[]` | 否 | 只保留匹配这些 glob 之一的路径 |
| `exclude_globs` | `string[]` | 否 | 跳过匹配这些 glob 的路径 |
| `follow_gitignore` | boolean | 否 | 跳过 gitignore 的路径。默认 `true` |
| `runtime_id` | string | 否 | 在哪个运行时上搜索。默认 `local` |

**响应体**：`ResponseType<{ items: `[T-FsSearchHit](#t-fssearchhit)`[]`, truncated: boolean }>`（命中结构与排序同 `fs:search`）。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `items` | [T-FsSearchHit](#t-fssearchhit)`[]` | 搜索命中 |
| `truncated` | boolean | 命中数被 `limit` 截断 |

**非零 code**：`40001`（校验失败；`details` 为 `{ path, message }[]`）、`40410`（工作区不存在，且不是可用的绝对路径）、`41303`。

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "items": [
      {
        "path": "src/server-api.ts",
        "name": "server-api.ts",
        "kind": "file",
        "score": 0.92,
        "match_positions": [ 4, 5, 6 ]
      }
    ],
    "truncated": false
  },
  "request_id": "01JZX4..."
}
```

#### `POST /api/v1/workspace/fs:suggest`

在无会话的情况下给出工作区内的文件与目录补全候选——即输入框中 `@` 文件提及的后端。

**请求体**：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `workspace` | string | 是 | 已注册工作区 id 或绝对根路径（当场注册） |
| `query` | string | 是 | 要补全的部分路径文本 |
| `limit` | integer | 否 | 最大候选数，1–200。默认 `50` |
| `follow_gitignore` | boolean | 否 | 跳过 gitignore 的路径。默认 `true` |
| `show_hidden` | boolean | 否 | 包含点文件。默认 `false` |
| `include_globs` | `string[]` | 否 | 只保留匹配这些 glob 之一的路径 |
| `exclude_globs` | `string[]` | 否 | 跳过匹配这些 glob 的路径 |
| `runtime_id` | string | 否 | 在哪个运行时上补全。默认 `local` |

**响应体**：`ResponseType<{ items: `[T-FsSuggestItem](#t-fssuggestitem)`[]`, truncated: boolean }>`（结构同搜索命中）。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `items` | [T-FsSuggestItem](#t-fssuggestitem)`[]` | 补全候选 |
| `truncated` | boolean | 候选数被 `limit` 截断 |

**非零 code**：`40001`（校验失败；`details` 为 `{ path, message }[]`）、`40410`。

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "items": [
      {
        "path": "src/server-api.ts",
        "name": "server-api.ts",
        "kind": "file",
        "score": 0.9,
        "match_positions": [ 4, 5 ]
      }
    ],
    "truncated": false
  },
  "request_id": "01JZX4..."
}
```

#### `POST /api/v1/fs:suggest`

`fs:suggest` 的工作区无关形式：请求体直接携带绝对 `roots`（1–32 条）。首 root 为主——其候选以相对路径返回，附加 root 的候选为绝对路径；重叠的 root 按 realpath 去重。每个 root 都会先 stat，不存在则整个请求失败。

**请求体**：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `roots` | `string[]` | 是 | 绝对根路径数组，1–32 条 |
| `query` | string | 是 | 要补全的部分路径文本 |
| `limit` | integer | 否 | 最大候选数。默认 `50` |
| `follow_gitignore` | boolean | 否 | 默认 `true` |
| `show_hidden` | boolean | 否 | 默认 `false` |
| `include_globs` | `string[]` | 否 | 只保留匹配这些 glob 之一的路径 |
| `exclude_globs` | `string[]` | 否 | 跳过匹配这些 glob 的路径 |
| `runtime_id` | string | 否 | 默认 `local` |

**响应体**：`ResponseType<{ items: `[T-FsSuggestItem](#t-fssuggestitem)`[]`, truncated: boolean }>`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `items` | [T-FsSuggestItem](#t-fssuggestitem)`[]` | 补全候选 |
| `truncated` | boolean | 候选数被 `limit` 截断 |

**非零 code**：`40001`（校验失败；`details` 为 `{ path, message }[]`）、`40409`（某个 root 不存在）、`40420`、`40926`。

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "items": [
      {
        "path": "src/server-api.ts",
        "name": "server-api.ts",
        "kind": "file",
        "score": 0.9,
        "match_positions": [ 4, 5 ]
      }
    ],
    "truncated": false
  },
  "request_id": "01JZX4..."
}
```

#### `GET /api/v1/fs:browse`

列出某个本机目录的子目录——文件夹选择器的后端。

**查询参数**：

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `path` | string | 绝对目录路径。默认用户主目录 |

**响应体**：`ResponseType<`[T-FsBrowseResponse](#t-fsbrowseresponse)`>`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `data` | [T-FsBrowseResponse](#t-fsbrowseresponse) | 目录列表；字段见类型汇总 |

**非零 code**：`40001`（`path` 不是绝对路径；`details` 为 `{ path, message }[]`）、`40409`、`40411`（权限不足）。

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "path": "/Users/dev",
    "parent": "/Users",
    "entries": [ { "name": "my-app", "path": "/Users/dev/my-app", "is_dir": true } ]
  },
  "request_id": "01JZX4..."
}
```

#### `GET /api/v1/fs:home`

返回文件夹选择器的落地数据。无参数。

**响应体**：`ResponseType<`[T-FsHomeResponse](#t-fshomeresponse)`>`（`recent_roots` 上限 8）。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `data` | [T-FsHomeResponse](#t-fshomeresponse) | 主目录与最近工作区；字段见类型汇总 |

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": { "home": "/Users/dev", "recent_roots": [ "/Users/dev/my-app" ] },
  "request_id": "01JZX4..."
}
```

#### `GET /api/v1/fs:content`

以流式返回本机文件系统上任意文件的原始字节——仅受 API token 保护，暴露端口时务必谨慎。响应为二进制流，支持 Range 请求与 ETag 缓存，不返回 `ResponseType`；见 [二进制与流式端点](#二进制与流式端点)。

**查询参数**：

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `path` | string | **必填。** 绝对文件路径（realpath 解析） |

**非零 code**（`ResponseType`）：`40001`（不是绝对路径或不是普通文件；`details` 为 `{ path, message }[]`）、`40409`、`40411`、`40906`（路径是目录）。

#### `POST /api/v1/fs:mkdir`

按绝对路径在本机文件系统上创建一个目录——文件夹选择器「新建文件夹」的后端。非递归：父目录必须已存在。

**请求体**：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `path` | string | 是 | 绝对目录路径 |

**响应体**：`ResponseType<{ path: string }>`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `path` | string | 创建的目录路径 |

**非零 code**：`40001`（校验失败；`details` 为 `{ path, message }[]`）、`40409`（父路径不存在）、`40411`、`40919`（路径已存在）。

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": { "path": "/Users/dev/new-project" },
  "request_id": "01JZX4..."
}
```

**文件上传与媒体。**

提示词附件的上传、下载与删除；会话媒体按会话作用域寻址。

| 方法与路径 | 说明 |
| --- | --- |
| `POST /api/v1/files` | multipart 上传，返回文件元信息 |
| `GET /api/v1/files/{file_id}` | 下载（二进制，错误用真实 HTTP 状态码） |
| `DELETE /api/v1/files/{file_id}` | 删除 |
| `GET /api/v1/sessions/{session_id}/media/{file_id}` | 按文件 id 下载提示词媒体（二进制） |

#### `POST /api/v1/files`

以 `multipart/form-data` 上传文件，供后续引用（例如作为提示词附件）。

**请求体**（multipart）：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `file` | binary | 是 | multipart 的文件部分 |
| `name` | string | 否 | 存储的显示名。默认上传文件名 |
| `expires_in_sec` | number | 否 | 文件过期前的秒数（非负）。默认永不过期 |

**响应体**：`ResponseType<`[T-FileMeta](#t-filemeta)`>`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `data` | [T-FileMeta](#t-filemeta) | 文件元信息；字段见类型汇总 |

**非零 code**：`40001`（multipart 未初始化或缺少 `file` 字段；`details` 为 `{ path, message }[]`）。

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "id": "f_01JZX4...",
    "name": "screenshot.png",
    "media_type": "image/png",
    "size": 204800,
    "created_at": "2026-09-02T08:12:00.000Z"
  },
  "request_id": "01JZX4..."
}
```

#### `GET /api/v1/files/{file_id}`

下载已上传的文件。响应为二进制流，支持 Range 请求但不处理 `If-None-Match`，不返回 `ResponseType`；失败使用真实 HTTP 状态码——见 [二进制与流式端点](#二进制与流式端点)。

**非零 code**：`40407`（HTTP 404：没有该 id 的文件，包括已过期的）、`50001`（HTTP 500）。

#### `DELETE /api/v1/files/{file_id}`

删除已上传的文件。无请求体。

**响应体**：`ResponseType<{ deleted: true }>`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `deleted` | boolean | 恒 `true` |

**非零 code**：同下载——`40407`（HTTP 404）、`50001`（HTTP 500）。

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": { "deleted": true },
  "request_id": "01JZX4..."
}
```

#### `GET /api/v1/sessions/{session_id}/media/{file_id}`

按文件 id 下载提示词媒体文件（会话提示词引用的图片或其他附件）；尚未提交到会话的 id 会回退到暂存的上传中查找。响应为二进制并支持 Range，不返回 `ResponseType`——共享约定见 [二进制与流式端点](#二进制与流式端点)；与那里返回 `ResponseType` 的端点不同，会话或文件不存在时返回真正的 404 状态码且响应体仍为 `ResponseType`。

**非零 code**：`40401`（HTTP 404）、`40407`（HTTP 404）。

**全局搜索。**

#### `POST /api/v1/search`

跨会话全文搜索，覆盖 User 消息、Assistant 回复与会话标题，由服务端的持久搜索索引支撑。当 `container.session_id` 指向本服务进程中存活的会话时，搜索改为直接扫描该会话的内存转录，响应的 `source` 字段（`index` 或 `live`）会报告本页结果由哪条路径提供。分页遵循 [`page_token`](#分页) 风格。

**请求体**：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `query` | string | 是 | 搜索文本 |
| `mode` | string | 否 | `terms`（默认）/ `literal`（零误报的精确子串搜索） |
| `op` | string | 否 | `terms` 模式下的词项组合符：`AND`（默认）/ `OR` |
| `container` | `{ session_id?: string, agent_id?: string }` | 否 | 将搜索限定在该容器内 |
| `role` | string | 否 | 限定 `user` / `assistant` / `title` 命中 |
| `start_time` | integer | 否 | 只看不早于该时间的命中（epoch 毫秒） |
| `end_time` | integer | 否 | 只看不晚于该时间的命中（epoch 毫秒） |
| `sort` | string | 否 | `score`（默认）/ `time_desc` / `time_asc`；`literal` 模式忽略此参数，始终最新在前 |
| `page_size` | integer | 否 | 每页命中数，1–50。默认 `20` |
| `page_token` | string | 否 | 上一页响应返回的令牌 |

`terms` 模式下查询会被分词（ASCII 词加 CJK n-gram）、去重，并以至多 32 个词项匹配倒排索引。

**响应体**：`ResponseType<`[T-SearchResponse](#t-searchresponse)`>`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `data` | [T-SearchResponse](#t-searchresponse) | 一页命中与索引状态；字段见类型汇总 |

**非零 code**：`40001`（校验失败、查询为空或超过 32 个词项、分页令牌非法；`details` 为 `{ path, message }[]`）、`50001`。

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "items": [
      {
        "session_id": "session_01JZX4...",
        "workspace_id": "wd_my-app_a1b2c3d4e5f6",
        "session_title": "Fix the login page",
        "agent_id": "main",
        "role": "user",
        "snippet": "...adjust the button spacing...",
        "time": 1787000000000,
        "turn": 3,
        "score": 2.31
      }
    ],
    "has_more": false,
    "index_state": { "state": "ready", "indexed_sessions": 12, "total_sessions": 12, "documents": 340 },
    "source": "index"
  },
  "request_id": "01JZX4..."
}
```

**GUI 存储。**

由服务端支撑的键值存储，接口对齐浏览器的 `localStorage`，持久化在服务的 home 目录下；web UI 用它保存跨客户端的 UI 状态。值是不透明字符串——序列化由调用方负责。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/v1/gui/store/length` | 已存键的数量 |
| `GET /api/v1/gui/store/getItem` | 按键读取值 |
| `POST /api/v1/gui/store/setItem` | 按键写入值 |
| `POST /api/v1/gui/store/removeItem` | 按键删除值 |
| `POST /api/v1/gui/store/clear` | 删除所有值 |

`key` 的长度上限为 256 个字符，缺省或超长返回 `40001`。

#### `GET /api/v1/gui/store/length`

返回已存键的数量（对齐 `localStorage.length`）。无参数。

**响应体**：`ResponseType<{ length: number }>`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `length` | number | 已存键的数量 |

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": { "length": 3 },
  "request_id": "01JZX4..."
}
```

#### `GET /api/v1/gui/store/getItem`

读取一个值（对齐 `localStorage.getItem`）。

**查询参数**：

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `key` | string | **必填。** 要读取的键，1–256 个字符 |

**响应体**：`ResponseType<{ value: string | null }>`——键不存在时为 `null`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `value` | string \| null | 存储的值；键不存在时为 `null` |

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": { "value": "{ \"sidebar\": \"collapsed\" }" },
  "request_id": "01JZX4..."
}
```

#### `POST /api/v1/gui/store/setItem`

写入一个值（对齐 `localStorage.setItem`）。

**请求体**：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `key` | string | 是 | 要写入的键，1–256 个字符 |
| `value` | string | 是 | 要存储的值 |

**响应体**：`ResponseType<null>`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `data` | null | 恒 `null` |

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": null,
  "request_id": "01JZX4..."
}
```

#### `POST /api/v1/gui/store/removeItem`

删除一个值（对齐 `localStorage.removeItem`）。

**请求体**：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `key` | string | 是 | 要删除的键，1–256 个字符 |

**响应体**：`ResponseType<null>`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `data` | null | 恒 `null` |

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": null,
  "request_id": "01JZX4..."
}
```

#### `POST /api/v1/gui/store/clear`

删除所有已存值（对齐 `localStorage.clear`）。无请求体。

**响应体**：`ResponseType<null>`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `data` | null | 恒 `null` |

**响应示例**：

```json
{
  "code": 0,
  "msg": "success",
  "data": null,
  "request_id": "01JZX4..."
}
```

## WebSocket 帧

事件流端点为 `/api/v1/ws`。服务端到客户端的帧分五路：

| 路由 | type 值 | 说明 |
| --- | --- | --- |
| 控制帧 | `server_hello` / `ping` / `ack` / `resync_required`（`error` 已声明但从不产出） | 连接管理，见 [控制帧](#控制帧) |
| 事件帧 | `event.*` 协议事件与裸 agent 事件 | 共享事件信封，见 [事件信封](#事件信封)、[event.\* 协议事件](#event-协议事件)、[agent 事件](#agent-事件) |
| transcript 帧 | `transcript.reset` / `transcript.ops` | 结构化转录流，见 [transcript 帧](#transcript-帧) |
| terminal 帧 | `terminal_output` / `terminal_exit` | 死协议，见 [terminal 帧](#terminal-帧) |

入站（客户端→服务端）控制帧按到达顺序串行处理；未知 `type` 被静默忽略。出站事件先进批量队列（16 毫秒或 64 条 flush，1 MB 高水位背压）；相邻同轮次的 `assistant.delta` / `thinking.delta` 帧在 flush 时会合并 `delta` 字符串——客户端不能把 delta 帧当不可变日志。

### 控制帧

客户端发送 JSON 帧 `{ "type", "id"?, "payload" }`；每个带 `id` 的入站帧都会收到一个 `ack` 应答。

#### server_hello（服务端→客户端）

连接建立后的首帧。

**payload**：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `ws_connection_id` | string | 连接 id（`conn_<ulid>`） |
| `protocol_version` | number | 恒 `2`。当前无任何一侧判定该版本号 |
| `heartbeat_ms` | number | 心跳间隔（默认 `10000`） |
| `max_event_buffer_size` | number | 每会话事件缓冲容量（默认 `1000`），断线回放的上限 |
| `capabilities` | object | 恒 `{ "event_batching": false, "compression": false }` |

**示例**：

```json
{ "type": "server_hello", "timestamp": "2026-09-02T08:00:00.000Z", "payload": { "ws_connection_id": "conn_01JZX4...", "protocol_version": 2, "heartbeat_ms": 10000, "max_event_buffer_size": 1000, "capabilities": { "event_batching": false, "compression": false } } }
```

#### ping / pong

- 服务端→客户端：`{ "type": "ping", "timestamp", "payload": { "nonce": number } }`，每 `heartbeat_ms` 一帧。
- 客户端→服务端：`{ "type": "pong", "payload": { "nonce": number } }`——服务端只重置心跳计时，不回 `ack`。连续两个周期没有任何入站帧，服务端以 `close(1001, 'heartbeat timeout')` 断连。

#### ack（服务端→客户端）

每个带 `id` 的入站控制帧一个应答：`{ "type": "ack", "id", "code", "msg", "payload" }`。`code: 0` 成功；`1` 参数或内部错误；`40112` 鉴权失败（`client_hello.payload.token` 校验失败，随后连接关闭）。

各入站帧及其 `ack` 的 payload：

| 入站帧 | payload（入） | ack payload（出） |
| --- | --- | --- |
| `client_hello` | `{ client_id, subscriptions?, cursors?, agent_filter?, token? }` | `{ accepted_subscriptions, resync_required, cursors }` |
| `subscribe` | `{ session_ids: string[], cursors?, watch_fs?, agent_filter? }` | `{ accepted, not_found, resync_required, cursors }` |
| `subscribe_v2` | `{ session_id, transcript, transcript_since? }`（见 [transcript 帧](#transcript-帧)） | 同 `subscribe` |
| `unsubscribe_v2` | `{ session_id, agent_ids? }` | `{ accepted: [session_id], not_found: [], resync_required: [] }`（无 `cursors` 键） |
| `unsubscribe` | `{ session_ids: string[] }` | `{ accepted: [], not_found: [], resync_required: [] }`（恒空数组） |
| `watch_fs_add` / `watch_fs_remove` | `{ session_id, paths: string[], runtime_id?, recursive? }` | `{ watched_paths, current_count }`；bridge 缺失或异常时 `code: 1` |

字段说明：

- `cursors`：`Record<session_id, { seq, epoch? }>`——断线恢复游标，见 [断线恢复](#断线恢复)。带游标订阅时服务端回放缺口事件；无法回放时先发 `resync_required`，并把该会话 id 列入 `ack` 的 `resync_required`。
- `watch_fs`：`Record<session_id, { paths: string[], recursive? }>`——随订阅一并登记的文件监听（等价于逐会话发 `watch_fs_add`），变更经 `event.fs.changed` 送达。
- `agent_filter`：`Record<session_id, string[]>`——只接收所列 Agent 的事件。
- `token`：`client_hello` 的冗余第二鉴权通道（升级请求已鉴权，缺省直接放行）。
- `client_id === 'kimi-inspect'` 的连接会被加入 DI 事件目标集（`event.di.*` 的门控，见 [event.\* 协议事件](#event-协议事件)）。

**示例**（`subscribe` 的 `ack`）：

```json
{ "type": "ack", "id": "1", "code": 0, "msg": "ok", "payload": { "accepted": [ "session_01JZX4..." ], "not_found": [], "resync_required": [], "cursors": { "session_01JZX4...": { "seq": 128, "epoch": "01JZX4..." } } } }
```

#### resync_required（服务端→客户端）

订阅游标无法回放时下发：事件缓冲溢出（`buffer_overflow`）、会话被重建（`session_recreated`）或 `epoch` 不符（`epoch_changed`）。处理方式见 [断线恢复](#断线恢复)。

**payload**：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `session_id` | string | 需要重新同步的会话 |
| `reason` | string | `buffer_overflow` / `session_recreated` / `epoch_changed` |
| `current_seq` | integer | 当前事件水位 |
| `epoch` | string | 可缺省：当前 epoch |

**示例**：

```json
{ "type": "resync_required", "timestamp": "2026-09-02T08:10:00.000Z", "payload": { "session_id": "session_01JZX4...", "reason": "buffer_overflow", "current_seq": 1420, "epoch": "01JZX4..." } }
```

#### error（控制帧，死声明）

控制帧形态的 `error`（`{ type: "error", timestamp, payload: { code, msg, fatal, request_id?, details? } }`）在 AsyncAPI 中声明，但服务端没有任何产出点。事件流中出现的 `type: "error"` 帧均为裸 agent `error` 事件（带 `session_id` / `seq` 事件信封，见 [agent 事件](#agent-事件)），客户端可按有无 `session_id` 分流。

### 事件信封

所有事件帧共享外层 `{ "type", "seq", "epoch"?, "volatile"?, "offset"?, "session_id", "timestamp", "payload" }`：`type` 与 `payload` 内事件的 `type` 重复一次；`session_id` 在全局事件上为 `__global__`；`timestamp` 为 ISO 8601（事件自带时间时取之）。`seq` / `epoch` / `volatile` / `offset` 的语义随产出器分四种形态：

| 形态 | `seq` | `epoch` | `volatile` | `offset` |
| --- | --- | --- | --- | --- |
| 持久（durable）事件 | 事件日志水位，严格递增并落盘 | 有 | 缺省 | 缺省 |
| 易失（volatile）事件 | 当前水位（不递增，与前后持久帧同 `seq`） | 有 | `true` | delta 类携带（该轮次内累计文本长度） |
| transcript 帧 | 外层为会话事件水位（非 transcript seq）；transcript seq 在 `payload.seq` | 有 | `true` | 缺省 |
| `event.fs.changed` | 文件监听作用域自增计数（与事件日志无关） | **无** | 缺省 | 缺省 |

易失类型全集：`assistant.delta` / `thinking.delta` / `tool.call.delta` / `tool.progress` / `shell.started` / `shell.output` / `shell.completed` / `agent.status.updated`，另有 `event.di.unit_changed` 与 `event.capability.changed`。易失事件不落盘、不回放；消费易失文本流时用 `offset` 与本地已累积文本比对：小于本地长度说明是重复帧，大于说明有缺漏、需走快照恢复。

投递范围分两类：**全局事件**广播给每个已建立连接（含未订阅该会话的）——`session.meta.updated`、`event.session.*`、`event.workspace.*`、`event.config.*`、`event.model_catalog.*`、`event.plugin.*`、`event.capability.*`、`event.di.*`（仅发往 `client_id: "kimi-inspect"` 的连接）；**会话事件**只发给订阅了该会话的连接，受 `agent_filter` 过滤——`event.question.*`、`event.approval.*` 与全部裸 agent 事件。`event.fs.changed` 单独一路：仅发往经 `watch_fs_add`（或 `subscribe` 的 `watch_fs`）登记了对应路径监听的连接。这些事件只覆盖本服务进程内的变更；其他进程（例如写同一 home 目录的 CLI）的变更要等索引 reconcile（约一分钟）才可见，因此概览客户端应保留低频兜底轮询。目前没有会话删除事件。

### event.* 协议事件

payload 内统一带 `agentId: "main"` 与 `sessionId`（全局事件为 `__global__` 或真实会话 id）。除标注外均为持久事件；各族的投递范围见 [事件信封](#事件信封)。

| type | payload 字段 | 备注 |
| --- | --- | --- |
| `event.session.created` | `session: T-Session` | 创建会话 / fork / 创建子会话时 |
| `event.session.archived` | `workspace_id`（另有 `agentId` 与 camelCase `sessionId`） | 在线与冷归档两条路径都会发出；概览免轮询 |
| `event.session.work_changed` | `busy, main_turn_active, pending_interaction, last_turn_reason?` | 会话工作聚合变化时 |
| `event.session.status_changed` | — | schema 已声明但**无产出点** |
| `event.workspace.created` | `workspace: T-Workspace` | 注册工作区时 |
| `event.workspace.updated` | `workspace: T-Workspace` | 重命名 / 重新注册 / 会话创建触碰工作区时 |
| `event.workspace.deleted` | `workspace_id, root` | 注销工作区时 |
| `event.config.changed` | `changedFields: string[]`（camelCase 域名）、`config: T-ConfigResponse` | 任何来源的配置变更；短时间窗内多次变更合并为一个事件 |
| `event.config.warning` | `warnings: { domain?, message }[]` | 配置告警 |
| `event.model_catalog.changed` | `changed, unchanged, failed`（同 [T-RefreshProviderModelsResponse](#t-refreshprovidermodelsresponse)） | 至少一个供应商的别名变化时 |
| `event.plugin.changed` | （无附加字段） | 插件安装 / 启用 / 停用 / 移除时 |
| `event.capability.changed` | `capability_id, install: { running, step?, percent?, error?, note? }` | 易失；能力安装进度 |
| `event.di.unit_changed` | `scope, token, state, error?` | 易失；仅发往 `client_id: "kimi-inspect"` 的连接；`state` 取值同 meta `features[].state`，枚举非封闭 |
| `event.question.requested` | [T-QuestionRequest](#t-questionrequest) 全字段 | 提问到达 |
| `event.question.answered` | `question_id, answers, resolved_at` | `answers` 为拍平的文本 map（`Record<条目 id, 文本>`），与 REST 的结构化 answers 形态不同 |
| `event.question.dismissed` | `question_id, dismissed_at` | |
| `event.approval.requested` | [T-ApprovalRequest](#t-approvalrequest) 全字段 | 审批到达 |
| `event.approval.resolved` | `approval_id, decision?, scope?, feedback?, selected_label?, resolved_at` | |
| `event.fs.changed` | `changes: { path, change, kind, size_delta?, etag? }[], coalesced_window_ms, truncated?, count?` | `change` 为 `created` / `modified` / `deleted`，`kind` 为 `file` / `directory` / `symlink`；`truncated: true` 时 `changes` 为空数组。信封特殊（见 [事件信封](#事件信封)） |

**示例**（`event.session.work_changed`）：

```json
{ "type": "event.session.work_changed", "seq": 129, "epoch": "01JZX4...", "session_id": "session_01JZX4...", "timestamp": "2026-09-02T08:06:00.000Z", "payload": { "type": "event.session.work_changed", "busy": true, "main_turn_active": true, "pending_interaction": "none", "agentId": "main", "sessionId": "session_01JZX4..." } }
```

### agent 事件

裸 agent 事件的 `payload` 为核心事件对象字段外加广播器补充的 `{ agentId, sessionId }`（camelCase）；除标注外均为持久事件。广播器的特判：

- `prompt.accepted` 被过滤，不广播。
- `turn.started` 的 `promptAttachments` 被显式剥离（schema 声明但 wire 上不出现）。
- `prompt.submitted` / `prompt.queued` / `prompt.steered` 的 `content` 从核心内容块投影为 [T-MessageContent](#t-messagecontent) 数组。
- `task.started` / `task.terminated` 各自额外派生一条 `background.task.started` / `background.task.terminated`（同 payload 改 type，随后发出）。
- `context.spliced` 触发一次 main agent 的 `agent.status.updated` 重发。

#### 轮次族

| type | payload 字段 | 备注 |
| --- | --- | --- |
| `turn.started` | `turnId, origin, prompt?, promptId?` | `origin` 为 [T-PromptOrigin](#t-promptorigin)；无 `promptAttachments` |
| `turn.ended` | `turnId, reason, error?, durationMs?, interruptReason?, time?` | `reason` 为 `completed` / `cancelled` / `failed` / `blocked`；`error` 为 [T-KimiError](#t-kimierror) |
| `turn.step.started` | `turnId, step, stepId?` | |
| `turn.step.completed` | `turnId, step, stepId?, usage?, finishReason?, providerFinishReason?, rawFinishReason?` 及时延组字段 | `usage` 为 [T-TokenUsage](#t-tokenusage) |
| `turn.step.retrying` | `turnId, step, stepId?, failedAttempt, nextAttempt, maxAttempts, delayMs, errorName, errorMessage, statusCode?` | |
| `turn.step.interrupted` | `turnId, step, stepId?, reason, message?` | |

#### 流式文本族（易失）

| type | payload 字段 | 备注 |
| --- | --- | --- |
| `assistant.delta` | `turnId, delta` | 带 `offset`；相邻同轮次帧可能被合并 |
| `thinking.delta` | `turnId, delta` | 同上 |

#### 工具调用族

| type | payload 字段 | 备注 |
| --- | --- | --- |
| `tool.call.delta` | `turnId, toolCallId, name?, argumentsPart?` | 易失 |
| `tool.call.started` | `turnId, toolCallId, name, args, description?, display?` | `display` 为 [T-ToolInputDisplay](#t-toolinputdisplay) |
| `tool.progress` | `turnId, toolCallId, update` | 易失；`update` 为 `{ kind: "stdout" \| "stderr" \| "progress" \| "status" \| "custom", text?, percent?, customKind?, customData?, replace? }` |
| `tool.result` | `turnId, toolCallId, output, isError?, synthetic?` | |
| `tool.list.updated` | `reason, serverName` | `reason` 为 `mcp.connected` / `mcp.disconnected` / `mcp.failed` |

#### Shell 族（易失）

| type | payload 字段 |
| --- | --- |
| `shell.started` | `commandId, taskId` |
| `shell.output` | `commandId, update, taskId?`（`update` 形态同 `tool.progress`） |
| `shell.completed` | `commandId, isError, taskId?` |

#### 任务族

| type | payload 字段 | 备注 |
| --- | --- | --- |
| `task.started` | `info` | `info` 为 T-TaskInfo（camelCase：`taskId, description, status, detached?, startedAt, endedAt?, stopReason?, timeoutMs?` 及 process / agent / question 三态各自扩展） |
| `task.terminated` | `info` | 同上 |
| `background.task.started` | 同 `task.started` | 派生帧 |
| `background.task.terminated` | 同 `task.terminated` | 派生帧 |
| `task.notified` | `notificationType, title, body, severity, sourceKind, sourceId` | `severity` 为 `info` / `warning` |

#### subagent 族

| type | payload 字段 |
| --- | --- |
| `subagent.spawned` | `subagentId, subagentName, parentToolCallId, parentToolCallUuid?, parentAgentId?, callerAgentId?, description?, swarmIndex?, runInBackground, model?, thinkingEffort?, taskId?` |
| `subagent.started` | `subagentId` |
| `subagent.suspended` | `subagentId, reason` |
| `subagent.completed` | `subagentId, resultSummary, usage?, contextTokens?` |
| `subagent.failed` | `subagentId, error` |

#### prompt 族

| type | payload 字段 | 备注 |
| --- | --- | --- |
| `prompt.submitted` | `promptId, userMessageId, status, content, createdAt` | `status` 为 `running` / `queued`；`content` 为投影后的 [T-MessageContent](#t-messagecontent) 数组 |
| `prompt.queued` | `promptId, content, queueLength` | |
| `prompt.started` | `promptId` | |
| `prompt.completed` | `promptId, finishedAt, reason` | `reason` 恒产出，为 `completed` / `failed` / `blocked` |
| `prompt.aborted` | `promptId, abortedAt` | |
| `prompt.steered` | `activePromptId, promptIds, content, steeredAt` | |
| `turn.steer` | `input, origin` | `input` 为核心内容块数组（**未投影**）；`origin` 为 [T-PromptOrigin](#t-promptorigin) |

#### compaction 族

| type | payload 字段 |
| --- | --- |
| `compaction.started` | `trigger?`（`manual` / `auto`）、`instruction?` |
| `compaction.blocked` | `turnId?` |
| `compaction.cancelled` | — |
| `compaction.completed` | `result: { summary, compactedCount, tokensBefore, tokensAfter, keptUserMessageCount?, keptHeadUserMessageCount?, droppedCount? }` |
| `context.spliced` | `start, deleteCount, messages, tokens?`（`messages` 为核心 ContextMessage 数组，**未投影**） |

#### 其他 agent 事件

| type | payload 字段 | 备注 |
| --- | --- | --- |
| `goal.updated` | `snapshot, change?` | `snapshot` 为 [T-GoalSnapshot](#t-goalsnapshot) 或 `null`；`change` 为 `{ kind: "lifecycle" \| "completion", status?, reason?, stats?, actor? }` |
| `plan.revision` | `id, version, path, sha256, bytes` | |
| `skill.activated` | `activationId, skillName, skillArgs?, trigger, skillPath?, skillSource?` | `trigger` 为 `user-slash` / `model-tool` / `nested-skill` |
| `plugin_command.activated` | `activationId, pluginId, commandName, commandArgs?, trigger` | `trigger` 恒 `user-slash` |
| `agent.status.updated` | `usage?, swarmMode?, towerMode?, planMode?, model?, thinkingEffort?, maxContextTokens?, contextTokens?` 合并 legacy 状态（`usage?, contextTokens, maxContextTokens?, model`），外加 `phase?` | 易失；`phase` 为 [T-AgentPhase](#t-agentphase)。schema 声明的 `permission` / `contextUsage` 无产出路径 |
| `agent.created` | （仅 `agentId` / `sessionId`） | |
| `agent.disposed` | （仅 `agentId` / `sessionId`） | |
| `session.meta.updated` | `title?, patch?` | 全局事件（广播给所有连接） |
| `error` | [T-KimiError](#t-kimierror) | 带事件信封；与控制帧 `error`（死声明）不同 |
| `warning` | `message, code?` | |
| `cron.fired` | `origin, prompt` | `origin` 为 T-CronJobOrigin |
| `hook.result` | `turnId?, hookEvent, content, blocked?` | |
| `mcp.server.status` | `server: { name, transport, status, toolCount, error? }` | `status` 直接透传核心六态：`pending` / `connected` / `failed` / `disabled` / `needs-auth` / `removed`——与 REST [T-McpServer](#t-mcpserver) 的四态取值域不同 |

**示例**（`tool.call.started`）：

```json
{ "type": "tool.call.started", "seq": 131, "epoch": "01JZX4...", "session_id": "session_01JZX4...", "timestamp": "2026-09-02T08:06:05.000Z", "payload": { "type": "tool.call.started", "turnId": 3, "toolCallId": "toolu_01J...", "name": "Bash", "args": { "command": "pnpm test" }, "display": { "kind": "command", "command": "pnpm test" }, "agentId": "main", "sessionId": "session_01JZX4..." } }
```

### transcript 帧

`subscribe_v2` 是唯一的转录订阅通道：其 `transcript` 按 Agent 指定粒度（`off` / `turn` / `block` / `delta`，键 `"*"` 表示默认粒度），粒度越高推送越细。粒度非 `off` 的 Agent 改由转录帧承载，该 Agent 的旧式事件在同一连接上被抑制（其他连接不受影响）。两种帧型：

| type | payload | 触发 |
| --- | --- | --- |
| `transcript.reset` | `{ type, agent_id, snapshot, has_more_older, seq? }` | 订阅、粒度升级或新 Agent 上名册时发送基线快照（`snapshot` 按订阅粒度裁剪，items 为空、仅全局状态与水位；历史经 REST 分页回读） |
| `transcript.ops` | `{ type, agent_id, ops, seq? }` | 转录存储产生 op 批次，或 `transcript_since` 游标回放 |

两帧的信封均为 `volatile: true`，外层 `seq` 为会话事件水位；每个 Agent 连续递增的 transcript seq 在 `payload.seq`。断线时用 `subscribe_v2` 的 `transcript_since`（`Record<agentId, seq>`）续传：服务端批次日志完整覆盖缺口时走 `transcript.ops` 回放，否则重发 `transcript.reset`；REST 侧对应 `GET .../transcript/ops?since_seq=`（补漏返回 `complete: false` 时需全量刷新）。粒度升降是否重发 reset 由转录契约的粒度规则决定。

**示例**（`transcript.ops`）：

```json
{ "type": "transcript.ops", "seq": 132, "epoch": "01JZX4...", "volatile": true, "session_id": "session_01JZX4...", "timestamp": "2026-09-02T08:06:06.000Z", "payload": { "type": "transcript.ops", "agent_id": "main", "ops": [ { "op": "append", "...": "..." } ], "seq": 43 } }
```

### terminal 帧

`terminal_attach` / `terminal_detach` / `terminal_input` / `terminal_resize` / `terminal_close` 及其 `ack`、以及服务端到客户端的 `terminal_output` / `terminal_exit` 在 AsyncAPI（`/asyncapi.json`）中完整声明，但**当前是死协议**：服务端不处理这些入站帧（按未知 `type` 静默丢弃），也没有任何 `terminal_output` / `terminal_exit` 的产出点。REST 的终端生命周期端点见 [终端](#终端) 域。

## 完整错误码

> TODO：逐个列出全部错误码（code / 含义 / 产出端点与形态）。范围：`0` / `40001`–`40005` / `40110`–`40113` / `40401`–`40420` / `40901`–`40929`（无 `40928`）/ `41001`–`41003` / `41301`–`41305` / `42902` / `50001`–`50004` / `60001`–`60002`；另有中间件码 `40101`（鉴权失败）与 `42901`（鉴权限流封禁）。

## 类型汇总

端点与帧型共享的类型字典，按传输面分为 REST 与 WS 两类，每条目以一个 TypeScript 定义块给出。「可缺省」（`field?: T`）表示该键可能不出现（`undefined` 被序列化丢弃），「可空」（`field: T | null`）表示显式 `null`，两者语义不同（见 [null 与缺省语义](#null-与缺省语义)）；简短语义以 `//` 行尾注释标注。

### REST 类型

REST 端点的请求与响应类型，按域分组。

**会话。**

### T-Session

会话对象。

```ts
type Session = {
  id: string; // `session_...`
  workspace_id: string; // 所属工作区 id（`wd_<slug>_<hash12>`）
  title: string; // 未设置时为 ""
  created_at: string; // ISO 8601
  updated_at: string; // ISO 8601
  archived_at?: string; // ISO 8601；未归档时不出现
  busy: boolean; // 任一 Agent 有活动轮次或后台任务
  main_turn_active: boolean; // main agent 轮次进行中
  pending_interaction: 'none' | 'approval' | 'question';
  last_turn_reason?: 'completed' | 'cancelled' | 'failed';
  archived: boolean;
  last_prompt?: string; // 最近一条提示词文本
  metadata: {
    cwd: string;
    [key: string]: unknown; // 附加自定义任意键（goal 键被剔除）
  };
  agent_config: {
    model: string; // 存活会话取绑定模型，否则 ""
  };
  usage: SessionUsage;
  permission_rules: unknown[]; // 恒 []
  message_count: number; // 恒 0
  last_seq: number; // 事件水位或 0
};
```

- 返回会话的各端点（除快照）中 `usage` 恒为全 0 的 [T-SessionUsage](#t-sessionusage)、`permission_rules` 恒 `[]`、`message_count` 恒 `0`；`last_seq` 仅 `GET /api/v1/sessions/{session_id}` 携带真实事件水位，其余端点恒 `0`。
- `last_turn_reason`：存活会话取实时值，冷会话取最后持久化值，均无则缺省。
- `agent_config` 恒只有 `model` 一键，schema 声明的其余配置键产出侧均不出现；schema 另声明的 `current_prompt_id` 产出侧从不出现（仅快照的 `in_flight_turn` 有同名字段）。

### T-SessionUsage

```ts
type SessionUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  total_cost_usd: number;
  context_tokens: number;
  context_limit: number;
  turn_count: number;
};
```

普通会话端点恒全 0；快照端点用法不同，见 [T-SnapshotUsage](#t-snapshotusage)。

### T-SessionStatus

main agent 的实时状态汇总。

```ts
type SessionStatus = {
  busy: boolean; // 同 Session.busy
  model?: string; // 模型别名；未绑定时不出现
  thinking_level: string; // 模型未绑定时为 ""
  permission: 'manual' | 'yolo' | 'auto';
  plan_mode: boolean; // Plan 模式
  swarm_mode: boolean;
  tower_mode: boolean;
  context_tokens: number; // 当前上下文 tokens
  max_context_tokens?: number; // 上下文上限；不可解析时不出现
  context_usage?: number; // 上下文占比（0–1）；无上限时不出现
};
```

### T-GoalSnapshot

目标快照（camelCase 载荷），与 `goal.updated` 事件的载荷共享。

```ts
type GoalSnapshot = {
  goalId: string;
  objective: string;
  completionCriterion?: string;
  status: 'active' | 'paused' | 'blocked' | 'complete';
  turnsUsed: number;
  tokensUsed: number;
  wallClockMs: number;
  terminalReason?: string;
  budget: {
    tokenBudget: number | null;
    turnBudget: number | null;
    wallClockBudgetMs: number | null;
    remainingTokens: number | null;
    remainingTurns: number | null;
    remainingWallClockMs: number | null;
    tokenBudgetReached: boolean;
    turnBudgetReached: boolean;
    wallClockBudgetReached: boolean;
    overBudget: boolean;
  };
};
```

### T-InFlightTurn

进行中轮次的实时投影，仅由快照的 `in_flight_turn` 产出。

```ts
type InFlightTurn = {
  turn_id: number;
  assistant_text: string;
  thinking_text: string;
  running_tools: {
    tool_call_id: string;
    name: string;
    args?: unknown;
    description?: string;
    display?: unknown;
    last_progress?: {
      kind: 'stdout' | 'stderr' | 'progress' | 'status' | 'custom';
      text?: string;
      percent?: number;
    };
  }[];
  current_prompt_id?: string;
};
```

**消息与提示词。**

### T-Message

消息对象。

```ts
type Message = {
  id: string; // `msg_<sessionId>_<6 位序号>` 或核心 id
  session_id: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: MessageContent[];
  created_at: string; // ISO 8601，单调递增
  metadata?: Record<string, unknown>; // 仅当消息带 origin 时：{ origin: PromptOrigin }（camelCase 嵌套，原样透传）
};
```

schema 声明的 `prompt_id` / `parent_message_id` 产出侧从不出现。

### T-MessageContent

消息内容块，按 `type` 区分。

```ts
type MessageContent =
  | { type: 'text'; text: string } // audio_url 降级为 [audio:<url>] 文本
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'tool_use'; tool_call_id: string; tool_name: string; input: unknown } // input 为解析后的参数（解析失败回原字符串）
  | { type: 'tool_result'; tool_call_id: string; output: unknown; is_error?: boolean } // is_error 仅 true 时出现
  | { type: 'image' | 'video'; source: ImageSource }
  | { type: 'file'; file_id?: string; path?: string; name?: string; media_type?: string; size?: number }; // 仅出现在输入（提示词 / 技能提交）；REST 投影不产出

type ImageSource =
  | { kind: 'url'; url: string; id?: string } // 外部 URL
  | { kind: 'base64'; media_type: string; data: string } // 仅提示词提交回显
  | { kind: 'session_media'; file_id: string }; // 会话媒体引用
```

- `tool_result` 的 `output`：有媒体块时为原始内容块数组，否则为拼接文本。
- `image` / `video` 的 `source` 产出侧仅上述三种；schema 声明的 `{ kind: 'file', file_id }` 与 `{ kind: 'path', path }` 为输入专用变体，产出侧不出现。

### T-PromptItem

提示词队列项 / 提交结果。

```ts
type PromptItem = {
  prompt_id: string;
  user_message_id: string; // Skill 捆绑提交时与 prompt_id 相同
  status: 'running' | 'queued' | 'blocked';
  content: MessageContent[]; // 投影后的用户输入（剥离 Skill 捆绑块）
  created_at: string; // ISO 8601
};
```

### T-PromptOrigin

提示词来源（camelCase 嵌套对象，原样透传）。

```ts
type PromptOrigin = {
  kind:
    | 'user'
    | 'skill_activation'
    | 'plugin_command'
    | 'injection'
    | 'shell_command'
    | 'compaction_summary'
    | 'system_trigger'
    | 'task'
    | 'background_task'
    | 'cron_job'
    | 'cron_missed'
    | 'hook_result'
    | 'retry';
  [key: string]: unknown; // 各态附带相应上下文字段
};
```

**交互。**

### T-ApprovalRequest

审批请求。

```ts
type ApprovalRequest = {
  approval_id: string;
  session_id: string;
  turn_id?: number;
  tool_call_id: string; // 缺省时回退为交互 id
  tool_name: string;
  action: string;
  tool_input_display: ToolInputDisplay;
  created_at: string; // ISO 8601
  expires_at: string; // ISO 8601，created_at 之后 24 小时
};
```

### T-ToolInputDisplay

工具输入展示，按 `kind` 区分。

```ts
type ToolInputDisplay =
  | { kind: 'command'; command: string; cwd?: string; description?: string; language?: 'bash' }
  | {
      kind: 'file_io';
      operation: 'read' | 'write' | 'edit' | 'glob' | 'grep';
      path: string;
      detail?: string;
      content?: string;
      before?: string;
      after?: string;
    }
  | { kind: 'diff'; path: string; before: string; after: string; hunks?: unknown }
  | { kind: 'search'; query: string; scope?: string }
  | { kind: 'url_fetch'; url: string; method?: string }
  | { kind: 'agent_call'; agent_name: string; prompt: string; background?: boolean }
  | { kind: 'skill_call'; skill_name: string; args?: string }
  | { kind: 'todo_list'; items: { title: string; status: string }[] }
  | { kind: 'task'; task_id: string; status: string; description: string; task_kind?: string }
  | { kind: 'task_stop'; task_id: string; task_description: string }
  | { kind: 'plan_review'; plan: string; path?: string; options?: { label: string; description: string }[] }
  | { kind: 'goal_start'; objective: string; completionCriterion?: string; mode: 'manual' | 'yolo' }
  | { kind: 'generic'; summary: string; detail?: string };
```

### T-QuestionRequest

提问请求。

```ts
type QuestionRequest = {
  question_id: string; // 交互 id
  session_id: string;
  turn_id?: number;
  tool_call_id?: string;
  questions: QuestionItem[]; // 1–4 个
  created_at: string; // ISO 8601
};

type QuestionItem = {
  id: string; // `q_<i>`，投影合成
  question: string;
  header?: string;
  body?: string;
  options: QuestionOption[]; // 2–4 个
  multi_select?: boolean;
  allow_other: true; // 恒产出
  other_label?: string;
  other_description?: string;
};

type QuestionOption = {
  id: string; // `opt_<i>_<j>`，投影合成
  label: string;
  description?: string;
};
```

**任务与终端。**

### T-Task

后台任务。

```ts
type Task = {
  id: string;
  session_id: string;
  kind: 'subagent' | 'bash' | 'tool'; // 核心映射：process→bash、agent→subagent、question→tool
  description: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled'; // 核心映射：timed_out→failed、killed→cancelled、lost→failed
  created_at: string; // ISO 8601，取 startedAt
  started_at: string; // 与 created_at 相同
  completed_at?: string; // ISO 8601
  command?: string; // 仅 bash 任务
  model?: string; // 仅 subagent 任务且有值
  thinking_effort?: string; // 同上
  agent_id?: string; // 同上
  subagent_type?: string; // 同上
  parent_tool_call_id?: string; // subagent / bash 任务且有值
  output_preview?: string; // 仅 with_output 读取且输出非空
  output_bytes?: number; // 同上
  run_in_background: boolean; // detached ?? true
};
```

REST 的 T-Task 不含 `subagent_phase` / `suspended_reason` / `swarm_index`——那些字段只在快照的 subagent 条目上（见 [T-SnapshotSubagent](#t-snapshotsubagent)）。

### T-Terminal

```ts
type Terminal = {
  id: string;
  session_id: string;
  cwd: string;
  shell: string;
  cols: number;
  rows: number;
  status: 'running' | 'exited';
  created_at: string; // ISO 8601
  exited_at?: string; // ISO 8601
  exit_code?: number | null; // 例如因信号终止时为 null
};
```

**快照。**

### T-SnapshotResponse

会话快照。

```ts
type SnapshotResponse = {
  as_of_seq: number; // 事件日志水位
  epoch: string; // 事件 epoch（冷会话可为 ""）
  session: Session; // agent_config.model 取实时绑定，usage 为 SnapshotUsage
  messages: { items: Message[]; has_more: boolean }; // 尾部最多 100 条
  in_flight_turn: InFlightTurn | null; // 无进行中轮次时为 null
  subagents: SnapshotSubagent[]; // 无存活时 []
  pending_approvals: ApprovalRequest[];
  pending_questions: QuestionRequest[];
};
```

### T-SnapshotUsage

```ts
type SnapshotUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  context_tokens: number;
  context_limit?: number;
};
```

与 [T-SessionUsage](#t-sessionusage) 不同：**无** `total_cost_usd` / `turn_count`，且 `context_limit` 可缺省。

### T-SnapshotSubagent

快照中的 subagent 条目。

```ts
type SnapshotSubagent = {
  id: string; // subagentId
  session_id: string;
  kind: 'subagent';
  description: string;
  status: Task['status'];
  subagent_phase?: 'queued' | 'working' | 'suspended' | 'completed' | 'failed';
  subagent_type?: string;
  parent_tool_call_id?: string;
  swarm_index?: number;
  run_in_background: boolean;
  model?: string;
  thinking_effort?: string;
  created_at: string; // ISO 8601
  started_at?: string; // ISO 8601
  completed_at?: string; // ISO 8601
  output_preview?: string;
  suspended_reason?: string;
};
```

**工作区。**

### T-Workspace

```ts
type Workspace = {
  id: string;
  root: string;
  name: string;
  created_at: string; // ISO 8601
  last_opened_at: string; // ISO 8601
  session_count: number;
};
```

注册与重命名会广播全局事件 `event.workspace.created` / `event.workspace.updated`。

**文件与搜索。**

### T-FsEntry

文件条目。

```ts
type FsGitStatus =
  | 'clean'
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'untracked'
  | 'ignored'
  | 'conflicted';

type FsEntry = {
  path: string;
  name: string;
  kind: 'file' | 'directory' | 'symlink';
  size?: number;
  modified_at: string; // ISO 8601
  etag?: string;
  mime?: string;
  language_id?: string;
  is_binary?: boolean;
  is_symlink_to?: string;
  git_status?: FsGitStatus; // 仅 include_git_status: true 时存在
  child_count?: number;
};
```

### T-FsListResponse

```ts
type FsListResponse = {
  items: FsEntry[];
  children_by_path?: Record<string, FsEntry[]>; // depth 大于 1 时另附
  truncated: boolean; // limit 截断了列表
};
```

### T-FsReadResponse

```ts
type FsReadResponse = {
  path: string;
  content: string;
  encoding: 'utf-8' | 'base64'; // 实际使用的编码
  size: number; // 文件完整大小
  truncated: boolean;
  etag: string;
  mime: string;
  language_id?: string;
  line_count?: number;
  is_binary: boolean;
};
```

### T-FsListManyResponse

```ts
type FsListManyResponse = {
  results: Record<string, FsEntry[]>; // 每个请求路径到其条目数组
  truncated_paths?: string[]; // 达到 limit 的路径
  partial_errors?: Record<string, { code: number; msg: string }>; // 失败路径到其错误
};
```

### T-FsStatManyResponse

```ts
type FsStatManyResponse = {
  entries: Record<string, FsEntry | null>; // 每个请求路径到其条目（不存在时为 null）
};
```

### T-FsSearchHit

```ts
type FsSearchHit = {
  path: string;
  name: string;
  kind: FsEntry['kind'];
  score: number; // 0–1 的模糊匹配得分
  match_positions: number[]; // 匹配到的字符偏移
};
```

响应形态为 `{ items: FsSearchHit[], truncated: boolean }`。

### T-FsSuggestItem

结构同 [T-FsSearchHit](#t-fssearchhit)，响应形态相同。

```ts
type FsSuggestItem = FsSearchHit;
```

### T-FsGrepResponse

```ts
type FsGrepResponse = {
  files: {
    path: string;
    matches: {
      line: number;
      col: number;
      text: string;
      before: string[]; // 最多携带 context_lines 行上下文
      after: string[]; // 同上
    }[];
  }[];
  files_scanned: number;
  truncated: boolean; // 某个匹配配额截断了结果
  elapsed_ms: number;
};
```

### T-FsGitStatusResponse

```ts
type FsGitStatusResponse = {
  branch: string;
  ahead: number;
  behind: number;
  entries: Record<string, FsGitStatus>; // 每个变更路径到其 git_status
  additions: number;
  deletions: number;
  pullRequest: { number: number; state: 'open' | 'merged' | 'closed' | 'draft'; url: string } | null; // camelCase 岛屿
};
```

### T-FsDiffResponse

```ts
type FsDiffResponse = {
  path: string;
  diff: string; // unified diff 文本
  truncated: boolean; // 过长的 diff 被截断
};
```

### T-FsBrowseResponse

```ts
type FsBrowseResponse = {
  path: string; // 解析后的目录
  parent: string | null; // 父目录（文件系统根处为 null）
  entries: { name: string; path: string; is_dir: true }[];
};
```

### T-FsHomeResponse

```ts
type FsHomeResponse = {
  home: string; // 用户主目录
  recent_roots: string[]; // 已注册工作区的根目录（上限 8）
};
```

### T-FileMeta

```ts
type FileMeta = {
  id: string; // `f_...`
  name: string;
  media_type: string; // 取自上传的内容类型
  size: number;
  created_at: string; // ISO 8601
  expires_at?: string; // ISO 8601
};
```

### T-SearchResponse

```ts
type SearchResponse = {
  items: {
    session_id: string;
    workspace_id: string;
    session_title: string;
    agent_id: string;
    role: 'user' | 'assistant' | 'title';
    snippet: string;
    time: number; // epoch 毫秒
    turn?: number;
    step_id?: string;
    score: number;
  }[];
  has_more: boolean;
  page_token?: string;
  incomplete?: 'candidate_cap' | 'postings_budget' | 'deadline'; // 超出预算的页携带
  index_state: {
    state: 'building' | 'ready' | 'readonly';
    indexed_sessions: number;
    total_sessions: number;
    documents: number;
    stale?: boolean; // 仍在追赶的落后视图
    degraded?: string; // 最近一次刷新失败的信息
  };
  source: 'live' | 'index'; // 本页结果由内存转录还是持久索引提供
};
```

**配置与模型。**

### T-ConfigResponse

配置全域对象（camelCase 域名转 snake_case）加合成键。

```ts
type ConfigResponse = {
  providers: Record<
    string,
    {
      type: string;
      base_url?: string;
      default_model?: string;
      has_api_key: boolean; // 密钥被剥离为 has_api_key
    }
  >; // 必有，空为 {}
  models?: Record<string, unknown>; // 模型别名 → 模型记录（剥离 apiKey / oauth，加 has_api_key，其余键原样）
  services?: unknown; // 内置外部服务配置（同 models，另把 customHeaders 换成 custom_header_keys: string[]）
  yolo?: boolean; // 由 default_permission_mode === "yolo" 合成
  default_provider?: string; // 全局默认供应商 id
  default_model?: string; // 全局默认模型别名
  [key: string]: unknown; // 未列出的域原样透传
};
```

未列出域（`thinking` / `plan_mode` / `default_permission_mode` / `default_plan_mode` / `permission` / `hooks` / `merge_all_available_skills` / `extra_skill_dirs` / `loop_control` / `background` / `subagent` / `secondary_model` / `experimental` / `telemetry` / `raw` 等）原样透传，可缺省。

### T-ModelCatalogItem

```ts
type ModelCatalogItem = {
  provider: string; // 所属供应商 id
  model: string; // 别名 id
  display_name?: string;
  max_context_size: number; // 以 token 计的上下文窗口
  capabilities?: string[];
  support_efforts?: string[];
  default_effort?: string;
};
```

### T-ProviderCatalogItem

```ts
type ProviderCatalogItem = {
  id: string;
  type: string; // 通信协议：kimi / openai / openai_responses / anthropic / google-genai / vertexai
  base_url?: string;
  default_model?: string;
  has_api_key: boolean;
  status: 'connected' | 'error' | 'unconfigured';
  models?: string[]; // 该供应商的模型别名 id
};
```

### T-CatalogProviderItem

models.dev 目录条目。

```ts
type CatalogProviderItem = {
  id: string;
  name: string;
  wire_type: 'kimi' | 'openai' | 'openai_responses' | 'anthropic' | 'google-genai' | 'vertexai' | null; // 解析出的协议
  guessed: boolean; // 启发式解析标记
  needs_base_url: boolean;
  rejected: boolean;
  reject_reason: string | null;
  env_key: string | null; // 上游约定的 API 密钥环境变量
  models: {
    id: string;
    name?: string;
    max_context_size: number;
    capabilities?: string[];
    reasoning: boolean;
  }[];
};
```

### T-RefreshProviderModelsResponse

```ts
type RefreshProviderModelsResponse = {
  changed: { provider_id: string; provider_name: string; added: number; removed: number }[]; // 新增 / 移除的别名数
  unchanged: string[]; // 无差异的供应商 id
  failed: { provider: string; reason: string }[];
};
```

**账号。**

### T-AuthSummary

```ts
type AuthSummary = {
  models_ready: boolean;
  providers_count: number;
  managed_provider: {
    name: string;
    status: 'authenticated' | 'expired' | 'revoked' | 'unauthenticated';
  } | null;
};
```

全局默认模型别名改从 `GET /api/v1/config` 的 `default_model` 读取，本对象不携带。

### T-OAuthFlowStart

OAuth 流程发起结果，按 `status` 区分。

```ts
type OAuthFlowStart =
  | {
      flow_id: string;
      provider: string;
      status: 'pending';
      verification_uri: string;
      verification_uri_complete: string;
      user_code: string;
      expires_in: number; // 秒；与 expires_at 是同一时限的两种表示
      interval: number;
      expires_at: string; // ISO 8601
    }
  | { flow_id: string; provider: string; status: 'authenticated' };
```

### T-OAuthFlowSnapshot

```ts
type OAuthFlowSnapshot = {
  flow_id: string;
  provider: string;
  status: 'pending' | 'authenticated' | 'denied' | 'expired' | 'cancelled';
  verification_uri: string;
  verification_uri_complete: string;
  user_code: string;
  expires_in: number;
  expires_at: string; // ISO 8601
  interval: number;
  resolved_at?: string; // ISO 8601；离开 pending 后记录到达终态的时间
  error_message?: string; // 描述失败的流程
};
```

### T-ManagedUsageResult

托管用量结果，按 `kind` 区分。

```ts
type ManagedUsageResult =
  | {
      kind: 'ok';
      summary: UsageRow | null; // 主配额行
      limits: UsageRow[]; // 每个配额窗口一行
      extra_usage: {
        balance_cents: number;
        total_cents: number;
        monthly_charge_limit_enabled: boolean;
        monthly_charge_limit_cents: number;
        monthly_used_cents: number;
        currency: string;
      } | null; // 按量付费钱包（金额均 integer 分）
    }
  | { kind: 'error'; message: string; status?: number }; // status 为上游 HTTP 状态码（如存在）

type UsageRow = {
  name?: string;
  window?: { duration: number; unit: 'minute' | 'hour' | 'day' | 'week' };
  used: number;
  limit: number;
  reset_at?: string;
};
```

### T-ManagedUserInfoResult

托管账号资料（camelCase 载荷），按 `kind` 区分。

```ts
type ManagedUserInfoResult =
  | {
      kind: 'ok';
      userInfo: {
        userId: string;
        nickname: string;
        status: string;
        region: string;
        userLevel: number;
        userLevelName: string;
        domain: number;
        domainName: string;
        globalId?: string;
        bio?: string;
        avatar?: string;
        username?: string;
        email?: string;
        phone?: { countryCode: string; number: string };
        createdTime?: string;
        lastLoginTime?: string;
      };
    }
  | { kind: 'error'; message: string; status?: number };
```

**扩展。**

### T-SkillDescriptor

```ts
type SkillDescriptor = {
  name: string;
  description: string;
  path: string;
  source: 'project' | 'user' | 'extra' | 'builtin';
  type?: string; // 技能类别（只有用户可激活的类型才能被激活）
  disable_model_invocation?: boolean; // 让技能对模型不可见
};
```

### T-CapabilityStatus

能力状态（camelCase 载荷）。

```ts
type CapabilityStatus = {
  id: 'kimi-cu' | 'kimi-webbridge';
  pluginId?: string;
  displayName: string;
  description: string;
  supported: boolean;
  state: 'ready' | 'partial' | 'not_installed' | 'unsupported'; // ready = 所有必需检测步骤均为 ok
  version?: string;
  steps: { id: string; state: 'ok' | 'missing' | 'failed'; detail?: string; optional?: boolean }[];
  install: {
    running: boolean;
    step?: string;
    percent?: number; // 0–100
    error?: string;
    note?: string;
  };
};
```

### T-PluginSummary

插件摘要（camelCase 载荷）。

```ts
type PluginSummary = {
  id: string;
  displayName: string;
  version?: string;
  enabled: boolean;
  state: 'ok' | 'error'; // 加载失败也会置 hasErrors
  skillCount: number;
  mcpServerCount: number;
  enabledMcpServerCount: number;
  hookCount: number;
  commandCount: number;
  hasErrors: boolean;
  source: 'local-path' | 'zip-url' | 'github';
  originalSource?: string;
  github?: {
    owner: string;
    repo: string;
    ref: { kind: 'branch' | 'tag' | 'sha'; value: string };
    installedSha?: string;
  };
};
```

### T-PluginMarketplaceEntry

插件市场条目（camelCase 载荷），服务端正名为 `PluginMarketplaceEntryWire`。

```ts
type PluginMarketplaceEntry = {
  id: string;
  tier: 'official' | 'curated' | 'third-party';
  displayName: string;
  description?: string;
  homepage?: string;
  keywords?: string[];
  version?: string;
  source: string; // 同 POST /api/v1/plugins 的 source 取值
  installed?: { version?: string; enabled: boolean }; // 实时安装状态；未安装时缺省
  updateAvailable?: boolean;
  capabilityId?: string; // 内置能力合并进来的条目携带
};
```

### T-ToolDescriptor

```ts
type ToolDescriptor = {
  name: string;
  description: string;
  input_schema: null; // 恒 null
  source: 'builtin' | 'skill' | 'mcp';
  active: boolean; // 工具策略的判定结果
  mcp_server_id?: string; // 仅 MCP 工具携带（从 mcp__<server>__<tool> 名称解析）
};
```

### T-McpServer

```ts
type McpServer = {
  id: string; // server 名称
  name: string; // 同 id
  transport: 'stdio' | 'http' | 'sse';
  status: 'connected' | 'connecting' | 'disconnected' | 'error';
  tool_count: number;
  last_error?: string;
};
```

`status` 由核心六态压为四态：pending→`connecting`、disabled/removed→`disconnected`、failed/needs-auth→`error`。

**v2。**

### T-V2Session

v2 会话对象。

```ts
type V2Session = {
  id: string;
  workspace: { id: string; cwd: string | null };
  meta: {
    title: string | null;
    last_prompt: string | null;
    created_at: number; // epoch 毫秒
    updated_at: number; // epoch 毫秒
    archived: boolean;
    archived_at: number | null; // 恒产出
  };
  activity: {
    status: 'running' | 'approval' | 'question' | 'failed' | 'idle'; // 冷会话恒 idle
    model: string | null; // 存活会话的绑定模型别名，冷会话为 null
  };
  git?: {
    // 仅 include=git 时产出；不可用时为 { branch: null, pull_request: null }
    branch: string | null;
    pull_request: { number: number; state: 'open' | 'closed' | 'merged'; url: string } | null;
  };
};
```

### T-V2SessionPage

```ts
type V2SessionPage = {
  items: V2Session[]; // fields=id,archived 投影时裁剪为 { id, archived }
  total: number;
  has_more: boolean;
  next_page_token: string | null;
};
```

### T-V2SessionGroupPage

```ts
type V2SessionGroupPage = {
  groups: {
    workspace: { id: string; cwd: string | null };
    sessions: V2Session[];
    total: number; // 该工作区匹配过滤条件的会话总数
  }[];
  total: number; // 组数
  has_more: boolean;
  next_page_token: string | null;
};
```

### T-V2BatchSessionResponse

```ts
type V2BatchSessionResponse = {
  results: { id: string; ok: boolean; error?: { code: number; message: string } }[]; // 保持输入顺序
  succeeded: number;
  failed: number;
};
```

### T-McpManagedServer

受管 MCP server（camelCase 载荷）。

```ts
type McpManagedServer = {
  name: string;
  config: McpServerConfigView | string[]; // 可变条目携带完整配置；只读条目被脱敏为排序后的键名列表
  source: 'global' | 'plugin' | 'caller'; // global = 配置文件层，plugin = 插件清单
  origin: string; // 条目的定义位置——文件路径或插件 id
  mutable: boolean; // 只有用户级条目可变；插件与项目层条目均为只读
  plugin?: { id: string; name: string }; // 仅插件条目携带
};
```

### T-McpServerConfigView

MCP server 配置的脱敏视图，按 `transport` 区分。

```ts
type McpServerConfigView =
  | {
      transport: 'stdio';
      command: string;
      args?: string[];
      cwd?: string;
      executor?: string;
      runtime_id?: string;
      envKeys?: string[]; // 替代 env（排序的键名），绝不泄露密钥值
      enabled?: boolean;
      startupTimeoutMs?: number;
      toolTimeoutMs?: number;
      enabledTools?: string[];
      disabledTools?: string[];
    }
  | {
      transport: 'http' | 'sse';
      url: string;
      auth?: 'oauth';
      bearerTokenEnvVar?: string;
      headerKeys?: string[]; // 替代 headers
      enabled?: boolean;
      startupTimeoutMs?: number;
      toolTimeoutMs?: number;
      enabledTools?: string[];
      disabledTools?: string[];
    };
```

### T-McpServerInspection

```ts
type McpServerInspection = {
  serverId: string; // `global:<name>` 或 `plugin:<pluginId>:<serverName>`（URL 编码）
  locator: { source: 'global'; name: string } | { source: 'plugin'; pluginId: string; serverName: string };
  runtimeName: string;
  canonicalUrl?: string;
  origin: 'global' | 'plugin' | 'caller';
  config: McpServerConfigView;
  enabled: boolean;
  editable: boolean;
  authStatus: McpServerAuthStatus['authStatus'];
  checkedAt?: number; // epoch 毫秒
  error?: string;
};
```

### T-McpServerAuthStatus

```ts
type McpServerAuthStatus = {
  name: string;
  authStatus:
    | 'not-applicable'
    | 'bearer-token'
    | 'oauth-required'
    | 'oauth-authorized'
    | 'oauth-expired'
    | 'unavailable';
};
```

**服务。**

### T-MetaResponse

`GET /meta` 的响应，服务端正名为 `MetaResponse`。

```ts
type MetaResponse = {
  server_version: string;
  capabilities: MetaCapabilities;
  server_id: string; // 本次启动生成的 ULID
  started_at: string; // ISO 8601
  open_in_apps: string[]; // 恒 []
  dangerous_bypass_auth: boolean;
  experimental_flags: Record<string, boolean>; // 按请求实时解析
  backend: 'v2';
  web_title?: string; // --web-title，未设置时缺省
  features: MetaFeature[]; // 按请求实时解析
};

type MetaCapabilities = {
  websocket: true;
  file_upload: true;
  fs_query: true;
  mcp: true;
  tasks: true;
  terminal: true;
};

type MetaFeature = {
  name: string;
  state: 'Pending' | 'Activating' | 'Active' | 'Unloading' | 'Failed';
  meta: Record<string, unknown>;
};
```

服务端 schema 中 `experimental_flags` / `backend` / `features` 为可选，但产出恒带这三个字段。

### T-Connection

活跃 WS 连接，由 REST `GET /connections` 返回。

```ts
type Connection = {
  id: string; // `conn_<ulid>`
  connected_at: string; // ISO 8601
  remote_address: string | null;
  user_agent: string | null;
  has_client_hello: boolean;
  subscriptions: string[]; // 排序的会话 id
};
```

### WS 类型

WS 帧携带的载荷类型：协议事件的内嵌对象与转录契约。

**事件载荷。**

### T-AgentPhase

agent 阶段（`agent.status.updated` 的 `phase` 字段）。

```ts
type AgentPhase = {
  kind:
    | 'idle'
    | 'running'
    | 'streaming'
    | 'tool_call'
    | 'retrying'
    | 'awaiting_approval'
    | 'interrupted'
    | 'ended';
  [key: string]: unknown; // 各态附带相应上下文字段（如 turnId、step）
};
```

### T-TokenUsage

token 用量（camelCase 载荷）。

```ts
type TokenUsage = {
  inputOther: number;
  output: number;
  inputCacheRead: number;
  inputCacheCreation: number;
};
```

### T-KimiError

核心错误对象。

```ts
type KimiError = {
  code: string; // 核心错误码字符串
  message: string;
  name?: string;
  details?: unknown;
  retryable: boolean;
  cause?: unknown; // 递归同构
};
```

**转录。**

### T-Transcript 族

转录载荷的类型正本是共享包 `@moonshot-ai/transcript` 的契约（客户端经同一依赖消费），`TranscriptItem` / `TranscriptOperation` 等嵌套类型均定义于该包。

#### T-TranscriptResponse

```ts
type TranscriptResponse = {
  agent_id: string;
  items: TranscriptItem[]; // turn / marker / taskref 三态；turn 含 steps[].frames[]，frame 分 text / thinking / tool / notice 四种
  has_more: boolean;
  tasks: TranscriptTask[];
  interactions: Interaction[];
  attachments: Attachment[];
  todos: Todo[];
  prompts: TranscriptPrompt[];
  meta: TranscriptMeta;
  agents: AgentDescriptor[];
  pending_interactions: string[];
  seq?: number;
};
```

#### T-TranscriptOpsCatchupResponse

```ts
type TranscriptOpsCatchupResponse = {
  agent_id: string;
  batches: { seq: number; ops: TranscriptOperation[] }[];
  latest_seq: number;
  complete: boolean;
};
```

`TranscriptOperation` 全集（判别字段为 `op`）：reset / turn.upsert / step.upsert / frame.upsert / append / marker.upsert / taskref.upsert / task.upsert / interaction.upsert / attachment.upsert / todo.upsert / prompt.upsert / meta.merge / items.remove。

#### T-TranscriptUserMessagesResponse

```ts
type TranscriptUserMessagesResponse = {
  agents: {
    agent_id: string;
    messages: {
      turn_id: string;
      ordinal: number;
      state: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'; // 轮次状态
      origin: TurnOrigin;
      prompt: string;
      attachment_ids?: string[];
      started_at?: string;
    }[];
    attachments: Attachment[];
  }[];
};
```

#### T-TranscriptPlanResponse

```ts
type TranscriptPlanResponse = {
  agent_id: string;
  plans: {
    tool_call_id: string;
    turn_id: string;
    source: 'interaction' | 'display' | 'output';
    plan: string;
    path?: string;
    options?: { label: string; description?: string }[];
    review?: {
      // 仅交互式审阅时存在
      state: 'pending' | 'approved' | 'rejected' | 'cancelled';
      selected_option?: string;
      feedback?: string;
    };
  }[];
};
```

## 二进制与流式端点

以下端点返回二进制流而非 JSON 载荷，各端点的 HTTP 能力并不相同：

| 方法与路径 | 说明 | Range 分段（206） | ETag / 304 |
| --- | --- | --- | --- |
| `GET /api/v1/files/{file_id}` | 下载已上传文件 | 支持 | 不支持（会发送 `etag` 头，但不处理 `If-None-Match`） |
| `GET /api/v1/sessions/{session_id}/fs/{path}:download` | 下载会话工作区文件 | 支持 | 支持 |
| `GET /api/v1/fs:content` | 读取本机任意文件（仅受 token 保护，谨慎暴露端口） | 支持 | 支持 |
| `POST /api/v1/sessions/{session_id}/export` | 导出会话与诊断信息（zip 流） | 不支持 | 不支持 |

错误语义也不相同：`GET /api/v1/files/{file_id}` 与 `GET .../media/{file_id}` 对查找和存储失败返回真实 404 / 500 状态码（参数校验失败仍返回 HTTP 200 的 `ResponseType`），其余三个端点的所有失败都返回 [`ResponseType`](#responsetype)——客户端在这三个端点上仍需检查 `code`。

## 下一步

- [在网页中使用](../guides/web.md) — 启动服务并在浏览器中使用 Kimi Code
- [kimi 命令](./kimi-command.md#kimi-web) — `kimi web` 的全部命令行选项
