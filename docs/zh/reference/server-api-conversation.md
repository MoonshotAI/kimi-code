# 会话与对话

客户端通过一条 WebSocket 连接（`/api/v1/ws`）实时接收会话的对话流、状态帧、交互请求和任务输出，通过 REST 接口（`/api/v1`）提交输入、回应审批、停止或撤销。本页按客户端的真实使用顺序组织，每一节先给出**完整的协议交互帧序列**（点击 `{…}` 或右上角「全部展开」可查看全部字段），再说明客户端的处理规则。REST 接口的详细参数表见 [会话接口](./server-api-sessions.md)，鉴权、信封和错误码见 [服务 API](./server-api.md)。

## 连接

WebSocket 端点为 `ws://<host>:<port>/api/v1/ws`。鉴权在 HTTP 升级握手时完成，token 放在 `Authorization: Bearer <token>` 请求头或子协议 `kimi-code.bearer.<token>` 中（见 [鉴权](./server-api.md#鉴权)）。

连接不需要握手帧。建立连接后，客户端立即开始接收 [全局事件](#全局事件)，并可直接发送命令。

### 心跳

| 方向 | 规则 |
| --- | --- |
| 服务端 → 客户端 | 每 10 秒发送一次 `{ "type": "ping" }`，客户端立即回复 `{ "type": "pong" }` |
| 服务端判定断线 | 每 10 秒基于单调时钟检查一次，距上一个合法入站帧满 20 秒时以关闭码 `1001`（`heartbeat timeout`）断开（实际发生在静默 20–30 秒之间） |
| 客户端判定断线 | 连续 25 秒未收到任何帧（或在浏览器页面切回前台、网络恢复时检查超时），客户端应主动断开并按 [断线恢复](#断线恢复) 重连 |

```wire
S {"type": "ping"}
C { "type": "pong" }
```

任何格式合法的入站 JSON 帧（带字符串 `type`）都算客户端活动；非法 JSON 或无 `type` 的帧直接忽略。服务端使用单调时钟计时（不受系统时间调整或机器休眠影响），若自身事件循环卡顿超过 12.5 秒，恢复后会先补发 `ping` 重新给满 20 秒窗口，并在断开前先排空已到达套接字的帧，避免误断正常连接。

### 命令与应答

客户端通过 WebSocket 发送的命令都是平铺的 JSON 帧，必须携带非空字符串 `request_id`（缺少可读 `request_id` 时服务端以关闭码 `1008` 断开）。服务端对每条命令回复一条 `response` 帧：

```wire focus=request_id,code,msg
C { "type": "subscribe", "request_id": "sub-1", "session_id": "s1", "agent_ids": ["main"] }
S {"type": "response", "request_id": "sub-1", "code": 0}
C { "type": "subscribe", "request_id": "sub-2", "session_id": "s404" }
S {"type": "response", "request_id": "sub-2", "code": 40401, "msg": "session not found"}
```

同一连接上的 `subscribe` 和 `unsubscribe` 按发送顺序串行处理，应答顺序与发送顺序严格一致；任务控制命令（`task.*`）按每个任务独立排队，不阻塞会话订阅。对话帧、`interaction`、`task`、Agent 状态帧（`agent`、`context`、`goal`、`todo`）以及全局事件帧均携带 ISO 8601 时间戳字段 `event_created_at`（`response`、`ping` / `pong`、`task.list` 与 `task.output` 不带该字段）。

| 命令 | 字段 | 用途 |
| --- | --- | --- |
| `subscribe` | `request_id`, `session_id`, `agent_ids?` | 订阅会话（默认 `["main"]`），对同一会话再次发送为增量追加 Agent |
| `unsubscribe` | `request_id`, `session_id`, `agent_ids?` | 停止接收指定 Agent；省略 `agent_ids` 或移除最后一个 Agent 时取消整个会话订阅 |
| `task.watch` | `request_id`, `session_id`, `agent_id`, `task_id`, `since_offset?`, `tail_bytes?` | 关注某个任务的输出流，应答 `task` 字段携带任务当前状态 |
| `task.unwatch` | `request_id`, `session_id`, `agent_id`, `task_id` | 停止接收该任务的输出流 |
| `task.stop` | `request_id`, `session_id`, `agent_id`, `task_id` | 停止任务，应答 `task` 字段携带停止后的状态 |
| `task.background` | `request_id`, `session_id`, `agent_id`, `task_id` | 将前台任务转入后台继续运行，应答 `task` 字段携带更新后的状态 |

## 订阅会话

一个会话中除了主 Agent（`main`），还可能有 subagent、swarm 成员和侧边对话（`btw`）。每个 Agent 有独立的对话与状态。下面走通「打开会话 → 接收实时流 → 展开并收起子 Agent → 断线重连」的完整过程：

<ol class="kap-walk">
<li>
<strong>订阅会话，接收初始当前内容</strong>
用户点开会话 <code>s1</code>，客户端默认只订阅 <code>main</code>。收到成功的 <code>response</code> 后，客户端清空本地该会话的内容，依次接收未决交互、任务列表、Agent 状态帧和最近一页轮次 <code>turns</code>：

```wire focus=agent_ids,code,interaction_id,tasks,status,context_tokens,has_more
C { "type": "subscribe", "request_id": "sub-1", "session_id": "s1", "agent_ids": ["main"] }
S {"type": "response", "request_id": "sub-1", "code": 0}
S {"type": "interaction", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "sub_7", "interaction_id": "i12", "kind": "approval", "status": "pending", "tool_call_id": "c7", "request": {"tool_name": "Bash", "action": "Run command", "expires_at": "2026-10-30T10:30:00.000Z"}}
S {"type": "task.list", "session_id": "s1", "agent_id": "main", "tasks": [{"task_id": "task-7q2m", "kind": "subagent", "status": "running", "phase": "working", "detached": false, "description": "Find call sites", "child_agent_id": "sub_7", "parent_tool_call_id": "call_agent_1", "started_at": "2026-10-29T10:29:50.000Z"}]}
S {"type": "agent", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "status": "running", "compacting": false, "model": "kimi-for-coding", "thinking": "high", "permission_mode": "manual", "plan_mode": false, "swarm_mode": false, "tower_mode": false}
S {"type": "context", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "context_tokens": 18210, "max_context_tokens": 262144}
S {"type": "goal", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main"}
S {"type": "todo", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "items": []}
S {"type": "turns", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turns": [{"turn_id": "t_9", "ordinal": 9, "turn_number": 9, "kind": "agent", "status": "running", "started_at": "2026-10-29T10:29:45.000Z", "steps": [], "items": []}], "has_more": true}
```

注意虽然只订阅了 `main`，但子 Agent `sub_7` 发起的审批 `i12` 照常送达（`interaction` 不受 `agent_ids` 过滤）；`sub_7` 的运行状态与描述则直接从 `main` 的 `task.list` 中读取。
</li>
<li>
<strong>展开与收起子 Agent 面板</strong>
用户点击展开子 Agent <code>sub_7</code> 的面板时，客户端再次发送 <code>subscribe</code> 增量加入 <code>sub_7</code>（已订阅的 <code>main</code> 不会重发 <code>turns</code>）；收起面板时只取消 <code>sub_7</code>：

```wire focus=agent_ids,agent_id,code
C { "type": "subscribe", "request_id": "sub-2", "session_id": "s1", "agent_ids": ["sub_7"] }
S {"type": "response", "request_id": "sub-2", "code": 0}
S {"type": "task.list", "session_id": "s1", "agent_id": "sub_7", "tasks": []}
S {"type": "agent", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "sub_7", "status": "running", "compacting": false, "model": "kimi-for-coding", "plan_mode": false, "swarm_mode": false, "tower_mode": false}
S {"type": "todo", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "sub_7", "items": []}
S {"type": "turns", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "sub_7", "turns": [], "has_more": false}
… 用户收起子 Agent 面板
C { "type": "unsubscribe", "request_id": "unsub-1", "session_id": "s1", "agent_ids": ["sub_7"] }
S {"type": "response", "request_id": "unsub-1", "code": 0}
```
</li>
</ol>

订阅成功后的帧序保证：

1. **应答（`response`）**：最先到达。会话无法打开时返回错误码（如 `40401`、`40930`、`40931`），不建立订阅。
2. **待处理交互（`interaction`）**：紧随 `response` 之后，全量补发该会话所有未决审批和提问。每次重新 `subscribe`（含增量订阅子 Agent）都会重发一次全量未决交互，客户端以这批数据替换本地待处理交互列表。
3. **任务与状态（`task.list`、`agent`、`context`、`goal`、`todo`）**：对本次新加入订阅的每个 Agent 立即发送。新建会话尚未创建 `main` 时，订阅会自动创建它。
4. **对话页（`turns` 或 `turns.failed`）**：异步从磁盘折叠加载最近最多 10 轮（上限 1 MiB），可能晚于实时状态帧到达；但**该 Agent 的增量对话帧（`turn.*`、`item.*`、`turns.removed`、`notice`）绝不会早于 `turns`**——加载期间产生的对话帧由服务端暂存，在 `turns` 发出后按顺序无缝补发。

### 会话在服务端关闭和重新打开

服务端会自动关闭空闲满 30 分钟（可通过 `KIMI_CODE_SESSION_IDLE_RECLAIM_MS` 配置）且无运行轮次、无未决交互、无定时任务的会话；调用 `:reload` 也会先关闭再重开会话。

- **空闲关闭与重开**：订阅依然保留。会话被再次唤醒或 `:reload` 重开时，服务端自动向订阅者重发每个已订阅 Agent 的 `task.list`、状态帧和 `turns`。客户端在任何时刻收到 `turns`，都用它替换该 Agent 的最新轮次。
- **归档或删除**：会话被归档或删除时，服务端移除所有连接对它的订阅，只广播对应的全局事件。恢复归档后客户端需重新发送 `subscribe`。

### 帧的投递范围

| 帧类型 | 投递对象 |
| --- | --- |
| [全局事件](#全局事件) | 每条已建立的 WebSocket 连接，无需订阅 |
| `interaction` | 订阅了该会话的所有连接，**不受 `agent_ids` 过滤** |
| `turns`、`turns.removed`、`turns.failed`、`turn.*`、`item.*`、`notice` | 订阅了该会话、且 `agent_ids` 包含该 `agent_id` 的连接 |
| `task.list`、`task`、`agent`、`context`、`goal`、`todo` | 同上 |
| `task.output` | 发送了 `task.watch` 关注该任务的连接（无需先订阅会话） |

### 帧的顺序

- 同一会话的帧进入同一个发送队列（每 16 毫秒或满 64 帧批量刷新；`response` 与 `interaction` 立即冲刷但不会越过已在队列中的帧）。
- 一轮结束时，`turn.ended` 必定先于 `status: "idle"` 的 `agent` 帧到达（除非该 Agent 的初始 `turns` 仍在异步加载中）。
- HTTP 响应与 WebSocket 帧分属不同通道，先后顺序不固定。客户端统一用 `prompt_id`、`turn_id` 或 `interaction_id` 对齐状态，不假设 HTTP 响应先于 WS 帧返回。

## 对话

一个 Agent 的对话由有序的**轮次（`Turn`）**组成，每个轮次包含有序的**条目（`Item`）**。下面走通「一轮正常对话（含思考、工具调用、正文回复）→ 下一轮模型报错重试后失败」的完整帧序列：

<ol class="kap-walk">
<li>
<strong>一轮开始与用户消息</strong>

```wire focus=turn.turn_id,turn.kind,item.type,item.prompt_ids,item.placement
S {"type": "turn.started", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn": {"turn_id": "t_1", "ordinal": 0, "turn_number": 0, "kind": "agent", "status": "running", "started_at": "2026-10-29T10:30:00.000Z", "steps": []}}
S {"type": "item.ended", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn_id": "t_1", "item": {"item_id": "u_1", "type": "user_message", "status": "ended", "outcome": "completed", "created_at": "2026-10-29T10:30:00.000Z", "prompt_ids": ["p-1"], "placement": "opener", "origin": {"kind": "user"}, "text": "README 里写的启动命令还能用吗", "attachments": [], "skills": []}}
```
</li>
<li>
<strong>思考与调用工具（Step 1）</strong>

```wire focus=item.type,item.name,item.stage,field,delta,set,item.output,step.finish_reason
S {"type": "item.started", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn_id": "t_1", "item": {"item_id": "r_1", "type": "reasoning", "step_index": 1, "status": "running", "created_at": "2026-10-29T10:30:00.400Z", "text": "", "started_at": "2026-10-29T10:30:00.400Z"}}
S {"type": "item.delta", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn_id": "t_1", "item_id": "r_1", "field": "text", "delta": "先读取 README.md"}
S {"type": "item.started", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn_id": "t_1", "item": {"item_id": "call_read_1", "type": "tool_call", "step_index": 1, "status": "running", "created_at": "2026-10-29T10:30:01.700Z", "name": "Read", "stage": "input", "started_at": "2026-10-29T10:30:01.700Z"}}
S {"type": "item.delta", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn_id": "t_1", "item_id": "call_read_1", "field": "input_text", "delta": "{\"path\":\"README.md\"}"}
S {"type": "item.ended", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn_id": "t_1", "item": {"item_id": "r_1", "type": "reasoning", "step_index": 1, "status": "ended", "outcome": "completed", "created_at": "2026-10-29T10:30:00.400Z", "text": "先读取 README.md 确认启动脚本。", "started_at": "2026-10-29T10:30:00.400Z", "duration_ms": 1200}}
S {"type": "item.updated", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn_id": "t_1", "item_id": "call_read_1", "set": {"stage": "executing", "input": {"path": "README.md"}}}
S {"type": "item.ended", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn_id": "t_1", "item": {"item_id": "call_read_1", "type": "tool_call", "step_index": 1, "status": "ended", "outcome": "completed", "created_at": "2026-10-29T10:30:01.700Z", "name": "Read", "stage": "executing", "input": {"path": "README.md"}, "output": "1\t# App\n2\tRun `pnpm dev`", "started_at": "2026-10-29T10:30:01.700Z", "ended_at": "2026-10-29T10:30:02.100Z"}}
S {"type": "turn.updated", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn_id": "t_1", "step": {"index": 1, "outcome": "completed", "finish_reason": "tool_calls", "started_at": "2026-10-29T10:30:00.300Z", "ended_at": "2026-10-29T10:30:02.100Z", "usage": {"input_other": 5210, "output": 96, "input_cache_read": 0, "input_cache_creation": 0}}}
```
</li>
<li>
<strong>正文回复与一轮结束（Step 2）</strong>

```wire focus=item.type,delta,item.text,turn.outcome,turn.duration_ms
S {"type": "item.started", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn_id": "t_1", "item": {"item_id": "a_1", "type": "assistant_message", "step_index": 2, "status": "running", "created_at": "2026-10-29T10:30:02.400Z", "text": ""}}
S {"type": "item.delta", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn_id": "t_1", "item_id": "a_1", "field": "text", "delta": "还能用，README 里的 `pnpm dev` 与 package.json 一致。"}
S {"type": "item.ended", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn_id": "t_1", "item": {"item_id": "a_1", "type": "assistant_message", "step_index": 2, "status": "ended", "outcome": "completed", "created_at": "2026-10-29T10:30:02.400Z", "text": "还能用，README 里的 `pnpm dev` 与 package.json 一致。"}}
S {"type": "turn.updated", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn_id": "t_1", "step": {"index": 2, "outcome": "completed", "finish_reason": "stop", "started_at": "2026-10-29T10:30:02.200Z", "ended_at": "2026-10-29T10:30:04.200Z"}}
S {"type": "turn.ended", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn": {"turn_id": "t_1", "ordinal": 0, "turn_number": 0, "kind": "agent", "status": "ended", "outcome": "completed", "started_at": "2026-10-29T10:30:00.000Z", "ended_at": "2026-10-29T10:30:04.200Z", "duration_ms": 4200, "steps": [{"index": 1, "outcome": "completed", "finish_reason": "tool_calls", "started_at": "2026-10-29T10:30:00.000Z", "ended_at": "2026-10-29T10:30:04.200Z"}, {"index": 2, "outcome": "completed", "finish_reason": "stop", "started_at": "2026-10-29T10:30:02.200Z", "ended_at": "2026-10-29T10:30:04.200Z"}]}}
```
</li>
<li>
<strong>模型请求出错、重试倒计时与失败结束</strong>
当上游模型返回可重试错误时，<code>turn.updated</code> 携带 <code>retry</code> 状态供客户端显示倒计时；若该步此前已输出半截条目，重试开始前服务端先发 <code>item.removed</code> 删掉半截内容；重试耗尽后该轮以 <code>outcome: "failed"</code> 结束：

```wire focus=retry.attempt,retry.delay_ms,turn.outcome,turn.end_reason,turn.error
S {"type": "turn.updated", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn_id": "t_2", "retry": {"attempt": 1, "next_attempt": 2, "max_attempts": 3, "delay_ms": 2000, "error": {"name": "ProviderError", "message": "upstream overloaded", "status_code": 529}}}
S {"type": "turn.ended", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn": {"turn_id": "t_2", "ordinal": 1, "turn_number": 1, "kind": "agent", "status": "ended", "outcome": "failed", "end_reason": "error", "error": {"code": "provider.overloaded", "message": "模型服务繁忙，请稍后再试", "status_code": 529, "retryable": true}, "started_at": "2026-10-29T10:31:00.000Z", "ended_at": "2026-10-29T10:31:08.000Z", "steps": []}}
```
</li>
</ol>

### 轮次

| 字段 | 说明 |
| --- | --- |
| `turn_id` | 会话内唯一 ID，撤销后新开的轮次不会复用旧 `turn_id` |
| `ordinal` | 这一轮在 Agent 当前历史中的顺序位置（从 0 递增）；按 `ordinal` 排序轮次，往前翻页时将其作为 `before_ordinal` |
| `turn_number` | 引擎轮次编号，供 [文件历史接口](./server-api-sessions.md#get-api-v1-sessions-session-id-file-history-changes) 查询该轮修改过的文件 |
| `kind` | `agent`（普通对话轮次）或 `system`（轮次之间只含单个 `system` 条目的系统轮次，如手动上下文压缩或分叉起点边界） |
| `status` | `running` 或 `ended` |
| `outcome` | 仅 `status: "ended"` 时出现：`completed`、`interrupted` 或 `failed` |
| `end_reason` | `interrupted` 时为 `user_cancelled`（用户停止）或 `aborted`；`failed` 时为 `error`、`max_steps`、`filtered`（内容过滤拦截）或 `blocked`（被 Hook 拦截） |
| `error` | 仅失败轮次：`{ code, message, name?, status_code?, request_id?, retryable? }` |
| `retry` | 仅运行中等待重试时出现：`{ attempt, next_attempt, max_attempts, delay_ms, error: { name, message, status_code? } }` |
| `started_at`、`ended_at?`、`duration_ms?` | 开始时间、结束时间与毫秒耗时 |
| `usage` | 本轮各步骤 token 用量之和：`{ input_other, output, input_cache_read, input_cache_creation }` |
| `steps` | 已结束步骤数组：`{ index, outcome, started_at, ended_at?, finish_reason?, usage? }` |
| `items` | 这一轮内的有序条目数组（`turn.started` 与 `turn.ended` 帧不含 `items`，客户端保留本地已有条目） |

### 条目

所有条目共有的基础字段：

| 字段 | 说明 |
| --- | --- |
| `item_id` | 条目 ID（`tool_call` 的 `item_id` 即工具调用 ID） |
| `type` | `user_message` / `reasoning` / `assistant_message` / `tool_call` / `notification` / `system` |
| `step_index` | 产生该条目的步骤序号 |
| `status` | `running` 或 `ended` |
| `outcome` | 仅 `status: "ended"` 时出现：`completed`、`interrupted` 或 `failed` |
| `created_at` | 创建时间（ISO 8601） |
| `debug` | 仅在 `KIMI_CODE_DEBUG=1` 下附于每个已结束步骤的最后一个条目：`{ finish_reason?, usage?, timing? }` |

#### `user_message`

| 字段 | 说明 |
| --- | --- |
| `prompt_ids` | 该消息承载的客户端 `prompt_id` 列表（多个插话在同一时机合并入轮时包含全部 ID）。客户端据此收掉本地显示的待发送气泡 |
| `placement` | `opener`（开启本轮的输入）或 `steer`（运行中途插入的插话） |
| `origin` | 来源对象：`{ kind: "user" }`、`{ kind: "skill", name, path?, args? }`、`{ kind: "plugin_command", plugin_id, command, args? }`、`{ kind: "cron", job_id, schedule, recurring, coalesced_count, stale }`、`{ kind: "hook", hook_event }`、`{ kind: "goal" }`、`{ kind: "retry" }`、`{ kind: "system" }` |
| `text` | 用户可见纯文本（不含系统注入的附件引导词、图片压缩说明或打包 Skill 正文） |
| `attachments` | 结构化附件列表：`{ kind: "image" \| "video" \| "audio" \| "file", file_id?, url?, name?, media_type?, size?, ordinal }` |
| `skills` | 随输入激活的 Skill：`{ name, path?, args? }[]` |
| `metadata` | 提交时传入的自定义 `metadata` 原样回显 |

#### `assistant_message` 和 `reasoning`

- **`assistant_message`**：`{ text }`，模型正文回复。
- **`reasoning`**：`{ text, started_at, duration_ms? }`，模型思考过程，`ended` 时附带思考耗时 `duration_ms`。

#### `tool_call`

| 字段 | 说明 |
| --- | --- |
| `name` | 工具名称（如 `Bash`、`Read`、`Edit`、`Agent`、`ExitPlanMode`） |
| `stage` | `input`（流式生成参数中）→ `awaiting_approval`（等待用户审批）→ `executing`（执行中） |
| `input`、`input_text` | 解析后的参数对象与 `stage: "input"` 期间流式追加的参数原文 |
| `output`、`error` | 工具实时流式输出与正常完成结果在 `output` 中；失败（`failed`）或被中断（`interrupted`）时的文本（含中断前已产生的输出）在 `error` 中 |
| `fields`、`media`、`note` | 工具 handler 结构化字段快照、媒体列表（`{ kind, file_id?, url?, media_type? }`）及模型补充说明 |
| `task_id` | 该工具以后台任务运行（或转入后台）时携带的任务 ID，可用于 `task.watch` / `task.stop` |
| `interaction_id` | 关联的审批或提问 ID（对应 [`interaction`](#审批与提问) 帧） |
| `agent_refs` | 启动的子 Agent 或 Swarm 成员：`{ agent_id, role: "child" \| "member", swarm_index?, task_id? }[]` |
| `display` | `ExitPlanMode` 携带 `{ kind: "plan_review", plan, path?, options, review }` |
| `started_at`、`ended_at?` | 开始与结束时间 |

#### `notification`

投递进对话的后台任务通知卡片：`{ notification_id, title, body, severity: "info" \| "warning" \| "error", notification_type, source: { kind, id }, task_id?, agent_id?, output?: { file?, preview?, bytes?, truncated? }, answer?: { answers: Record<string, string \| true>, note?: string } }`。

#### `system`

| `kind` | 附加字段 | 说明 |
| --- | --- | --- |
| `compaction` | `trigger: "manual" \| "auto"`, `instruction?`, `tokens_before?`, `tokens_after?`, `compacted_count?`, `summary?` | 完成的上下文压缩分隔项 |
| `fork_boundary` | `source: "btw" \| "fork"`, `forked_from: { agent_id }` | 分叉或侧边对话（`btw`）开头的边界标记 |

### 实时更新

客户端维护对话状态的归并规则如下：

| 帧 | 载荷 | 客户端归并动作 |
| --- | --- | --- |
| `turns` | `turns: Turn[]`, `has_more: boolean` | 订阅或会话重开时到达，替换该 Agent 本地最新的这些轮次 |
| `turns.failed` | `code: number`, `msg: string` | 初始对话加载失败（订阅仍保持有效；展示错误态，若后续到达新的 `turns` 帧则直接覆盖恢复） |
| `turn.started`、`turn.ended` | `turn`（不含 `items`） | 按 `turn_id` 新建或更新轮次头部字段，保留该轮已有的 `items`；轮次列表按 `ordinal` 升序排列 |
| `turn.updated` | `turn_id`, `step?`, `retry?` | 将 `step` 按 `index` 写入 `turn.steps`；用 `retry` 替换 `turn.retry`（未带 `retry` 时清除） |
| `item.started`、`item.ended` | `turn_id`, `item` | 按 `(turn_id, item_id)` 原地替换已有条目，本地不存在则追加到该轮 `items` 末尾 |
| `item.delta` | `turn_id`, `item_id`, `field`, `delta` | 将 `delta` 字符串追加到条目的 `field`（`text`、`input_text` 或 `output`） |
| `item.updated` | `turn_id`, `item_id`, `set` | 将 `set` 浅合并到目标条目上 |
| `item.removed` | `turn_id`, `item_id` | 从该轮删除 `item_id`（用于步骤重试时撤回失败那次已流出的半截内容） |
| `turns.removed` | `turn_ids: string[]` | 按 `turn_id` 删除被撤销或清空的轮次，同时丢弃在此之前发出、尚未返回的历史翻页请求 |
| `notice` | `{ level, title, detail?, code? }` | 展示实时瞬态提示（如 `compaction.cancelled`），不插入对话历史 |

## 提交输入

通过 [`POST /api/v1/sessions/{session_id}/prompts`](./server-api-sessions.md#post-api-v1-sessions-session-id-prompts) 提交用户输入。下面走通「空闲提交开新轮 → 运行中提交进入队列 → 将排队输入改为插话 → 网络超时原样重发」的完整流程：

<ol class="kap-walk">
<li>
<strong>Agent 空闲时提交：立即开启新轮次</strong>

```wire focus=prompt_id,status,item.prompt_ids,item.placement
H POST /api/v1/sessions/s1/prompts
  { "prompt_id": "p-1", "content": [ { "type": "text", "text": "帮我看看这个报错" } ] }
R { "prompt_id": "p-1", "user_message_id": "u_1", "status": "running", "content": [ { "type": "text", "text": "帮我看看这个报错" } ], "created_at": "2026-10-29T10:35:00.000Z" }
S {"type": "turn.started", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn": {"turn_id": "t_1", "ordinal": 0, "turn_number": 0, "kind": "agent", "status": "running", "started_at": "2026-10-29T10:35:00.000Z", "steps": []}}
S {"type": "item.ended", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn_id": "t_1", "item": {"item_id": "u_1", "type": "user_message", "status": "ended", "outcome": "completed", "created_at": "2026-10-29T10:35:00.000Z", "prompt_ids": ["p-1"], "placement": "opener", "origin": {"kind": "user"}, "text": "帮我看看这个报错", "attachments": [], "skills": []}}
```
</li>
<li>
<strong>Agent 运行中提交：进入排队，随后改为插话（Steer）</strong>

```wire focus=status,steered,prompt_ids,item.placement,item.prompt_ids
H POST /api/v1/sessions/s1/prompts
  { "prompt_id": "p-2", "content": [ { "type": "text", "text": "顺便也检查一下 lint" } ] }
R { "prompt_id": "p-2", "user_message_id": "u_2", "status": "queued", "content": [ { "type": "text", "text": "顺便也检查一下 lint" } ], "created_at": "2026-10-29T10:35:10.000Z" }
H POST /api/v1/sessions/s1/prompts:steer
  { "prompt_ids": ["p-2"] }
R { "steered": true, "prompt_ids": ["p-2"] }
… 当前步骤结束，到达下一个插话点
S {"type": "item.ended", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn_id": "t_1", "item": {"item_id": "u_2", "type": "user_message", "status": "ended", "outcome": "completed", "created_at": "2026-10-29T10:35:12.000Z", "prompt_ids": ["p-2"], "placement": "steer", "origin": {"kind": "user"}, "text": "顺便也检查一下 lint", "attachments": [], "skills": []}}
```
</li>
<li>
<strong>网络超时：用同一个 <code>prompt_id</code> 幂等重发</strong>

```wire focus=prompt_id,status
H POST /api/v1/sessions/s1/prompts
  { "prompt_id": "p-3", "content": [ { "type": "text", "text": "再跑一下单测" } ] }
… 网络超时，客户端不确定服务端是否已收到，原样重发：
H POST /api/v1/sessions/s1/prompts
  { "prompt_id": "p-3", "content": [ { "type": "text", "text": "再跑一下单测" } ] }
R { "prompt_id": "p-3", "user_message_id": "u_3", "status": "queued", "content": [ { "type": "text", "text": "再跑一下单测" } ], "created_at": "2026-10-29T10:35:20.000Z" }
```
</li>
</ol>

### 开始执行还是排队

- **立即开启新轮次**：当目标 Agent 空闲、队列为空，且不在撤销、压缩或分叉过程中时，输入立即开启新的一轮，HTTP 响应等待轮次启动（`status: "running"`）后返回；若被 Hook 拦截或启动前失败，则以 `status: "blocked"` 或 `"failed"` 返回。
- **进入队列**：其他情况下（包括撤销、压缩或分叉进行期间），输入进入队列并立即返回 `status: "queued"`，待当前操作结束后自动按序执行。可用 [`GET /api/v1/sessions/{session_id}/prompts`](./server-api-sessions.md#get-api-v1-sessions-session-id-prompts) 读取 `main` 正在运行与排队的输入。

### 重试和幂等

客户端为每条输入生成会话内唯一的 `prompt_id`：

- 同一 `prompt_id` 配相同请求体重发时，若首次请求已受理则直接返回首次结果（不会重复入队，也不会重复应用设置）；若首次请求仍在处理则等待其完成并返回同一结果。
- 同一 `prompt_id` 配不同请求体，或跨 `/prompts`、`/steer`、`skills/{name}:activate` 混用同一 ID 时，返回 `40927`。

### 插话

Agent 正在运行时，若希望新内容不必等当前轮次结束、而是在下一步立即送入模型，有两种方式：

- **直接插话**：调用 [`POST /api/v1/sessions/{session_id}/steer`](./server-api-sessions.md#post-api-v1-sessions-session-id-steer)，请求体与 `/prompts` 相同。有运行中轮次时，响应等消息在下一个插话点真正插入后返回；无运行中轮次时等同普通提交。
- **将排队输入改为插话**：调用 [`POST /api/v1/sessions/{session_id}/prompts:steer`](./server-api-sessions.md#post-api-v1-sessions-session-id-prompts-steer) 传入 `prompt_ids`。插入对话后表现为 `placement: "steer"` 的 `user_message`。

## 停止、撤销与压缩

下面展示停止当前轮次、撤销历史轮次、手动压缩上下文与开启侧边对话（`btw`）的交互过程：

<ol class="kap-walk">
<li>
<strong>撤回排队输入并取消当前轮次（<code>:cancel</code>）</strong>

```wire focus=aborted,cancelled,item.outcome,turn.outcome,turn.end_reason
H POST /api/v1/sessions/s1/prompts/p-9:abort
R { "aborted": true }
H POST /api/v1/sessions/s1:cancel
R { "cancelled": true }
S {"type": "item.ended", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn_id": "t_3", "item": {"item_id": "call_bash_1", "type": "tool_call", "step_index": 1, "status": "ended", "outcome": "interrupted", "created_at": "2026-10-29T10:36:00.000Z", "name": "Bash", "stage": "executing", "error": "partial output...\n[Command interrupted by user]", "started_at": "2026-10-29T10:36:00.000Z", "ended_at": "2026-10-29T10:36:02.000Z"}}
S {"type": "turn.ended", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn": {"turn_id": "t_3", "ordinal": 2, "turn_number": 2, "kind": "agent", "status": "ended", "outcome": "interrupted", "end_reason": "user_cancelled", "started_at": "2026-10-29T10:35:50.000Z", "ended_at": "2026-10-29T10:36:02.000Z", "steps": []}}
```
</li>
<li>
<strong>撤销第 5 轮及之后的所有轮次（<code>:undo</code>）</strong>

```wire focus=turn_id,removed_turn_ids,turn_ids
H POST /api/v1/sessions/s1:undo
  { "turn_id": "t_5" }
R { "removed_turn_ids": ["t_5", "t_6", "t_7"] }
S {"type": "turns.removed", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn_ids": ["t_5", "t_6", "t_7"]}
```
</li>
<li>
<strong>手动压缩上下文（<code>:compact</code>）</strong>

```wire focus=compacting,turn.kind,item.kind,item.tokens_before,item.tokens_after
H POST /api/v1/sessions/s1:compact
  { "instruction": "保留数据库迁移相关的结论" }
R {}
S {"type": "agent", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "status": "idle", "compacting": true, "plan_mode": false, "swarm_mode": false, "tower_mode": false}
S {"type": "turn.started", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn": {"turn_id": "t_8", "ordinal": 5, "turn_number": 5, "kind": "system", "status": "ended", "outcome": "completed", "started_at": "2026-10-29T10:38:00.000Z", "ended_at": "2026-10-29T10:38:00.000Z", "steps": []}}
S {"type": "item.ended", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn_id": "t_8", "item": {"item_id": "sys_1", "type": "system", "status": "ended", "outcome": "completed", "created_at": "2026-10-29T10:38:00.000Z", "kind": "compaction", "trigger": "manual", "instruction": "保留数据库迁移相关的结论", "tokens_before": 182340, "tokens_after": 8120, "summary": "…"}}
S {"type": "turn.ended", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn": {"turn_id": "t_8", "ordinal": 5, "turn_number": 5, "kind": "system", "status": "ended", "outcome": "completed", "started_at": "2026-10-29T10:38:00.000Z", "ended_at": "2026-10-29T10:38:00.000Z", "steps": []}}
S {"type": "agent", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "status": "idle", "compacting": false, "plan_mode": false, "swarm_mode": false, "tower_mode": false}
```
</li>
<li>
<strong>开启并在用完后关闭只读侧边对话（<code>:btw</code> / <code>agents/{agent_id}:close</code>）</strong>

```wire focus=agent_id,agent_ids,closed,status
H POST /api/v1/sessions/s1:btw
R { "agent_id": "btw_1" }
C { "type": "subscribe", "request_id": "sub-btw", "session_id": "s1", "agent_ids": ["btw_1"] }
S {"type": "response", "request_id": "sub-btw", "code": 0}
H POST /api/v1/sessions/s1/agents/btw_1:close
R { "closed": true }
S {"type": "agent", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "btw_1", "status": "ended", "compacting": false, "plan_mode": false, "swarm_mode": false, "tower_mode": false}
```
</li>
</ol>

### 停止

- [`POST /api/v1/sessions/{session_id}:cancel`](./server-api-sessions.md#post-api-v1-sessions-session-id-cancel) 取消目标 Agent（默认 `main`，可通过 `agent_id` 指定子 Agent 或旁路对话 Agent）正在运行的轮次；传入 `include_background: true` 时还会一并停止已转入后台运行的任务。有活动轮次或后台任务被取消时返回 `{ cancelled: true }`，否则幂等返回 `{ cancelled: false }`。未完结的 `tool_call` 以 `outcome: "interrupted"` 结束并保留已产生输出，未决交互以 `cancelled` 结束。
- 取消轮次不会清空排队中的用户输入；若希望连同排队输入全部停下，先对排队项调用 [`POST .../prompts/{prompt_id}:abort`](./server-api-sessions.md#post-api-v1-sessions-session-id-prompts-prompt-id-abort) 撤回，再调用 `:cancel`。

### 撤销

- [`POST /api/v1/sessions/{session_id}:undo`](./server-api-sessions.md#post-api-v1-sessions-session-id-undo) 接收 `{ turn_id, agent_id? }`，删除该轮及其之后的所有轮次（不回滚磁盘文件）。
- 目标轮必须是 `kind: "agent"`，且开场 `user_message` 的 `origin.kind` 为 `user`、`skill` 或 `plugin_command`；不能跨越最近一次上下文压缩（否则返回 `40911`）；Agent 正在工作时返回 `40901`。

### 压缩

- [`POST /api/v1/sessions/{session_id}:compact`](./server-api-sessions.md#post-api-v1-sessions-session-id-compact) 在 `main` 空闲时发起手动压缩（忙或已有压缩进行中时返回 `40910`）。
- 压缩期间 `agent.compacting` 为 `true`；完成后对话流中出现一个含 `compaction` 条目的 `system` 轮次；若压缩被取消，则收到 `code: "compaction.cancelled"` 的 `notice` 帧。

## 审批与提问

工具调用需要许可（`approval`）或调用 `AskUserQuestion` 请求选择（`question`）时，服务端向会话的所有订阅者推送 `interaction` 帧，客户端通过 [`POST /api/v1/sessions/{session_id}/interactions/{interaction_id}`](./server-api-sessions.md#post-api-v1-sessions-session-id-interactions-interaction-id) 回应：

<ol class="kap-walk">
<li>
<strong>收到审批并同意（记住本会话同类操作）</strong>

```wire focus=set,interaction_id,kind,status,decision,scope,outcome
S {"type": "item.updated", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn_id": "t_3", "item_id": "c7", "set": {"stage": "awaiting_approval", "interaction_id": "i9"}}
S {"type": "interaction", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "interaction_id": "i9", "kind": "approval", "status": "pending", "tool_call_id": "c7", "request": {"tool_name": "Bash", "action": "Run command", "tool_input_display": {"command": "rm -rf dist"}, "expires_at": "2026-10-30T10:31:00.000Z"}}
H POST /api/v1/sessions/s1/interactions/i9
  { "kind": "approval", "decision": "approved", "scope": "session" }
R { "outcome": "approved", "ended_at": "2026-10-29T10:31:00.000Z" }
S {"type": "interaction", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "interaction_id": "i9", "kind": "approval", "status": "ended", "outcome": "approved", "ended_at": "2026-10-29T10:31:00.000Z", "response": {"decision": "approved", "scope": "session"}, "request": {"tool_name": "Bash", "action": "Run command", "tool_input_display": {"command": "rm -rf dist"}, "expires_at": "2026-10-30T10:31:00.000Z"}}
S {"type": "item.updated", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn_id": "t_3", "item_id": "c7", "set": {"stage": "executing"}}
```
</li>
<li>
<strong>收到提问并回答</strong>

```wire focus=interaction_id,kind,request.questions,answers,outcome
S {"type": "interaction", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "interaction_id": "i10", "kind": "question", "status": "pending", "tool_call_id": "c8", "request": {"questions": [{"id": "q1", "question": "使用哪个包管理器？", "multi_select": false, "allow_other": true, "options": [{"id": "a", "label": "pnpm (Recommended)"}, {"id": "b", "label": "npm"}]}]}}
H POST /api/v1/sessions/s1/interactions/i10
  { "kind": "question", "answers": { "q1": { "kind": "single", "option_id": "a" } }, "method": "click" }
R { "outcome": "answered", "ended_at": "2026-10-29T10:31:20.000Z" }
S {"type": "interaction", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "interaction_id": "i10", "kind": "question", "status": "ended", "outcome": "answered", "ended_at": "2026-10-29T10:31:20.000Z", "request": {"questions": [{"id": "q1", "question": "使用哪个包管理器？", "multi_select": false, "allow_other": true, "options": [{"id": "a", "label": "pnpm (Recommended)"}, {"id": "b", "label": "npm"}]}]}, "response": {"answers": {"q1": "pnpm (Recommended)"}, "method": "click"}}
```
</li>
</ol>

| 字段 | 说明 |
| --- | --- |
| `interaction_id` | 交互唯一 ID，应答时写在 URL 路径中 |
| `kind` | `approval` 或 `question` |
| `status` | `pending`（等待处理）或 `ended`（已结束） |
| `agent_id`、`tool_call_id` | 发起该交互的 Agent 与等待中的 `tool_call` 条目 ID |
| `request` | 审批：`{ tool_name, action, tool_input_display?, expires_at }`；提问：`{ questions: [{ id, question, header?, body?, options: [{ id, label, description? }], multi_select?, allow_other? }] }` |
| `outcome`、`ended_at`、`response?` | `status: "ended"` 时出现：`outcome` 为 `approved` / `rejected` / `cancelled` / `answered` / `dismissed` |

客户端处理规则：

- **只凭 `status: "ended"` 的 `interaction` 帧关闭卡片**，不要仅凭 HTTP 响应关卡片，这样多个窗口同时打开同一会话时可同步关闭。
- **并发与过期容错**：多端同时应答同一交互时，第一个生效，后续收到 `40902`（已结束）或 `40404`（超出 60 秒 / 256 条已结束缓存窗口），客户端收到这两个错误码直接关闭本地卡片即可，无需报错。

## 任务

Shell 命令（前台与后台）和 subagent（含 AgentSwarm 成员）统一通过 WebSocket 任务帧同步与控制，不走 REST 接口。下面走通「启动后台命令 → `task.watch` 看输出 → `since_offset` 续传 → `task.stop` 停止任务」的完整流程：

<ol class="kap-walk">
<li>
<strong>后台启动命令，订阅输出流（<code>task.watch</code>）</strong>

```wire focus=task_id,detached,parent_tool_call_id,offset,text
S {"type": "task", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "task_id": "bash-k3f9x2ab", "kind": "shell", "status": "running", "detached": true, "description": "Start dev server", "command": "pnpm dev", "parent_tool_call_id": "call_bash_1", "started_at": "2026-10-29T10:33:20.100Z"}
C { "type": "task.watch", "request_id": "r2", "session_id": "s1", "agent_id": "main", "task_id": "bash-k3f9x2ab" }
S {"type": "response", "request_id": "r2", "code": 0, "task": {"task_id": "bash-k3f9x2ab", "kind": "shell", "status": "running", "detached": true}}
S {"type": "task.output", "session_id": "s1", "agent_id": "main", "task_id": "bash-k3f9x2ab", "offset": 0, "text": "> dev\n> vite\n\n"}
S {"type": "task.output", "session_id": "s1", "agent_id": "main", "task_id": "bash-k3f9x2ab", "offset": 14, "text": "  VITE ready in 312 ms\n"}
```
</li>
<li>
<strong>取消关注（<code>task.unwatch</code>）、按字节偏移续传与停止任务（<code>task.stop</code>）</strong>

```wire focus=since_offset,offset,text,status,outcome
C { "type": "task.unwatch", "request_id": "r3", "session_id": "s1", "agent_id": "main", "task_id": "bash-k3f9x2ab" }
S {"type": "response", "request_id": "r3", "code": 0}
… 稍后重新打开面板，传入已有输出的 UTF-8 字节末尾 37
C { "type": "task.watch", "request_id": "r4", "session_id": "s1", "agent_id": "main", "task_id": "bash-k3f9x2ab", "since_offset": 37 }
S {"type": "response", "request_id": "r4", "code": 0, "task": {"task_id": "bash-k3f9x2ab", "kind": "shell", "status": "running", "detached": true}}
S {"type": "task.output", "session_id": "s1", "agent_id": "main", "task_id": "bash-k3f9x2ab", "offset": 37, "text": "10:41:07 [vite] hmr update\n"}
C { "type": "task.stop", "request_id": "r5", "session_id": "s1", "agent_id": "main", "task_id": "bash-k3f9x2ab" }
S {"type": "task", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "task_id": "bash-k3f9x2ab", "kind": "shell", "status": "ended", "outcome": "killed", "detached": true, "started_at": "2026-10-29T10:33:20.100Z", "ended_at": "2026-10-29T10:52:03.410Z"}
S {"type": "response", "request_id": "r5", "code": 0, "task": {"task_id": "bash-k3f9x2ab", "kind": "shell", "status": "ended", "outcome": "killed", "detached": true}}
```
</li>
</ol>

### 任务列表

| 字段 | 说明 |
| --- | --- |
| `task_id` | 任务 ID |
| `kind` | `shell` / `subagent` / `other` |
| `status` | `running` 或 `ended`（任务结束发送最后一帧 `status: "ended"` 的 `task`，此后不再出现在 `task.list` 中） |
| `outcome` | 仅已结束任务：`completed` / `failed` / `timed_out` / `killed` / `lost` |
| `phase` | 仅运行中的 subagent：`working` 或 `suspended` |
| `state_reason` | 仅挂起（`suspended`）的 subagent：挂起原因说明文本 |
| `detached` | `false` 表示发起它的工具调用仍在等待它（前台任务）；`true` 表示已在后台运行 |
| `description`、`command` | 任务描述与 Shell 命令文本 |
| `child_agent_id`、`parent_tool_call_id`、`swarm_index` | 关联的子 Agent ID、发起工具调用 ID 及 Swarm 成员序号 |
| `model`、`thinking` | subagent 使用的模型与思考强度 |
| `started_at`、`ended_at`、`result_summary`、`error` | 起止时间、结果摘要与错误信息 |

### 任务输出和控制

- **`task.watch` 与首段合并**：服务端先回带 `task` 当前状态的 `response`，再发首段 `task.output`（默认最后 32 KiB，最大 1 MiB；若传入 `since_offset` 且未超出尾段缓冲，则只发 `since_offset` 之后的新增字节）。客户端合并规则：首段 `offset` 等于本地已存 UTF-8 字节长度时直接追加，否则丢弃本地缓存从首段重建。
- **单独停止前台工具或转入后台**：前台运行的命令同样在 `task.list` 中（`detached: false`，`parent_tool_call_id` 指向对应 `tool_call`）。对它发 `task.stop` 只结束该工具调用（当前轮继续执行）；对它发 `task.background` 将其转入后台（`detached` 变为 `true`，工具调用立即以 `completed` 返回，后台跑完后投递 `notification` 条目；AgentSwarm 成员不可转后台，返回 `40933`）。

## Agent 状态

每个 Agent 的状态按更新频率拆分为四种独立事件帧，客户端按 `agent_id` 整份替换：

| 帧 | 核心字段 | 说明 |
| --- | --- | --- |
| `agent` | `status: "idle" \| "running" \| "ended"`, `compacting`, `model?`, `thinking?`, `permission_mode?`, `plan_mode`, `swarm_mode`, `tower_mode` | Agent 运行状态与当前生效设置（旁路对话关闭时发送最后一条 `status: "ended"`）。修改设置调用 [`POST /api/v1/sessions/{session_id}/profile`](./server-api-sessions.md#post-api-v1-sessions-session-id-profile) |
| `context` | `context_tokens`, `max_context_tokens?` | 该 Agent 自身的上下文窗口水位（不含子 Agent），服务端按 **250 毫秒窗口合并节流**只发最新值 |
| `goal` | `goal?: { objective, status, completion_criterion?, turns_used, tokens_used, wall_clock_ms }` | 仅 `main` 拥有。无目标时省略 `goal` 字段；`wall_clock_ms` 不随单纯时间流逝重发，客户端自行累加显示实时计时 |
| `todo` | `items: [{ title, status: "pending" \| "in_progress" \| "done" }]` | Agent 的待办列表，随 Agent 写入或 `:undo` 撤销整体替换 |

## 断线恢复

订阅与 `task.watch` 均不跨断线保留。重连后的恢复步骤：

1. **重新发送 `subscribe`**：收到成功的 `response` 时，清空该会话本地保存的轮次、取消未返回的翻页请求，并用随后到达的 `interaction`、`task.list`、状态帧和 `turns` 重建当前状态。
2. **恢复任务输出关注**：对仍在查看的任务输出面板重新发送 `task.watch`，将本地已有输出的 UTF-8 字节末尾作为 `since_offset` 传入。
3. **刷新全局列表**：断线期间错过的全局事件不回放，调用 [`GET /api/v1/sessions`](./server-api-sessions.md#get-api-v1-sessions) 等 REST 接口刷新本地列表。

## 全局事件

全局事件无需订阅，自动推送给每条已建立的 WebSocket 连接。所有帧都是扁平结构，以 `type` 和 `event_created_at` 开头，不再包含 `session_id`、`timestamp` 或 `payload` 信封：

```wire focus=type,change,session,kind
S {"type": "session", "event_created_at": "2026-10-29T10:41:30.000Z", "change": "updated", "session": {"id": "s2", "workspace_id": "wd_aaa_000000000000", "cwd": "/work/app", "title": "修复登录", "created_at": "2026-10-29T10:30:00.000Z", "updated_at": "2026-10-29T10:41:30.000Z", "activity": "idle", "pending_interaction": "none", "last_turn_outcome": "completed", "archived": false}}
S {"type": "invalidated", "event_created_at": "2026-10-29T10:42:00.000Z", "kind": "models"}
```

| `type` | 其他字段 | 客户端处理规则 |
| --- | --- | --- |
| `session` | `change`: `created` / `updated` / `archived` / `restored` / `deleted`；`session` 为完整的[会话对象](./server-api-sessions.md#会话对象) | 按 `session.id` 整体替换；`change` 为 `deleted` 时删除。创建、重命名、归档、恢复、忙碌状态或最近结局变化都通过这一帧同步 |
| `workspace` | `change`: `created` / `updated` / `deleted`；`workspace` 为完整的[工作区对象](./server-api-service.md#工作区对象) | 按 `workspace.id` 整体替换；`change` 为 `deleted` 时删除 |
| `config` | `config` 为完整配置（密钥已脱敏）；`warnings` 可选，为 `{ domain?, message }[]` | 整体替换本地配置；有警告时同时展示 |
| `invalidated` | `kind`: `models` / `plugins` | 列表内容已变化但不随帧携带：`models` 重新读取 `GET /api/v1/models`，`plugins` 重新读取 `GET /api/v1/plugins` |

内置能力的安装进度使用独立的扁平帧 `event.capability.changed`，字段为 `event_created_at`、`capability_id` 和 `install`；它不是列表失效通知，客户端应继续展示安装进度。
