# 服务与配置接口

本页列出不绑定单个会话的服务级接口和配置接口。会话相关接口见 [会话接口](./server-api-sessions.md)，文件接口见 [文件接口](./server-api-files.md)，鉴权、响应信封、错误码和分页等通用约定见 [服务 API](./server-api.md)。

路径中的 `:{action}` 后缀是动作约定：对单个资源或资源集合 POST 到 `路径:动作`，执行非 CRUD 操作（如会话的 `:fork`、`:archive`，供应商集合的 `:refresh`）。

## 服务与元信息

这一组接口报告服务实例本身的信息，并提供探活和关闭入口。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/v1/healthz` | 探活，免鉴权 |
| `GET /api/v1/meta` | 服务版本、能力集、`server_id`、实验开关 |
| `POST /api/v1/shutdown` | 优雅退出（先回 200 再关闭）；绑定在 loopback 地址或以 `--allow-remote-shutdown` 启动时才挂载 |

### `GET /api/v1/healthz`

探活接口，供脚本和进程管理器使用。它是唯一不需要 bearer token 的 `/api` 接口（见 [鉴权](./server-api.md#鉴权)），应答时不触碰配置和引擎。

成功时 `data` 为 `{ "ok": true }`。

### `GET /api/v1/meta`

返回本实例的身份信息和能力集。大多数字段在启动时固定；`experimental_flags` 和 `features` 在每次请求时实时解析，开关翻转或某个 feature 失败会体现在下一次响应中。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `server_version` | string | 服务版本 |
| `capabilities` | object | 能力集：`websocket`、`file_upload`、`fs_query`、`mcp`、`tasks`，值恒为 `true` |
| `server_id` | string | 本服务实例的唯一 id |
| `started_at` | string | 启动时间，ISO 8601 格式 |
| `open_in_apps` | array | 可作为 `open-in` 目标的宿主应用：`finder` / `cursor` / `vscode` / `iterm` / `terminal`。目前恒为空 |
| `dangerous_bypass_auth` | boolean | 服务是否以 `--dangerous-bypass-auth` 启动（为 `true` 时客户端可以跳过 token 提示） |
| `backend` | string | 引擎后端：`v1` / `v2`。本服务恒为 `v2` |
| `web_title` | string | 来自 `--web-title` 的自定义浏览器标签页标题，未设置时省略 |
| `experimental_flags` | object | 实验开关 id → 是否启用，在请求时解析 |
| `features` | array | 引擎 feature，每项为 `{ name, state, meta }`。`state` 为 `Pending` / `Activating` / `Active` / `Unloading` / `Failed` |

### `POST /api/v1/shutdown`

请求服务优雅退出。服务端先发出响应，随后立即执行关闭，因此调用方收到的响应是可信的。

服务绑定在 loopback 地址，或以 `--allow-remote-shutdown` 启动时，才会挂载这个接口。其他情况下服务端不注册这个路由，请求得到 404。

成功时 `data` 为 `{ "ok": true }`。

## 登录与用量

这一组接口驱动托管 Kimi OAuth 登录的生命周期，并读取账号级信息。托管供应商名为 `managed:kimi-code`，下面各接口的可选参数 `provider` 都默认取这个值。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/v1/auth` | 鉴权状态快照 |
| `POST /api/v1/oauth/login` | 发起 OAuth device-code 登录流程 |
| `GET /api/v1/oauth/login` | 轮询登录流程状态 |
| `DELETE /api/v1/oauth/login` | 取消进行中的登录流程 |
| `POST /api/v1/oauth/logout` | 登出托管供应商 |
| `GET /api/v1/oauth/usage` | 套餐额度与加油包 |
| `GET /api/v1/oauth/userinfo` | 账号资料 |
| `GET /api/v1/oauth/region` | 解析客户端所属区域（`mainland-cn` / `global`） |

### `GET /api/v1/auth`

返回鉴权状态快照：默认模型能否解析到可用的供应商配置，以及托管供应商的登录状态。

全局 `default_model` 别名存在于模型表中、且能解析到已配置的供应商时，`models_ready` 为 `true`。自带 `base_url` 的平铺（providerless）模型和通过 `KIMI_MODEL_*` 环境变量注入的模型都算在内。服务端不校验凭据，因此之后的对话请求仍可能以 `40111` / `40112` 失败。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `models_ready` | boolean | 默认模型能否解析到已配置的供应商，判断规则见上文 |
| `providers_count` | integer | 已配置的供应商数量 |
| `managed_provider` | object \| null | 托管供应商的登录状态 |
| `managed_provider.name` | string | 托管供应商名称 |
| `managed_provider.status` | string | `authenticated` / `expired` / `revoked` / `unauthenticated` |

