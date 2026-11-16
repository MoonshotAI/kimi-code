<script setup>
import { onMounted } from 'vue'
import { withBase } from 'vitepress'
import { redirectLegacyServerApiAnchor } from '../../.vitepress/theme/serverApiLegacyAnchors'

onMounted(() => redirectLegacyServerApiAnchor('zh'))
</script>

# 服务 API【测试版】

`kimi web` 启动的本地服务（以及桌面端内嵌服务）对外提供 **Kimi Agent Protocol（KAP）**：由 HTTP REST 接口（`/api/v1`）与 WebSocket 事件流（`/api/v1/ws`）组成。任何客户端或脚本都可以用它创建会话、提交输入、实时接收流式对话与状态、回应审批，以及管理工作区、模型、插件和 MCP。启动服务的方式与命令行选项见 [kimi 命令](./kimi-command.md#kimi-web)。

::: warning 注意
本协议处于 Beta 阶段，接口与字段可能随版本演进。运行中的服务同时提供由校验 schema 实时生成的 [`GET /openapi.json`](#地址与在线-schema) 与 [`GET /asyncapi.json`](#地址与在线-schema)。
:::

## 文档结构

1. **本页（概览与快速开始）**：[给 Agent 的资料](#给-agent-的资料)、通用约定、[鉴权](#鉴权)、[响应信封](#响应信封)、[错误码](#错误码)，以及 5 分钟走完最小闭环的 [快速开始](#快速开始)。
2. **[会话与对话](./server-api-conversation.md)**：客户端协议指南——连接与订阅、一轮对话（Turn / Item）、提交输入与插话、停止 / 撤销 / 压缩、审批与提问、任务输出流、Agent 状态与全局事件。每节包含完整的交互消息序列与客户端处理规则，**实现客户端从这一页开始**。
3. **[会话接口](./server-api-sessions.md)**：`/api/v1/sessions` 下的全部 REST 接口参考（会话创建与分组列表、批量归档恢复、profile 设置、会话动作、轮次分页、输入队列与交互应答）。
4. **[服务与配置接口](./server-api-service.md)**：服务元信息、OAuth 登录与额度、远程控制、配置、模型与供应商、工作区、内置能力与插件、MCP 管理、文件上传与全局搜索。
5. **[文件接口](./server-api-files.md)**：会话文件系统、工作区文件系统、本机文件接口及流式下载的 HTTP 行为。

## 给 Agent 的资料

如果你希望让 AI Agent 为你实现一个 Kimi Code 客户端、看板或自动化脚本：

- **发一个文件**：直接把单文件协议汇总 <a :href="withBase('/zh/kap.md')" target="_blank" download="kap.md"><code>/zh/kap.md</code></a> 发给 Agent。
- **按场景只发一部分**：上下文有限时，按要做的事挑选页面，每组都带上本页的通用约定与错误码：

| 要做的事 | 必读指南 | 接口参考 |
| --- | --- | --- |
| 只读看板、多会话状态监控 | [订阅会话](./server-api-conversation.md#订阅会话)、[全局事件](./server-api-conversation.md#全局事件) | [会话列表与会话对象](./server-api-sessions.md#会话) |
| 最小的对话客户端 | [快速开始](#快速开始)、[对话](./server-api-conversation.md#对话)、[提交输入](./server-api-conversation.md#提交输入) | [会话接口](./server-api-sessions.md) |
| 远程处理审批与提问 | [审批与提问](./server-api-conversation.md#审批与提问) | [答复交互](./server-api-sessions.md#审批与提问) |
| 后台任务监控与脚本自动化 | [快速开始](#快速开始)、[任务](./server-api-conversation.md#任务) | [会话动作](./server-api-sessions.md#会话动作)、[提示词](./server-api-sessions.md#提示词) |

随资料附上这段说明即可：

```text
按所附的 Kimi Agent Protocol 文档实现一个 Kimi Code 客户端。
- 服务地址：http://127.0.0.1:58627/api/v1；WebSocket：ws://127.0.0.1:58627/api/v1/ws；凭证：YOUR_TOKEN。
- 只使用文档写明的消息、接口和字段；遇到不认识的事件类型、条目类型或字段时跳过，不报错。
- 对 JSON 响应（除 204 空响应与二进制下载/导出流外）检查信封里的 code 字段，含义见「错误码」。
- 提交输入时由客户端生成会话内唯一的 prompt_id，网络出错或超时时用同一个 prompt_id 原样重发。
```

## 通用约定

- **命名与时间**：REST 与 WebSocket 核心字段使用 `snake_case`；时间统一为 ISO 8601 字符串，时长以 `_ms` 结尾（毫秒数字）。
- **不透明 ID**：`session_id`、`turn_id`、`item_id`、`interaction_id`、`task_id` 均为不透明字符串，客户端不要从格式推断含义。`turn_id` 与 `item_id` 由服务端从持久化记录确定性推出，实时事件与历史翻页得到同一个 ID。
- **动作路径**：对单个资源或集合执行非 CRUD 操作时，路径以 `:{action}` 结尾并用 `POST` 调用，如 `POST /api/v1/sessions/{session_id}:fork`、`POST /api/v1/sessions:archive`。
- **例子怎么读**：文档中的协议交互块标明四类方向——`客户端`（WebSocket 客户端 → 服务端）、`服务端`（WebSocket 服务端 → 客户端）、`HTTP`（HTTP 请求）、`响应`（HTTP 响应信封中的 `data`）。高亮字段是当前步骤关注的重点，点击折叠的 `{…}` 或右上角「全部展开」可查看完整载荷：

```wire focus=request_id,code,cancelled
C { "type": "task.watch", "request_id": "r2", "session_id": "s1", "agent_id": "main", "task_id": "bash-k3f9x2ab" }
S {"type": "response", "request_id": "r2", "code": 0}
H POST /api/v1/sessions/s1:cancel
R { "cancelled": true }
```

## 地址与在线 schema

默认监听地址为 `http://127.0.0.1:58627`（端口被占用时依次尝试下一个端口，最多 100 次；可用 `--host` 和 `--port` 指定，传入 `--port 0` 可让操作系统自动分配空闲端口）。

服务运行时提供两份由实际校验 schema 生成的机器可读定义（读取同样需要鉴权）：

- `GET /openapi.json`：REST 接口定义（OpenAPI 3.0）
- `GET /asyncapi.json`：WebSocket 消息定义（AsyncAPI）

## 鉴权

所有 `/api/*` 路径以及 `/openapi.json`、`/asyncapi.json` 均需 bearer token，仅以下三类请求免鉴权：

- `OPTIONS` 预检请求
- `GET /api/v1/healthz`（探活）
- 静态网页资源（不在 `/api/` 下的路径）

客户端获取 `(origin, token)` 的标准方式有两种：由宿主启动 `kimi web --no-open --port 0` 并从进程启动输出中读取监听地址与 `Token`，或由宿主环境（如桌面端或远程网关）直接注入 `(origin, token)`。REST 请求通过 `Authorization: Bearer <token>` 请求头携带凭证；WebSocket 升级请求可使用同一请求头，或使用子协议 `kimi-code.bearer.<token>`（适合浏览器 `new WebSocket(url, [protocol])`）。

凭证缺失或无效返回 HTTP 401（信封 `code` 为 `40101`）；请求头 `Host` 不合法或不在允许列表返回 HTTP 403（`code` 为 `40301`）。服务绑定在非 loopback 地址时，同一来源 60 秒内连续鉴权失败 10 次会被封禁 60 秒，期间返回 HTTP 429（`code` 为 `42901`）。

## 响应信封

除二进制流下载接口外，所有 JSON 响应都封装在同一信封中：

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
| `code` | 业务结果码，`0` 表示成功，非 `0` 见 [错误码](#错误码)。客户端应始终先判断 `code` |
| `msg` | 结果说明或错误信息 |
| `data` | 成功时的业务数据（各接口文档列出的响应字段即 `data` 的内容）；出错时除 `40911`（`:undo` 越过压缩边界或锚点不足时返回 `{ reason, requestedCount, undoableCount }`）外均为 `null` |
| `details` | 可选。按错误码附带的结构化上下文（如 `40001` 的字段校验明细、`40931` 的锁持有者、`40113` 的 `model_id`） |
| `request_id` | 本次请求的 ULID（可通过 `X-Request-Id` 请求头传入） |

HTTP 状态码除以下场景外均为 `200`，业务成败以信封 `code` 为准：

| 场景 | HTTP 状态码 |
| --- | --- |
| 鉴权失败 / 缺少允许的 Host 或 Origin / 触发限流 | `401` / `403` / `429` |
| 创建供应商、`:import_catalog`、`:import_registry` 成功 | `201`（响应体仍为标准信封） |
| 删除供应商成功 | `204`（无响应体） |
| 二进制与流式下载端点 | 支持 `206`（Range）与 `304`（ETag），出错时返回真实 `4xx` / `500` 状态码，见 [二进制与流式端点](./server-api-files.md#二进制与流式端点) |

## 错误码

HTTP 与 WebSocket `response` 帧共用同一套错误码：

| 段位 / 常用码 | 含义 |
| --- | --- |
| `0` | 成功 |
| `40001` | 参数或字段校验失败（`details` 列出具体字段） |
| `40003`–`40006` | 供应商由 OAuth 托管不可手改（`40003`）、目录条目无法导入（`40004`）、私有注册表不可用（`40005`）、工作区源文件夹重复（`40006`） |
| `40101` | 凭证缺失或无效（HTTP 401） |
| `40301` | 请求 `Host` 头缺失、非法或未被允许（HTTP 403） |
| `40110`–`40113` | 未配置供应商（`40110`）、供应商缺少凭据（`40111`）、凭据被拒（`40112`）、模型无法解析（`40113`） |
| `40401`–`40421` | 会话或 Agent 不存在（`40401`）、提示词不存在（`40402`）、交互不存在或已过期（`40404`）、任务不存在（`40406`）、文件不存在（`40407`）、MCP 服务不存在（`40408`）、路径不存在（`40409`）、工作区不存在（`40410`）、Skill 不存在（`40415`）、目录条目不存在（`40417`）、能力不存在（`40418`）、插件不存在（`40419`）、环境不存在（`40420`）、轮次不存在（`40421`） |
| `40901` / `40902` | 会话或 Agent 忙（`40901`）、交互已结束（`40902`） |
| `40910`–`40920` | 无法压缩（`40910`）、无法撤销（`40911`）、Skill 不可激活（`40912`）、目标状态冲突（`40913`–`40918`、`40920`） |
| `40922`–`40935` | 分页条件与 `page_token` 不符（`40922`）、标题无法生成（`40923`）、能力安装中或不支持（`40924`/`40925`）、环境不可用（`40926`）、`prompt_id` 被用于不同请求（`40927`）、远程控制冲突（`40928`）、MCP OAuth 失败（`40929`）、会话版本过高（`40930`）、会话正被其他进程占用（`40931`）、会话已被其他进程更新（`40932`）、任务不能转后台（`40933`）、插件目录已变化（`40934`）、无法进入 Tower 模式（`40935`） |
| `41302`–`41305` | 文件超过 10 MiB（`41302`）、远程目录条目过多（`41303`）、路径越出工作区（`41304`）、搜索超时（`41305`） |
| `42901` / `42902` | 鉴权失败封禁（`42901`）、文件监听数超限（`42902`） |
| `50001`–`50004` | 服务端内部错误（`50001`）、持久化读写失败（`50003`）、模型目录不可用（`50004`） |
| `6xxxx` / `7xxxx` / `8xxxx` | 工具运行时、LLM 供应商、MCP 透传错误，`msg` 保留上游原文 |

### 多进程并发码（`40931` 与 `40932`）

同一个 `kap-server` 下的多个客户端（如浏览器多标签页、桌面端与远程控制）共享内存态，不会触发这两个错误。只有当不同进程（例如独立运行的 CLI 与桌面端内嵌服务）操作同一个会话时才会出现：

- **`40931`（会话正被占用）**：另一个进程正在写入该会话（`details` 含占用方信息）。等对方空闲后重试；若确认持锁进程已异常退出、仅残留了锁文件，先调用 [`POST /api/v1/sessions/{session_id}:takeover`](./server-api-sessions.md#post-api-v1-sessions-session-id-takeover) 再重试。
- **`40932`（会话已过期）**：会话已被其他进程更新。提交输入、激活 Skill 和压缩遇到此情况时，服务端会自动重新加载会话、向订阅者重发最新 `turns` 并继续执行；只有 `:undo` 会直接返回 `40932`（此时服务端已完成重载，未执行撤销，客户端应让用户先查看刷新后的历史再决定是否撤销）。

## 分页

列表接口支持三类分页参数：

- **`page_token` / `page` 分页**：[`GET /api/v1/sessions`](./server-api-sessions.md#get-api-v1-sessions)（扁平与按工作区分组视图均支持）与 [`POST /api/v1/search`](./server-api-service.md#post-api-v1-search) 使用不透明的 `next_page_token`（绑定查询条件，中途修改过滤或排序条件返回 `40922` / `40001`）；`GET /api/v1/sessions` 同时支持从 1 开始的无状态 `page` 页码。
- **轮次 `before_ordinal` 分页**：[`GET /api/v1/sessions/{session_id}/agents/{agent_id}/turns`](./server-api-sessions.md#get-api-v1-sessions-session-id-agents-agent-id-turns) 按轮次在当前历史中的位置 `ordinal` 向前翻页。
- **ID 游标分页（`before_id` / `after_id`）**：扁平会话列表支持 `before_id` 与 `after_id`（二选一）加 `page_size`。

## 快速开始

下面用 `curl` 和一段零依赖的 Node.js 脚本（Node.js 22+ 内置 `WebSocket`）走完最小闭环：启动服务、创建会话、订阅实时事件、提交输入、接收流式回复并往前翻页。

### 1. 准备环境变量

先启动服务（`kimi web --no-open --port 0`），把终端启动输出中 `Local` 行的基地址（不含 `#token=...`）与 `Token` 填入变量（若未传 `--port 0`，默认地址为 `http://127.0.0.1:58627`）：

```sh
export KAP="http://127.0.0.1:<启动输出中的端口>"
export TOKEN="<启动输出中的 Token>"
```

### 2. 创建会话

```sh
curl -s -X POST "$KAP/api/v1/sessions" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"cwd\": \"$PWD\"}"
```

把响应里的 `data.id`（形如 `session_...`）记为 `SESSION`：

```sh
export SESSION="<上一步返回的 data.id>"
```

### 3. 连接 WebSocket 并订阅会话

先建立订阅再提交输入，确保不漏掉轮次开头的事件。将下面代码存为 `subscribe.mjs` 并运行 `node subscribe.mjs`：

```js
const { KAP, TOKEN, SESSION } = process.env;
const ws = new WebSocket(`${KAP.replace(/^http/, 'ws')}/api/v1/ws`, [
  `kimi-code.bearer.${TOKEN}`,
]);

ws.onopen = () => {
  ws.send(
    JSON.stringify({
      type: 'subscribe',
      request_id: 'sub-1',
      session_id: SESSION,
      agent_ids: ['main'],
    }),
  );
};

ws.onmessage = (frame) => {
  const event = JSON.parse(frame.data);
  if (event.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
  console.log(event.type, event);
};
```

### 4. 提交输入并观察实时事件流

另开一个终端提交一条提示词（带上客户端生成的 `prompt_id` 以保证网络重试幂等）：

```sh
curl -s -X POST "$KAP/api/v1/sessions/$SESSION/prompts" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"prompt_id": "p-1", "content": [{"type": "text", "text": "用一句话介绍这个仓库"}]}'
```

从订阅到这一轮结束，客户端与服务端的完整交互帧序列如下（点击帧中的 `…` 或右上角「全部展开」可查看完整字段）：

```wire focus=code,status,turn.kind,item.type,item.prompt_ids,delta,turn.outcome
C { "type": "subscribe", "request_id": "sub-1", "session_id": "s1", "agent_ids": ["main"] }
S {"type": "response", "request_id": "sub-1", "code": 0}
S {"type": "task.list", "session_id": "s1", "agent_id": "main", "tasks": []}
S {"type": "agent", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "status": "idle", "compacting": false, "model": "kimi-for-coding", "thinking": "high", "permission_mode": "manual", "plan_mode": false, "swarm_mode": false, "tower_mode": false}
S {"type": "goal", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main"}
S {"type": "todo", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "items": []}
S {"type": "turns", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turns": [], "has_more": false}
H POST /api/v1/sessions/s1/prompts
  { "prompt_id": "p-1", "content": [ { "type": "text", "text": "用一句话介绍这个仓库" } ] }
R { "prompt_id": "p-1", "user_message_id": "u_1", "status": "running", "content": [ { "type": "text", "text": "用一句话介绍这个仓库" } ], "created_at": "2026-10-29T10:30:00.000Z" }
S {"type": "turn.started", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn": {"turn_id": "t_1", "ordinal": 0, "turn_number": 0, "kind": "agent", "status": "running", "started_at": "2026-10-29T10:30:00.000Z", "steps": []}}
S {"type": "item.ended", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn_id": "t_1", "item": {"item_id": "u_1", "type": "user_message", "status": "ended", "outcome": "completed", "created_at": "2026-10-29T10:30:00.000Z", "prompt_ids": ["p-1"], "placement": "opener", "origin": {"kind": "user"}, "text": "用一句话介绍这个仓库", "attachments": [], "skills": []}}
S {"type": "item.started", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn_id": "t_1", "item": {"item_id": "a_1", "type": "assistant_message", "step_index": 1, "status": "running", "created_at": "2026-10-29T10:30:00.500Z", "text": ""}}
S {"type": "item.delta", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn_id": "t_1", "item_id": "a_1", "field": "text", "delta": "这是 Kimi Code 的核心仓库。"}
S {"type": "item.ended", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn_id": "t_1", "item": {"item_id": "a_1", "type": "assistant_message", "step_index": 1, "status": "ended", "outcome": "completed", "created_at": "2026-10-29T10:30:00.500Z", "text": "这是 Kimi Code 的核心仓库。"}}
S {"type": "turn.updated", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn_id": "t_1", "step": {"index": 1, "outcome": "completed", "finish_reason": "stop", "started_at": "2026-10-29T10:30:00.400Z", "ended_at": "2026-10-29T10:30:01.800Z"}}
S {"type": "turn.ended", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn": {"turn_id": "t_1", "ordinal": 0, "turn_number": 0, "kind": "agent", "status": "ended", "outcome": "completed", "started_at": "2026-10-29T10:30:00.000Z", "ended_at": "2026-10-29T10:30:01.800Z", "duration_ms": 1800, "steps": [{"index": 1, "outcome": "completed", "finish_reason": "stop", "started_at": "2026-10-29T10:30:00.400Z", "ended_at": "2026-10-29T10:30:01.800Z"}]}}
S {"type": "agent", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "status": "idle", "compacting": false, "model": "kimi-for-coding", "thinking": "high", "permission_mode": "manual", "plan_mode": false, "swarm_mode": false, "tower_mode": false}
```

### 5. 往前翻页读取更早的轮次

订阅时的 `turns` 帧最多携带最近 10 轮。当 `has_more` 为 `true` 且用户向上滚动时，把本地已加载最早一轮的 `ordinal`（`FIRST_ORDINAL`）作为 `before_ordinal` 传入，读取更早的历史轮次（结构与 WebSocket 推送的 `Turn` 完全一致）：

```sh
curl -s -H "Authorization: Bearer $TOKEN" \
  "$KAP/api/v1/sessions/$SESSION/agents/main/turns?before_ordinal=$FIRST_ORDINAL&page_size=20"
```

## 下一步

- [会话与对话](./server-api-conversation.md)：完整的 WebSocket 事件流例子与客户端状态归并规则
- [会话接口](./server-api-sessions.md)：会话管理、轮次、提示词与审批的 REST 接口详情
- [服务与配置接口](./server-api-service.md)：工作区、模型、插件、MCP 与全局搜索接口
- [文件接口](./server-api-files.md)：会话与工作区文件读写及流式下载
