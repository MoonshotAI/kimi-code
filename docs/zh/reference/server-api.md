# 服务 API

`kimi web` 启动的本地服务暴露两组程序化接口：REST API（`/api/v1`，另有 `/api/v2/sessions`）和 WebSocket 事件流（`/api/v1/ws`）。本页是这两组接口的协议参考；服务的启动方式与命令行选项见 [kimi 命令](./kimi-command.md#kimi-web)，端到端的上手流程见[本地服务与 API](../guides/server.md)。

每个端点的完整请求 / 响应 schema 以服务自描述的规范文档为准：`GET /openapi.json`（OpenAPI）与 `GET /asyncapi.json`（AsyncAPI），两者都需要鉴权。

::: warning 注意
本页描述的 REST 与 WebSocket API 为实验性特性：不保证接口稳定性，端点、字段与事件类型可能随版本随时更改。集成时请以当前版本服务的 `/openapi.json` 与 `/asyncapi.json` 为准。
:::

## 基础约定

### 地址

默认地址 `http://127.0.0.1:58627`；端口被占用时自动 +1 重试（至多 100 次），可用 `--port` / `--host` 修改。同一 home 目录可并存多个实例，运行中的实例登记在 `~/.kimi-code/server/instances/`。

### 鉴权

除以下例外，所有 `/api/*` 路径（含 `/openapi.json` 与 `/asyncapi.json`）都要求 bearer token：

- `OPTIONS` 预检请求
- `GET /api/v1/healthz`（探活）
- 静态 web 资源（非 `/api/` 路径）

携带方式：REST 用 `Authorization: Bearer <token>` 请求头；WebSocket 升级请求可用同一请求头，或子协议 `kimi-code.bearer.<token>`。token 的生成与轮换见[本地服务与 API：鉴权](../guides/server.md#鉴权)。

鉴权失败返回 HTTP 401，信封 `code` 为 `40101`。在非 loopback 绑定上，同一来源 60 秒内鉴权失败 10 次会被封禁 60 秒，期间一律返回 HTTP 429（`code` 为 `42901`）。

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

其中 201 的响应体仍是标准信封（`code` 为 `0`），只是状态行遵循 REST 的资源创建习惯；204 按 HTTP 语义没有响应体，删除成功以状态码本身为准。

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
- **`page_token`**：不透明令牌（内部绑定了查询条件指纹），用于 `POST /api/v1/search` 与 `GET /api/v2/sessions`。翻页途中改变任何查询条件会使令牌失效：v2 返回 `40922`，search 返回 `40001`。`GET /api/v2/sessions` 另提供无状态的 `page` 页码模式作为替代。

## REST 端点

按资源分组列出端点。路径里的 `:{action}` 是动作后缀约定——对单个资源 POST 到 `路径:动作` 执行非 CRUD 操作（如会话的 `:fork`、`:archive`）。

### 服务与元信息

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/v1/healthz` | 探活，免鉴权 |
| `GET /api/v1/meta` | 服务版本、能力集、`server_id`、实验开关等 |
| `POST /api/v1/shutdown` | 优雅退出（先回 200 再关闭）；仅 loopback 绑定时挂载 |

### 登录与用量

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/v1/auth` | 登录就绪状态快照 |
| `POST /api/v1/oauth/login` | 发起 OAuth device-code 登录流程 |
| `GET /api/v1/oauth/login` | 轮询登录流程状态 |
| `DELETE /api/v1/oauth/login` | 取消进行中的登录流程 |
| `POST /api/v1/oauth/logout` | 登出托管供应商 |
| `GET /api/v1/oauth/usage` | 查询套餐用量与限额 |
| `GET /api/v1/oauth/userinfo` | 查询账号资料 |

### 配置

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/v1/config` | 读取全局配置（密钥字段脱敏） |
| `POST /api/v1/config` | 合并式更新配置，并广播 `event.config.changed` |

### 模型与供应商

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

### 会话

| 方法与路径 | 说明 |
| --- | --- |
| `POST /api/v1/sessions` | 创建会话（需 `workspace_id` 或 `metadata.cwd`） |
| `GET /api/v1/sessions` | 列出会话，游标分页，支持 `busy` / `archived_only` 等过滤 |
| `GET /api/v1/sessions/{session_id}` | 读取单个会话 |
| `GET /api/v1/sessions/{session_id}/profile` | 读取会话档案 |
| `POST /api/v1/sessions/{session_id}/profile` | 更新标题、元数据、agent 配置 |
| `POST /api/v1/sessions/{session_id}:{action}` | 会话动作：`fork` / `compact` / `undo` / `abort` / `btw` / `archive` / `restore` |
| `GET /api/v1/sessions/{session_id}/children` | 列出子会话 |
| `POST /api/v1/sessions/{session_id}/children` | 创建子会话（fork 并打标） |
| `GET /api/v1/sessions/{session_id}/status` | 实时状态汇总 |
| `GET /api/v1/sessions/{session_id}/goal` | 当前目标快照（无则 `null`） |
| `GET /api/v1/sessions/{session_id}/warnings` | 会话级告警 |
| `POST /api/v1/sessions/{session_id}/export` | 导出会话与诊断信息（zip 流，不走信封） |
| `GET /api/v1/sessions/{session_id}/snapshot` | 客户端重建用全量快照（含 `as_of_seq` 与 `epoch`） |

### 消息与转录

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/v1/sessions/{session_id}/messages` | 消息分页（`before_id` / `after_id` / `role`） |
| `GET /api/v1/sessions/{session_id}/messages/{message_id}` | 读取单条消息 |
| `GET /api/v1/sessions/{session_id}/transcript` | 转录按轮次分页（需 `agent_id`），全局状态不分页随响应返回 |
| `GET /api/v1/sessions/{session_id}/transcript/ops` | 转录批次补漏（`since_seq`），`complete: false` 时需全量刷新 |
| `GET /api/v1/sessions/{session_id}/transcript/user-messages` | 各轮次的用户输入，不分页 |
| `GET /api/v1/sessions/{session_id}/transcript/plan` | ExitPlanMode 计划内容、路径与审阅结果 |

### 提示词

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/v1/sessions/{session_id}/prompts` | 进行中与排队中的提示词 |
| `POST /api/v1/sessions/{session_id}/prompts` | 提交提示词（内容块数组，可带模型 / 权限模式等覆盖） |
| `POST /api/v1/sessions/{session_id}/prompts:steer` | 把排队的提示词插入当前轮次 |
| `POST /api/v1/sessions/{session_id}/prompts/{prompt_id}:abort` | 中止进行中的提示词 |
| `POST /api/v1/sessions/{session_id}/prompts/{prompt_id}:steer` | 插入单个排队提示词 |

### 审批与提问

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/v1/sessions/{session_id}/approvals` | 列出审批请求（可按 `status=pending` 过滤） |
| `POST /api/v1/sessions/{session_id}/approvals/{approval_id}` | 答复审批 |
| `GET /api/v1/sessions/{session_id}/questions` | 列出提问 |
| `POST /api/v1/sessions/{session_id}/questions/{question_id}` | 回答提问 |
| `POST /api/v1/sessions/{session_id}/questions/{question_id}:dismiss` | 忽略提问 |

### 后台任务

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/v1/sessions/{session_id}/tasks` | 列出后台任务 |
| `GET /api/v1/sessions/{session_id}/tasks/{task_id}` | 读取任务（可选输出预览） |
| `POST /api/v1/sessions/{session_id}/tasks/{task_id}:cancel` | 取消任务 |

### 技能、工具与 MCP

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/v1/sessions/{session_id}/skills` | 会话级技能目录 |
| `GET /api/v1/workspaces/{workspace_id}/skills` | 无会话的工作区技能目录 |
| `POST /api/v1/sessions/{session_id}/skills/{skill_name}:activate` | 激活技能（开启一个轮次） |
| `GET /api/v1/tools` | 列出当前生效 agent 的工具 |
| `GET /api/v1/mcp/servers` | 列出 MCP 服务 |
| `POST /api/v1/mcp/servers/{mcp_server_id}:restart` | 重启 MCP 服务 |

### 终端

PTY 终端接口，仅 loopback 绑定时挂载。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/v1/sessions/{session_id}/terminals` | 列出终端 |
| `POST /api/v1/sessions/{session_id}/terminals` | 创建终端 |
| `GET /api/v1/sessions/{session_id}/terminals/{terminal_id}` | 读取终端（含回滚缓冲） |
| `POST /api/v1/sessions/{session_id}/terminals/{terminal_id}:close` | 关闭终端 |

### 工作区

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/v1/workspaces` | 列出已注册工作区 |
| `POST /api/v1/workspaces` | 注册工作区（按根路径幂等） |
| `PATCH /api/v1/workspaces/{workspace_id}` | 重命名 |
| `DELETE /api/v1/workspaces/{workspace_id}` | 注销（保留磁盘内容） |
| `GET /api/v1/workspaces/{workspace_id}/trust` | 读取信任状态 |
| `POST /api/v1/workspaces/{workspace_id}/trust` | 授予信任 |
| `POST /api/v1/workspaces/{workspace_id}/untrust` | 撤销信任 |

### 文件系统

会话内文件操作为 `POST /api/v1/sessions/{session_id}/fs:{action}`，动作包括 `list` / `read` / `list_many` / `stat` / `stat_many` / `mkdir` / `search` / `grep` / `git_status` / `diff` / `open` / `open-in` / `reveal`，请求体为 JSON。另有：

| 方法与路径 | 说明 |
| --- | --- |
| `POST /api/v1/workspace/fs:search` | 无会话的工作区搜索（body 携带工作区引用） |
| `GET /api/v1/sessions/{session_id}/fs/{path}:download` | 下载会话文件（二进制，见下文） |
| `GET /api/v1/fs:browse` | 列出本机目录（文件夹选择器用） |
| `GET /api/v1/fs:home` | 用户主目录与最近工作区 |
| `GET /api/v1/fs:content` | 读取本机任意文件原始字节（仅受 token 保护，谨慎暴露端口） |
| `POST /api/v1/fs:mkdir` | 按绝对路径创建目录 |

### 文件上传

| 方法与路径 | 说明 |
| --- | --- |
| `POST /api/v1/files` | multipart 上传（字段 `file`，可选 `name`、`expires_in_sec`），返回文件元信息 |
| `GET /api/v1/files/{file_id}` | 下载（二进制，错误用真实 HTTP 状态码） |
| `DELETE /api/v1/files/{file_id}` | 删除 |

### 全局搜索与其他

| 方法与路径 | 说明 |
| --- | --- |
| `POST /api/v1/search` | 跨会话全文搜索，`mode` 为 `terms`（默认）或 `literal`（精确子串），`page_token` 分页 |
| `GET /api/v1/connections` | 列出当前在线的 WebSocket 连接 |
| `GET /api/v2/sessions` | 新一代会话列表，见下节 |
| `POST /api/v2/sessions:archive` | 批量归档会话，见下节 |
| `POST /api/v2/sessions:restore` | 批量恢复已归档会话，见下节 |
| `/api/v1/debug/*` | 反射式调试 RPC，仅 `--debug-endpoints` 且 loopback 时挂载，不属于稳定协议 |

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
        "sessions": [ { "id": "session_...", "workspace": { "id": "wd_my-app_a1b2c3d4e5f6", "cwd": "/Users/dev/my-app" }, "meta": { "title": "修复登录页", "last_prompt": "调整按钮间距", "created_at": 1787000000000, "updated_at": 1787000100000, "archived": false, "archived_at": null }, "activity": { "status": "idle" } } ],
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

唯一端点是 `ws://<host>:<port>/api/v1/ws`，升级请求即完成鉴权（方式见上文「鉴权」）。连接建立后服务端立即发送 `server_hello`：

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

错误语义也不相同：`GET /api/v1/files/{file_id}` 对查找和存储失败返回真实 404 / 500 状态码（参数校验失败仍走 HTTP 200 信封），其余三个端点的所有失败都走标准[响应信封](#响应信封)——客户端在这三个端点上仍需检查信封中的 `code`。

## 下一步

- [本地服务与 API](../guides/server.md) — 启动、鉴权与端到端调用流程
- [kimi 命令](./kimi-command.md#kimi-web) — `kimi web` 的全部命令行选项
