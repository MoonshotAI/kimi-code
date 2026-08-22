# 服务 API

`kimi web` 启动的本地服务暴露两组程序化接口：REST API（`/api/v1`，另有 `/api/v2/sessions`）和 WebSocket 事件流（`/api/v1/ws`）。本页是这两组接口的协议参考。如何启动服务及其命令行选项见 [kimi 命令](./kimi-command.md#kimi-web) 参考；端到端的上手流程见 [本地服务与 API](../guides/server.md)。

本页是一份经过整理、面向人阅读的参考：下文逐一记录每个端点的参数、请求体与响应结构。每个端点精确的机器可读 schema 以服务的在线规范文档为准：`GET /openapi.json`（OpenAPI）与 `GET /asyncapi.json`（AsyncAPI），两者都由服务运行时实际执行的校验 schema 生成。两者都需要鉴权；当本页与在线规范不一致时，以在线规范为准。

::: warning 注意
本页描述的 REST 与 WebSocket API 为实验性特性：不保证接口稳定性，端点、字段与事件类型可能随任何版本更改。集成时请以你所用版本服务的 `/openapi.json` 与 `/asyncapi.json` 文档为准。
:::

## 基础约定

### 地址

默认地址为 `http://127.0.0.1:58627`。端口被占用时，服务会用下一个端口重试（至多 100 次）；可用 `--port` / `--host` 修改绑定。同一 home 目录下可并存多个实例，运行中的实例登记在 `~/.kimi-code/server/instances/`。

### 鉴权

除以下例外，所有 `/api/*` 路径（含 `/openapi.json` 与 `/asyncapi.json`）都要求 bearer token：

- `OPTIONS` 预检请求
- `GET /api/v1/healthz`（探活）
- 静态 web 资源（非 `/api/` 路径）

携带方式：REST 用 `Authorization: Bearer <token>` 请求头；WebSocket 升级请求接受同一请求头，或子协议 `kimi-code.bearer.<token>`。token 的生成与轮换见 [本地服务与 API：鉴权](../guides/server.md#authentication)。

鉴权失败返回 HTTP 401，信封 `code` 为 `40101`。在非 loopback 绑定上，同一来源 60 秒内鉴权失败 10 次会被封禁 60 秒，期间每个请求都返回 HTTP 429（`code` 为 `42901`）。

### 响应信封

所有 JSON 响应统一包在信封里：

```json
{
  "code": 0,
  "msg": "success",
  "data": {},
  "request_id": "01JZX4A6E7M8V0R3Q0N2K2M5Q9"
}
```

- `code`：业务结果，`0` 表示成功；错误码分段见下文。
- `data`：成功时的业务数据。注意部分「错误」信封也携带非空 `data`——例如重复解决审批返回 `40902` 且 `data.resolved` 为 `false`——客户端应先判 `code` 再看 `data`。
- `request_id`：本次请求的 ULID；客户端可用 `X-Request-Id` 请求头指定，非法值会被服务端重新生成。

HTTP 状态码几乎总是 200，业务结果以 `code` 为准。例外情况：

| 场景 | HTTP 状态 |
| --- | --- |
| 鉴权失败 / 触发限流 | 401 / 429 |
| 创建供应商、导入供应商目录成功 | 201 |
| 删除供应商成功 | 204 |
| 二进制与流式端点 | 支持时返回 206（Range 分段）/ 304（ETag 未变），各端点能力不同，详见「[二进制与流式端点](#二进制与流式端点)」 |
| `GET /api/v1/files/{file_id}` 下载错误 | 真实 404 / 500（响应体仍为信封） |

其中 201 的响应体仍是标准信封（`code` 为 `0`），只是状态行遵循 REST 的资源创建惯例；204 按定义没有响应体，删除成功以状态码本身为准。

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

### 分页

列表端点有两种分页风格：

- **游标式**：`before_id` / `after_id`（互斥）加 `page_size`（1–100），响应为 `{ items, has_more }`。用于会话列表、消息列表、转录等。
- **`page_token`**：不透明令牌（绑定了查询条件的指纹），用于 `POST /api/v1/search` 与 `GET /api/v2/sessions`。翻页途中改变任何查询条件会使令牌失效：v2 返回 `40922`，search 返回 `40001`。`GET /api/v2/sessions` 另提供无状态的 `page` 页码模式作为替代。

## REST 端点

下文按资源分组列出端点。路径里的 `:{action}` 后缀是动作约定——对单个资源 POST 到 `路径:动作` 执行非 CRUD 操作（如会话的 `:fork`、`:archive`）。

### 服务与元信息

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/v1/healthz` | 探活，免鉴权 |
| `GET /api/v1/meta` | 服务版本、能力集、`server_id`、实验开关 |
| `POST /api/v1/shutdown` | 优雅退出（先回 200 再关闭）；仅 loopback 绑定时挂载 |

#### `GET /api/v1/healthz`

供脚本与进程管理器使用的探活端点。它是唯一豁免 bearer token 的 `/api` 端点（见 [鉴权](#鉴权)），应答时不触碰配置与引擎。

成功时 `data` 为 `{ "ok": true }`。

#### `GET /api/v1/meta`

返回本实例的身份信息与能力集。大多数字段在启动时即固定；`experimental_flags` 与 `features` 按请求实时解析，因此开关翻转或某个 feature 失败会体现在下一次响应中。

成功时 `data` 携带：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `server_version` | string | 服务版本 |
| `capabilities` | object | 能力集——`websocket`、`file_upload`、`fs_query`、`mcp`、`tasks`、`terminal`，均恒为 `true` |
| `server_id` | string | 本服务实例的唯一 id |
| `started_at` | string | 启动时间，ISO 8601 格式 |
| `open_in_apps` | array | 可作为 `open-in` 目标的宿主应用（`finder` / `cursor` / `vscode` / `iterm` / `terminal`）；目前恒为空 |
| `dangerous_bypass_auth` | boolean | 服务是否以 `--dangerous-bypass-auth` 启动（客户端可跳过 token 提示） |
| `backend` | string | 引擎后端，`v1` 或 `v2`；本服务恒为 `v2` |
| `web_title` | string | 来自 `--web-title` 的自定义浏览器标签页标题；未设置时省略 |
| `experimental_flags` | object | 实验开关 id → 是否启用，按请求时解析 |
| `features` | array | 引擎 feature，形如 `{ name, state, meta }`；`state` 为 `Pending` / `Activating` / `Active` / `Unloading` / `Failed` |

#### `POST /api/v1/shutdown`

请求服务优雅退出。响应先发出，随后立即执行关闭，因此调用方可以信任收到的响应。该路由仅在 loopback 绑定时挂载——非 loopback 绑定时它根本不会被注册（请求得到 404），除非服务以 `--allow-remote-shutdown` 启动。

成功时 `data` 为 `{ "ok": true }`。

### 登录与用量

这组端点驱动托管 Kimi OAuth 登录的生命周期，并暴露账号级信息。托管供应商名为 `managed:kimi-code`；下面每个端点上可选的 `provider` 参数都默认取它。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/v1/auth` | 鉴权就绪状态快照 |
| `POST /api/v1/oauth/login` | 发起 OAuth device-code 登录流程 |
| `GET /api/v1/oauth/login` | 轮询登录流程状态 |
| `DELETE /api/v1/oauth/login` | 取消进行中的登录流程 |
| `POST /api/v1/oauth/logout` | 登出托管供应商 |
| `GET /api/v1/oauth/usage` | 套餐用量与限额 |
| `GET /api/v1/oauth/userinfo` | 账号资料 |
| `GET /api/v1/oauth/region` | 解析客户端所属区域（`mainland-cn` / `global`） |

#### `GET /api/v1/auth`

鉴权就绪状态快照：服务是否具备可用的模型配置，以及托管供应商的登录状态。当至少配置了一个供应商、设置了默认模型、且托管供应商（如存在）未被吊销时，`ready` 为 `true`。

成功时 `data` 携带 `ready`（布尔值）、`providers_count`（已配置供应商数量）、`default_model`（全局默认模型别名，或 `null`）与 `managed_provider`（`null`，或 `{ name, status }`，其中 `status` 为 `authenticated` / `expired` / `revoked` / `unauthenticated` 之一）。

#### `POST /api/v1/oauth/login`

为托管供应商发起 OAuth device-code 登录流程；发起新流程会中止同一供应商进行中的流程。账号已登录时无需用户交互，响应会立即报告 `authenticated`。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `provider` | body | string | 托管供应商名称。默认 `managed:kimi-code` |
| `region` | body | string | `mainland-cn` 或 `global`；覆盖 `GET /api/v1/oauth/region` 一节描述的区域解析结果，仅对本次流程生效 |

成功时 `data` 有两种形态。进行中的流程——`{ flow_id, provider, status: "pending", verification_uri, verification_uri_complete, user_code, expires_in, interval, expires_at }`：打开 `verification_uri_complete`（或打开 `verification_uri` 并输入 `user_code`），然后每隔 `interval` 秒轮询 `GET /api/v1/oauth/login`，直到流程完结或超过 `expires_at`（`expires_in` 是以秒表示的同一时限）。已登录的快速路径——`{ flow_id, provider, status: "authenticated" }`。

#### `GET /api/v1/oauth/login`

轮询某供应商的登录流程状态。尚未发起过流程时返回 `null`。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `provider` | query | string | 托管供应商名称。默认 `managed:kimi-code` |

成功时 `data` 为 `null` 或流程快照：`{ flow_id, provider, status, verification_uri, verification_uri_complete, user_code, expires_in, expires_at, interval }`，其中 `status` 为 `pending` / `authenticated` / `denied` / `expired` / `cancelled`。流程离开 `pending` 后，`resolved_at` 记录其到达终态的时间，`error_message` 描述失败的流程。

#### `DELETE /api/v1/oauth/login`

取消某供应商进行中的登录流程。没有进行中的流程时，该调用为空操作，返回最近一次已知状态。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `provider` | query | string | 托管供应商名称。默认 `managed:kimi-code` |

成功时 `data` 为 `{ cancelled, status }`：只有确实中止了一个 `pending` 流程时 `cancelled` 才为 `true`，`status` 为调用后的流程状态。

#### `POST /api/v1/oauth/logout`

登出托管供应商：丢弃已存储的 OAuth 凭据、中止进行中的登录流程，并把托管供应商从配置中移除。OAuth 托管的供应商拒绝手动编辑与删除（见下文 `PUT` / `DELETE /api/v1/providers/{provider_id}`），因此要移除它需先登出。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `provider` | body | string | 托管供应商名称。默认 `managed:kimi-code` |

成功时 `data` 为 `{ logged_out: true, provider }`。

#### `GET /api/v1/oauth/usage`

托管账号的套餐用量与限额，实时取自账号服务。上游失败不会让信封失败——它以 `kind: "error"` 的形式带内返回。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `provider` | query | string | 托管供应商名称。默认 `managed:kimi-code` |

成功时 `data` 为 `{ kind: "ok", summary, limits, extra_usage }` 或 `{ kind: "error", message, status? }`，其中 `status` 为上游 HTTP 状态码（如存在）。在 `ok` 形态中，`summary`（可空）是主配额行，`limits` 列出每个配额窗口；一行的结构为 `{ name?, window?, used, limit, reset_at? }`，其中 `window` 为 `{ duration, unit }`，`unit` 为 `minute` / `hour` / `day` / `week` 之一。`extra_usage`（可空）是按量付费钱包：`{ balance_cents, total_cents, monthly_charge_limit_enabled, monthly_charge_limit_cents, monthly_used_cents, currency }`。

#### `GET /api/v1/oauth/userinfo`

托管账号的资料，带内 `kind: "error"` 约定与 `GET /api/v1/oauth/usage` 相同。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `provider` | query | string | 托管供应商名称。默认 `managed:kimi-code` |

成功时 `data` 为 `{ kind: "ok", userInfo }` 或 `{ kind: "error", message, status? }`。`userInfo` 始终携带 `userId`、`nickname`、`status`、`region`、`userLevel`、`userLevelName`、`domain`、`domainName`，并可能附加 `globalId`、`bio`、`avatar`、`username`、`email`、`phone`（`{ countryCode, number }`）、`createdTime` 与 `lastLoginTime`。

#### `GET /api/v1/oauth/region`

解析该客户端所属的 Kimi 区域。结果在本地推导，不经网络探测：优先取环境变量或配置固定的 OAuth host，其次是已配置的 OAuth key，再次是 home 目录中的区域标记文件；默认为 `mainland-cn`。

成功时 `data` 为 `{ region }`，`region` 为 `mainland-cn` / `global` 之一。

### 配置

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/v1/config` | 读取全局配置（密钥字段脱敏） |
| `POST /api/v1/config` | 合并式更新配置，并广播 `event.config.changed` |

#### `GET /api/v1/config`

返回解析后的全局配置——`config.toml` 叠加覆盖层后的生效结果。密钥已脱敏：每个供应商只报告 `has_api_key`，绝不返回存储的密钥。

成功时 `data` 为配置对象；其字段与 [顶层字段](../configuration/config-files.md#top-level-fields) 记录的顶层域一一对应：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `providers` | object | 供应商 id → `{ type, base_url?, default_model?, has_api_key }` 的映射 |
| `default_provider` | string | 全局默认供应商 id |
| `default_model` | string | 全局默认模型别名 |
| `models` | object | 模型别名 → 模型记录的映射 |
| `thinking` | object | Thinking 模式的默认参数 |
| `plan_mode` | boolean | Plan 模式开关 |
| `yolo` | boolean | 派生值：`default_permission_mode` 为 `yolo` 时为 `true` |
| `default_permission_mode` | string | 新会话的默认权限模式 |
| `default_plan_mode` | boolean | 新会话是否以 Plan 模式启动 |
| `permission` | object | 初始权限规则 |
| `hooks` | array | 生命周期钩子 |
| `services` | object | 内置外部服务配置 |
| `merge_all_available_skills` | boolean | 是否合并所有可用目录中的 Agent Skills |
| `extra_skill_dirs` | array | 额外的 Skill 搜索目录 |
| `loop_control` | object | Agent 循环控制参数 |
| `background` | object | 后台任务运行参数 |
| `subagent` | object | subagent 配置 |
| `secondary_model` | object | subagent 的次级模型池 |
| `experimental` | object | 实验开关 id → 是否启用 |
| `telemetry` | boolean | 是否启用匿名遥测 |
| `raw` | object | 原始解析的 `config.toml` 内容，包含未建模字段 |

#### `POST /api/v1/config`

合并式更新全局配置：请求体中的每个顶层域被深合并进对应域，未出现在请求体中的域保持不动。把 `yolo` 设为 `true` 是 `default_permission_mode: "yolo"` 的简写。更新成功后，服务会广播全局 `event.config.changed` 事件，携带变更的字段名与完整的更新后配置；被拒绝的补丁（值非法或持久化失败）返回 `40001` 与底层错误信息。

请求体是部分配置对象——上述响应域中除 `raw` 外的任意子集，均为可选：

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `providers` | body | object | 供应商 id → 供应商表的映射 |
| `default_provider` | body | string | 全局默认供应商 id |
| `default_model` | body | string | 全局默认模型别名 |
| `models` | body | object | 模型别名 → 模型记录的映射 |
| `thinking` | body | object | Thinking 模式的默认参数 |
| `plan_mode` | body | boolean | Plan 模式开关 |
| `yolo` | body | boolean | `true` 映射为 `default_permission_mode: "yolo"`；`false` 被忽略 |
| `default_permission_mode` | body | string | `manual` / `yolo` / `auto` |
| `default_plan_mode` | body | boolean | 新会话是否以 Plan 模式启动 |
| `permission` | body | object | 初始权限规则 |
| `hooks` | body | array | 生命周期钩子 |
| `services` | body | object | 内置外部服务配置 |
| `merge_all_available_skills` | body | boolean | 是否合并所有可用目录中的 Agent Skills |
| `extra_skill_dirs` | body | array | 额外的 Skill 搜索目录 |
| `loop_control` | body | object | Agent 循环控制参数 |
| `background` | body | object | 后台任务运行参数 |
| `subagent` | body | object | subagent 配置 |
| `secondary_model` | body | object | subagent 的次级模型池 |
| `experimental` | body | object | 实验开关 id → 是否启用 |
| `telemetry` | body | boolean | 是否启用匿名遥测 |

成功时 `data` 为完整的更新后配置，形态与 `GET /api/v1/config` 相同。

### 模型与供应商

这组端点管理模型配置的两半——`config.toml` 的 [供应商](../configuration/providers.md) 表与模型别名表——外加一个由服务端代理的 models.dev 目录，用于一次性导入。模型别名 id 就是配置中的别名键：通过供应商管理端点创建的别名形如 `provider_id/model`（例如 `my-provider/kimi-for-coding`），而模型别名表中的裸键（如 `turbo`）原样使用；API 中任何接收 `model_id` 的地方（包括全局 `default_model`）指的都是这个别名 id。`:{action}` 路由上不支持的动作返回 `40001`。

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

成功时 `data.items` 为 `{ provider, model, display_name?, max_context_size, capabilities?, support_efforts?, default_effort? }` 数组：`model` 是别名 id（供应商管理的别名为 `provider_id/model`，否则为裸键），`provider` 是所属供应商 id，`max_context_size` 是以 token 计的上下文窗口，`capabilities` / `support_efforts` / `default_effort` 描述能力标志与 Thinking 模式的 effort 支持。

#### `POST /api/v1/models/{model_id}:set_default`

把全局 `default_model` 设为一个已存在的别名。`model_id` 是配置中的别名键原样——裸键如 `POST /api/v1/models/turbo:set_default`；当 id 含 `/` 时需做 URL 编码，如 `POST /api/v1/models/my-provider%2Fkimi-for-coding:set_default`。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `model_id` | path | string | **必填。** 配置中的模型别名键原样；含 `/` 时需 URL 编码 |

成功时 `data` 为 `{ default_model, model }`——当前生效的别名及其目录项（形态与 `GET /api/v1/models` 的单项相同）。

- `40001`：路径中的动作后缀非法或不支持
- `40413`：不存在该 id 的模型别名

#### `GET /api/v1/providers`

列出每个已配置供应商及其凭据与模型发现状态，不泄露任何密钥。这也是其他供应商端点引用的供应商条目形态。

成功时 `data.items` 为如下结构的数组：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 供应商 id |
| `type` | string | 通信协议：`kimi` / `openai` / `openai_responses` / `anthropic` / `google-genai` / `vertexai` |
| `base_url` | string | API 基础 URL，如已设置 |
| `default_model` | string | 该供应商的默认模型别名，如已设置 |
| `has_api_key` | boolean | 是否已存储凭据 |
| `status` | string | 存在 API 密钥或缓存的 OAuth token 时为 `connected`，否则为 `unconfigured`（`error` 在 schema 中保留） |
| `models` | array | 该供应商的模型别名 id |

#### `POST /api/v1/providers`

一次保存创建供应商及其模型别名；响应为 HTTP 201 加标准信封。当全局 `default_model` 完全未配置时（全新安装），会以新供应商的 `default_model`（或第一个模型）播种；已有默认值绝不被修改。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `id` | body | string | **必填。** 供应商 id——字母、数字、`-`、`_` 与空格；必须以字母或数字开头 |
| `type` | body | string | **必填。** 通信协议：`kimi` / `openai` / `openai_responses` / `anthropic` / `google-genai` / `vertexai` |
| `api_key` | body | string | API 密钥，存储于 `config.toml` |
| `base_url` | body | string | API 基础 URL；不得包含环境变量占位符（`${...}`） |
| `default_model` | body | string | 该供应商的默认模型；必须是 `models[].model` 之一 |
| `models` | body | array | **必填。** 至少一条，不允许重复的 `model` 值；条目结构见下文 |

每个 `models[]` 条目声明一个别名，其 id 为 `id/model`：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `model` | string | **必填。** 上游模型名 |
| `max_context_size` | integer | **必填。** 以 token 计的上下文窗口，≥ 1 |
| `display_name` | string | 显示名 |
| `capabilities` | array | 能力标志，如 `thinking` 或 `image_in` |
| `max_output_size` | integer | 最大输出 token 数，≥ 1 |
| `support_efforts` | array | 支持的 Thinking 模式 effort 档位 |
| `adaptive_thinking` | boolean | 自适应 thinking 开关 |

成功时 `data` 为创建好的供应商条目（形态与 `GET /api/v1/providers` 的单项相同）。

- `40921`：已存在该 `id` 的供应商

#### `GET /api/v1/providers/{provider_id}`

读取单个供应商。与列表路由不同，设置了密钥时响应会暴露存储的 `api_key`，以便本地编辑表单预填——暴露端口时请牢记这一点。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `provider_id` | path | string | **必填。** 供应商 id |

成功时 `data` 为供应商条目，存有密钥时附带 `api_key`。

- `40412`：供应商不存在

#### `PUT /api/v1/providers/{provider_id}`

一次保存整体替换供应商：`type`、`base_url` 与模型列表被重写，该供应商的别名按 `models` 重建——不再列出的别名从 `config.toml` 中消失，其他供应商的别名不受影响。`api_key` 是三态的：省略表示保留已存密钥，`""` 表示清除，其他值表示替换。除 `new_id` 重命名迁移外，全局默认指针绝不被修改。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `provider_id` | path | string | **必填。** 当前供应商 id |
| `new_id` | body | string | 重命名供应商；providers 键、模型别名、`default_provider`、指向旧别名的 `default_model` 以及 subagent 次级模型池都会随之迁移。id 规则与 `POST /api/v1/providers` 相同 |
| `type` | body | string | **必填。** 通信协议：`kimi` / `openai` / `openai_responses` / `anthropic` / `google-genai` / `vertexai` |
| `api_key` | body | string | 三态，见上文 |
| `base_url` | body | string | API 基础 URL；不得包含环境变量占位符（`${...}`） |
| `default_model` | body | string | 该供应商的默认模型；必须是 `models[].model` 之一 |
| `models` | body | array | **必填。** 至少一条，不允许重复的 `model` 值；条目结构与 `POST /api/v1/providers` 相同 |

成功时 `data` 为 `{ provider }`，即保存后的供应商条目。

- `40001`：重命名后的别名 id 会与其他供应商的别名冲突
- `40003`：供应商由 OAuth 托管——请改用 `POST /api/v1/oauth/logout` 登出
- `40412`：供应商不存在
- `40921`：`new_id` 已被占用

#### `DELETE /api/v1/providers/{provider_id}`

删除供应商及其全部模型别名；subagent 次级模型池会级联清理。全局 `default_provider` / `default_model` 指针保持不动，即使它们指向被删的供应商——那是用户的设置，不由本端点代为回收。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `provider_id` | path | string | **必填。** 供应商 id |

成功时服务应答 204 且无响应体——状态行本身即表示删除成功（见 [响应信封](#响应信封)）。

- `40003`：供应商由 OAuth 托管——请改用 `POST /api/v1/oauth/logout` 登出
- `40412`：供应商不存在

#### `POST /api/v1/providers/{provider_id}:refresh`

从上游来源重新发现单个供应商的模型元数据，并重写该供应商的别名。模型来源为静态的供应商不经任何网络调用直接报告 `unchanged`。至少一个供应商的别名发生变化时，服务会广播全局 `event.model_catalog.changed` 事件。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `provider_id` | path | string | **必填。** 供应商 id |

成功时 `data` 为刷新报告：`changed` 是 `{ provider_id, provider_name, added, removed }`（新增 / 移除的别名数）的数组，`unchanged` 是无差异的供应商 id 数组，`failed` 是 `{ provider, reason }` 的数组。

- `40001`：路径中的动作后缀非法或不支持
- `40412`：供应商不存在

#### `POST /api/v1/providers:refresh`

刷新每个供应商的模型元数据。请求体可选且被忽略。

成功时 `data` 为与 `POST /api/v1/providers/{provider_id}:refresh` 相同的刷新报告（`changed` / `unchanged` / `failed`）。

#### `POST /api/v1/providers:refresh_oauth`

与 `POST /api/v1/providers:refresh` 相同的刷新，仅限 OAuth 凭据的供应商。请求体可选且被忽略。

成功时 `data` 为刷新报告（`changed` / `unchanged` / `failed`）。

#### `POST /api/v1/providers:import_catalog`

把一个 models.dev 目录条目导入为已配置供应商；响应为 HTTP 201 加标准信封。通信协议与端点来自目录解析，目录中的每个模型都写为一个别名。导入已存在的 id 等同于刷新——供应商条目及其别名按目录重写，省略 `api_key` 表示保留已存密钥。全局默认指针绝不被修改，仅在完全未配置默认模型时，以第一个导入的模型播种 `default_model`。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `catalog_id` | body | string | **必填。** 来自 `GET /api/v1/catalog/providers` 的目录条目 id |
| `id` | body | string | 覆盖目录 id 作为本地供应商 id。id 规则与 `POST /api/v1/providers` 相同 |
| `api_key` | body | string | 导入供应商的 API 密钥 |
| `base_url` | body | string | 覆盖目录解析出的端点；条目的 `needs_base_url` 为 `true` 时必填 |

成功时 `data` 为 `{ provider, models_imported }`——供应商条目与写入的别名数量。

- `40001`：缺少 `catalog_id` 或其他请求体校验失败
- `40003`：目标供应商已存在且由 OAuth 托管
- `40004`：条目无法导入（被拒绝、要求 `base_url`、没有可导入的模型，或其 id 不能用作供应商 id）
- `40417`：不存在该 `catalog_id` 的目录条目
- `50004`：models.dev 目录不可用

#### `POST /api/v1/providers:import_registry`

把一个 models.dev 形态的私有注册表——一个 `api.json` URL 加可选的 Bearer key——导入为已配置供应商；响应为 HTTP 201 加标准信封。每个列出的供应商都带 `source` 记录写入，以便定时刷新重新发现。重复导入同一 URL 会移除上游已消失的供应商——URL 是注册表的稳定身份，因此轮换 key 是安全的。全局默认指针遵循与 `:import_catalog` 相同的规则。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `url` | body | string | **必填。** 注册表 `api.json` 的 URL |
| `api_key` | body | string | 注册表的 Bearer key；省略时复用上一次导入同一 URL 所用的 key |

成功时 `data` 为 `{ providers, models_imported }`——供应商条目数组与写入的别名总数。

- `40001`：缺少 `url` 或其他请求体校验失败
- `40003`：某个列出的供应商已存在且由 OAuth 托管
- `40005`：注册表无法获取或解析，或未列出可导入的供应商

#### `GET /api/v1/catalog/providers`

浏览 models.dev 目录，由服务端代理，带 10 分钟内存缓存与内置快照兜底。条目保持上游目录顺序。服务无法导入的条目携带 `rejected: true` 与机器可读的 `reject_reason`；`needs_base_url: true` 的条目在导入时要求提供 base URL。

成功时 `data.items` 为 `{ id, name, wire_type, guessed, needs_base_url, rejected, reject_reason, env_key, models }` 数组：`wire_type` 是解析出的协议（可空，枚举与供应商 `type` 相同），`guessed` 标记启发式解析，`env_key` 是上游约定的 API 密钥环境变量（可空），`models` 是 `{ id, name?, max_context_size, capabilities?, reasoning }` 的数组。

- `50004`：目录不可用（在线拉取与内置快照均失败）

#### `GET /api/v1/catalog/providers/{catalog_id}`

按 catalog id 读取单个 models.dev 目录条目——条目形态与 `GET /api/v1/catalog/providers` 相同。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `catalog_id` | path | string | **必填。** 目录条目 id |

成功时 `data` 为该目录条目（形态与 `GET /api/v1/catalog/providers` 的单项相同）。

- `40417`：不存在该 `catalog_id` 的目录条目
- `50004`：目录不可用

### 会话

这些端点用于创建、列出和查看会话，执行会话级动作（fork、compact、undo 等），并读取会话级汇总。其中大多数返回的会话采用 [session 对象](#session-对象) 中统一说明的线上格式；非 CRUD 操作使用上文介绍的 `:{action}` 约定。

| 方法与路径 | 说明 |
| --- | --- |
| `POST /api/v1/sessions` | 创建会话（需 `workspace_id` 或 `metadata.cwd`） |
| `GET /api/v1/sessions` | 列出会话，游标分页，支持 `busy` / `archived_only` 等过滤 |
| `GET /api/v1/sessions/{session_id}` | 读取单个会话 |
| `GET /api/v1/sessions/{session_id}/profile` | 读取会话档案 |
| `POST /api/v1/sessions/{session_id}/profile` | 更新标题、元数据、Agent 配置 |
| `POST /api/v1/sessions/{session_id}/title/generate` | 通过托管的 `chat_title` 工具生成标题 |
| `POST /api/v1/sessions/{session_id}:{action}` | 会话动作：`fork` / `compact` / `undo` / `abort` / `btw` / `archive` / `restore` |
| `GET /api/v1/sessions/{session_id}/children` | 列出子会话 |
| `POST /api/v1/sessions/{session_id}/children` | 创建子会话（fork 并打标） |
| `GET /api/v1/sessions/{session_id}/status` | 实时状态汇总 |
| `GET /api/v1/sessions/{session_id}/goal` | 当前目标快照（无则 `null`） |
| `GET /api/v1/sessions/{session_id}/warnings` | 会话级告警 |
| `GET /api/v1/sessions/{session_id}/runtime` | 读取 main agent 的运行时绑定 |
| `POST /api/v1/sessions/{session_id}/runtime` | 切换 main agent 的运行时绑定 |
| `POST /api/v1/sessions/{session_id}/export` | 导出会话与诊断信息（zip 流，不走信封） |
| `GET /api/v1/sessions/{session_id}/snapshot` | 客户端重建用全量快照（含 `as_of_seq` 与 `epoch`） |
| `GET /api/v1/sessions/{session_id}/media/{file_id}` | 按文件 id 下载提示词媒体（二进制） |

#### session 对象

每个返回会话的端点都使用这种线上格式。实时状态字段（`busy`、`main_turn_active`、`pending_interaction`、`last_turn_reason`）由会话的活动聚合解析得出：未加载到本服务进程中的会话（冷会话）始终上报为不忙碌且无待处理交互。少数字段在当前投影中是占位值——已逐字段注明。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 会话 id（`session_...`） |
| `workspace_id` | string | 所属工作区 id |
| `title` | string | 会话标题；无标题时为 `""` |
| `created_at` / `updated_at` | string | 创建时间与最后更新时间，ISO 8601 |
| `archived` | boolean | 会话是否已归档（归档后从默认会话列表中隐藏） |
| `archived_at` | string | 归档时间，ISO 8601；仅在已归档时存在 |
| `busy` | boolean | 是否有任一 Agent 存在进行中的轮次或后台任务 |
| `main_turn_active` | boolean | main agent 是否有进行中的轮次 |
| `pending_interaction` | string | `none` / `approval` / `question`——有未答复的交互在等待 |
| `last_turn_reason` | string | main agent 最近一次轮次的结果：`completed` / `cancelled` / `failed` |
| `last_prompt` | string | 最近一条用户提示词文本（如有） |
| `metadata` | object | 自定义元数据；始终携带 `cwd`（会话的工作目录） |
| `agent_config` | object | 投影为 `{ model }`；`model` 在大多数响应中为 `""`，仅由 `GET /api/v1/sessions/{session_id}/snapshot` 填入实时模型 |
| `usage` | object | token 汇总 `{ input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, context_tokens, context_limit?, total_cost_usd?, turn_count? }`；在 snapshot 端点之外全为零 |
| `permission_rules` | array | 会话权限规则；当前始终为 `[]` |
| `message_count` | integer | 消息数；当前始终为 `0` |
| `last_seq` | integer | 最后的事件序列号；当前始终为 `0` |

#### `POST /api/v1/sessions`

创建会话并返回。目标目录来自 `workspace_id`（已注册的工作区）或 `metadata.cwd`（首次使用时注册该工作区）；两者同时提供时必须一致。创建时会广播全局 `event.session.created` 事件。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `workspace_id` | body | string | 未提供 `metadata.cwd` 时**必填**。已注册的工作区 id；会话创建于该工作区的根目录 |
| `metadata` | body | object | 自定义元数据。`metadata.cwd` 为工作目录，未提供 `workspace_id` 时**必填**；两者同时提供时必须等于工作区根目录 |
| `title` | body | string | 初始标题（至少 1 个字符）；否则会话无标题 |
| `agent_config` | body | object | schema 接受该字段但当前不会应用——模型与各模式请通过 `POST /api/v1/sessions/{session_id}/profile` 设置 |

成功时，`data` 为新会话的 [session 对象](#session-对象)。

- `40001`：`workspace_id` 与 `metadata.cwd` 都未提供，或 `metadata.cwd` 与工作区根目录不一致（`details` 会列出该字段）
- `40409`：工作目录不存在或不是目录
- `40410`：没有以该 `workspace_id` 注册的工作区

#### `GET /api/v1/sessions`

跨工作区列出会话，按 `updated_at` 最新在前。游标分页遵循 [分页](#分页)，但有一个特例：不提供 `page_size`（且不提供 `archived_only`）时，响应是单个不分页的窗口，其 `has_more` 恒为 `false`，因此要真正翻页请传入 `page_size`。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `before_id` | query | string | 只保留早于该 id 的会话；与 `after_id` 互斥 |
| `after_id` | query | string | 只保留晚于该 id 的会话；与 `before_id` 互斥 |
| `page_size` | query | integer | 1–100。分页生效时默认为 `20`；不分页的默认行为见上文说明 |
| `busy` | query | boolean | 只保留忙碌（或只保留空闲）的会话 |
| `include_archive` | query | boolean | 在活跃会话之外同时包含已归档会话。默认 `false` |
| `archived_only` | query | boolean | 只保留已归档会话；与 `include_archive` 互斥；即使不提供 `page_size` 也会启用游标分页 |
| `exclude_empty` | query | boolean | 去掉没有任何用户提示词的会话 |
| `workspace_id` | query | string | 限定到单个工作区（别名会被解析） |

成功时，`data` 为 `{ items, has_more }`，其中每个元素为 [session 对象](#session-对象)。

- `40001`：校验失败——例如 `before_id` 与 `after_id` 同用，或 `archived_only` 与 `include_archive` 同用
- `40410`：未知的 `workspace_id`

#### `GET /api/v1/sessions/{session_id}`

从索引中读取单个会话。会话已加载到本进程时会包含实时状态字段；冷会话上报为不忙碌，并携带其最后持久化的轮次结果。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | **必填。** 会话 id |

成功时，`data` 为 [session 对象](#session-对象)。

- `40401`：会话不存在，或其工作区已无法解析

#### `GET /api/v1/sessions/{session_id}/profile`

读取会话档案——与 `GET /api/v1/sessions/{session_id}` 相同的线上载荷。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | **必填。** 会话 id |

成功时，`data` 为 [session 对象](#session-对象)。

- `40401`：会话不存在

#### `POST /api/v1/sessions/{session_id}/profile`

更新会话档案：标题、自定义元数据以及 main agent 的配置。在这里设置的标题会成为自定义标题，优先级高于生成的标题；设置标题会广播全局 `session.meta.updated` 事件。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | **必填。** 会话 id |
| `title` | body | string | 新标题（至少 1 个字符）；会成为自定义标题 |
| `metadata` | body | object | 合并进会话自定义元数据的键 |
| `agent_config` | body | object | main agent 的部分配置；字段如下，均为可选 |

每个 `agent_config` 字段都会立即应用到 main agent：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `model` | string | 模型别名 id；空字符串会被忽略 |
| `thinking` | string | Thinking 强度等级 |
| `permission_mode` | string | `manual` / `yolo` / `auto` |
| `plan_mode` | boolean | 进入或退出 Plan 模式 |
| `swarm_mode` | boolean | 进入或退出 swarm 模式 |
| `goal_objective` | string | 以该文本为内容创建一个目标 |
| `goal_control` | string | `pause` / `resume` / `cancel` 当前目标 |

schema 还接受 `agent_config` 内的 `system_prompt`、`tools`、`mcp_servers`，以及顶层的 `permission_rules` 数组，但更新路由当前不会应用它们。

成功时，`data` 为更新后的 [session 对象](#session-对象)。

- `40401`：会话不存在

#### `POST /api/v1/sessions/{session_id}/title/generate`

通过托管供应商的 `chat_title` 工具根据会话的提示词生成标题并应用，同时广播 `session.meta.updated`。生成需要托管 OAuth 登录和 `auto_session_title` 实验开关；未提供 `force` 时，已有自定义标题或已生成标题的会话会上报为不可用，而不会被覆盖。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | **必填。** 会话 id |
| `force` | body | boolean | 即使已有自定义或生成的标题也重新生成。默认 `false` |
| `source` | body | string | 标题输入：`user_prompts`（默认）/ `first_turn` / `digest` |

成功时，`data` 为 `{ title }`——当前应用到会话的标题。

- `40401`：会话不存在
- `40923`：生成不可用——开关未开启、没有托管 OAuth 登录或尚无任何提示词内容、已有标题但未提供 `force`，或后端请求失败

#### `POST /api/v1/sessions/{session_id}:{action}`

会话动作通过同一条路由分发：路径尾部解析为 `{session_id}:{action}`，请求体按该动作的 schema 校验，动作缺失或未知时返回 `40001`（`unsupported action: ...`）。每个动作都会先解析会话，因此会话未知时都可能返回 `40401`。支持的动作在下面逐一说明。

#### `POST /api/v1/sessions/{session_id}:fork`

将会话——其转录、Agent 状态与文件——复制到同一工作区中的新会话，并广播 `event.session.created`。当会话中任一 Agent 有进行中的轮次时，fork 会被拒绝。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `title` | body | string | fork 的标题（至少 1 个字符）。默认 `Fork: <source title>` |
| `metadata` | body | object | fork 的自定义元数据 |

成功时，`data` 为新会话的 [session 对象](#session-对象)。

- `40901`：会话有进行中的轮次，无法 fork

#### `POST /api/v1/sessions/{session_id}:compact`

对 main agent 的上下文发起一次手动全量压缩。调用立即返回；进度与完成通过 `compaction.*` WebSocket 事件投递。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `instruction` | body | string | 给压缩摘要的额外指引；空值会被忽略 |

成功时，`data` 为空对象。

- `40910`：有轮次或其他上下文变更正在进行，或历史中没有可压缩的内容

#### `POST /api/v1/sessions/{session_id}:undo`

将 main agent 的对话回退 `count` 个轮次，并同步修正派生的会话状态（包括会话的 `last_prompt`）。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `count` | body | integer | 要撤销的轮次数；正整数。默认 `1` |
| `page_size` | body | integer | 返回的历史窗口大小，1–100。默认 `50` |

成功时，`data` 为 `{ messages, status }`：`messages` 是剩余上下文消息按最新在前的 `{ items, has_more }` 分页，`status` 与 `GET /api/v1/sessions/{session_id}/status` 的汇总相同。

- `40901`：有轮次正在进行或压缩正在运行——等其结束后重试
- `40911`：无法撤销那么多轮次（遇到压缩边界或检查点丢失）；`data` 携带 `{ reason, requestedCount, undoableCount }`

#### `POST /api/v1/sessions/{session_id}:abort`

取消 main agent 正在运行的轮次——等同于用户在 TUI 中中止轮次的程序化版本。

成功时，`data` 为 `{ aborted: true }`。

#### `POST /api/v1/sessions/{session_id}:btw`

开启一个 `"by the way"` 旁路对话：把 main agent fork 成一个禁用工具调用的子 Agent，让快速的临时问题在隔离环境中运行，不触碰工作上下文。需要可用的模型配置。

成功时，`data` 为 `{ agent_id }`——新子 Agent 的 id。

#### `POST /api/v1/sessions/{session_id}:archive`

将会话标记为已归档：它从默认会话列表中消失（使用 `include_archive` 或 `archived_only` 时仍会列出），并且服务端广播全局 `event.session.archived` 事件。

成功时，`data` 为 `{ archived: true }`。

#### `POST /api/v1/sessions/{session_id}:restore`

取消会话的归档状态并恢复它。

成功时，`data` 为 `archived: false` 的 [session 对象](#session-对象)。

#### `GET /api/v1/sessions/{session_id}/children`

列出会话的子会话——即通过 `POST /api/v1/sessions/{session_id}/children` 创建的会话。游标分页遵循 [分页](#分页)。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | **必填。** 会话 id |
| `before_id` | query | string | 只保留早于该 id 的子会话；与 `after_id` 互斥 |
| `after_id` | query | string | 只保留晚于该 id 的子会话；与 `before_id` 互斥 |
| `page_size` | query | integer | 1–100。默认 `100` |
| `busy` | query | boolean | 只保留忙碌（或只保留空闲）的子会话 |

成功时，`data` 为 `{ items, has_more }`，其中每个元素为 [session 对象](#session-对象)。

- `40401`：会话不存在

#### `POST /api/v1/sessions/{session_id}/children`

创建子会话：fork 当前会话并记录为其子会话，因此会出现在 `GET /api/v1/sessions/{session_id}/children` 下。适用与 `:fork` 相同的进行中轮次限制。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | **必填。** 会话 id |
| `title` | body | string | 子会话的标题（至少 1 个字符）。默认 `Child: <source title>` |
| `metadata` | body | object | 子会话的自定义元数据 |

成功时，`data` 为新会话的 [session 对象](#session-对象)，并且服务端广播 `event.session.created`。

- `40901`：会话有进行中的轮次，无法 fork

#### `GET /api/v1/sessions/{session_id}/status`

main agent 的实时状态汇总；读取它会在会话为冷态时将其恢复。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | **必填。** 会话 id |

成功时，`data` 为 `{ busy, model?, thinking_level, permission, plan_mode, swarm_mode, context_tokens, max_context_tokens?, context_usage? }`：`busy` 表示是否有进行中的轮次，`model` / `thinking_level` / `permission` 为当前生效的 Agent 设置，`plan_mode` / `swarm_mode` 为模式标志，`context_tokens` 与 `max_context_tokens`、`context_usage`（0–1）描述上下文窗口的占用情况。

- `40401`：会话不存在

#### `GET /api/v1/sessions/{session_id}/goal`

读取会话当前的目标快照；没有活跃目标时为 `null`。注意，与本 API 的大多数载荷不同，该载荷使用 camelCase 键。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | **必填。** 会话 id |

成功时，`data` 为 `null` 或 `{ goalId, objective, completionCriterion?, status, turnsUsed, tokensUsed, wallClockMs, budget, terminalReason? }`，其中 `status` 为 `active` / `paused` / `blocked` / `complete`，`budget` 报告 token、轮次与 wall-clock 三项预算，以及各自的剩余量与每项预算的 reached 标志（未设置对应预算时各项为 null）。

- `40401`：会话不存在

#### `GET /api/v1/sessions/{session_id}/warnings`

读取会话级告警。目前的产生者只有 `AGENTS.md` 过大检查（`agents-md-oversized`），因此大多数会话的列表为空。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | **必填。** 会话 id |

成功时，`data` 为 `{ warnings }`，每个条目为 `{ code, message, severity }`，其中 `severity` 为 `info` / `warning` / `error` 之一。

- `40401`：会话不存在

#### `GET /api/v1/sessions/{session_id}/runtime`

读取 main agent 的运行时绑定——即该会话的 Agent 循环运行在哪个运行时上。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | **必填。** 会话 id |

成功时，`data` 为 `{ workspace_id, runtime_id }`。

- `40401`：会话不存在

#### `POST /api/v1/sessions/{session_id}/runtime`

切换 main agent 的运行时绑定。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | **必填。** 会话 id |
| `runtime_id` | body | string | **必填。** 目标运行时 id |

成功时，`data` 为新的绑定 `{ workspace_id, runtime_id }`。

- `40420`：不存在该 `runtime_id` 的运行时
- `40926`：运行时存在但不可用

#### `POST /api/v1/sessions/{session_id}/export`

将会话连同诊断日志一起导出为 zip 附件（`kimi-session-<id>.zip`）。响应是二进制流，不是 JSON 信封——能力与失败语义见 [二进制与流式端点](#二进制与流式端点)。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | **必填。** 会话 id |
| `web_log` | body | string | 要包含在归档中的客户端日志文本，最多 256 KB UTF-8 |
| `desktop` | body | boolean | 同时包含桌面宿主的日志。默认 `false` |

#### `GET /api/v1/sessions/{session_id}/snapshot`

为重新同步后重建客户端组装一份原子快照：会话、最近的消息、进行中的轮次、存活的 subagent 以及待处理交互，全部盖上 `as_of_seq` 水位与用于重新订阅的 `epoch`——见 [断线恢复](#断线恢复)。与普通的会话端点不同，内嵌的会话携带实时的 `agent_config.model` 与真实的 `usage` 总计。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | **必填。** 会话 id |

成功时，`data` 为 `{ as_of_seq, epoch, session, messages, in_flight_turn, subagents?, pending_approvals, pending_questions }`：`session` 为 [session 对象](#session-对象)，`messages` 为最新 100 条消息的 `{ items, has_more }`，`in_flight_turn` 为已部分流式输出的轮次（空闲时为 `null`，已知时带 `current_prompt_id`），`subagents` 列出存活的 subagent 任务，`pending_approvals` / `pending_questions` 承载未答复的交互。

- `40401`：会话不存在

#### `GET /api/v1/sessions/{session_id}/media/{file_id}`

按文件 id 下载提示词媒体文件（会话提示词引用的图片或其他附件）；尚未提交到会话的 id 会回退到暂存的上传中查找。响应为二进制并支持 `Range`（范围请求返回 206）——共享约定见 [二进制与流式端点](#二进制与流式端点)；与那里走信封的端点不同，会话或文件不存在时会返回真正的 404 状态码并携带信封体。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | **必填。** 会话 id |
| `file_id` | path | string | **必填。** 媒体文件 id |

### 消息与转录

`messages` 端点分页返回 main agent 的扁平化消息历史，`transcript` 端点则提供按 Agent 组织的结构化转录——轮次、任务、交互、附件——即 WebSocket [转录协议](#转录协议) 实时流式推送的内容。历史分页与补漏用这些端点，实时尾部用 WebSocket 订阅。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/v1/sessions/{session_id}/messages` | 消息分页（`before_id` / `after_id` / `role`） |
| `GET /api/v1/sessions/{session_id}/messages/{message_id}` | 读取单条消息 |
| `GET /api/v1/sessions/{session_id}/transcript` | 按轮次分页的转录（需 `agent_id`）；全局状态不分页随响应返回 |
| `GET /api/v1/sessions/{session_id}/transcript/ops` | op 批次补漏（`since_seq`）；`complete: false` 表示需要全量刷新 |
| `GET /api/v1/sessions/{session_id}/transcript/user-messages` | 各轮次起始的用户输入，不分页 |
| `GET /api/v1/sessions/{session_id}/transcript/plan` | ExitPlanMode 计划内容、路径与审阅结果 |

#### `GET /api/v1/sessions/{session_id}/messages`

分页返回 main agent 的消息历史——与会话快照共享的扁平化上下文转录——最新在前。游标分页遵循 [分页](#分页)；读取历史会在会话为冷态时将其恢复。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | **必填。** 会话 id |
| `before_id` | query | string | 只保留早于该消息 id 的消息；与 `after_id` 互斥 |
| `after_id` | query | string | 只保留晚于该消息 id 的消息；与 `before_id` 互斥 |
| `page_size` | query | integer | 1–100。默认 `50` |
| `role` | query | string | 只保留单一角色：`user` / `assistant` / `tool` / `system`。过滤在分页切片之后应用，因此过滤后的一页可能少于 `page_size` 条而 `has_more` 仍为 `true`——持续翻页直到 `has_more` 为 `false` |

成功时，`data` 为 `{ items, has_more }`，其中每个元素是消息对象 `{ id, session_id, role, content, created_at, prompt_id?, parent_message_id?, metadata? }`；`content` 是按 [提示词](#提示词) 中说明的线上格式组成的内容块数组（`text`、`tool_use`、`tool_result`、`image`、`video`、`file`、`thinking`）。

- `40001`：校验失败——例如 `before_id` 与 `after_id` 同用
- `40401`：会话不存在

#### `GET /api/v1/sessions/{session_id}/messages/{message_id}`

按 id 从同一历史中读取单条消息。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | **必填。** 会话 id |
| `message_id` | path | string | **必填。** 消息 id |

成功时，`data` 为上文 `GET /api/v1/sessions/{session_id}/messages` 中说明的元素形态的消息对象。

- `40401`：会话不存在
- `40403`：该会话中不存在此 id 的消息

#### `GET /api/v1/sessions/{session_id}/transcript`

返回某个 Agent 的结构化转录中的一页：轮次（含其步骤与帧）以及轮次之间的标记与任务引用。活跃会话从内存存储应答（先回填所请求 Agent 的持久化历史）；冷会话则从持久化的线上记录重建 Agent。这是转录能力的历史半边——实时流式半边是 [转录协议](#转录协议) 订阅。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | **必填。** 会话 id |
| `agent_id` | query | string | **必填。** 要读取其转录的 Agent；必须是纯文本形式的 agent id（字母、数字、`.`、`_`、`-`——不含路径分隔符） |
| `before_turn` | query | string | 只保留早于该轮次 id 的轮次；与 `after_turn` 互斥 |
| `after_turn` | query | string | 只保留晚于该轮次 id 的轮次；与 `before_turn` 互斥 |
| `page_size` | query | integer | 1–100 个轮次。默认 `20` |

分页单位是轮次：不带游标时返回最新的一页，`has_more` 表示还有更早的轮次。成功时，`data` 为 `{ agent_id, items, has_more, tasks, interactions, attachments, todos, meta, agents, pending_interactions, seq? }`——`items` 是本次分页的轮次切片，`tasks` / `interactions` / `attachments` / `todos` / `meta` / `agents` / `pending_interactions` 是不分页、随每次响应一起返回的全局 Agent 状态，`seq` 是该 Agent 用于恢复流的 op 批次水位（仅活跃会话）。

- `40001`：校验失败——`before_turn` 与 `after_turn` 同用，或 `agent_id` 不是纯文本形式
- `40401`：会话不存在

#### `GET /api/v1/sessions/{session_id}/transcript/ops`

从服务端的 op 日志提供点对点的补漏：某个 Agent 的 `seq > since_seq` 的已记录 op 批次，最旧在前。它是 [转录协议](#转录协议) 中 `transcript_since` 恢复游标的 REST 对应物，共享同一份有界日志，因此适用相同的回退规则。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | **必填。** 会话 id |
| `agent_id` | query | string | **必填。** Agent id（纯文本形式，约束与转录端点相同） |
| `since_seq` | query | integer | **必填。** 调用方已应用的最后一个 op 批次 seq，最小为 `0`；返回其之后的批次 |

成功时，`data` 为 `{ agent_id, batches, latest_seq, complete }`，每个批次为 `{ seq, ops }`。`complete: true` 表示直到 `latest_seq` 的每个批次都在；`complete: false` 表示日志已不再覆盖到 `since_seq`（或会话根本不是活跃状态），调用方必须回退为一次完整的 `GET .../transcript` 刷新。

- `40001`：校验失败
- `40401`：会话不存在

#### `GET /api/v1/sessions/{session_id}/transcript/user-messages`

列出会话中每个开启轮次的输入，按 Agent 分组且不分页：真实用户文本、以斜杠命令形式使用的 Skill 与插件命令、以及 cron 提示词——可通过 `origin` 区分——另有仅含附件的提示词，其 `prompt` 投影为空。所列消息引用的附件实体会随响应一起返回（仅元数据，绝不包含字节内容）。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | **必填。** 会话 id |
| `agent_id` | query | string | 只读取一个 Agent（纯文本 id）。默认读取所有在册 Agent |

成功时，`data` 为 `{ agents }`，每个条目为 `{ agent_id, messages, attachments }`；消息为 `{ turn_id, ordinal, state, origin, prompt, attachment_ids?, started_at? }`，其中 `state` 为轮次状态（`queued` / `running` / `completed` / `failed` / `cancelled`）。

- `40001`：校验失败——`agent_id` 不是纯文本形式
- `40401`：会话不存在

#### `GET /api/v1/sessions/{session_id}/transcript/plan`

按时间线顺序读取某个 Agent 的 `ExitPlanMode` 工具调用的计划信息——计划内容、计划文件路径、提供的选项以及审阅结果。内容投影自第一个可用的事实来源：关联的审批交互（交互式审阅）、实时工具帧的展示（auto 模式），或工具结果的输出文本；每个条目在 `source` 中记录了具体来源。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | **必填。** 会话 id |
| `agent_id` | query | string | **必填。** Agent id（纯文本形式） |
| `tool_call_id` | query | string | 将读取范围限定到单次 `ExitPlanMode` 调用；不提供时列出所有可恢复计划内容的调用 |

成功时，`data` 为 `{ agent_id, plans }`，每个计划为 `{ tool_call_id, turn_id, source, plan, path?, options?, review? }`：`source` 为 `interaction` / `display` / `output`，`options` 是审阅选项，形如 `{ label, description? }`，`review`（仅交互式审阅时存在）为 `{ state, selected_option?, feedback? }`，其中 `state` 为 `pending` / `approved` / `rejected` / `cancelled` 之一。

- `40001`：校验失败
- `40401`：会话不存在
- `40416`：提供了 `tool_call_id`，但不存在该 id 的 `ExitPlanMode` 调用

### 提示词

提示词是一次用户输入的单位：提交一条提示词会把它排入会话的 main agent（或指定 Agent）的队列，排队中的提示词可以插入进行中的轮次，运行中的提示词可以中止。轮次进度本身通过 WebSocket [事件](#事件) 流式推送，不经过这些端点。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/v1/sessions/{session_id}/prompts` | 进行中与排队中的提示词 |
| `POST /api/v1/sessions/{session_id}/prompts` | 提交提示词（内容块数组，可带模型 / 权限模式覆盖） |
| `POST /api/v1/sessions/{session_id}/prompts:steer` | 把排队的提示词插入进行中的轮次 |
| `POST /api/v1/sessions/{session_id}/prompts/{prompt_id}:abort` | 中止运行中的提示词 |
| `POST /api/v1/sessions/{session_id}/prompts/{prompt_id}:steer` | 插入单条排队的提示词 |

#### `GET /api/v1/sessions/{session_id}/prompts`

读取 main agent 的提示词队列快照。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | **必填。** 会话 id |

成功时，`data` 为 `{ active, queued }`：`active` 是运行中的提示词（空闲时为 `null`），`queued` 按顺序列出等待中的提示词。提示词为 `{ prompt_id, user_message_id, status, content, created_at }`，其中 `status` 为 `running` / `queued` / `blocked` 之一，`content` 采用 `POST /api/v1/sessions/{session_id}/prompts` 接受的内容块格式。

- `40401`：会话不存在

#### `POST /api/v1/sessions/{session_id}/prompts`

向会话提交一条用户提示词。先校验媒体引用，然后把可选的覆盖项应用到目标 Agent——`profile`（与 `model` / `thinking` 一起绑定），接着是 `model`、`thinking`、`permission_mode` 和 `disabled_tools`——随后提示词入队；响应在提示词被接受后立即返回，不等待轮次执行。提供 `skills` 时，提示词以打包的 Skill 激活方式运行，而不是普通用户提示词。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | **必填。** 会话 id |
| `content` | body | array | **必填。** 非空的内容块数组；变体见下 |
| `agent_id` | body | string | 目标 Agent。默认为 main agent |
| `prompt_id` | body | string | 客户端选定的提示词 id，用于幂等提交；已被进行中提示词占用的 id 返回 `40927`，已完成的返回 `40903`。不能与 `skills` 同用 |
| `skills` | body | array | 打包的 Skill 激活，至少 1 个 `{ name, args? }` 条目；每个 Skill 必须存在且可由用户激活 |
| `profile` | body | string | 提交前要绑定的 Agent 档案 |
| `model` | body | string | 要切换到的模型别名 |
| `thinking` | body | string | Thinking 强度等级 |
| `permission_mode` | body | string | `manual` / `yolo` / `auto` |
| `disabled_tools` | body | array | 要为会话禁用的工具名 |

schema 还接受 `metadata`、`plan_mode`、`swarm_mode`、`goal_objective` 和 `goal_control`，但提交路由当前不会应用它们。每个 `content` 内容块是按 `type` 区分的对象：

| 内容块 | 字段 | 说明 |
| --- | --- | --- |
| `text` | `text` | 纯文本 |
| `image` / `video` | `source` | 媒体输入；`source` 为 `{ kind: "url", url, id? }`、`{ kind: "base64", media_type, data }`、`{ kind: "file", file_id }`（来自 `POST /api/v1/files` 的上传）或 `{ kind: "session_media", file_id }`（已提交到本会话的媒体）之一 |
| `file` | `file_id`、`name`、`media_type`、`size` | 通过 `POST /api/v1/files` 上传的文件附件 |

schema 还接受共享消息格式中的 `tool_use`、`tool_result` 和 `thinking` 内容块，但它们在用户提示词中没有意义。未知或 kind 不匹配的 `file_id` 引用会在提示词创建之前、任何覆盖项应用之前被拒绝。

成功时，`data` 为被接受的提示词 `{ prompt_id, user_message_id, status, content, created_at }`。

- `40001`：校验失败——例如 `prompt_id` 与 `skills` 同用，或未知的 `profile`
- `40110`：尚未配置供应商——请先完成登录
- `40111`：解析出的供应商没有凭据（`details.provider_id`）
- `40112`：供应商的凭据被拒绝（`details.provider_id`）
- `40113`：模型无法解析（已知时带 `details.model_id` / `details.provider_id`）
- `40401`：会话不存在
- `40407`：引用的 `file_id` 不存在（或与内容块的媒体 kind 不匹配）
- `40415`：某个 `skills` 条目指向未知的 Skill
- `40903`：`prompt_id` 属于已完成的提示词；`data` 携带 `{ aborted: false }`
- `40912`：Skill 存在但无法由用户激活
- `40927`：`prompt_id` 已被进行中的提示词占用

#### `POST /api/v1/sessions/{session_id}/prompts:steer`

把排队的提示词插入进行中的轮次，让运行中的轮次立即消费它们，而不是先运行结束。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | **必填。** 会话 id |
| `prompt_ids` | body | array | **必填。** 非空的排队提示词 id 数组 |

成功时，`data` 为 `{ steered: true, prompt_ids }`。

- `40001`：校验失败
- `40401`：会话不存在
- `40402`：所列提示词 id 不在队列中

#### `POST /api/v1/sessions/{session_id}/prompts/{prompt_id}:abort`

中止运行中的提示词。本端点与下面的 `:steer` 通过同一条路由 `POST /api/v1/sessions/{session_id}/prompts/{tail}` 分发：尾部解析为 `{prompt_id}:{action}`，动作缺失或未知时返回 `40001`（`unsupported action: ...`）。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | **必填。** 会话 id |
| `prompt_id` | path | string | **必填。** 提示词 id |

成功时，`data` 为 `{ aborted: true }`。

- `40401`：会话不存在
- `40402`：不存在该 id 的提示词
- `40903`：提示词已完成；`data` 携带 `{ aborted: false }`

#### `POST /api/v1/sessions/{session_id}/prompts/{prompt_id}:steer`

把单条排队的提示词插入进行中的轮次——是 `POST /api/v1/sessions/{session_id}/prompts:steer` 的单提示词形式。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | **必填。** 会话 id |
| `prompt_id` | path | string | **必填。** 排队中的提示词 id |

成功时，`data` 为 `{ steered: true, prompt_ids: [prompt_id] }`。

- `40401`：会话不存在
- `40402`：没有该 id 的排队提示词

### 审批与提问

审批与提问是会话的两类待处理交互：审批是为工具调用请求许可，提问是请求带标签选项的结构化输入。这些端点用于列出和答复它们；新的请求通过 WebSocket 以 `event.approval.requested` 与 `event.question.requested` 到达。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/v1/sessions/{session_id}/approvals` | 列出待处理的审批请求（必须 `status=pending`） |
| `POST /api/v1/sessions/{session_id}/approvals/{approval_id}` | 答复审批 |
| `GET /api/v1/sessions/{session_id}/questions` | 列出待处理的提问（必须 `status=pending`） |
| `POST /api/v1/sessions/{session_id}/questions/{question_id}` | 回答提问 |
| `POST /api/v1/sessions/{session_id}/questions/{question_id}:dismiss` | 忽略提问 |

#### `GET /api/v1/sessions/{session_id}/approvals`

列出会话待处理的审批请求——即工具调用发起的权限提示。读取列表会在会话为冷态时将其恢复。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | **必填。** 会话 id |
| `status` | query | string | **必填。** 必须为 `pending` |

成功时，`data` 为 `{ items }`，每个元素为 `{ approval_id, session_id, turn_id?, tool_call_id, tool_name, action, tool_input_display, created_at, expires_at }`：`tool_name` / `action` / `tool_input_display` 描述等待许可的调用，`expires_at` 为 `created_at` 之后 24 小时。

- `40001`：`status` 缺失或不是 `pending`
- `40401`：会话不存在

#### `POST /api/v1/sessions/{session_id}/approvals/{approval_id}`

答复一个待处理的审批请求，让等待中的工具调用继续执行（或不执行）。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | **必填。** 会话 id |
| `approval_id` | path | string | **必填。** 审批请求 id |
| `decision` | body | string | **必填。** `approved` / `rejected` / `cancelled` |
| `scope` | body | string | 配合 `approved` 使用，`session`（唯一取值）还会让该审批规则在会话的剩余时间内被记住 |
| `feedback` | body | string | 回传给 Agent 的自由文本反馈 |
| `selected_label` | body | string | 当请求提供了带标签的选项时（例如计划审阅），所选选项的标签 |

成功时，`data` 为 `{ resolved: true, resolved_at }`。

- `40001`：校验失败
- `40401`：会话不存在
- `40404`：没有该 id 的待处理审批
- `40902`：审批已被答复；`data` 携带 `{ resolved: false }`

#### `GET /api/v1/sessions/{session_id}/questions`

列出会话待处理的提问。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | **必填。** 会话 id |
| `status` | query | string | **必填。** 必须为 `pending` |

成功时，`data` 为 `{ items }`，每个元素为 `{ question_id, session_id, turn_id?, tool_call_id?, questions, created_at }`。`questions` 包含 1–4 个 `{ id, question, header?, body?, options, multi_select?, allow_other?, other_label?, other_description? }` 条目，每个条目带 2–4 个 `{ id, label, description? }` 形式的 `options`；`multi_select` 允许选择多个选项，`allow_other` 允许自由文本回答。

- `40001`：`status` 缺失或不是 `pending`
- `40401`：会话不存在

#### `POST /api/v1/sessions/{session_id}/questions/{question_id}`

回答一个待处理的提问。两个提问端点通过同一条路由 `POST /api/v1/sessions/{session_id}/questions/{tail}` 分发：单独的提问 id 表示回答问题，`{question_id}:dismiss` 尾部表示忽略问题，其他情况返回 `40001`。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | **必填。** 会话 id |
| `question_id` | path | string | **必填。** 提问 id |
| `answers` | body | object | **必填。** 提问条目 id（`q_0`……）到答案对象的映射；变体见下 |
| `method` | body | string | 答案的产生方式：`enter` / `space` / `number_key` / `click` |
| `note` | body | string | 附在回答上的自由文本备注 |

每个答案是按 `kind` 区分的对象：

| kind 值 | 字段 | 说明 |
| --- | --- | --- |
| `single` | `option_id` | 选中的单个选项 |
| `multi` | `option_ids` | 选中的多个选项（至少 1 个） |
| `other` | `text` | 自由文本回答 |
| `multi_with_other` | `option_ids`、`other_text` | 选项加自由文本 |
| `skipped` | — | 跳过了该条目 |

成功时，`data` 为 `{ resolved: true, resolved_at }`。

- `40001`：校验失败（`details` 列出每个字段）
- `40401`：会话不存在
- `40405`：没有该 id 的待处理提问
- `40902`：提问已被答复；`data` 携带 `{ resolved: false }`

#### `POST /api/v1/sessions/{session_id}/questions/{question_id}:dismiss`

忽略一个待处理的提问，不作回答。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | **必填。** 会话 id |
| `question_id` | path | string | **必填。** 提问 id |

成功时信封的 `code` 是 `40909`（`question dismissed`）而不是 `0`，`data` 为 `{ dismissed: true, dismissed_at }`——客户端必须特殊处理该端点的成功码。

- `40401`：会话不存在
- `40405`：没有该 id 的待处理提问
- `40902`：提问已被答复；`data` 携带 `{ resolved: false }`

### 后台任务

后台任务是会话的异步单元——后台 Shell、subagent 与长时间运行的工具任务。注册表仅包含实时数据：未加载到本服务进程中的会话会返回空列表。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/v1/sessions/{session_id}/tasks` | 列出后台任务 |
| `GET /api/v1/sessions/{session_id}/tasks/{task_id}` | 读取任务（可选输出预览） |
| `POST /api/v1/sessions/{session_id}/tasks/{task_id}:cancel` | 取消任务 |

#### `GET /api/v1/sessions/{session_id}/tasks`

列出会话的后台任务。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | **必填。** 会话 id |
| `status` | query | string | 只保留单一状态：`running` / `completed` / `failed` / `cancelled` |

成功时，`data` 为 `{ items }`，每个元素是任务对象 `{ id, session_id, kind, description, status, created_at, started_at?, completed_at?, command?, model?, thinking_effort?, agent_id?, subagent_type?, parent_tool_call_id?, output_preview?, output_bytes? }`。`kind` 为 `bash` / `subagent` / `tool`；`command` 仅在 `bash` 任务时设置，模型与 Agent 字段仅在 `subagent` 任务时设置，输出字段仅在以 `with_output` 读取任务时设置。超时与丢失的任务上报为 `failed`；被杀死的任务上报为 `cancelled`。

- `40001`：校验失败——未知的 `status`
- `40401`：会话不存在

#### `GET /api/v1/sessions/{session_id}/tasks/{task_id}`

读取单个后台任务，可选携带输出的末尾片段。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | **必填。** 会话 id |
| `task_id` | path | string | **必填。** 任务 id |
| `with_output` | query | boolean | 在响应中包含输出末尾片段。默认 `false` |
| `output_bytes` | query | integer | 请求的输出末尾片段的字节大小，最小 `0`。默认 `32768` |

成功时，`data` 为上文 `GET /api/v1/sessions/{session_id}/tasks` 中说明的任务对象；当 `with_output=true` 且输出非空时，`output_preview` 携带末尾片段文本，`output_bytes` 为其字节长度。

- `40001`：校验失败
- `40401`：会话不存在
- `40406`：没有该 id 的任务（冷会话完全没有实时任务）

#### `POST /api/v1/sessions/{session_id}/tasks/{task_id}:cancel`

取消运行中的任务。它通过 `POST /api/v1/sessions/{session_id}/tasks/{tail}` 分发，`cancel` 是唯一的动作——单独的任务 id 或未知动作返回 `40001`。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | **必填。** 会话 id |
| `task_id` | path | string | **必填。** 任务 id |

成功时，`data` 为 `{ cancelled: true }`。

- `40001`：动作后缀缺失或未知
- `40401`：会话不存在
- `40406`：没有该 id 的任务
- `40904`：任务已结束；`data` 携带 `{ cancelled: false }`，`details.current_status` 为最终状态

### 技能、工具与 MCP

这组端点暴露会话或工作区可见的技能目录、当前生效 agent 的工具列表及其 MCP 服务。技能激活与 MCP 重启使用 `:{action}` 约定；激活即斜杠命令 `/<skill>` 的 REST 等价形式。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/v1/sessions/{session_id}/skills` | 会话级技能目录 |
| `GET /api/v1/workspaces/{workspace_id}/skills` | 无会话的工作区技能目录 |
| `POST /api/v1/sessions/{session_id}/skills/{skill_name}:activate` | 激活技能（开启一个轮次） |
| `GET /api/v1/tools` | 列出当前生效 agent 的工具 |
| `GET /api/v1/mcp/servers` | 列出 MCP 服务 |
| `POST /api/v1/mcp/servers/{mcp_server_id}:restart` | 重启 MCP 服务 |

#### `GET /api/v1/sessions/{session_id}/skills`

列出单个会话可用的技能，按会话的优先级合并所有来源（内置、插件、extra、用户、项目）。会话处于冷态时，读取目录会恢复该会话。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | **必填。** 会话 id |

成功时 `data` 为 `{ skills }`，每项是一个技能描述符 `{ name, description, path, source, type?, disable_model_invocation? }`：`source` 为 `project` / `user` / `extra` / `builtin`；`type` 标识技能类别（只有用户可激活的类型才能被激活）；`disable_model_invocation` 会让技能对模型不可见。

- `40401`：会话不存在（或未激活）

#### `GET /api/v1/workspaces/{workspace_id}/skills`

列出该工作区中的会话将看到的技能目录，但不创建或恢复会话——即针对工作区根目录计算出的同一套内置、插件、extra、用户、项目来源合并结果。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `workspace_id` | path | string | **必填。** 已注册工作区 id |

成功时 `data` 为 `{ skills }`，技能描述符见上文 `GET /api/v1/sessions/{session_id}/skills` 的说明。

- `40410`：工作区不存在

#### `POST /api/v1/sessions/{session_id}/skills/{skill_name}:activate`

在会话中激活技能——即斜杠命令 `/<skill>` 的 REST 等价形式——以技能内容加上 `args` 与附件在 main agent 上开启一个轮次。该端点经单一路由 `POST /api/v1/sessions/{session_id}/skills/{tail}` 分发：尾部按 `{skill_name}:{action}` 解析，`activate` 是唯一动作；只给名称或动作未知时返回 `40001`（`unsupported action: ...`）。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | **必填。** 会话 id |
| `skill_name` | path | string | **必填。** 要激活的技能名 |
| `args` | body | string | 传给技能的自由文本参数，相当于斜杠命令后的文本 |
| `attachments` | body | array | 随激活携带的媒体块。`image` / `video` 块带 `source` 对象（`kind` 为 `url` / `base64` / `file` / `session_media`，与提示词内容块同形）；`file` 块带顶层 `file_id`、`name`、`media_type`、`size` |

成功时 `data` 为 `{ activated: true, skill_name }`。

- `40001`：校验失败或动作后缀不支持
- `40401`：会话不存在（或未激活）
- `40407`：引用的附件文件不存在
- `40415`：没有该名称的技能
- `40912`：技能存在，但其类型不允许用户激活

#### `GET /api/v1/tools`

列出当前生效 agent 的工具——即 `session_id` 指定会话的 main agent；省略参数时取最近创建的会话。若该会话不在本服务进程中存活，列表为空。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | query | string | 要查看其 main agent 的会话。默认最近创建的会话 |

成功时 `data` 为 `{ tools }`，每项为 `{ name, description, input_schema, source, mcp_server_id?, active? }`：`source` 为 `builtin` / `skill` / `mcp`；`mcp_server_id` 仅 MCP 工具携带（从 `mcp__<server>__<tool>` 名称解析）；`active` 报告工具策略的判定结果。`input_schema` 目前恒为 `null`。

#### `GET /api/v1/mcp/servers`

列出当前生效 agent 配置的 MCP 服务（与 `GET /api/v1/tools` 相同，取最近创建的存活会话的 main agent）。没有存活会话时列表为空。

成功时 `data` 为 `{ servers }`，每项为 `{ id, name, transport, status, last_error?, tool_count }`：`transport` 为 `stdio` / `http` / `sse`；`status` 为 `connected` / `connecting` / `disconnected` / `error`；服务处于 `error` 时 `last_error` 携带失败信息。

#### `POST /api/v1/mcp/servers/{mcp_server_id}:restart`

重新连接当前生效 agent 的某个 MCP 服务。该端点经 `POST /api/v1/mcp/servers/{tail}` 分发，`restart` 是唯一动作——只给服务 id 或动作未知时返回 `40001`。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `mcp_server_id` | path | string | **必填。** MCP 服务 id（即其配置名称） |

成功时 `data` 为 `{ restarting: true }`。

- `40001`：缺少动作后缀或动作未知
- `40408`：没有该 id 的 MCP 服务（无存活会话时同样返回此错误）

### 能力与插件

能力是带有分层就绪状态的内置特性——由检测步骤加后台安装组成；当前版本注册了 `kimi-cu`（Kimi Computer Use）与 `kimi-webbridge`（Kimi WebBridge）。插件是已安装的技能、MCP 服务、hook 与命令的打包集合。这组端点报告能力状态、驱动能力安装，并管理插件从市场列表到移除的整个生命周期。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/v1/capabilities` | 列出内置能力及其就绪状态 |
| `GET /api/v1/capabilities/{capability_id}` | 读取单个能力的状态 |
| `POST /api/v1/capabilities/{capability_id}:install` | 开始安装能力（后台进行，轮询 GET 查看进度） |
| `GET /api/v1/plugins` | 列出已安装插件 |
| `POST /api/v1/plugins` | 从本地路径、zip URL 或 GitHub 仓库安装插件 |
| `GET /api/v1/plugins/marketplace` | 插件市场目录，合并实时安装状态 |
| `POST /api/v1/plugins/{plugin_id}:{action}` | 插件动作：`enable` / `disable` / `remove` |

#### `GET /api/v1/capabilities`

列出所有已注册能力及其就绪状态。

成功时 `data` 为 `{ capabilities }`，每项是一个能力状态对象 `{ id, pluginId?, displayName, description, supported, state, version?, steps, install }`。`state` 为 `ready`（所有必需检测步骤均为 `ok`）/ `partial`（部分步骤 `ok`）/ `not_installed` / `unsupported`（当前平台/架构不可用）；`steps` 以 `{ id, state, detail?, optional? }` 列出各检测步骤，其 `state` 为 `ok` / `missing` / `failed` 之一；`install` 为安装进度 `{ running, step?, percent?, error?, note? }`，其中 `percent` 取值 0 到 100。

#### `GET /api/v1/capabilities/{capability_id}`

读取单个能力的就绪状态——即 `:install` 动作的轮询对应端点。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `capability_id` | path | string | **必填。** 能力 id |

成功时 `data` 为上文 `GET /api/v1/capabilities` 说明的能力状态对象。

- `40418`：没有该 id 的能力

#### `POST /api/v1/capabilities/{capability_id}:install`

在后台开始安装能力并立即返回当前状态（`install.running` 为 `true`）；轮询 `GET /api/v1/capabilities/{capability_id}` 查看进度。该端点经 `POST /api/v1/capabilities/{tail}` 分发，`install` 是唯一动作——只给 id 或动作未知时返回 `40001`。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `capability_id` | path | string | **必填。** 能力 id |

成功时 `data` 为上文 `GET /api/v1/capabilities` 说明的能力状态对象。

- `40001`：缺少动作后缀或动作未知
- `40418`：没有该 id 的能力
- `40924`：该能力的安装已在进行中
- `40925`：当前平台/架构不支持该能力

#### `GET /api/v1/plugins`

列出已安装插件。

成功时 `data` 为 `{ plugins }`，每项为 `{ id, displayName, version?, enabled, state, skillCount, mcpServerCount, enabledMcpServerCount, hookCount, commandCount, hasErrors, source, originalSource?, github? }`：`state` 为 `ok` / `error`（加载失败也会置 `hasErrors`）；`source` 为 `local-path` / `zip-url` / `github`；GitHub 来源的插件由 `github` 携带来源信息 `{ owner, repo, ref, installedSha? }`，其中 `ref` 为 `{ kind: branch|tag|sha, value }`。

#### `POST /api/v1/plugins`

安装插件并返回其摘要。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `source` | body | string | **必填。** 安装来源：本地绝对路径、指向 zip 压缩包的 `http(s)` URL，或 GitHub URL——`https://github.com/<owner>/<repo>`，可选地用 `/tree/<branch-or-sha>`、`/releases/tag/<tag>` 或 `/commit/<sha>` 锁定版本 |

成功时 `data` 为上文 `GET /api/v1/plugins` 说明的插件摘要。

- `40001`：校验失败——例如 `source` 既不是 URL 也不是绝对路径，或插件加载失败
- `40409`：本地路径不存在

#### `GET /api/v1/plugins/marketplace`

列出插件市场目录并合并实时安装状态。目录按请求从配置的市场 URL 拉取（超时 10 秒）；使用默认目录时，目录中缺少的内置能力会作为条目合并进来（带 `capabilityId`），而当前平台不支持的能力对应条目会被剔除。

成功时 `data` 为 `{ entries }`，每项为 `{ id, tier, displayName, description?, homepage?, keywords?, version?, source, installed?, updateAvailable?, capabilityId? }`：`tier` 为 `official` / `curated` / `third-party`；插件已安装时 `installed` 为 `{ version?, enabled }`；`updateAvailable` 标记目录版本新于已安装版本的条目。条目的 `source` 即 `POST /api/v1/plugins` 的 `source` 字段取值。

- `50001`：市场不可达或返回了非法目录

#### `POST /api/v1/plugins/{plugin_id}:enable`

启用一个已安装插件。插件动作经单一路由 `POST /api/v1/plugins/{tail}` 分发：尾部按 `{plugin_id}:{action}` 解析，动作为 `enable` / `disable` / `remove`；只给 id 或动作未知时返回 `40001`（`unsupported action: ...`）。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `plugin_id` | path | string | **必填。** 已安装插件 id |

成功时 `data` 为 `{ ok: true }`。

- `40001`：缺少动作后缀或动作未知
- `40419`：没有该 id 的已安装插件

#### `POST /api/v1/plugins/{plugin_id}:disable`

停用一个已安装插件但不移除它；分发约定同上文 `:enable`。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `plugin_id` | path | string | **必填。** 已安装插件 id |

成功时 `data` 为 `{ ok: true }`。

- `40001`：缺少动作后缀或动作未知
- `40419`：没有该 id 的已安装插件

#### `POST /api/v1/plugins/{plugin_id}:remove`

移除一个已安装插件；分发约定同上文 `:enable`。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `plugin_id` | path | string | **必填。** 已安装插件 id |

成功时 `data` 为 `{ ok: true }`。

- `40001`：缺少动作后缀或动作未知
- `40419`：没有该 id 的已安装插件

### 终端

PTY 终端接口；仅在 loopback 绑定时挂载（非 loopback 绑定会跳过它们，除非传入 `--allow-remote-terminals`）。终端的输入、输出与尺寸调整经 WebSocket 的 `terminal_*` 帧传输——REST 侧只管理终端生命周期。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/v1/sessions/{session_id}/terminals` | 列出终端 |
| `POST /api/v1/sessions/{session_id}/terminals` | 创建终端 |
| `GET /api/v1/sessions/{session_id}/terminals/{terminal_id}` | 读取终端 |
| `POST /api/v1/sessions/{session_id}/terminals/{terminal_id}:close` | 关闭终端 |

#### `GET /api/v1/sessions/{session_id}/terminals`

列出会话的终端。会话处于冷态时，读取列表会恢复该会话。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | **必填。** 会话 id |

成功时 `data` 为 `{ items }`，每项是一个终端对象 `{ id, session_id, cwd, shell, cols, rows, status, created_at, exited_at?, exit_code? }`：`status` 为 `running` / `exited`；已退出的终端携带 `exited_at` 与 `exit_code`（进程未报告退出码时为 `null`，例如因信号终止）。回滚缓冲不属于该对象——输出经 WebSocket 回放与流式推送。

- `40401`：会话不存在

#### `POST /api/v1/sessions/{session_id}/terminals`

为会话创建一个 PTY 终端。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | **必填。** 会话 id |
| `runtime_id` | body | string | 生成终端进程的运行时。默认 `local` |
| `cwd` | body | string | 工作目录，相对于会话工作区（传绝对路径会校验失败）。默认工作区根目录 |
| `shell` | body | string | Shell 可执行文件。默认该运行时的 shell |
| `cols` | body | integer | 终端宽度，正数。默认 `80` |
| `rows` | body | integer | 终端高度，正数。默认 `24` |

成功时 `data` 为上文 `GET /api/v1/sessions/{session_id}/terminals` 说明的终端对象。

- `40001`：校验失败（`details` 逐字段说明）
- `40401`：会话不存在
- `41304`：`cwd` 解析后越出会话工作区

#### `GET /api/v1/sessions/{session_id}/terminals/{terminal_id}`

读取单个终端。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | **必填。** 会话 id |
| `terminal_id` | path | string | **必填。** 终端 id |

成功时 `data` 为上文 `GET /api/v1/sessions/{session_id}/terminals` 说明的终端对象。

- `40401`：会话不存在
- `40414`：没有该 id 的终端

#### `POST /api/v1/sessions/{session_id}/terminals/{terminal_id}:close`

关闭终端并结束其进程。该端点经 `POST /api/v1/sessions/{session_id}/terminals/{tail}` 分发，`close` 是唯一动作——只给 id 或动作未知时返回 `40001`。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | **必填。** 会话 id |
| `terminal_id` | path | string | **必填。** 终端 id |

成功时 `data` 为 `{ closed: true }`。

- `40001`：缺少动作后缀或动作未知
- `40401`：会话不存在
- `40414`：没有该 id 的终端

### 工作区

工作区是已注册的项目目录，会话都落在其中。这组端点管理注册表——列出、注册、重命名、注销——以及控制项目级 MCP 配置是否加载的每工作区信任状态。所有返回工作区的端点都使用 [workspace 对象](#workspace-对象) 中统一说明的传输结构。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/v1/workspaces` | 列出已注册工作区 |
| `POST /api/v1/workspaces` | 注册工作区（按根路径幂等） |
| `PATCH /api/v1/workspaces/{workspace_id}` | 重命名 |
| `DELETE /api/v1/workspaces/{workspace_id}` | 注销（保留磁盘内容） |
| `GET /api/v1/workspaces/{workspace_id}/trust` | 读取信任状态 |
| `POST /api/v1/workspaces/{workspace_id}/trust` | 授予信任 |
| `POST /api/v1/workspaces/{workspace_id}/untrust` | 撤销信任 |

#### workspace 对象

所有返回工作区的端点都使用此传输结构。注册与重命名会广播全局事件 `event.workspace.created` / `event.workspace.updated`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 工作区 id，由根路径派生的 `wd_<slug>_<hash12>` 字符串 |
| `root` | string | 项目目录的绝对路径 |
| `name` | string | 显示名，1–100 个字符；默认取根目录的基名 |
| `created_at` | string | 注册时间，ISO 8601 |
| `last_opened_at` | string | 最近一次打开或重新注册工作区的时间，ISO 8601 |
| `session_count` | integer | 工作区内的会话数 |

#### `GET /api/v1/workspaces`

列出所有已注册工作区。

成功时 `data` 为 `{ items }`，每项是一个 [workspace 对象](#workspace-对象)。

#### `POST /api/v1/workspaces`

注册工作区并返回它。注册按根路径幂等：重复注册同一根路径会返回已存在的工作区，仅刷新 `last_opened_at`（保留已存名称），并广播 `event.workspace.updated` 而非 `event.workspace.created`。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `root` | body | string | **必填。** 已存在目录的绝对路径 |
| `name` | body | string | 显示名，1–100 个字符。默认根目录的基名 |

成功时 `data` 为 [workspace 对象](#workspace-对象)。

- `40001`：`root` 缺失或不是绝对路径（`details` 会列出该字段）
- `40409`：`root` 不存在或不是目录

#### `PATCH /api/v1/workspaces/{workspace_id}`

重命名工作区——仅修改显示名，根路径不变。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `workspace_id` | path | string | **必填。** 工作区 id |
| `name` | body | string | **必填。** 新的显示名，1–100 个字符 |

成功时 `data` 为 [workspace 对象](#workspace-对象)。

- `40001`：校验失败（`details` 逐字段说明）
- `40410`：工作区不存在

#### `DELETE /api/v1/workspaces/{workspace_id}`

注销工作区。只移除注册表条目——磁盘上的目录不受影响。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `workspace_id` | path | string | **必填。** 工作区 id |

成功时 `data` 为 `{ deleted: true }`。

- `40410`：工作区不存在

#### `GET /api/v1/workspaces/{workspace_id}/trust`

读取工作区信任状态。信任状态决定是否为该工作区加载项目级 MCP 配置。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `workspace_id` | path | string | **必填。** 工作区 id |

成功时 `data` 为 `{ trusted }`。

- `40410`：工作区不存在

#### `POST /api/v1/workspaces/{workspace_id}/trust`

将工作区标记为信任，并加载其项目级 MCP 配置。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `workspace_id` | path | string | **必填。** 工作区 id |

成功时 `data` 为 `{ trusted: true }`。

- `40410`：工作区不存在

#### `POST /api/v1/workspaces/{workspace_id}/untrust`

撤销工作区信任，并卸载其项目级 MCP 配置。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `workspace_id` | path | string | **必填。** 工作区 id |

成功时 `data` 为 `{ trusted: false }`。

- `40410`：工作区不存在

### 文件系统

会话内文件操作走 `POST /api/v1/sessions/{session_id}/fs:{action}`，请求体为 JSON；动作包括 `list` / `read` / `list_many` / `stat` / `stat_many` / `mkdir` / `search` / `grep` / `git_status` / `diff` / `open` / `open-in` / `reveal`。每个动作的请求体还接受可选的 `runtime_id`（string，默认 `local`），用于选择执行操作的运行时；`open`、`open-in` 与 `reveal` 仅在 `local` 运行时上可用。另有：

| 方法与路径 | 说明 |
| --- | --- |
| `POST /api/v1/workspace/fs:search` | 无会话的工作区搜索（body 携带工作区引用） |
| `POST /api/v1/workspace/fs:suggest` | 无会话的文件补全候选（用于 `@` 文件提及） |
| `GET /api/v1/sessions/{session_id}/fs/{path}:download` | 下载会话文件（二进制，见下文） |
| `GET /api/v1/fs:browse` | 列出本机目录（文件夹选择器用） |
| `GET /api/v1/fs:home` | 用户主目录与最近工作区 |
| `GET /api/v1/fs:content` | 读取本机任意文件原始字节（仅受 token 保护，谨慎暴露端口） |
| `POST /api/v1/fs:mkdir` | 按绝对路径创建目录 |

#### `POST /api/v1/sessions/{session_id}/fs:list`

列出会话工作区目录下的条目，可选递归子目录。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | **必填。** 会话 id |
| `path` | body | string | 要列出的目录，相对于会话工作目录。默认 `.` |
| `depth` | body | integer | 递归深度，1–10。默认 `1` |
| `limit` | body | integer | 最大条目数，1–1000。默认 `200` |
| `show_hidden` | body | boolean | 包含点文件。默认 `false` |
| `follow_gitignore` | body | boolean | 跳过 gitignore 的路径。默认 `true` |
| `exclude_globs` | body | string[] | 额外要跳过的 glob |
| `sort` | body | string | `type_first`（默认）/ `name_asc` / `name_desc` / `mtime_desc` / `size_desc` |
| `include_git_status` | body | boolean | 附带每个条目的 git 状态。默认 `false` |

成功时 `data` 为 `{ items, truncated }`——`depth` 大于 1 时另附 `children_by_path`（路径 → 条目的映射）。每项是一个条目对象 `{ path, name, kind, size?, modified_at, etag?, mime?, language_id?, is_binary?, is_symlink_to?, git_status?, child_count? }`，其中 `kind` 为 `file` / `directory` / `symlink`；`git_status`（仅 `include_git_status: true` 时存在）为 `clean` / `modified` / `added` / `deleted` / `renamed` / `untracked` / `ignored` / `conflicted` 之一；`truncated` 表示 `limit` 截断了列表。

- `40001`：请求体校验失败
- `40401`：会话不存在
- `40409`：路径不存在（包括 `path` 不是目录的情况）
- `41304`：路径越出会话工作区

#### `POST /api/v1/sessions/{session_id}/fs:read`

以文本或 base64 读取会话文件的一段内容。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | **必填。** 会话 id |
| `path` | body | string | **必填。** 文件路径，相对于会话工作目录 |
| `offset` | body | integer | 起始字节偏移。默认 `0` |
| `length` | body | integer | 读取字节数，1–10485760（10 MiB）。默认 `1048576`（1 MiB） |
| `encoding` | body | string | `auto`（默认）/ `utf-8` / `base64` |

成功时 `data` 为 `{ path, content, encoding, size, truncated, etag, mime, language_id?, line_count?, is_binary }`，其中 `encoding` 报告实际使用的编码（`utf-8` 或 `base64`），`size` 为文件完整大小。`encoding: "auto"` 时文本以 `utf-8` 返回（非 UTF-8 文本会被转码），二进制内容以 `base64` 返回；`encoding: "utf-8"` 强制按文本读取并拒绝二进制文件。

- `40001`：请求体校验失败
- `40401`：会话不存在
- `40409`：路径不存在
- `40906`：路径是目录
- `40907`：二进制文件却指定了 `encoding: "utf-8"`
- `41302`：文件超过 10 MiB 读取上限
- `41304`：路径越出会话工作区

#### `POST /api/v1/sessions/{session_id}/fs:list_many`

一次调用列出多个会话目录；失败的路径会折进响应里，而不是让整个请求失败。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | **必填。** 会话 id |
| `paths` | body | string[] | **必填。** 要列出的目录，1–100 条 |

其余请求体字段（`depth`、`limit`、`show_hidden`、`follow_gitignore`、`exclude_globs`、`sort`、`include_git_status`）的类型、取值范围与默认值同 `fs:list`。成功时 `data` 为 `{ results }`——每个请求路径到其条目数组（条目对象见 `fs:list` 的说明）的映射，另附 `truncated_paths`（达到 `limit` 的路径）与 `partial_errors`（失败路径到其 `{ code, msg }` 错误的映射）。

- `40001`：请求体校验失败
- `40401`：会话不存在

#### `POST /api/v1/sessions/{session_id}/fs:stat`

查询会话工作区内单个路径的元信息。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | **必填。** 会话 id |
| `path` | body | string | **必填。** 要查询的路径，相对于会话工作目录 |

成功时 `data` 为 `fs:list` 中说明的条目对象。

- `40001`：请求体校验失败
- `40401`：会话不存在
- `40409`：路径不存在
- `41304`：路径越出会话工作区

#### `POST /api/v1/sessions/{session_id}/fs:stat_many`

一次调用查询多个会话路径的元信息；不存在的路径返回 `null`，不会让整个请求失败。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | **必填。** 会话 id |
| `paths` | body | string[] | **必填。** 要查询的路径，1–1000 条 |

成功时 `data` 为 `{ entries }`——每个请求路径到其条目对象（见 `fs:list` 的说明）的映射，路径不存在时为 `null`。

- `40001`：请求体校验失败
- `40401`：会话不存在

#### `POST /api/v1/sessions/{session_id}/fs:mkdir`

在会话工作区内创建目录。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | **必填。** 会话 id |
| `path` | body | string | **必填。** 要创建的目录，相对于会话工作目录 |
| `recursive` | body | boolean | 创建缺失的父目录。默认 `false` |

成功时 `data` 为所建目录的条目对象（见 `fs:list` 的说明）。

- `40001`：请求体校验失败
- `40401`：会话不存在
- `40409`：父目录不存在（非递归创建）
- `40919`：路径已存在（非递归创建）
- `41304`：路径越出会话工作区

#### `POST /api/v1/sessions/{session_id}/fs:search`

在会话工作区内模糊搜索文件与目录名。`query` 为空时改为列出顶层条目。当 `{session_id}` 位置携带的是工作区引用（已注册工作区 id 或绝对根路径）而非会话 id 时，搜索针对该工作区执行——这是为尚未创建的草稿会话准备的无会话形式；正式的无会话端点是 `POST /api/v1/workspace/fs:search`。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | **必填。** 会话 id，或工作区引用 |
| `query` | body | string | **必填。** 搜索文本；`""` 表示列出顶层 |
| `limit` | body | integer | 最大命中数，1–200。默认 `50` |
| `include_globs` | body | string[] | 只保留匹配这些 glob 之一的路径 |
| `exclude_globs` | body | string[] | 跳过匹配这些 glob 的路径 |
| `follow_gitignore` | body | boolean | 跳过 gitignore 的路径。默认 `true` |

成功时 `data` 为 `{ items, truncated }`，每项为 `{ path, name, kind, score, match_positions }`——`kind` 为 `file` / `directory` / `symlink`，`score` 为 0 到 1 之间的模糊匹配得分，`match_positions` 列出匹配到的字符偏移。命中按得分排序（同分按路径），`truncated` 表示超出 `limit` 的命中被丢弃。

- `40001`：请求体校验失败
- `40401`：该引用既不是会话，也不是可解析的工作区

#### `POST /api/v1/sessions/{session_id}/fs:grep`

在会话工作区内搜索文件内容——默认按字面字符串，`regex: true` 时按正则表达式。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | **必填。** 会话 id |
| `pattern` | body | string | **必填。** 要搜索的文本或正则 |
| `regex` | body | boolean | 将 `pattern` 视为正则表达式。默认 `false` |
| `case_sensitive` | body | boolean | 默认 `true` |
| `include_globs` | body | string[] | 只保留匹配这些 glob 之一的文件 |
| `exclude_globs` | body | string[] | 跳过匹配这些 glob 的文件 |
| `follow_gitignore` | body | boolean | 跳过 gitignore 的路径。默认 `true` |
| `max_files` | body | integer | 最多扫描的文件数，1–10000。默认 `200` |
| `max_matches_per_file` | body | integer | 每个文件保留的匹配数，1–10000。默认 `50` |
| `max_total_matches` | body | integer | 总共保留的匹配数，1–100000。默认 `5000` |
| `context_lines` | body | integer | 每个匹配携带的上下文行数，0–10。默认 `2` |

成功时 `data` 为 `{ files, files_scanned, truncated, elapsed_ms }`，其中 `files` 的每项为 `{ path, matches }`，每个匹配为 `{ line, col, text, before, after }`（`before` / `after` 最多携带 `context_lines` 行上下文）；`truncated` 表示某个匹配配额截断了结果。

- `40001`：请求体校验失败
- `40401`：会话不存在
- `41305`：搜索超时

#### `POST /api/v1/sessions/{session_id}/fs:git_status`

读取会话工作区的 git 状态，可选限定在一组路径内。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | **必填。** 会话 id |
| `paths` | body | string[] | 将状态限定在这些路径；省略表示整个工作区 |

成功时 `data` 为 `{ branch, ahead, behind, entries, additions, deletions, pullRequest }`，其中 `entries` 把每个变更路径映射到其状态（`clean` / `modified` / `added` / `deleted` / `renamed` / `untracked` / `ignored` / `conflicted`），`pullRequest` 为 `{ number, state, url }`（`state` 为 `open` / `merged` / `closed` / `draft`）或 `null`。

- `40001`：请求体校验失败
- `40401`：会话不存在
- `40908`：git 不可用（不是仓库，或没有 git 可执行文件）

#### `POST /api/v1/sessions/{session_id}/fs:diff`

返回会话工作区内单个文件的 unified git diff。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | **必填。** 会话 id |
| `path` | body | string | **必填。** 要 diff 的文件，相对于会话工作目录 |

成功时 `data` 为 `{ path, diff, truncated }`，其中 `diff` 为 unified diff 文本，`truncated` 表示过长的 diff 被截断。

- `40001`：请求体校验失败
- `40401`：会话不存在
- `40908`：git 不可用（不是仓库，或没有 git 可执行文件）
- `41304`：路径越出会话工作区

#### `POST /api/v1/sessions/{session_id}/fs:open`

用宿主操作系统的默认程序打开会话文件。仅限 local 运行时。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | **必填。** 会话 id |
| `path` | body | string | **必填。** 要打开的文件，相对于会话工作目录 |
| `line` | body | integer | 在处理程序支持时跳转到的行号（正整数） |

成功时 `data` 为 `{ opened: true }`。

- `40001`：请求体校验失败
- `40401`：会话不存在
- `40409`：路径不存在
- `41304`：路径越出会话工作区

#### `POST /api/v1/sessions/{session_id}/fs:open-in`

在指定的宿主应用程序中打开会话文件或目录。仅限 local 运行时。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | **必填。** 会话 id |
| `app_id` | body | string | **必填。** 目标应用：`finder` / `cursor` / `vscode` / `iterm` / `terminal` |
| `path` | body | string | **必填。** 要打开的文件或目录，相对于会话工作目录 |
| `line` | body | integer | 在应用支持时跳转到的行号（正整数） |

成功时 `data` 为 `{ opened: true }`。

- `40001`：请求体校验失败
- `40401`：会话不存在
- `40409`：路径不存在
- `41304`：路径越出会话工作区
- `50001`：应用启动失败

#### `POST /api/v1/sessions/{session_id}/fs:reveal`

在宿主操作系统的文件管理器中显示会话文件。仅限 local 运行时。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | **必填。** 会话 id |
| `path` | body | string | **必填。** 要显示的文件，相对于会话工作目录 |

成功时 `data` 为 `{ revealed: true }`。

- `40001`：请求体校验失败
- `40401`：会话不存在
- `40409`：路径不存在
- `41304`：路径越出会话工作区

#### `GET /api/v1/sessions/{session_id}/fs/{path}:download`

从会话工作区下载文件；`{path}` 是相对于工作区的文件路径，并带字面量 `:download` 后缀。响应为支持 Range 与 ETag 的二进制流——见 [二进制与流式端点](#二进制与流式端点)。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | **必填。** 会话 id |
| `path` | path | string | **必填。** 相对于工作区的文件路径，加 `:download` 后缀 |
| `runtime_id` | query | string | 从哪个运行时读取。默认 `local` |

- `40001`：路径缺失或为空
- `40401`：会话不存在
- `40409`：路径不存在
- `41304`：路径越出会话工作区

#### `POST /api/v1/workspace/fs:search`

`fs:search` 的无会话形式：工作区改由请求体而非 URL 携带。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `workspace` | body | string | **必填。** 已注册工作区 id 或绝对根路径（当场注册） |
| `query` | body | string | **必填。** 搜索文本；`""` 表示列出顶层 |
| `limit` | body | integer | 最大命中数，1–200。默认 `50` |
| `include_globs` | body | string[] | 只保留匹配这些 glob 之一的路径 |
| `exclude_globs` | body | string[] | 跳过匹配这些 glob 的路径 |
| `follow_gitignore` | body | boolean | 跳过 gitignore 的路径。默认 `true` |
| `runtime_id` | body | string | 在哪个运行时上搜索。默认 `local` |

成功时 `data` 为 `{ items, truncated }`，命中结构与排序同 `fs:search`。

- `40001`：请求体校验失败
- `40410`：工作区不存在，且不是可用的绝对路径

#### `POST /api/v1/workspace/fs:suggest`

在无会话的情况下给出工作区内的文件与目录补全候选——即输入框中 `@` 文件提及的后端。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `workspace` | body | string | **必填。** 已注册工作区 id 或绝对根路径（当场注册） |
| `query` | body | string | **必填。** 要补全的部分路径文本 |
| `limit` | body | integer | 最大候选数，1–200。默认 `50` |
| `follow_gitignore` | body | boolean | 跳过 gitignore 的路径。默认 `true` |
| `show_hidden` | body | boolean | 包含点文件。默认 `false` |
| `include_globs` | body | string[] | 只保留匹配这些 glob 之一的路径 |
| `exclude_globs` | body | string[] | 跳过匹配这些 glob 的路径 |
| `runtime_id` | body | string | 在哪个运行时上补全。默认 `local` |

成功时 `data` 为 `{ items, truncated }`，每项为 `{ path, name, kind, score, match_positions }`，命中结构同 `fs:search`。

- `40001`：请求体校验失败
- `40410`：工作区不存在，且不是可用的绝对路径

#### `GET /api/v1/fs:browse`

列出某个本机目录的子目录——文件夹选择器的后端。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `path` | query | string | 绝对目录路径。默认用户主目录 |

成功时 `data` 为 `{ path, parent, entries }`，其中 `path` 为解析后的目录，`parent` 为其父目录（文件系统根处为 `null`），每条目为 `{ name, path, is_dir: true }`。

- `40001`：`path` 不是绝对路径
- `40409`：路径不存在
- `40411`：权限不足

#### `GET /api/v1/fs:home`

返回文件夹选择器的落地数据。无参数。

成功时 `data` 为 `{ home, recent_roots }`，其中 `home` 为用户主目录，`recent_roots` 列出已注册工作区的根目录。

#### `GET /api/v1/fs:content`

以流式返回本机文件系统上任意文件的原始字节——仅受 API token 保护，暴露端口时务必谨慎。支持 Range 请求与 ETag 缓存；见 [二进制与流式端点](#二进制与流式端点)。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `path` | query | string | **必填。** 绝对文件路径 |

- `40001`：`path` 不是绝对路径，或不是普通文件
- `40409`：路径不存在
- `40411`：权限不足
- `40906`：路径是目录

#### `POST /api/v1/fs:mkdir`

按绝对路径在本机文件系统上创建一个目录——文件夹选择器「新建文件夹」的后端。非递归：父目录必须已存在。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `path` | body | string | **必填。** 绝对目录路径 |

成功时 `data` 为 `{ path }`。

- `40001`：`path` 不是绝对路径
- `40409`：父路径不存在
- `40411`：权限不足
- `40919`：路径已存在

### 文件上传

| 方法与路径 | 说明 |
| --- | --- |
| `POST /api/v1/files` | multipart 上传（字段 `file`，可选 `name`、`expires_in_sec`），返回文件元信息 |
| `GET /api/v1/files/{file_id}` | 下载（二进制，错误用真实 HTTP 状态码） |
| `DELETE /api/v1/files/{file_id}` | 删除 |

#### `POST /api/v1/files`

以 `multipart/form-data` 上传文件，供后续引用（例如作为提示词附件）。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `file` | body | binary | **必填。** multipart 的文件部分 |
| `name` | body | string | 存储的显示名。默认上传文件名 |
| `expires_in_sec` | body | number | 文件过期前的秒数（非负）。默认永不过期 |

成功时 `data` 为文件元信息 `{ id, name, media_type, size, created_at, expires_at? }`，其中 `media_type` 取自上传的内容类型。

- `40001`：multipart 请求体缺少 `file` 字段

#### `GET /api/v1/files/{file_id}`

下载已上传的文件。响应为二进制流，支持 Range 请求但不处理 `If-None-Match`；失败使用真实 HTTP 状态码——见 [二进制与流式端点](#二进制与流式端点)。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `file_id` | path | string | **必填。** 上传响应返回的文件 id |

- `40407`（HTTP 404）：没有该 id 的文件（包括已过期的文件）

#### `DELETE /api/v1/files/{file_id}`

删除已上传的文件。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `file_id` | path | string | **必填。** 上传响应返回的文件 id |

成功时 `data` 为 `{ deleted: true }`。

- `40407`（HTTP 404）：没有该 id 的文件

### GUI 存储

由服务端支撑的键值存储，接口对齐浏览器的 `localStorage`，持久化在服务的 home 目录下；web UI 用它保存跨客户端的 UI 状态。值是不透明字符串——序列化由调用方负责。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/v1/gui/store/length` | 已存键的数量 |
| `GET /api/v1/gui/store/getItem` | 按键读取值 |
| `POST /api/v1/gui/store/setItem` | 按键写入值 |
| `POST /api/v1/gui/store/removeItem` | 按键删除值 |
| `POST /api/v1/gui/store/clear` | 删除所有值 |

#### `GET /api/v1/gui/store/length`

返回已存键的数量（对齐 `localStorage.length`）。无参数。

成功时 `data` 为 `{ length }`。

#### `GET /api/v1/gui/store/getItem`

读取一个值（对齐 `localStorage.getItem`）。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `key` | query | string | **必填。** 要读取的键，1–256 个字符 |

成功时 `data` 为 `{ value }`——已存字符串，键不存在时为 `null`。

#### `POST /api/v1/gui/store/setItem`

写入一个值（对齐 `localStorage.setItem`）。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `key` | body | string | **必填。** 要写入的键，1–256 个字符 |
| `value` | body | string | **必填。** 要存储的值 |

成功时 `data` 为 `null`。

#### `POST /api/v1/gui/store/removeItem`

删除一个值（对齐 `localStorage.removeItem`）。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `key` | body | string | **必填。** 要删除的键，1–256 个字符 |

成功时 `data` 为 `null`。

#### `POST /api/v1/gui/store/clear`

删除所有已存值（对齐 `localStorage.clear`）。无参数。

成功时 `data` 为 `null`。

### 全局搜索与其他

| 方法与路径 | 说明 |
| --- | --- |
| `POST /api/v1/search` | 跨会话全文搜索，`mode` 为 `terms`（默认）或 `literal`（精确子串），`page_token` 分页 |
| `GET /api/v1/connections` | 列出当前在线的 WebSocket 连接 |
| `GET /api/v2/sessions` | 新一代会话列表，见下文 |
| `POST /api/v2/sessions:archive` | 批量归档会话，见下文 |
| `POST /api/v2/sessions:restore` | 批量恢复已归档会话，见下文 |
| `/api/v1/debug/*` | 反射式调试 RPC，仅 `--debug-endpoints` 且 loopback 时挂载，不属于稳定协议 |

#### `POST /api/v1/search`

跨会话全文搜索，覆盖 User 消息、Assistant 回复与会话标题，由服务端的持久搜索索引支撑。当 `container.session_id` 指向本服务进程中存活的会话时，搜索改为直接扫描该会话的内存转录，响应的 `source` 字段（`index` 或 `live`）会报告本页结果由哪条路径提供。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `query` | body | string | **必填。** 搜索文本 |
| `mode` | body | string | `terms`（默认）/ `literal` |
| `op` | body | string | `terms` 模式下的词项组合符：`AND`（默认）/ `OR` |
| `container` | body | object | 将搜索限定在 `{ session_id?, agent_id? }` |
| `role` | body | string | 限定 `user` / `assistant` / `title` 命中 |
| `start_time` | body | integer | 只看不早于该时间的命中（epoch 毫秒） |
| `end_time` | body | integer | 只看不晚于该时间的命中（epoch 毫秒） |
| `sort` | body | string | `score`（默认）/ `time_desc` / `time_asc`；`literal` 模式忽略此参数，始终最新在前 |
| `page_size` | body | integer | 每页命中数，1–50。默认 `20` |
| `page_token` | body | string | 上一页响应返回的令牌 |

`terms` 模式下查询会被分词（ASCII 词加 CJK n-gram）、去重，并以至多 32 个词项匹配倒排索引；`literal` 模式是零误报的精确子串搜索。成功时 `data` 为 `{ items, has_more, page_token?, index_state, source }`，每项为 `{ session_id, workspace_id, session_title, agent_id, role, snippet, time, turn?, step_id?, score }`。`index_state` 为 `{ state, indexed_sessions, total_sessions, documents, stale?, degraded? }`，其中 `state` 为 `building` / `ready` / `readonly` 之一；`stale` 标记仍在追赶的落后视图，`degraded` 携带最近一次刷新失败的信息。超出预算的页会额外携带 `incomplete`，取值为 `candidate_cap` / `postings_budget` / `deadline` 之一。分页令牌锁定索引代际与查询条件——索引重建或查询变更会使其失效。

- `40001`：请求体校验失败、查询不可用（为空或超过 32 个词项），或分页令牌非法

#### `GET /api/v1/connections`

列出当前连接到本服务的 WebSocket 客户端，按连接时间最早在前。无参数。

成功时 `data` 为 `{ connections }`，每项为 `{ id, connected_at, remote_address, user_agent, has_client_hello, subscriptions }`：`connected_at` 为 ISO 8601 时间戳；`remote_address` 与 `user_agent` 未知时为 `null`；`has_client_hello` 报告客户端是否已发送握手帧；`subscriptions` 列出该连接订阅的会话 id。

### `GET /api/v2/sessions`

面向列表页的新一代会话查询，筛选、排序、字段组都在查询参数里：

| 参数 | 说明 |
| --- | --- |
| `workspace.id` | 按工作区过滤，可重复 |
| `activity.status` | 按活动状态过滤：`running` / `approval` / `question` / `failed` / `idle`，可重复 |
| `meta.updated_after` | 只看该时间（epoch 毫秒）之后更新过的会话 |
| `meta.updated_before` | 只看该时间（epoch 毫秒）之前更新过的会话 |
| `meta.archived` | `true` / `false`（默认）/ `all` |
| `meta.has_prompt` | `true` 只保留有用户 prompt 的会话，`false` 只保留空会话（等价 `GET /api/v1/sessions` 的 `exclude_empty`） |
| `view` | `flat`（默认）/ `by_workspace`，见下文 |
| `group.page_size` | `view=by_workspace` 时每个工作区返回的会话数：1–100，默认 5（使用 `id,archived` 投影时上限 10000）；未开分组视图时传入返回 `40001` |
| `sort` | `meta.updated_at_desc`（默认）/ `meta.updated_at_asc` / `meta.created_at_desc` |
| `include` | 逗号分隔的附加字段组；目前支持 `git`（分支与 PR 信息，按目录去重并缓存 60 秒） |
| `fields` | 逗号分隔的字段投影；目前仅支持 `id,archived`，每项裁剪为 `{ id, archived }`（用于全选匹配场景）。不可与 `include=git` 同传（`40001`） |
| `page_size` | 1–100，默认 50；使用 `id,archived` 投影时上限放宽至 10000。`view=by_workspace` 时按组计数 |
| `page_token` | 上一页返回的翻页令牌 |
| `page` | 无状态的 1 起始页码；与 `page_token` 互斥（同传返回 `40001`） |

响应每项固定包含 `workspace`、`meta`、`activity` 三组，`include=git` 时附加 `git` 组；`fields=id,archived` 时仅返回 `{ id, archived }`。每页额外携带 `total`，即过滤后的集合大小。翻页令牌绑定首页查询条件（含投影），中途改条件返回 `40922`。`page` 模式是跳页用的无状态替代：每次请求都是独立快照，不签发令牌，`next_page_token` 恒为 `null`。

`view=by_workspace` 时，同一份过滤、排序后的集合会重新投影为按工作区分组的形态，概览页因此可以用一次请求替代「每个工作区各一轮询」：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "groups": [
      {
        "workspace": { "id": "wd_my-app_a1b2c3d4e5f6", "cwd": "/Users/dev/my-app" },
        "sessions": [ { "id": "session_...", "workspace": { "id": "wd_my-app_a1b2c3d4e5f6", "cwd": "/Users/dev/my-app" }, "meta": { "title": "Fix the login page", "last_prompt": "adjust the button spacing", "created_at": 1787000000000, "updated_at": 1787000100000, "archived": false, "archived_at": null }, "activity": { "status": "idle" } } ],
        "total": 42
      }
    ],
    "total": 7,
    "has_more": true,
    "next_page_token": "eyJ2IjoxLCJmIjoi..."
  },
  "request_id": "req_..."
}
```

每组携带该工作区按请求 `sort` 排序的前 `group.page_size` 条会话，以及该工作区匹配过滤条件的会话总数 `total`（用作「查看全部」入口）。只有至少有一条匹配会话的工作区才会出现；组间按组内首条会话的 sort key 排序，相同则按工作区 id。`page` 与 `page_token` 按组翻页（外层 `total` 为组数），指纹绑定规则相同：令牌同时覆盖 `view` 与分组参数，翻页途中变更同样返回 `40922`。

### `POST /api/v2/sessions:archive` 与 `POST /api/v2/sessions:restore`

面向会话管理页的批量归档/恢复。请求体为 `{ "ids": ["session_..."] }`——非空、去重后不超过 5000 条。仍在线的会话走完整生命周期；未加载的冷会话直接改写磁盘上的元数据，不会被加载。

只有请求体校验失败才会让整个请求失败（`40001`）；其余情况按条返回：`data.results` 保持输入顺序，每项为 `{ id, ok }` 或 `{ id, ok: false, error }`（不存在的 id 在自身条目里报 `40401`），并附 `succeeded` / `failed` 计数。

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "results": [
      { "id": "session_a", "ok": true },
      { "id": "session_b", "ok": false, "error": { "code": 40401, "message": "session session_b does not exist" } }
    ],
    "succeeded": 1,
    "failed": 1
  },
  "request_id": "req_..."
}
```

## WebSocket 协议

### 建立连接

唯一端点是 `ws://<host>:<port>/api/v1/ws`；鉴权在升级请求时完成（见上文 [鉴权](#鉴权)）。连接建立后服务端立即发送 `server_hello`：

```json
{
  "type": "server_hello",
  "timestamp": "2026-01-01T00:00:00.000Z",
  "payload": {
    "ws_connection_id": "conn_01JZX4...",
    "protocol_version": 2,
    "max_event_buffer_size": 1000,
    "capabilities": { "event_batching": false, "compression": false }
  }
}
```

注意服务端不发送心跳，也不会主动断开空闲连接——保活与重连由客户端自己负责。

### 控制帧

客户端发送 JSON 帧 `{ "type", "id"?, "payload" }`；每个请求帧都会收到应答 `{ "type": "ack", "id", "code", "msg", "payload" }`，`code` 为 `0` 表示成功。

| 帧 | payload | 说明 |
| --- | --- | --- |
| `subscribe` | `{ session_ids, cursors?, agent_filter? }` | 订阅会话事件；带 `cursors`（每会话 `{seq, epoch}`）时回放错过的持久事件 |
| `unsubscribe` | `{ session_ids }` | 取消会话订阅 |
| `subscribe_v2` | `{ session_id, transcript, transcript_since? }` | 订阅转录流（唯一的转录订阅通道），`transcript` 按 agent 指定粒度 |
| `unsubscribe_v2` | `{ session_id, agent_ids? }` | 退订转录流；省略 `agent_ids` 表示整个会话 |
| `watch_fs_add` / `watch_fs_remove` | `{ session_id, paths, recursive? }` | 订阅 / 取消文件变更通知（`event.fs.changed`） |
| `client_hello` | `{ client_id }` | 握手帧，其余字段为遗留兼容 |

### 事件

事件帧形状为 `{ "type", "seq", "epoch"?, "volatile"?, "offset"?, "session_id"?, "timestamp", "payload" }`，`type` 即事件类型。按投递范围分两类：

- **全局事件**：发送到每个已建立连接，无需订阅——`session.meta.updated`、`event.session.created`、`event.session.archived`、`event.session.work_changed`、`event.session.status_changed`、`event.workspace.*`、`event.config.*`。
- **会话事件**：只发给订阅了该会话的连接，受 `agent_filter` 过滤。主要事件族：

| 事件族 | 主要事件 |
| --- | --- |
| 轮次 | `turn.started`、`turn.ended`、`turn.step.started` / `completed` / `interrupted` / `retrying` |
| 流式文本 | `assistant.delta`、`thinking.delta`（带 `offset` 用于对齐） |
| 工具调用 | `tool.call.started`、`tool.call.delta`、`tool.progress`、`tool.result` |
| 交互 | `event.approval.requested` / `resolved`、`event.question.requested` / `answered` / `dismissed` |
| subagent | `subagent.spawned` / `started` / `suspended` / `completed` / `failed` |
| 后台 | `task.started` / `terminated`、`shell.started` / `output` / `completed` |
| 其他 | `compaction.*`、`skill.activated`、`goal.updated`、`prompt.*`、`error`、`warning` |

有三个全局生命周期事件可以让跨工作区概览免掉逐工作区轮询。`event.session.archived` 在在线归档与冷归档两条路径上都会发出；其事件帧 `session_id` 是全局水位 `__global__`，真实会话 id 在 payload 里：`{ "type": "event.session.archived", "workspace_id": "wd_...", "sessionId": "session_..." }`（payload 字段为 `workspace_id` / `sessionId`）。`event.workspace.created` / `updated` 携带完整工作区对象（`{ id, root, name, created_at, last_opened_at, session_count }`——会话创建触碰工作区时也会发 `updated`），`event.workspace.deleted` 携带 `{ "workspace_id", "root" }`。这些事件只覆盖本服务进程内的变更；其他进程（例如写同一 home 目录的 CLI）的变更要等索引 reconcile（约一分钟）才可见，因此概览客户端应保留低频兜底轮询。目前没有会话删除事件。

事件另分持久与易失两种：持久事件带严格递增的 `seq`，落盘并可回放；易失事件（各 `*.delta`、`tool.progress`、`shell.*` 等）标 `volatile: true`，不回放。消费易失文本流时用 `offset`（该轮次内的累计字符偏移）与本地已累积文本比对：小于本地长度说明是重复帧，大于说明有缺漏、需走快照恢复。

### 断线恢复

重连后在 `subscribe` 的 `cursors` 里带上每个会话最后应用事件的 `{seq, epoch}`，服务端会回放缺口；落后超过缓冲（1000 条）或游标失效时改为收到 `resync_required`。此时调用 `GET /api/v1/sessions/{session_id}/snapshot` 拿全量快照（含 `as_of_seq` 与 `epoch`），再以新游标重新订阅。

### 转录协议

`subscribe_v2` 的 `transcript` 按 agent 指定粒度：`off` / `turn` / `block` / `delta`（键 `"*"` 表示默认粒度），粒度越高推送越细。粒度非 `off` 的 agent 走两帧推送：`transcript.reset`（基线快照，历史经 REST 分页回读）和 `transcript.ops`（增量批次，带每个 agent 连续递增的 `seq`）；该 agent 的旧式事件在同一连接上被抑制，改由转录帧承载。断线时用 `transcript_since` 续传；服务端批次日志无法覆盖缺口时（REST 补漏返回 `complete: false`）需全量刷新。REST 侧对应 `GET .../transcript`（按轮次分页）与 `GET .../transcript/ops?since_seq=`（批次补漏）。

## 二进制与流式端点

以下端点返回二进制流而非 JSON 载荷，各端点的 HTTP 能力并不相同：

| 方法与路径 | 说明 | Range 分段（206） | ETag / 304 |
| --- | --- | --- | --- |
| `GET /api/v1/files/{file_id}` | 下载已上传文件 | 支持 | 不支持（会发送 `etag` 头，但不处理 `If-None-Match`） |
| `GET /api/v1/sessions/{session_id}/fs/{path}:download` | 下载会话工作区文件 | 支持 | 支持 |
| `GET /api/v1/fs:content` | 读取本机任意文件（仅受 token 保护，谨慎暴露端口） | 支持 | 支持 |
| `POST /api/v1/sessions/{session_id}/export` | 导出会话与诊断信息（zip 流） | 不支持 | 不支持 |

错误语义也不相同：`GET /api/v1/files/{file_id}` 对查找和存储失败返回真实 404 / 500 状态码（参数校验失败仍走 HTTP 200 信封），其余三个端点的所有失败都走标准 [响应信封](#响应信封)——客户端在这三个端点上仍需检查信封中的 `code`。

## 下一步

- [本地服务与 API](../guides/server.md) — 启动、鉴权与端到端调用流程
- [kimi 命令](./kimi-command.md#kimi-web) — `kimi web` 的全部命令行选项