本接口不返回全局默认模型别名，改从 [`GET /api/v1/config`](#配置) 的 `default_model` 读取。

### `POST /api/v1/oauth/login`

为托管供应商发起 OAuth device-code 登录流程。发起新流程会中止同一供应商进行中的流程。账号已登录时不需要用户交互，响应直接报告 `authenticated`。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `provider` | body | string | 托管供应商名称。默认 `managed:kimi-code` |
| `region` | body | string | `mainland-cn` / `global`。覆盖 [`GET /api/v1/oauth/region`](#get-api-v1-oauth-region) 的区域解析结果，只对本次流程生效 |

成功时 `data.status` 为 `pending` 或 `authenticated`。账号已登录时，`data` 只有 `flow_id`、`provider` 和 `status: "authenticated"`。流程进行中时，`data` 字段如下：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `flow_id` | string | 流程 id |
| `provider` | string | 托管供应商名称 |
| `status` | string | `pending` |
| `verification_uri` | string | 验证页地址，打开后输入 `user_code` |
| `verification_uri_complete` | string | 可以直接打开的验证页地址，不需要再输入 `user_code` |
| `user_code` | string | 在 `verification_uri` 页面输入的用户码 |
| `expires_in` | integer | 流程时限，单位秒。与 `expires_at` 表示同一时限 |
| `interval` | integer | 轮询间隔，单位秒 |
| `expires_at` | string | 流程过期时间 |

拿到进行中的流程后，打开 `verification_uri_complete`（或打开 `verification_uri` 并输入 `user_code`），然后每隔 `interval` 秒轮询 `GET /api/v1/oauth/login`，直到流程完结或超过 `expires_at`。

### `GET /api/v1/oauth/login`

轮询某个供应商的登录流程状态。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `provider` | query | string | 托管供应商名称。默认 `managed:kimi-code` |

尚未发起过流程时，`data` 为 `null`。否则 `data` 为流程快照，包含 `POST /api/v1/oauth/login` 进行中形态的全部字段，以下字段的取值不同或为新增：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `status` | string | `pending` / `authenticated` / `denied` / `expired` / `cancelled` |
| `resolved_at` | string | 流程离开 `pending` 后出现，记录流程到达终态的时间 |
| `error_message` | string | 描述失败的流程，可省略 |

### `DELETE /api/v1/oauth/login`

取消某个供应商进行中的登录流程。没有进行中的流程时，本次调用不做任何操作，返回最近一次已知状态。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `provider` | query | string | 托管供应商名称。默认 `managed:kimi-code` |

成功时 `data` 为 `{ cancelled, status }`。只有确实中止了一个 `pending` 流程时，`cancelled` 才为 `true`；`status` 是调用后的流程状态。

### `POST /api/v1/oauth/logout`

登出托管供应商：丢弃已存储的 OAuth 凭据，中止进行中的登录流程，并把托管供应商从配置中移除。OAuth 托管的供应商不能手动编辑或删除（见 [`PUT` / `DELETE /api/v1/providers/{provider_id}`](#模型与供应商)），要移除它只能先登出。

登出默认 Kimi 供应商（`managed:kimi-code`）时，服务端还会拆除本机的远程控制，并清除缓存的远程控制云端会话。登出其他供应商不影响远程控制。拆除顺序取决于隧道由谁持有：

- **没有隧道运行，或隧道由本机其他进程持有**：服务端先把本机设备下线并持有本机锁，确保凭据被丢弃之前本机任何进程都无法再次开启远程控制。清理失败时，登出中止。
- **隧道由本服务持有**：服务端先丢弃凭据，响应发出后随即拆除隧道，因此通过远程控制链接发起的登出仍能收到响应。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `provider` | body | string | 托管供应商名称。默认 `managed:kimi-code` |

成功时 `data` 为 `{ logged_out: true, provider }`。

- `50001`：登出默认 Kimi 供应商时，远程控制清理或登出本身失败

### `GET /api/v1/oauth/usage`

读取托管账号的套餐额度和加油包，数据实时取自账号服务。账号服务出错时信封仍然成功，错误放在 `data` 里返回。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `provider` | query | string | 托管供应商名称。默认 `managed:kimi-code` |

成功时 `data.kind` 为 `ok` 或 `error`：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `quota.usages` | object | 仅 `ok`：各时间窗口的用量，键为 `limit5h`、`limit7d`、`monthTotal`、`monthCode`，客户端按实际下发的键渲染。每项为 `{ usedRatio, resetAt? }`：`usedRatio` 是 0–1 的已用比例（浮点数），`resetAt` 是 RFC3339 格式的重置时间 |
| `quota.extraUsage` | object \| null | 仅 `ok`：按量付费钱包，字段为 `balanceCents`、`totalCents`、`monthlyChargeLimitEnabled`、`monthlyChargeLimitCents`、`monthlyUsedCents`、`currency` |
| `message` | string | 仅 `error`：错误信息 |
| `status` | integer | 仅 `error`：账号服务返回的 HTTP 状态码，没有时省略 |

### `GET /api/v1/oauth/userinfo`

读取托管账号的资料。账号服务出错时的处理方式与 [`GET /api/v1/oauth/usage`](#get-api-v1-oauth-usage) 相同：信封仍然成功，错误放在 `data` 里返回。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `provider` | query | string | 托管供应商名称。默认 `managed:kimi-code` |

成功时 `data.kind` 为 `ok` 或 `error`：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `userInfo` | object | 仅 `ok`：账号资料。始终包含 `userId`、`nickname`、`status`、`region`、`userLevel`、`userLevelName`、`domain`、`domainName`；可能附加 `globalId`、`bio`、`avatar`、`username`、`email`、`phone`（`{ countryCode, number }`）、`createdTime` 和 `lastLoginTime` |
| `message` | string | 仅 `error`：错误信息 |
| `status` | integer | 仅 `error`：账号服务返回的 HTTP 状态码，没有时省略 |

### `GET /api/v1/oauth/region`

解析客户端所属的 Kimi 区域。结果在本地推导，不做网络探测。服务端按以下顺序取第一个能决定区域的输入：环境变量或配置固定的 OAuth host，已配置的 OAuth key，`<home>/region` 中的安装渠道标记。

客户端未登录、且上述输入都无法决定区域时，服务端根据设备时区和语言环境推断。推断出明确结果时，服务端把它缓存到 `<home>/region.json`，之后直接使用缓存；客户端登录后缓存被清除。原始时区和语言环境值不会上传。

信号缺失或冲突时，本次进程回退到 `mainland-cn`，但不持久化这个结果，下次启动时重新判断。设置 `KIMI_CODE_REGION_MARKER=off` 可以同时禁用安装渠道标记和本地推断；设置了 `KIMI_CODE_BASE_URL` 时也不做本地推断。

成功时 `data` 为 `{ region }`，`region` 为 `mainland-cn` / `global`。

## 远程控制

这一组接口管理机器级的远程控制隧道（见 [远程控制指南](../guides/remote-control.md)）和账号的设备注册表。隧道状态按机器区分。设备注册表按账号区分、保存在云端，因此设备接口需要 Kimi 登录；服务端持有登录会话，把请求代理到 relay，OAuth 凭据不会暴露给调用方。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/v1/remote-control` | 读取隧道状态 |
| `POST /api/v1/remote-control` | 开启或关闭隧道 |
| `GET /api/v1/remote-control/devices` | 列出账号下的设备 |
| `PATCH /api/v1/remote-control/devices/{id}` | 重命名设备 |
| `POST /api/v1/remote-control/devices/{id}/deactivate` | 让设备下线 |
| `DELETE /api/v1/remote-control/devices/{id}` | 从注册表中删除设备 |

### `GET /api/v1/remote-control`

返回当前隧道状态。隧道处于关闭状态、但本机另一个存活进程持有单实例锁时，`data.conflict` 携带锁持有者的信息。隧道关闭时，每次读取都会重新检查锁；持有者进程退出后，`conflict` 和已存的 `error` 一并清除。

成功时 `data` 为隧道状态对象：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `enabled` | boolean | 远程控制开关 |
| `state` | string | `off` / `starting` / `on` / `stopping` |
| `url` | string | 隧道地址，可省略 |
| `device_id` | string | 本机设备标识，可省略 |
| `device_name` | string | 本机设备名称，可省略 |
| `error` | string | 错误信息，可省略 |
| `conflict` | object | 锁持有者信息，只在上述冲突时出现：`{ pid, local_origin, device_id, url, started_at }` |

### `POST /api/v1/remote-control`

开启或关闭隧道。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `enabled` | body | boolean | `true` 开启隧道，`false` 关闭隧道 |

成功时 `data` 为隧道状态对象，与 `GET /api/v1/remote-control` 相同。

- `40001`（`VALIDATION_FAILED`）：开启时服务没有绑定在 loopback 地址，或以 `--dangerous-bypass-auth` 启动
- `40928`（`REMOTE_CONTROL_ALREADY_RUNNING`）：开启时本机另一个存活进程持有单实例锁。`details` 携带锁持有者信息，结构与 `conflict` 相同
- `50001`（`INTERNAL_ERROR`）：开启或关闭隧道失败

### `GET /api/v1/remote-control/devices`

从云端注册表列出账号下的远程控制设备。

成功时 `data` 为 `{ devices, max_devices? }`，`max_devices` 是设备数量上限。`devices` 每项字段如下：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `device_id` | string | 设备标识 |
| `alias` | string | 显示名称 |
| `status` | string | `online` / `offline` |
| `platform` | string | 设备平台 |
| `client_version` | string | 客户端版本 |
| `local_base_url` | string | 设备本地服务地址 |
| `created_at` | string | 创建时间 |
| `updated_at` | string | 更新时间 |
| `last_remote_access_at` | string | 最近一次远程访问时间 |

- `50001`（`INTERNAL_ERROR`）：请求云端注册表失败

### `PATCH /api/v1/remote-control/devices/{id}`

重命名设备。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `id` | path | string | 设备标识 |
| `alias` | body | string | 新的显示名称，去除首尾空白后为 1–50 个字符 |

成功时 `data` 为 `{ ok: true }`。

- `40001`（`VALIDATION_FAILED`）：名称为空或超长。服务端在请求云端之前就返回
- `50001`（`INTERNAL_ERROR`）：请求云端注册表失败

### `POST /api/v1/remote-control/devices/{id}/deactivate`

在云端注册表中把设备置为离线。离线设备保留在列表中，不占用套餐的设备额度；该设备下次开启远程控制时恢复在线。

目标设备是本机时，服务端先停止本地隧道（启动中的开启会被取消），再持有本机锁完成下线，确保并发的开启无法在成功响应之后重新注册设备。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `id` | path | string | 设备标识 |

成功时 `data` 为 `{ ok: true }`。

- `50001`（`INTERNAL_ERROR`）：请求云端注册表失败；目标设备是本机、且锁持有者没有在限定时间内停止时也返回此错误，不报告成功

### `DELETE /api/v1/remote-control/devices/{id}`

把设备从云端注册表中移除：设备从列表中消失，仍在连接的隧道被断开。与[下线](#post-api-v1-remote-control-devices-id-deactivate)不同，删除不会把设备保留在列表中。

目标设备是本机时，服务端先停止本地隧道，再持有本机锁完成删除，确保设备无法在成功响应之后重新注册。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `id` | path | string | 设备标识 |

成功时 `data` 为 `{ ok: true }`。

- `50001`（`INTERNAL_ERROR`）：请求云端注册表失败；目标设备是本机、且锁持有者没有在限定时间内停止时也返回此错误

## 配置

这一组接口读写全局配置（`config.toml`），并读取由 Kimi Code 服务远程下发的客户端配置。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/v1/config` | 读取全局配置（密钥字段脱敏） |
| `POST /api/v1/config` | 合并式更新配置，并广播 `event.config.changed` |
| `POST /api/v1/client_configs` | 读取由 Kimi Code 服务远程控制的指定客户端配置 |

### `GET /api/v1/config`

返回解析后的全局配置：`config.toml` 叠加覆盖层后的生效结果。密钥已脱敏：每个供应商只报告 `has_api_key`，不返回存储的密钥。

成功时 `data` 为配置对象，字段与 [顶层字段](../configuration/config-files.md#顶层字段) 中的顶层域一一对应：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `providers` | object | 供应商 id → `{ type, base_url?, default_model?, api_key_env?, has_api_key }` 的映射 |
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
| `auto_session_title` | boolean | 是否允许客户端自动生成会话标题 |
| `disable_feedback_survey` | boolean | 是否关闭会话评分提示 |
| `raw` | object | 原始解析的 `config.toml` 内容，包含未建模的字段 |

### `POST /api/v1/config`

合并式更新全局配置。请求体中的每个顶层域深合并进对应的域，请求体中没有出现的域保持不变。

请求体是部分配置对象：可以包含 [`GET /api/v1/config`](#get-api-v1-config) 响应中除 `raw` 外的任意顶层域，全部可选，类型和含义与响应表相同。以下两个域有额外的写入规则：

- **`yolo`**：`true` 是 `default_permission_mode: "yolo"` 的简写；`false` 被忽略。
- **`default_permission_mode`**：取值为 `manual` / `yolo` / `auto`。

成功时 `data` 为更新后的完整配置，形态与 `GET /api/v1/config` 相同。

每一次配置变更都会广播全局事件 `event.config.changed`（见 [全局事件](./server-api-conversation.md#全局事件)），包括经本接口成功更新、在进程外编辑 `config.toml`，以及服务端内部写入（如 OAuth 登录刷新）。短时间内的多次变更合并为一个事件：`changedFields` 携带受影响的域名（camelCase 配置域，例如 `defaultModel`），`config` 携带当前完整的配置投影（形状与 `GET /api/v1/config` 的响应相同）。

- `40001`：补丁被拒绝（值非法或持久化失败），响应带底层错误信息

### `POST /api/v1/client_configs`

读取由 Kimi Code 服务远程控制的指定客户端配置，包括哪些模型或思考强度的切换需要用户确认，以及客户端的升级策略。服务端从账号所在区域的 Kimi Code 服务读取（设置了 `KIMI_CODE_BASE_URL` 时改用该地址），并把结果规范化成该名称预期的结构。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `name` | body | string | 必填。`model_switch_confirm` / `effort_switch_confirm` / `client_upgrade_policy` |

成功时 `data` 为 `{ name, config }`。名称不在上述范围内或读取失败时，`config` 为 `null`，客户端回退到内置行为。

读到的值不会变成 `null`：缺失或格式不对的字段取关闭状态的默认值。例如格式不对的 `model_switch_confirm` 返回 `{ enable: false, rules: [] }`。

## 模型与供应商

这一组接口管理模型配置的两部分：`config.toml` 中的 [供应商](../configuration/providers.md) 表和模型别名表。另有一个由服务端代理的 models.dev 目录，用于一次性导入供应商。

模型别名 id 就是配置中的别名键。通过供应商管理接口创建的别名形如 `provider_id/model`（例如 `my-provider/kimi-for-coding`），模型别名表中的裸键（如 `turbo`）原样使用。API 中所有接收 `model_id` 的地方（包括全局 `default_model`）指的都是这个别名 id。

`:{action}` 路由上不支持的动作返回 `40001`。

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
| `POST /api/v1/providers:{action}` | 集合级动作：`refresh` / `refresh_oauth` / `import_catalog`（201）/ `import_registry`（201） |
| `GET /api/v1/catalog/providers` | 浏览 models.dev 目录（服务端代理） |
| `GET /api/v1/catalog/providers/{catalog_id}` | 读取目录中的单个条目 |

### `GET /api/v1/models`

列出所有供应商下已配置的模型别名。

成功时 `data.items` 为模型数组，每项字段如下：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `provider` | string | 所属供应商 id |
| `model` | string | 别名 id：供应商管理的别名为 `provider_id/model`，其余为裸键 |
| `display_name` | string | 显示名，可省略 |
| `max_context_size` | integer | 上下文窗口，单位 token |
| `capabilities` | array | 能力标志，可省略 |
| `support_efforts` | array | 支持的 Thinking 模式 effort 档位，可省略 |
| `default_effort` | string | 默认 effort 档位，可省略 |
| `upgrade` | object | 自定义 registry 模型可以携带，用于引导用户切换到替代模型 |
| `upgrade.model` | string | 替代模型 |
| `upgrade.migration_markdown` | string | 迁移说明，其中的占位符已替换为模型 ID |
| `upgrade.retirement_at` | string | 退役时间，可省略 |

### `POST /api/v1/models/{model_id}:set_default`

把全局 `default_model` 设为一个已存在的别名。`model_id` 是配置中的别名键原样，裸键如 `POST /api/v1/models/turbo:set_default`；id 含 `/` 时需要 URL 编码，如 `POST /api/v1/models/my-provider%2Fkimi-for-coding:set_default`。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `model_id` | path | string | 必填。配置中的模型别名键原样，含 `/` 时需要 URL 编码 |

成功时 `data` 为 `{ default_model, model }`：`default_model` 是当前生效的别名，`model` 是它的目录项（形态与 `GET /api/v1/models` 的单项相同）。

- `40001`：路径中的动作后缀非法或不支持
- `40413`：不存在该 id 的模型别名

### `GET /api/v1/providers`

列出每个已配置的供应商及其凭据和模型发现状态，不泄露任何密钥。这里的条目形态也是其他供应商接口引用的「供应商条目」。

成功时 `data.items` 为供应商条目数组：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 供应商 id |
| `type` | string | 通信协议，原样返回配置中的值（通过本组接口写入的取值见 `POST /api/v1/providers` 的 `type`），配置未设置时为 `openai` |
| `base_url` | string | API 基础 URL，未设置时省略 |
| `default_model` | string | 该供应商的默认模型别名。供应商未设置、但全局 `default_model` 属于该供应商时取全局值，否则省略 |
| `api_key_env` | string | 读取 API 密钥的环境变量名，未设置时省略 |
| `has_api_key` | boolean | 是否有可用的 API 密钥：配置了非空的 `api_key`，或 `api_key_env` 指向的环境变量有值，或供应商的 `env` 中提供了密钥 |
| `status` | string | 凭据配置冲突（`api_key` 与 `api_key_env` 同时存在，或其中之一与 OAuth 同时存在）时为 `error`；否则存在 API 密钥或缓存的 OAuth token 时为 `connected`，都没有时为 `unconfigured` |
| `models` | array | 该供应商的模型别名 id |

### `POST /api/v1/providers`

一次保存创建供应商及其模型别名，成功时返回 HTTP 201 和标准信封。全局 `default_model` 完全未配置时（全新安装），服务端用新供应商的 `default_model`（或第一个模型）作为初始值；已有的默认值不会被修改。

凭据二选一：`api_key` 直接存储密钥，`api_key_env` 改为记录读取密钥的环境变量名。两者同时传入非空值时请求被拒绝。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `id` | body | string | 必填。供应商 id，只能包含字母、数字、`-`、`_` 和空格，必须以字母或数字开头 |
| `type` | body | string | 必填。通信协议：`kimi` / `openai` / `openai_responses` / `anthropic` / `bedrock` / `google-genai` / `vertexai` |
| `api_key` | body | string | API 密钥，存储在 `config.toml` 中 |
| `api_key_env` | body | string | 读取 API 密钥的环境变量名。服务端只存储变量名，不存储密钥 |
| `base_url` | body | string | API 基础 URL，不能包含环境变量占位符（`${...}`） |
| `default_model` | body | string | 该供应商的默认模型，必须是 `models[].model` 之一 |
| `models` | body | array | 必填。至少一条，`model` 值不能重复；条目结构见下表 |

每个 `models[]` 条目声明一个别名，别名 id 为 `id/model`：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `model` | string | 必填。上游模型名 |
| `max_context_size` | integer | 必填。上下文窗口，单位 token，≥ 1 |
| `display_name` | string | 显示名 |
| `capabilities` | array | 能力标志，如 `thinking` 或 `image_in` |
| `protocol` | string | 线路协议覆盖：`anthropic`、`openai` 或 `openai_responses`；省略时按模型 ID 推断 |
| `max_output_size` | integer | 最大输出 token 数，≥ 1 |
| `support_efforts` | array | 支持的 Thinking 模式 effort 档位 |
| `adaptive_thinking` | boolean | 自适应 thinking 开关 |

成功时 `data` 为创建好的供应商条目（形态与 `GET /api/v1/providers` 的单项相同）。

- `40001`：请求体校验失败，或 `api_key` 与 `api_key_env` 同时传入非空值
- `40921`：已存在该 `id` 的供应商

### `GET /api/v1/providers/{provider_id}`

读取单个供应商。与列表接口不同，设置了密钥时响应会返回存储的 `api_key`，供本地编辑表单预填。对外暴露服务端口时要考虑这一点。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `provider_id` | path | string | 必填。供应商 id |

成功时 `data` 为供应商条目，存有密钥时附带 `api_key`。

- `40412`：供应商不存在

### `PUT /api/v1/providers/{provider_id}`

一次保存整体替换供应商。`type`、`base_url` 和模型列表被重写，该供应商的别名按 `models` 重建：不再列出的别名从 `config.toml` 中消失，其他供应商的别名不受影响。除 `new_id` 重命名引起的迁移外，本接口不修改全局默认指针。

`api_key` 和 `api_key_env` 各有三种写法：省略表示保留已存的值，`""` 表示清除，其他值表示替换。两者互斥：其中一个传入非空值时，另一个被清除；两者同时传入非空值时请求被拒绝。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `provider_id` | path | string | 必填。当前供应商 id |
| `new_id` | body | string | 重命名供应商。providers 键、模型别名、`default_provider`、指向旧别名的 `default_model` 以及 subagent 次级模型池都随之迁移。id 规则与 `POST /api/v1/providers` 相同 |
| `type` | body | string | 必填。通信协议：`kimi` / `openai` / `openai_responses` / `anthropic` / `bedrock` / `google-genai` / `vertexai` |
| `api_key` | body | string | API 密钥，三种写法见上文 |
| `api_key_env` | body | string | 读取 API 密钥的环境变量名，三种写法见上文 |
| `base_url` | body | string | API 基础 URL，不能包含环境变量占位符（`${...}`） |
| `default_model` | body | string | 该供应商的默认模型，必须是 `models[].model` 之一 |
| `models` | body | array | 必填。至少一条，`model` 值不能重复；条目结构与 `POST /api/v1/providers` 相同 |

成功时 `data` 为 `{ provider }`，`provider` 是保存后的供应商条目。

- `40001`：请求体校验失败、`api_key` 与 `api_key_env` 同时传入非空值，或重命名后的别名 id 会与其他供应商的别名冲突
- `40003`：供应商由 OAuth 托管，需改用 `POST /api/v1/oauth/logout` 登出
- `40412`：供应商不存在
- `40921`：`new_id` 已被占用

### `DELETE /api/v1/providers/{provider_id}`

删除供应商及其全部模型别名，并级联清理 subagent 次级模型池。全局 `default_provider` / `default_model` 指针保持不变，即使它们指向被删除的供应商；这两个值是用户的设置，本接口不代为回收。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `provider_id` | path | string | 必填。供应商 id |

成功时返回 HTTP 204，没有响应体，状态码本身表示删除成功（见 [响应信封](./server-api.md#响应信封)）。

- `40003`：供应商由 OAuth 托管，需改用 `POST /api/v1/oauth/logout` 登出
- `40412`：供应商不存在

### `POST /api/v1/providers/{provider_id}:refresh`

从上游来源重新发现单个供应商的模型元数据，并重写该供应商的别名。模型来源为静态的供应商不发起网络请求，直接报告 `unchanged`。

本接口和集合级的 `:refresh`、`:refresh_oauth` 都遵循同一条广播规则：刷新报告的 `changed` 非空（至少一个供应商的别名或托管模型元数据发生变化）时，服务端广播全局事件 `event.model_catalog.changed`（见 [全局事件](./server-api-conversation.md#全局事件)），事件内容与刷新报告相同。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `provider_id` | path | string | 必填。供应商 id |

成功时 `data` 为刷新报告：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `changed` | array | 有变化的供应商，每项为 `{ provider_id, provider_name, added, removed }`，`added` / `removed` 是新增 / 移除的别名数 |
| `unchanged` | array | 无差异的供应商 id |
| `failed` | array | 刷新失败的供应商，每项为 `{ provider, reason }` |
| `retired_default` | object | 可选。刷新发现 registry 移除了当前默认模型、且该模型此前声明过 `upgrade` 替代模型时出现，为 `{ from, to, from_display_name }` |

出现 `retired_default` 时，默认模型已重定向为 `to`，仍绑定 `from` 的已打开会话也已切换到 `to`；`from_display_name` 是被移除模型的显示名，供提示使用。`event.model_catalog.changed` 事件中也会出现同一字段。

- `40001`：路径中的动作后缀非法或不支持
- `40412`：供应商不存在

### `POST /api/v1/providers:refresh`

刷新每个供应商的模型元数据。请求体可选，内容被忽略。

成功时 `data` 为刷新报告，结构与 [`POST /api/v1/providers/{provider_id}:refresh`](#post-api-v1-providers-provider-id-refresh) 相同，同样可能带 `retired_default`。

### `POST /api/v1/providers:refresh_oauth`

只刷新托管供应商 `managed:kimi-code` 的模型列表。该供应商不存在或不是 OAuth 托管时，不做任何刷新，返回空报告。请求体可选，内容被忽略。

成功时 `data` 为刷新报告，只含 `changed` / `unchanged` / `failed`，不带 `retired_default`。

### `POST /api/v1/providers:import_catalog`

把一个 models.dev 目录条目导入为已配置的供应商，成功时返回 HTTP 201 和标准信封。通信协议和端点来自目录解析，目录中的每个模型都写为一个别名。

导入已存在的 id 等同于刷新：供应商条目及其别名按目录重写，省略 `api_key` 时保留已存密钥。本接口不修改已有的全局默认指针；只有完全没有配置默认模型时，才用第一个导入的模型作为 `default_model` 的初始值。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `catalog_id` | body | string | 必填。来自 `GET /api/v1/catalog/providers` 的目录条目 id |
| `id` | body | string | 用作本地供应商 id，覆盖目录 id。id 规则与 `POST /api/v1/providers` 相同 |
| `api_key` | body | string | 导入供应商的 API 密钥 |
| `base_url` | body | string | 覆盖目录解析出的端点。条目的 `needs_base_url` 为 `true` 时必填 |

成功时 `data` 为 `{ provider, models_imported }`：`provider` 是供应商条目，`models_imported` 是写入的别名数量。

- `40001`：缺少 `catalog_id`，或请求体其他校验失败
- `40003`：目标供应商已存在且由 OAuth 托管
- `40004`：条目无法导入（被拒绝、要求 `base_url`、没有可导入的模型，或其 id 不能用作供应商 id）
- `40417`：不存在该 `catalog_id` 的目录条目
- `50004`：models.dev 目录不可用

### `POST /api/v1/providers:import_registry`

把一个 models.dev 形态的私有注册表（一个 `api.json` URL 加可选的 Bearer key）导入为已配置的供应商，成功时返回 HTTP 201 和标准信封。注册表列出的每个供应商写入时都带 `source` 记录，供定时刷新重新发现。

重复导入同一 URL 时，上游已消失的供应商会被移除。URL 是注册表的稳定身份，因此轮换 key 是安全的。全局默认指针的处理规则与 [`:import_catalog`](#post-api-v1-providers-import-catalog) 相同。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `url` | body | string | 必填。注册表 `api.json` 的 URL |
| `api_key` | body | string | 注册表的 Bearer key。省略时复用上一次导入同一 URL 所用的 key |

成功时 `data` 字段如下：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `providers` | array | 导入的供应商条目 |
| `models_imported` | integer | 写入的别名总数 |
| `credential_env` | object | 供应商 id → 环境变量名的映射。注册表为某个供应商声明了 API 密钥环境变量时，取其中第一个非空的变量名 |

- `40001`：缺少 `url`，或请求体其他校验失败
- `40003`：某个列出的供应商已存在且由 OAuth 托管
- `40005`：注册表无法获取或解析，或没有列出可导入的供应商

### `GET /api/v1/catalog/providers`

浏览 models.dev 目录。请求由服务端代理，带 10 分钟内存缓存，并以内置快照兜底。条目保持上游目录的顺序。

服务端无法导入的条目带 `rejected: true` 和机器可读的 `reject_reason`。`needs_base_url: true` 的条目在导入时要求提供 base URL。

成功时 `data.items` 为目录条目数组：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 目录条目 id |
| `name` | string | 条目名称 |
| `wire_type` | string \| null | 解析出的协议，枚举与供应商 `type` 相同 |
| `base_url` | string \| null | 解析出的端点。`needs_base_url` 为 `true` 或被拒绝的条目为 `null` |
| `guessed` | boolean | 是否为启发式解析的结果 |
| `needs_base_url` | boolean | 导入时是否要求提供 base URL |
| `rejected` | boolean | 服务端是否无法导入该条目 |
| `reject_reason` | string \| null | 机器可读的拒绝原因 |
| `env_key` | string \| null | 上游约定的 API 密钥环境变量 |
| `models` | array | 每项为 `{ id, name?, max_context_size, capabilities?, reasoning }` |

- `50004`：目录不可用（在线拉取与内置快照均失败）

### `GET /api/v1/catalog/providers/{catalog_id}`

按 catalog id 读取单个 models.dev 目录条目。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `catalog_id` | path | string | 必填。目录条目 id |

成功时 `data` 为该目录条目，形态与 `GET /api/v1/catalog/providers` 的单项相同。

- `40417`：不存在该 `catalog_id` 的目录条目
- `50004`：目录不可用

## Skill、工具与 MCP

查看工作区可见的 Skill 目录与当前生效 Agent 的工具列表。MCP 服务注册表与 OAuth 管理见 [MCP 管理](#mcp-管理)；会话级的 Skill 目录与 Skill 激活（斜杠命令 `/<skill>` 的 REST 等价形式）见 [会话 Skill](./server-api-sessions.md#会话-skill)。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/v1/workspaces/{workspace_id}/skills` | 无会话的工作区 Skill 目录 |
| `GET /api/v1/tools` | 列出当前生效 Agent 的工具 |
| `/api/v1/mcp/*` | MCP 服务注册表增删改查、探测与 OAuth 管理，见 [MCP 管理](#mcp-管理) |

### `GET /api/v1/workspaces/{workspace_id}/skills`

列出该工作区中的会话会看到的 Skill 目录，不创建也不恢复会话。目录针对工作区的主目录和额外源文件夹计算，合并的来源与会话相同：内置、插件、extra、用户、项目。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `workspace_id` | path | string | 必填。已注册工作区 id |

成功时 `data` 为 `{ skills }`，每项是一个 Skill 描述符，与 [会话 Skill](./server-api-sessions.md#会话-skill) 返回的结构相同：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `name` | string | Skill 名称。同名 Skill 可以以不同 `path` 作为多个变体返回 |
| `description` | string | Skill 描述 |
| `path` | string | Skill 的路径 |
| `source` | string | `project` / `user` / `extra` / `builtin` |
| `workspace_dir` | string | 项目级 Skill 的根目录，其他来源省略 |
| `type` | string | 可选。Skill 类别，只有用户可激活的类型才能被激活 |
| `disable_model_invocation` | boolean | 可选。为 `true` 时 Skill 对模型不可见 |
| `scopes` | string[] | 可选。Skill 声明的适用客户端：`tui` / `web` |

- `40410`：工作区不存在

### `GET /api/v1/tools`

列出当前生效 Agent 的工具。当前生效 Agent 是所选会话的 main agent，会话的取法有两种：

- **传入 `session_id`**：服务端按需恢复该会话，冷会话也会被加载到本服务进程中。会话不存在时列表为空。
- **省略 `session_id`**：取最近创建的会话，但不恢复它。该会话不在本服务进程中存活时列表为空，不会回退到更早的存活会话。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | query | string | 要查看其 main agent 的会话。默认最近创建的会话 |

成功时 `data` 为 `{ tools }`，每项字段如下：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `name` | string | 工具名 |
| `description` | string | 工具描述 |
| `input_schema` | null | 目前恒为 `null` |
| `source` | string | `builtin` / `skill` / `mcp` |
| `mcp_server_id` | string | 仅 MCP 工具携带，从 `mcp__<server>__<tool>` 形式的工具名解析 |
| `active` | boolean | 可选。工具策略的判定结果 |

## 能力与插件

查询内置能力的就绪状态并安装能力，以及管理插件从市场浏览、安装到移除的整个过程。

能力是内置特性，由检测步骤和后台安装两部分组成，就绪状态分级（见 [能力状态对象](#能力状态对象) 的 `state`）。当前版本注册了 `kimi-cu`（Kimi Computer Use）与 `kimi-webbridge`（Kimi Browser Extension）。插件是已安装的 Skill、MCP 服务、hook 与命令的打包集合。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/v1/capabilities` | 列出内置能力及其就绪状态 |
| `GET /api/v1/capabilities/{capability_id}` | 读取单个能力的状态 |
| `POST /api/v1/capabilities/{capability_id}:install` | 开始安装能力（后台进行，轮询 GET 查看进度） |
| `GET /api/v1/plugins` | 列出已安装插件 |
| `GET /api/v1/plugins/{plugin_id}` | 读取已安装插件及其声明的能力 |
| `POST /api/v1/plugins` | 安装自定义插件，或安装指定预期版本的市场条目 |
| `POST /api/v1/plugins/preview` | 只读检查市场条目的能力，不安装插件 |
| `GET /api/v1/plugins/marketplace` | 插件市场目录，合并实时安装状态 |
| `POST /api/v1/plugins/{plugin_id}:enable` | 启用插件 |
| `POST /api/v1/plugins/{plugin_id}:disable` | 停用插件 |
| `POST /api/v1/plugins/{plugin_id}:remove` | 移除插件 |

### 能力状态对象

所有能力接口都返回这个结构。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 能力 id |
| `pluginId` | string | 可选。插件 id |
| `displayName` | string | 展示名称 |
| `description` | string | 描述 |
| `supported` | boolean | 当前平台是否支持 |
| `state` | string | `ready`（所有必需检测步骤均为 `ok`）/ `partial`（部分步骤为 `ok`）/ `not_installed` / `unsupported`（当前平台 / 架构不可用） |
| `version` | string | 可选。版本 |
| `steps` | array | 各检测步骤，每项为 `{ id, state, detail?, optional? }`，其中 `state` 为 `ok` / `missing` / `failed` |
| `install.running` | boolean | 是否正在安装 |
| `install.step` | string | 可选。当前安装步骤 |
| `install.percent` | number | 可选。安装进度，取值 0 到 100 |
| `install.error` | string | 可选。安装错误 |
| `install.note` | string | 可选。安装说明 |
| `install.confirmationRequired` | string | 可选。为 `stop-processes` 时，安装因相关进程仍在运行而停止，需要用户确认后带 `stopRunningProcesses: true` 重新安装 |

### `GET /api/v1/capabilities`

列出所有已注册能力及其就绪状态。

成功时 `data` 为 `{ capabilities }`，每项是一个 [能力状态对象](#能力状态对象)。

### `GET /api/v1/capabilities/{capability_id}`

读取单个能力的就绪状态。安装能力后，客户端轮询这个接口查看进度。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `capability_id` | path | string | 必填。能力 id |

成功时 `data` 为 [能力状态对象](#能力状态对象)。

- `40418`：没有该 id 的能力

### `POST /api/v1/capabilities/{capability_id}:install`

在后台开始安装能力，并立即返回当前状态（此时 `install.running` 为 `true`）。客户端轮询 [`GET /api/v1/capabilities/{capability_id}`](#get-api-v1-capabilities-capability-id) 查看进度。

服务端用路由 `POST /api/v1/capabilities/{tail}` 统一分发，`install` 是唯一动作；只给 id 或动作未知时，返回 `40001`。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `capability_id` | path | string | 必填。能力 id |
| `stopRunningProcesses` | body | boolean | 可选。为 `true` 时允许安装过程停止仍在运行的相关进程。请求体可省略 |

成功时 `data` 为 [能力状态对象](#能力状态对象)。

目前只有 Windows 上的 `kimi-cu` 会检查运行中的进程：存在相关进程且没有传 `stopRunningProcesses: true` 时，后台安装结束，`install.confirmationRequired` 为 `stop-processes`。

- `40001`：缺少动作后缀或动作未知
- `40418`：没有该 id 的能力
- `40924`：该能力的安装已在进行中
- `40925`：当前平台 / 架构不支持该能力

### 插件摘要

列出、安装插件时返回这个结构，插件详情在它的基础上增加字段。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 插件 id |
| `displayName` | string | 展示名称 |
| `description` | string | 可选。描述 |
| `shortDescription` | string | 可选。简短描述 |
| `longDescription` | string | 可选。详细描述 |
| `version` | string | 可选。版本 |
| `enabled` | boolean | 是否启用 |
| `state` | string | `ok` / `error`。加载失败时也会置 `hasErrors` |
| `skillCount` | integer | Skill 数量 |
| `mcpServerCount` | integer | MCP 服务数量 |
| `enabledMcpServerCount` | integer | 已启用的 MCP 服务数量 |
| `hookCount` | integer | hook 数量 |
| `commandCount` | integer | 命令数量 |
| `hasErrors` | boolean | 是否有错误 |
| `source` | string | `local-path` / `zip-url` / `github` |
| `originalSource` | string | 可选。原始来源 |
| `github` | object | 可选。GitHub 来源的插件携带来源信息 `{ owner, repo, ref, installedSha? }`，其中 `ref` 为 `{ kind, value }`，`kind` 为 `branch` / `tag` / `sha` |
| `origin` | string | `marketplace` / `custom` / `unknown` |
| `catalogId` | string | 可选。目录 id |
| `installedAt` | string | 安装时间，ISO 时间戳 |

### `GET /api/v1/plugins`

列出已安装插件。

成功时 `data` 为 `{ plugins }`，每项是一个 [插件摘要](#插件摘要)。

### `GET /api/v1/plugins/{plugin_id}`

读取已安装插件的详情与能力。`skills` 和 `mcpServers` 两份清单都来自插件的真实文件与 manifest。`interface.skillOverrides` 和 `interface.mcpOverrides` 只覆盖展示信息，不改变调用名称或运行配置。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `plugin_id` | path | string | 必填。已安装插件 id |
| `locale` | query | string | 可选。例如 `en-US` 或 `zh-CN`，用于读取 `interface.locales` 中对应语言的翻译，只影响能力的展示文案；未匹配的字段回退到默认 `interface` |

成功时 `data` 为 [插件摘要](#插件摘要)，另加以下字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `root` | string | 插件根目录 |
| `updatedAt` | string | 可选。更新时间 |
| `manifestKind` | string | 可选。manifest 类型：`kimi-plugin-root` / `kimi-plugin-dir` |
| `manifestPath` | string | 可选。manifest 路径 |
| `skills` | array | 实际发现的 Skill：调用名称 `name`，以及可选的展示名称 `displayName` 与描述 `description` |
| `mcpServers` | array | manifest 声明的 MCP 服务：名称、运行时名称、启停状态、传输方式、非敏感连接配置，以及可选的展示名称、描述和图标 URL |
| `shadowedManifestPath` | string | 可选。被遮蔽的 manifest 路径 |
| `diagnostics` | array | 诊断信息，每项为 `{ severity, message }`，`severity` 为 `error` / `warn` / `info` |

- `40419`：没有该 id 的已安装插件

### `POST /api/v1/plugins`

安装插件并返回其摘要。请求体二选一：自定义安装只传 `source`；市场安装传 `marketplaceId` 及预期版本信息，不直接传 `source`。两种写法都不接受其他字段。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `source` | body | string | 自定义安装时必填。本地绝对路径、http(s) ZIP URL 或 GitHub URL。GitHub URL 可以用 `/tree/<branch-or-sha>`、`/releases/tag/<tag>` 或 `/commit/<sha>` 锁定版本 |
| `marketplaceId` | body | string | 市场安装时必填。目录条目 id |
| `expectedVersion` | body | string | 市场安装用。用户看到的版本；无版本的自定义条目可省略 |
| `expectedSha256` | body | string | 市场安装用。用户看到的 `sha256sum`（64 位十六进制）。ZIP 条目声明了 `sha256sum` 时，必须传入且与目录一致；本地目录和 GitHub 条目无需传 |

市场安装时，服务端从同一份目录快照解析 `source`、`sha256sum` 和预期插件 ID，在解压前校验压缩包，并校验 manifest ID。

成功时 `data` 为 [插件摘要](#插件摘要)。

- `40001`：校验失败，例如 `source` 既不是 URL 也不是绝对路径，或插件加载失败
- `40409`：本地路径不存在
- `40419`：没有该 id 的市场条目
- `40934`：目录条目已相对用户看到的版本发生变化（刷新目录后重试）

### `POST /api/v1/plugins/preview`

只读检查市场条目的能力，不安装插件。服务端把压缩包下载到临时目录，在解压前校验 SHA-256，校验 manifest ID，并发现其中的 Skill 与 MCP 服务。预览不写入安装记录，不安装运行时，也不保留解压后的插件。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `marketplaceId` | body | string | 必填。目录条目 id |
| `expectedVersion` | body | string | 用户看到的版本 |
| `expectedSha256` | body | string | 可选。用户看到的 `sha256sum`（64 位十六进制），提供时必须与当前目录一致 |
| `locale` | body | string | 可选。展示文案的语言，选择规则与 [`GET /api/v1/plugins/{plugin_id}`](#get-api-v1-plugins-plugin-id) 的 `locale` 相同 |

成功时 `data` 为 `{ skills, mcpServers }`，例如：

```json
{
  "skills": [{ "name": "<Skill 名称>", "description": "<可选描述>" }],
  "mcpServers": [{ "name": "<manifest 中的名称>", "runtimeName": "<运行时名称>", "enabled": true, "transport": "stdio" }]
}
```

两类条目还可以包含 overrides 提供的 `displayName`、`description`，MCP 条目还可以包含 `iconUrl`。MCP 条目的字段结构与 [`GET /api/v1/plugins/{plugin_id}`](#get-api-v1-plugins-plugin-id) 相同，示例只列出常用字段。

- `40001`：请求、压缩包、SHA-256 或 manifest 无效
- `40419`：没有该 id 的市场条目
- `40934`：目录条目已相对用户看到的版本发生变化（刷新目录后重试）

### `GET /api/v1/plugins/marketplace`

列出插件市场目录，并合并实时安装状态。默认目录 URL 由当前 managed `baseURL` 派生为 `${baseURL}/plugins/marketplace`，不再注入内置能力条目。

服务端按两个条件过滤条目，两个条件必须同时满足：

- **宿主**：目录中的 `clients` 把条目限制为 `desktop`、`cli` 或两者，缺省时两种宿主均可用。Web 和 Remote Control 使用所连接 server 的宿主身份。
- **操作系统**：`platforms` 独立按服务端所在的操作系统过滤。`platforms` 未设置、包含服务端所在的平台，或者只包含 `cloud` 时，条目保留；其他条目被过滤，包括同时列了 `cloud` 和其他平台、但不包含服务端所在平台的条目。

cloud-only 条目不能在本机安装。旧 `kimi-webbridge` 条目不再返回，Computer Use 只返回当前平台对应的接线插件。

安装记录和托管文件仍共享在服务端的数据目录下。当前宿主不可用的条目，也会从该宿主的已安装列表和运行能力中隐藏。

服务端把最近一次成功获取的可用性配置缓存到 `plugins/availability.json`。目录刷新成功后，客户端规则的变化会隐藏或恢复已有安装，无需重新安装，也不会删除插件文件。

成功时 `data` 为 `{ entries }`，每项字段如下。安装市场条目的请求写法见 [`POST /api/v1/plugins`](#post-api-v1-plugins)。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 目录条目 id，市场安装时作为 `marketplaceId` 传入 |
| `tier` | string | 条目层级：`official` / `curated` / `third-party`。条目声明了 `distribution` 时，`distribution.category` 为 `official` 取 `official`，否则取 `curated`；没有声明时取条目的 `tier`，缺省为 `third-party` |
| `classification` | string | 条目分类：`official` / `third_party`。条目声明了 `distribution` 时取 `distribution.category`，否则由 `tier` 推出：`official` 取 `official`，其余取 `third_party` |
| `displayName` | string | 展示名称 |
| `description` | string | 可选。描述，语言由 `defaultLocale` 声明 |
| `shortDescription` | string | 可选。简短描述 |
| `longDescription` | string | 可选。详细描述 |
| `cliDescription` | string | 可选。CLI 描述，语言由 `defaultLocale` 声明 |
| `homepage` | string | 可选。主页 |
| `keywords` | string[] | 可选。关键词 |
| `version` | string | 可选。版本 |
| `source` | string | 条目来源 |
| `iconUrl` | string | 可选。图标 URL |
| `sha256sum` | string | 可选。压缩包摘要 |
| `filename` | string | 可选。文件名 |
| `locale` | object | 可选。各语言的 `displayName`、`shortDescription`、`longDescription` 和 `cliDescription` 翻译 |
| `defaultLocale` | string | 可选。顶层 `description` / `cliDescription` 的语言 |
| `platforms` | string[] | 可选。`darwin` / `win32` / `linux` / `cloud` |
| `distribution` | object | 可选。分发信息：`category` 为 `official` / `third_party`；可选的 `region`（string）、`defaultInstall`（boolean）、`weight`（number）、`userLevel` 原样取自目录 |
| `billing` | object | 可选。计费信息，原样取自目录 |
| `installed` | object | 可选。已安装时携带实时安装状态 `{ version?, enabled }` |
| `updateAvailable` | boolean | 可选。有可用更新时为 `true`，否则省略 |
| `capabilityId` | string | 可选。只由服务端标注，且只在使用默认市场时标注：`kimi-browser-extension` 映射到 `kimi-webbridge` 能力，`kimi-cu` / `kimi-cu-win` 映射到 `kimi-cu` 能力 |

- `50001`：市场不可达或返回了非法目录

### `POST /api/v1/plugins/{plugin_id}:enable`

启用一个已安装插件。插件动作由单一路由 `POST /api/v1/plugins/{tail}` 分发：尾部按 `{plugin_id}:{action}` 解析，动作为 `enable` / `disable` / `remove`；只给 id 或动作未知时，返回 `40001`（`unsupported action: ...`）。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `plugin_id` | path | string | 必填。已安装插件 id |

成功时 `data` 为 `{ ok: true }`。

- `40001`：缺少动作后缀或动作未知
- `40419`：没有该 id 的已安装插件

### `POST /api/v1/plugins/{plugin_id}:disable`

停用一个已安装插件，但不移除它。分发规则同 [`:enable`](#post-api-v1-plugins-plugin-id-enable)。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `plugin_id` | path | string | 必填。已安装插件 id |

成功时 `data` 为 `{ ok: true }`。

- `40001`：缺少动作后缀或动作未知
- `40419`：没有该 id 的已安装插件

### `POST /api/v1/plugins/{plugin_id}:remove`

移除一个已安装插件。分发规则同 [`:enable`](#post-api-v1-plugins-plugin-id-enable)。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `plugin_id` | path | string | 必填。已安装插件 id |

成功时 `data` 为 `{ ok: true }`。

- `40001`：缺少动作后缀或动作未知
- `40419`：没有该 id 的已安装插件

## 工作区

管理工作区注册表，并读写每个工作区的信任状态。工作区是已注册的项目目录，会话都落在其中；信任状态决定是否加载该工作区的项目级 MCP 配置。返回工作区的接口都使用 [工作区对象](#工作区对象)。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/v1/workspaces` | 列出已注册工作区 |
| `POST /api/v1/workspaces` | 注册工作区（每次调用创建新条目，重试用 `idempotency_key` 去重） |
| `PATCH /api/v1/workspaces/{workspace_id}` | 重命名，或整体替换源文件夹 |
| `POST /api/v1/workspaces/{workspace_id}/primary` | 把某个源文件夹提升为主目录 |
| `GET /api/v1/workspaces/project-config-dirs` | 只读获取项目 `local.toml` 中的附加目录 |
| `DELETE /api/v1/workspaces/{workspace_id}` | 注销工作区（保留磁盘内容） |
| `GET /api/v1/workspaces/{workspace_id}/trust` | 读取信任状态 |
| `POST /api/v1/workspaces/{workspace_id}/trust` | 授予信任 |
| `POST /api/v1/workspaces/{workspace_id}/untrust` | 撤销信任 |

### 工作区对象

注册和更新工作区时，服务端广播 [全局事件](./server-api-conversation.md#全局事件) `event.workspace.created` / `event.workspace.updated`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 工作区 id。隐式渠道（CLI / VS Code 按目录进入）为 `wd_<slug>_<hash12>`，经 `POST /api/v1/workspaces` 显式创建的为 `wm_<uuid>` |
| `root` | string | 主目录的绝对路径 |
| `name` | string | 显示名，1–100 个字符；默认取主目录的基名 |
| `kind` | string | `managed`：显式创建，`wm_` id，会话不合并项目 `local.toml`。`implicit`：按目录隐式注册，`wd_` id，会话合并项目 `local.toml` 以兼容旧配置 |
| `additional_dirs` | string[] | 注册表管理的额外源文件夹绝对路径，不含项目 `local.toml` 与临时来源 |
| `created_at` | string | 注册时间，ISO 8601 |
| `last_opened_at` | string | 最近一次打开或重新注册工作区的时间，ISO 8601 |
| `session_count` | integer | 工作区内的会话数 |

### `GET /api/v1/workspaces`

列出所有已注册工作区。

成功时 `data` 为 `{ items }`，每项是一个 [工作区对象](#工作区对象)。

### `POST /api/v1/workspaces`

注册一个新工作区并返回它。每次调用都创建新条目（`wm_<uuid>` id），即使同一路径已是其他工作区的主目录，也不会合并到已有条目或给出提示。

客户端重复提交（网络重试、重复点击）时应携带同一个 `idempotency_key`，服务端按键去重并返回首次创建的条目。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `root` | body | string | 必填。已存在目录的绝对路径，作为主目录 |
| `name` | body | string | 显示名，1–100 个字符。默认主目录的基名 |
| `additional_dirs` | body | string[] | 额外源文件夹，最多 64 项。每项按 `add-dir` 的规则解析（绝对路径、相对主目录或 `~` 展开），必须已存在且为目录，不能与主目录或彼此重复 |
| `idempotency_key` | body | string | 客户端生成的幂等键，1–200 个字符。相同键的重试返回首次创建的工作区 |

成功时 `data` 为 [工作区对象](#工作区对象)。

- `40001`：`root` 缺失或不是绝对路径，或其他请求校验失败（`details` 列出该字段）
- `40006`：`additional_dirs` 含重复项或与主目录相同。`msg` 为 `Duplicate source folder: <实际路径>`；`details` 为 `[{ "path": "additional_dirs.N", "directory": "<解析后的绝对路径>" }]`，其中 `path` 是请求字段位置，`directory` 是重复的目录
- `40409`：`root` 或 `additional_dirs` 中的路径不存在或不是目录

### `PATCH /api/v1/workspaces/{workspace_id}`

更新工作区的显示名和 / 或源文件夹，主目录不可修改。`name` 与 `additional_dirs` 至少提供其一。`additional_dirs` 是整体替换：提交编辑后的完整列表，省略该字段则保持不变。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `workspace_id` | path | string | 必填。工作区 id |
| `name` | body | string | 新的显示名，1–100 个字符 |
| `additional_dirs` | body | string[] | 替换后的完整额外源文件夹列表，解析与校验规则同 [`POST /api/v1/workspaces`](#post-api-v1-workspaces) |

成功时 `data` 为 [工作区对象](#工作区对象)。

- `40001`：两个字段都缺失，或其他请求校验失败（`details` 逐字段说明）
- `40006`：目录项重复或与主目录相同，`msg`、`details.path` 和 `details.directory` 的含义同 [`POST /api/v1/workspaces`](#post-api-v1-workspaces)
- `40409`：`additional_dirs` 中的路径不存在或不是目录
- `40410`：工作区不存在

### `POST /api/v1/workspaces/{workspace_id}/primary`

把目录集内的某个源文件夹提升为主目录。服务端做原子交换：该路径成为新的 `root`，原主目录进入 `additional_dirs`；工作区 id 与会话桶不变，全部会话保留。`local.toml` 跟随主目录生效，因此交换后原主目录 `local.toml` 中的附加目录不再并入。

对于已在 `local` 环境上运行、且未显式设置 `environmentCwd` 的既有会话，后续工具调用的默认工作目录和相对路径会跟随新的主目录。显式 `environmentCwd` 和远程环境绑定仍使用其配置的目录。

附加目录只扩大允许访问的范围，不会成为相对路径的候选根目录，访问这些目录需使用绝对路径或显式 `cwd`。切换过程中已注册的工具保持可用，工作区原有的信任决定也会在重启后保留。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `workspace_id` | path | string | 必填。工作区 id |
| `path` | body | string | 必填。要提升的目录，解析规则同 `add-dir`；必须在当前目录集（`root` ∪ `additional_dirs`）内 |

成功时 `data` 为 [工作区对象](#工作区对象)。

- `40001`：`path` 不在目录集内
- `40409`：`path` 不存在或不是目录
- `40410`：工作区不存在

### `GET /api/v1/workspaces/project-config-dirs`

只读返回指定项目 `local.toml` 中的 `workspace.additional_dir`，结果已解析为绝对路径、去重，并剔除 `root` 自身。接口不修改注册表，也不修改 `local.toml`。客户端可以用它把项目的旧配置并入新建或编辑工作区的表单，随保存生效。

服务端从 `root` 向上查找包含 `.git` 的目录作为项目根（找不到时用 `root` 本身），读取其中的 `.kimi-code/local.toml`。`local.toml` 缺失时返回空数组。TOML 损坏或配置的目录已不存在时请求失败，不会按空配置返回。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `root` | query | string | 必填。项目主目录的绝对路径 |

成功时 `data` 为 `{ additional_dirs: string[] }`。

- `40001`：`root` 缺失或为空；`local.toml` 的结构不合法（例如 `workspace.additional_dir` 不是字符串数组）；或其中配置的目录不存在、不是目录
- `50001`：`local.toml` 不是合法的 TOML，或读取失败

### `DELETE /api/v1/workspaces/{workspace_id}`

注销工作区。只移除注册表条目，磁盘上的目录不受影响。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `workspace_id` | path | string | 必填。工作区 id |

成功时 `data` 为 `{ deleted: true }`。

- `40410`：工作区不存在

### `GET /api/v1/workspaces/{workspace_id}/trust`

读取工作区的信任状态。信任状态决定是否为该工作区加载项目级 MCP 配置。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `workspace_id` | path | string | 必填。工作区 id |

成功时 `data` 为 `{ trusted }`。

- `40410`：工作区不存在

### `POST /api/v1/workspaces/{workspace_id}/trust`

把工作区标记为受信任，并加载其项目级 MCP 配置。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `workspace_id` | path | string | 必填。工作区 id |

成功时 `data` 为 `{ trusted: true }`。

- `40410`：工作区不存在

### `POST /api/v1/workspaces/{workspace_id}/untrust`

撤销与当前目录集关联的持久化信任记录。进程或配置覆盖没有让工作区保持受信任时，同时卸载其项目级 MCP 配置。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `workspace_id` | path | string | 必填。工作区 id |

成功时 `data` 为 `{ trusted }`，表示撤销后的有效信任状态。通常为 `false`；`KIMI_CODE_TRUST_WORKSPACE` 或 [`[workspace] require_trust = false`](../configuration/config-files.md#workspace-trust) 生效时仍为 `true`。

- `40410`：工作区不存在

## 文件上传

上传文件供后续引用（例如作为提示词附件），以及下载、删除已上传的文件。

| 方法与路径 | 说明 |
| --- | --- |
| `POST /api/v1/files` | multipart 上传（字段 `file`，可选 `name`、`expires_in_sec`），返回文件元信息 |
| `GET /api/v1/files/{file_id}` | 下载（二进制，错误用真实 HTTP 状态码） |
| `DELETE /api/v1/files/{file_id}` | 删除 |

### `POST /api/v1/files`

以 `multipart/form-data` 上传文件。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `file` | body | binary | 必填。multipart 的文件部分 |
| `name` | body | string | 存储的显示名。默认上传的文件名 |
| `expires_in_sec` | body | number | 文件过期前的秒数（非负）。默认永不过期 |

成功时 `data` 为文件元信息：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 文件 id，下载和删除时使用 |
| `name` | string | 显示名 |
| `media_type` | string | 取自上传的内容类型 |
| `size` | integer | 文件大小 |
| `created_at` | string | 上传时间 |
| `expires_at` | string | 可选。过期时间 |

- `40001`：multipart 请求体缺少 `file` 字段

### `GET /api/v1/files/{file_id}`

下载已上传的文件。响应是二进制流，支持 Range 请求，但不处理 `If-None-Match`。失败时使用真实 HTTP 状态码，见 [二进制与流式端点](./server-api-files.md#二进制与流式端点)。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `file_id` | path | string | 必填。上传响应返回的文件 id |

- `40407`（HTTP 404）：没有该 id 的文件（包括已过期的文件）

### `DELETE /api/v1/files/{file_id}`

删除已上传的文件。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `file_id` | path | string | 必填。上传响应返回的文件 id |

成功时 `data` 为 `{ deleted: true }`。

- `40407`（HTTP 404）：没有该 id 的文件

## GUI 存储

由服务端支撑的键值存储，接口对齐浏览器的 `localStorage`，数据持久化在服务的 home 目录下。web UI 用它保存跨客户端的 UI 状态。值是不透明字符串，序列化由调用方负责。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/v1/gui/store/length` | 已存键的数量 |
| `GET /api/v1/gui/store/getItem` | 按键读取值 |
| `POST /api/v1/gui/store/setItem` | 按键写入值 |
| `POST /api/v1/gui/store/removeItem` | 按键删除值 |
| `POST /api/v1/gui/store/clear` | 删除所有值 |

### `GET /api/v1/gui/store/length`

返回已存键的数量，对齐 `localStorage.length`。无参数。

成功时 `data` 为 `{ length }`。

### `GET /api/v1/gui/store/getItem`

读取一个值，对齐 `localStorage.getItem`。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `key` | query | string | 必填。要读取的键，1–256 个字符 |

成功时 `data` 为 `{ value }`：已存的字符串，键不存在时为 `null`。

### `POST /api/v1/gui/store/setItem`

写入一个值，对齐 `localStorage.setItem`。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `key` | body | string | 必填。要写入的键，1–256 个字符 |
| `value` | body | string | 必填。要存储的值 |

成功时 `data` 为 `null`。

### `POST /api/v1/gui/store/removeItem`

删除一个值，对齐 `localStorage.removeItem`。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `key` | body | string | 必填。要删除的键，1–256 个字符 |

成功时 `data` 为 `null`。

### `POST /api/v1/gui/store/clear`

删除所有已存的值，对齐 `localStorage.clear`。无参数。

成功时 `data` 为 `null`。

## 全局搜索与其他

跨会话全文搜索、列出在线的 WebSocket 连接，以及其他接口的入口。

| 方法与路径 | 说明 |
| --- | --- |
| `POST /api/v1/search` | 跨会话全文搜索，`mode` 为 `terms`（默认）或 `literal`（精确子串），`page_token` 分页 |
| `GET /api/v1/connections` | 列出当前在线的 WebSocket 连接 |
| `GET /api/v1/sessions` | 会话列表与分组查询，见 [`GET /api/v1/sessions`](./server-api-sessions.md#get-api-v1-sessions) |
| `POST /api/v1/sessions:archive` | 批量归档会话，见 [`POST /api/v1/sessions:archive`](./server-api-sessions.md#post-api-v1-sessions-archive) |
| `POST /api/v1/sessions:restore` | 批量恢复已归档会话，见 [`POST /api/v1/sessions:restore`](./server-api-sessions.md#post-api-v1-sessions-restore) |
| `/api/v1/mcp/*` | 统一的 MCP 管理面，见 [MCP 管理](#mcp-管理) |
| `/api/v1/debug/*` | 反射式调试 RPC，仅在 `--debug-endpoints` 且 loopback 时挂载，不属于稳定协议 |

### `POST /api/v1/search`

跨会话全文搜索 User 消息、Assistant 回复与会话标题，由服务端的持久搜索索引支撑。

用 `container.session_id` 限定在单个会话内搜索时同样走索引。因此运行中步骤正在生成的文本，要等该步骤保存、索引追上之后才能搜到；仍在追赶的视图由 `index_state.stale` 标记。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `query` | body | string | 必填。搜索文本 |
| `mode` | body | string | `terms`（默认）/ `literal` |
| `op` | body | string | `terms` 模式下的词项组合方式：`AND`（默认）/ `OR` |
| `container` | body | object | 把搜索限定在 `{ session_id?, agent_id? }` |
| `role` | body | string | 只看 `user` / `assistant` / `title` 命中 |
| `start_time` | body | integer | 只看不早于该时间的命中（epoch 毫秒） |
| `end_time` | body | integer | 只看不晚于该时间的命中（epoch 毫秒） |
| `sort` | body | string | `score`（默认）/ `time_desc` / `time_asc`；`literal` 模式忽略此参数，始终最新在前 |
| `page_size` | body | integer | 每页命中数，1–50。默认 `20` |
| `page_token` | body | string | 上一页响应返回的令牌 |

`terms` 模式把查询分词（ASCII 词加 CJK n-gram）、去重，并以至多 32 个词项匹配倒排索引。`literal` 模式是零误报的精确子串搜索。

分页令牌锁定索引代际与查询条件，索引重建或查询变更都会使令牌失效。

成功时 `data` 字段如下：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `items` | array | 命中列表，每项字段见下表 |
| `has_more` | boolean | 是否还有下一页 |
| `page_token` | string | 可选。下一页的令牌 |
| `incomplete` | string | 仅超出预算的页携带：`candidate_cap` / `postings_budget` / `deadline` |
| `index_state.state` | string | `building` / `ready` / `readonly` |
| `index_state.indexed_sessions` | integer | 已索引的会话数 |
| `index_state.total_sessions` | integer | 会话总数 |
| `index_state.documents` | integer | 文档数 |
| `index_state.stale` | boolean | 可选。标记仍在追赶的落后视图 |
| `index_state.degraded` | string | 可选。最近一次刷新失败的信息 |

`items` 每项字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `session_id` | string | 会话 id |
| `workspace_id` | string | 工作区 id |
| `session_title` | string | 会话标题 |
| `agent_id` | string | Agent id |
| `role` | string | `user` / `assistant` / `title` |
| `snippet` | string | 命中片段 |
| `time` | number | 命中时间 |
| `turn` | integer | 可选。轮次 |
| `step_id` | string | 可选。步骤 id |
| `score` | number | 相关性得分 |

- `40001`：请求体校验失败、查询不可用（为空或超过 32 个词项），或分页令牌非法

### `GET /api/v1/connections`

列出当前连接到本服务的 WebSocket 客户端，最早连接的在前。无参数。

成功时 `data` 为 `{ connections }`，每项字段如下：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 连接 id |
| `connected_at` | string | 连接时间，ISO 8601 |
| `remote_address` | string \| null | 远端地址，未知时为 `null` |
| `user_agent` | string \| null | User-Agent，未知时为 `null` |
| `subscriptions` | string[] | 该连接订阅的会话 id |

## MCP 管理

`/api/v1/mcp/*` 是服务统一的 MCP 管理面，独立于任何会话，直接管理 MCP 服务注册表本身。它覆盖用户级配置的增删改查（每条配置写入前校验）、连接测试、按 locator 寻址的检查目录、各服务的授权状态，以及完整的 OAuth 流程。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/v1/mcp/servers` | 列出所有已知 MCP 服务 |
| `GET /api/v1/mcp/servers/{name}` | 按运行时名称获取单个 MCP 服务 |
| `POST /api/v1/mcp/servers` | 向用户级 `mcp.json` 添加 MCP 服务 |
| `PUT /api/v1/mcp/servers/{name}` | 替换一个用户级条目 |
| `DELETE /api/v1/mcp/servers/{name}` | 删除一个用户级条目 |
| `POST /api/v1/mcp/servers:test` | 对单个 MCP 服务发起真实连接探测 |
| `POST /api/v1/mcp/servers:inspect` | 按 locator 寻址的目录，并批量探测连接 |
| `GET /api/v1/mcp/auth-statuses` | 目录中各 MCP 服务的 OAuth 状态 |
| `POST /api/v1/mcp/auth:begin` | 开始一次交互式 OAuth 流程 |
| `POST /api/v1/mcp/auth:complete` | 等待浏览器回调并完成 code 交换 |
| `POST /api/v1/mcp/auth:cancel` | 终止已开始的 OAuth 流程 |
| `POST /api/v1/mcp/auth:reset` | 清除某个 MCP 服务已存储的凭据 |

管理面有两种寻址方式：

- **运行时名称**：增删改查接口与 `servers:test` 使用普通的运行时 `name`。
- **locator**：检查与 OAuth 接口使用 locator，因为插件条目和文件条目可能共用同一个运行时名称。文件层条目的 locator 为 `{ "source": "global", "name" }`，插件清单条目为 `{ "source": "plugin", "pluginId", "serverName" }`。

检查结果还带有稳定的 `serverId` 标识：`global:<name>` 或 `plugin:<pluginId>:<serverName>`（URL 编码）。

除 `auth:complete` 和 `auth:cancel` 外，各接口都接受可选的 `cwd`：`servers:test` 和 `servers:inspect` 放在请求体中，其余接口（包括 `auth:begin` 和 `auth:reset`）是查询参数。不传时目录只覆盖用户级文件与插件清单；传入后，该目录的项目根层与项目本地层会并入，但仅在工作区 [受信任](#get-api-v1-workspaces-workspace-id-trust) 时并入，否则跳过项目层。对 stdio 服务执行 `servers:test` 时，`cwd` 同时是子进程的工作目录。

连接探测与 OAuth 调用会等服务配置加载完成后再执行。

### `GET /api/v1/mcp/servers`

列出管理面已知的全部 MCP 服务。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `cwd` | query | string | 并入该目录（须受信任）的项目层 |

成功时 `data` 是受管 MCP 服务数组，每项字段如下：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `name` | string | 运行时名称 |
| `config` | object | 可变条目携带完整配置，便于编辑界面预填；只读条目脱敏为排序后的键名列表（`envKeys` / `headerKeys`），不会泄露密钥值 |
| `source` | string | `global`（配置文件层，包括用户级文件和项目层）或 `plugin`（插件清单）。schema 中另有 `caller`，目前不会返回 |
| `origin` | string | 条目的定义位置：文件路径或插件 id |
| `mutable` | boolean | 只有用户级条目可变；插件与项目层条目均为只读 |
| `plugin` | object | 仅插件条目携带：`{ id, name }` |

- `40001`：校验失败

### `GET /api/v1/mcp/servers/{name}`

按运行时名称获取单个 MCP 服务。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `name` | path | string | 必填。MCP 服务的运行时名称 |
| `cwd` | query | string | 并入该目录（须受信任）的项目层 |

成功时 `data` 为单个受管 MCP 服务，字段同 [`GET /api/v1/mcp/servers`](#get-api-v1-mcp-servers)。

- `40001`：校验失败
- `40408`：不存在该名称的 MCP 服务

### `POST /api/v1/mcp/servers`

向用户级 `mcp.json` 添加 MCP 服务。请求体是包含 `name` 的完整服务配置，`transport`（`stdio` / `http` / `sse`）决定配置形状，写入前会校验。

写入与项目层的同名条目冲突时，因条目只读而被拒绝，需改为编辑定义它的文件。项目层只在传入 `cwd` 且该目录受信任时并入，因此只有这时才会检查这一冲突。与同名的插件条目冲突不阻止写入，新的文件条目会遮蔽插件条目。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `cwd` | query | string | 并入该目录（须受信任）的项目层，返回的列表也包含项目层 |

成功时 `data` 为刷新后的 MCP 服务列表，字段同 [`GET /api/v1/mcp/servers`](#get-api-v1-mcp-servers)。

- `40001`：校验失败，或目标条目为只读

### `PUT /api/v1/mcp/servers/{name}`

替换一个用户级条目。请求体与 [`POST /api/v1/mcp/servers`](#post-api-v1-mcp-servers) 的配置相同，但不含 `name`，由路径指定条目；与同名条目冲突时的规则也相同。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `name` | path | string | 必填。要替换的条目的运行时名称 |
| `cwd` | query | string | 并入该目录（须受信任）的项目层 |

成功时 `data` 为刷新后的 MCP 服务列表。

- `40001`：校验失败，或目标条目为只读
- `40408`：不存在该名称的 MCP 服务

### `DELETE /api/v1/mcp/servers/{name}`

删除一个用户级条目。无请求体。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `name` | path | string | 必填。要删除的条目的运行时名称 |
| `cwd` | query | string | 并入该目录（须受信任）的项目层 |

成功时 `data` 为刷新后的 MCP 服务列表。

- `40001`：校验失败，或目标条目为只读
- `40408`：不存在该名称的 MCP 服务

### `POST /api/v1/mcp/servers:test`

对单个 MCP 服务发起真实连接探测，不持久化任何内容。传 `name` 探测注册表条目（含插件与受信任的项目层），或传 `server` 按原样探测内联配置；两者必须且只能传一个。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `name` | body | string | 注册表条目的运行时名称 |
| `server` | body | object | 按原样探测的内联配置，须包含 `name` |
| `cwd` | body | string | 用于并入项目层；同时是 stdio 子进程的工作目录 |

成功时 `data` 为 `{ success, output }`：连接成功时 `output` 列出该服务的可用工具，否则携带失败信息。

- `40001`：两种目标形式都传或都不传、内联配置无效，或运行时名称被多个已启用的 MCP 服务共用
- `40408`：不存在该名称的 MCP 服务

### `POST /api/v1/mcp/servers:inspect`

返回按 locator 寻址的目录（配置已脱敏），并对每个 OAuth 候选批量发起真实连接探测。探测遇到过期授权时，可能刷新或作废已存储的凭据。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `targets` | body | array | 缩小目录范围的 locator 数组；不传则检查全部 MCP 服务 |
| `cwd` | body | string | 并入该目录（须受信任）的项目层 |

成功时 `data` 是检查结果数组，每项字段如下：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `serverId` | string | 稳定标识，格式见 [MCP 管理](#mcp-管理) |
| `locator` | object | 该条目的 locator |
| `runtimeName` | string | 运行时名称 |
| `canonicalUrl` | string | 可选。远程服务的凭据 URL |
| `origin` | string | 条目来源，取值与 [`GET /api/v1/mcp/servers`](#get-api-v1-mcp-servers) 的 `source` 相同 |
| `config` | object | 脱敏后的配置 |
| `enabled` | boolean | 是否启用 |
| `editable` | boolean | 是否可编辑 |
| `authStatus` | string | `not-applicable` / `bearer-token` / `oauth-required` / `oauth-authorized` / `oauth-expired` / `unavailable`。运行时名称被多个已启用的 MCP 服务共用时无法无歧义地探测，报告 `unavailable` |
| `checkedAt` | number | 可选。检查时间 |
| `error` | string | 可选。错误说明，例如运行时名称被共用时的说明 |

- `40001`：校验失败
- `40408`：`targets` 中有 locator 未匹配到任何条目

### `GET /api/v1/mcp/auth-statuses`

读取注册表目录中各 MCP 服务的 OAuth 状态。只需要授权维度时，它比 [`servers:inspect`](#post-api-v1-mcp-servers-inspect) 更轻量。验证探测可能刷新或作废已存储的凭据。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `cwd` | query | string | 并入该目录（须受信任）的项目层 |
| `verify` | query | string | `true`：对每个 OAuth 候选发起真实连接验证。`false`：完全离线，只凭配置与已存储的 token 分类。缺省：保留隐式 OAuth 探测，只探测未固定且没有已存储凭据的远程服务 |

成功时 `data` 是 `{ name, authStatus }` 数组，`authStatus` 的取值与 [`servers:inspect`](#post-api-v1-mcp-servers-inspect) 相同。

### `POST /api/v1/mcp/auth:begin`

为远程 MCP 服务开始一次交互式 OAuth 流程。目标必须使用远程传输（`http` / `sse`），且不含静态 bearer token；静态请求头仅在配置显式设置 `auth: "oauth"` 时允许。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| locator | body | object | 必填。整个请求体是目标的 [locator](#mcp-管理) |
| `cwd` | query | string | 可选。并入该目录（须受信任）的项目层 |

成功时 `data.status` 为以下两种之一：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `status` | string | `authorization-required`：需要授权。`already-authorized`：授权已存在，此时没有其他字段 |
| `flowId` | string | 仅 `authorization-required`：流程 id，供 `auth:complete` 与 `auth:cancel` 使用 |
| `authorizationUrl` | string | 仅 `authorization-required`：在浏览器中打开该 URL 完成授权 |

- `40001`：校验失败；该 MCP 服务无法使用 OAuth（stdio 传输、静态 bearer token，或未设置 `auth: "oauth"` 的静态请求头）；或运行时名称被多个已启用的 MCP 服务共用
- `40408`：locator 未匹配到任何条目
- `40929`：OAuth 流程本身失败

### `POST /api/v1/mcp/auth:complete`

等待已开始流程的浏览器回调，并完成 code 交换。等待默认 15 分钟，可用 `timeoutMs` 覆盖；空闲流程无论如何都会在 15 分钟后过期。客户端关闭 HTTP 连接会中止等待。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `flowId` | body | string | 必填。`auth:begin` 返回的流程 id |
| `timeoutMs` | body | integer | 等待时长（毫秒），1 到 2³¹−1。默认 15 分钟 |

成功时 `data` 为 `null`。

- `40001`：校验失败，包括 `flowId` 未知、`timeoutMs` 超出范围
- `40929`：OAuth 流程本身失败

### `POST /api/v1/mcp/auth:cancel`

在未完成的情况下终止已开始的流程。未知流程会被忽略。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `flowId` | body | string | 必填。要终止的流程 id |

成功时 `data` 为 `null`。

- `40001`：校验失败
- `40929`：OAuth 流程本身失败

### `POST /api/v1/mcp/auth:reset`

清除某个 MCP 服务已存储的凭据，失效事件会送达存活的会话。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| locator | body | object | 必填。整个请求体是目标的 [locator](#mcp-管理) |
| `cwd` | query | string | 可选。并入该目录（须受信任）的项目层 |

成功时 `data` 为 `null`。

- `40001`：校验失败；目标使用 stdio 传输；或运行时名称被多个已启用的 MCP 服务共用
- `40408`：locator 未匹配到任何条目
- `40929`：OAuth 流程本身失败
