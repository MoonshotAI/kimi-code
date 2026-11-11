<script setup>
import { onMounted } from 'vue'
import { redirectLegacyServerApiAnchor } from '../../.vitepress/theme/serverApiLegacyAnchors'

onMounted(() => redirectLegacyServerApiAnchor('zh'))
</script>

# 服务 API【测试版】

`kimi web` 启动的本地服务提供两组接口：REST API（`/api/v1`，另有 `/api/v2/sessions` 和 `/api/v2/mcp`）和 WebSocket 事件流（`/api/v1/ws`）。脚本和第三方客户端可以用它们创建会话、提交提示词、实时接收对话内容，以及管理配置、模型和工作区。启动服务的方法和命令行选项见 [kimi 命令](./kimi-command.md#kimi-web)。

::: warning 注意
这些接口是实验性特性，不保证稳定：端点、字段和事件类型可能在任何版本中变化。集成时以你所用版本服务的 `/openapi.json` 和 `/asyncapi.json` 为准。
:::

本页说明所有接口共用的约定，并用一个最小例子走通完整流程。各类接口的细节分在以下几页：

- [会话与对话](./server-api-conversation.md)：WebSocket 协议，以及客户端如何订阅会话、显示对话、提交输入、处理审批和任务、断线后恢复。写客户端从这一页开始。
- [会话接口](./server-api-sessions.md)：创建、列出、修改会话，会话动作（分叉、压缩、撤销等），消息与轮次的分页读取，提示词和交互的 REST 接口。
- [服务与配置接口](./server-api-service.md)：服务信息、登录与用量、远程控制、配置、模型与供应商、Skill 与 MCP、插件、工作区、文件上传、全局搜索。
- [文件接口](./server-api-files.md)：读写会话目录、工作区和本机文件，以及下载类接口的 HTTP 行为。

## 在线 schema

本组页面是整理过、供人阅读的参考。每个端点精确的机器可读定义以服务运行时提供的两份文档为准：`GET /openapi.json`（REST，OpenAPI 格式）和 `GET /asyncapi.json`（WebSocket，AsyncAPI 格式）。两份文档都由服务实际执行的校验 schema 生成，读取时同样需要鉴权。本页与在线 schema 不一致时，以在线 schema 为准。

## 地址

默认地址为 `http://127.0.0.1:58627`。端口被占用时，服务会依次尝试下一个端口，最多重试 100 次。用 `--port` 和 `--host` 可以修改绑定地址。

同一个 home 目录下可以同时运行多个实例，运行中的实例登记在 `~/.kimi-code/server/instances/`。

## 鉴权

所有 `/api/*` 路径，以及 `/openapi.json` 和 `/asyncapi.json`，都需要 bearer token，只有下面三种请求例外：

- `OPTIONS` 预检请求；
- `GET /api/v1/healthz`（探活）；
- 静态网页资源（不在 `/api/` 下的路径）。

REST 请求用 `Authorization: Bearer <token>` 请求头携带 token。WebSocket 升级请求可以用同样的请求头，也可以用子协议 `kimi-code.bearer.<token>`。token 的生成和轮换见 [在网页中使用](../guides/web.md#开始使用)。

鉴权失败时返回 HTTP 401，信封 `code` 为 `40101`。服务绑定在非 loopback 地址时，同一来源 60 秒内鉴权失败 10 次会被封禁 60 秒，封禁期间每个请求都返回 HTTP 429，`code` 为 `42901`。

## 响应信封

所有 JSON 响应都包在同一种信封里：

```json
{
  "code": 0,
  "msg": "success",
  "data": {},
  "request_id": "01JZX4A6E7M8V0R3Q0N2K2M5Q9"
}
```

| 字段 | 说明 |
| --- | --- |
| `code` | 业务结果，`0` 表示成功，其他值见 [错误码](#错误码) |
| `msg` | 结果说明 |
| `data` | 成功时的业务数据。部分错误也会带 `data`，例如无法执行的撤销返回 `40911`，`data` 为 `{ reason, requestedCount, undoableCount }`。客户端应先判断 `code`，再读 `data` |
| `request_id` | 本次请求的 ULID。客户端可以用 `X-Request-Id` 请求头指定，值不合法时服务端重新生成 |

HTTP 状态码几乎总是 200，业务结果以 `code` 为准。例外情况如下：

| 场景 | HTTP 状态 |
| --- | --- |
| 鉴权失败 / 触发限流 | 401 / 429 |
| 创建供应商、导入供应商目录（`:import_catalog`）、导入自定义目录（`:import_registry`）成功 | 201，响应体仍是 `code` 为 `0` 的信封 |
| 删除供应商成功 | 204，没有响应体 |
| 二进制与流式端点 | 支持时返回 206（Range 分段）和 304（ETag 未变），各端点能力不同，见 [二进制与流式端点](./server-api-files.md#二进制与流式端点) |
| `GET /api/v1/files/{file_id}`、`GET /api/v1/fs:content` 和会话文件 `:download` 出错 | 真实的 4xx / 500 状态码，响应体仍是信封 |

## 错误码

错误码按前三位分段：

| 段位 | 含义 | 示例 |
| --- | --- | --- |
| `0` | 成功 | |
| `400xx` | 请求参数错误 | `40001` 校验失败（`details` 逐字段说明）、`40003` 供应商由 OAuth 托管、`40006` 工作区源文件夹重复 |
| `401xx` | 鉴权与就绪状态 | `40101` 未授权、`40110` 未配置供应商、`40113` 模型无法解析 |
| `404xx` | 资源不存在 | `40401` 会话、`40408` MCP 服务、`40409` 文件路径 |
| `409xx` | 状态冲突 | `40901` 会话忙、`40902` 交互已结束、`40922` 分页条件与 `page_token` 不符、`40931` 会话正被其他客户端使用、`40932` 会话已被其他客户端更新、`40935` 无法进入 Tower 模式 |
| `413xx` | 体积或范围超限 | `41302` 读取文件超过 10 MB、`41304` 路径超出会话目录 |
| `429xx` | 限流 | `42901` 鉴权失败封禁、`42902` 文件监听数超限 |
| `500xx` | 服务端内部错误 | `50001` 未捕获异常、`50003` 持久化失败 |
| `6xxxx` / `7xxxx` / `8xxxx` | 工具运行时、LLM 供应商、MCP 透传的错误 | `msg` 保留上游原文 |

各接口可能返回的错误码列在接口说明的末尾。

### 多个客户端打开同一会话

`40931` 和 `40932` 只在同一个会话被多个客户端打开时出现。

- **`40931`**：另一个 Kimi Code 进程正在写入这个会话。等它空闲后重试。如果确认那个进程已经退出、只是留下了锁，先调用 [`POST /api/v1/sessions/{session_id}:takeover`](./server-api-sessions.md#post-api-v1-sessions-session-id-takeover) 再重试。
- **`40932`**：会话已被其他客户端更新。提交提示词、激活 Skill 和压缩遇到这种情况时，服务端会重新载入会话，向订阅者推送最新的 `turns` 帧，然后重新执行请求，调用方不会收到 `40932`。只有撤销会返回 `40932`：服务端已经重新载入会话，这次没有撤销任何内容。客户端应让用户先查看刷新后的历史，再决定是否撤销。

## 分页

列表接口有两种分页方式：

- **游标分页**：`before_id` 和 `after_id`（二选一）加 `page_size`（1–100），响应为 `{ items, has_more }`。会话列表、消息列表等接口用这种方式。Agent 的轮次例外，按轮次的 `ordinal` 分页（`before_ordinal` 加 `page_size`）。
- **`page_token` 分页**：令牌不透明，绑定了查询条件。`POST /api/v1/search` 和 `GET /api/v2/sessions` 用这种方式。翻页过程中改变任何查询条件，令牌就会失效：`/api/v2/sessions` 返回 `40922`，搜索返回 `40001`。`GET /api/v2/sessions` 另外提供无状态的 `page` 页码模式。

## 动作路径

对单个资源执行增删改查以外的操作时，路径以 `:动作名` 结尾，用 POST 调用，例如 `POST /api/v1/sessions/{session_id}:fork`、`POST /api/v1/sessions/{session_id}:archive`。

## 用 API 驱动一个会话

下面用 curl 走一遍最小流程：确认服务状态，创建会话，订阅事件，提交提示词，再读回历史。示例假设服务运行在默认地址，token 已存入 shell 变量 `TOKEN`。

1. 确认服务状态：

   ```sh
   curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:58627/api/v1/meta
   ```

2. 创建会话，用 `metadata.cwd` 指定工作目录：

   ```sh
   curl -s -X POST http://127.0.0.1:58627/api/v1/sessions \
     -H "Authorization: Bearer $TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"metadata": {"cwd": "/path/to/project"}}'
   ```

   响应里的 `data.id`（形如 `session_...`）就是后续请求使用的会话 id。

3. 连接 WebSocket 并订阅这个会话。任何 WebSocket 客户端都可以，下面是一个不需要依赖的 Node.js 脚本（Node.js 22 及以上内置 `WebSocket` 客户端）：

   ```js
   // subscribe.mjs. Usage: TOKEN=... node subscribe.mjs session_...
   const ws = new WebSocket('ws://127.0.0.1:58627/api/v1/ws', [
     `kimi-code.bearer.${process.env.TOKEN}`,
   ]);
   ws.onmessage = (e) => console.log(e.data);
   ws.onopen = () =>
     ws.send(
       JSON.stringify({
         type: 'subscribe',
         request_id: '1',
         session_id: process.argv[2],
       }),
     );
   ```

4. 提交提示词：

   ```sh
   curl -s -X POST http://127.0.0.1:58627/api/v1/sessions/<session_id>/prompts \
     -H "Authorization: Bearer $TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"content": [{"type": "text", "text": "用一句话介绍这个仓库"}]}'
   ```

   订阅端会先收到一帧 `turns`，里面是 main agent 最近的轮次。随后依次收到：`turn.started`（轮次开始），提示词对应的 `item.ended`，思考、回复和工具调用流式产生时的 `item.started`、`item.delta`、`item.ended`，每一步结束时的 `turn.updated`，最后是 `turn.ended`（轮次结束）。这些帧的含义见 [实时更新](./server-api-conversation.md#实时更新)。

5. 随时可以用 REST 读回历史消息：

   ```sh
   curl -s -H "Authorization: Bearer $TOKEN" \
     "http://127.0.0.1:58627/api/v1/sessions/<session_id>/messages?page_size=20"
   ```

## 下一步

- [会话与对话](./server-api-conversation.md)：WebSocket 协议和客户端流程
- [在网页中使用](../guides/web.md)：启动服务并在浏览器中使用 Kimi Code
- [kimi 命令](./kimi-command.md#kimi-web)：`kimi web` 的全部命令行选项
