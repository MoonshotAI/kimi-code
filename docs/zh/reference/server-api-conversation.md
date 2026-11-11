# 会话与对话

客户端通过一条 WebSocket 连接实时接收会话的对话内容和状态，通过 REST 接口提交输入、回应审批、停止或撤销。本页按客户端的使用顺序说明这套协议：建立连接，订阅会话，显示对话，提交输入，处理审批和任务，断线后恢复。接口共用的鉴权、信封和错误码见 [服务 API](./server-api.md)，各 REST 接口的参数见 [会话接口](./server-api-sessions.md)。

## 连接

WebSocket 只有一个端点：`ws://<host>:<port>/api/v1/ws`。鉴权在升级请求时完成，token 放在 `Authorization: Bearer <token>` 请求头里，或放在子协议 `kimi-code.bearer.<token>` 里（见 [鉴权](./server-api.md#鉴权)）。

连接不需要握手。连接建立后，客户端立即开始接收 [全局事件](#全局事件)，也可以直接发送命令。

### 心跳

| 方向 | 规则 |
| --- | --- |
| 服务端 → 客户端 | 每 10 秒发送一次 `{ "type": "ping" }`，客户端回复 `{ "type": "pong" }` |
| 服务端判断断线 | 服务端每 10 秒检查一次，距离上一个入站帧满 20 秒时，以关闭码 1001（reason 为 `heartbeat timeout`）断开。所以实际断开发生在客户端静默 20–30 秒之间 |
| 客户端判断断线 | 连续 25 秒没有收到任何帧，客户端应认为连接已断开并重连，重连后的步骤见 [断线恢复](#断线恢复) |

任何格式合法的入站帧都算客户端活动，包括服务端不认识的帧类型。不是合法 JSON、或者没有字符串 `type` 的帧会被直接丢弃，也不算活动。

为了不误断开正常的连接，服务端还做了下面几点处理，客户端不需要配合：

- **不受系统时间影响**：服务端用单调时钟（只会往前走、不受系统时间修改影响的时钟）计时，有人调整系统时间、或者机器睡眠后唤醒，都不会让连接被判为超时。
- **服务端自己卡住之后重新计时**：服务端进程卡住期间发不出 `ping`，客户端也就不会回应。服务端恢复后，如果发现两次检查之间隔了超过 12.5 秒（默认间隔的 1.25 倍），就认为是自己卡住了：不断开连接，而是补发一个 `ping`，重新给客户端 20 秒回应。
- **断开前先读完已到达的消息**：客户端在服务端卡住期间回的 `pong` 可能还没被读取。服务端决定断开之前，会先处理这些已经到达的消息，再检查一次，有回应就不断开。

### 命令与应答

客户端发送的命令是平铺的 JSON 帧：字段和 `type` 并列，每条命令都要带 `request_id`。服务端对每条命令回复一条应答：

```json
{ "type": "response", "request_id": "1", "code": 0, "msg": "...", "task": {} }
```

`code` 为 `0` 表示成功，`msg` 和 `task` 只在需要时出现。命令缺少可读的 `request_id` 时，服务端以关闭码 1008 断开连接。服务端不认识的帧类型会被忽略。

同一连接上的 `subscribe` 和 `unsubscribe` 按发送顺序逐条处理：后一条要等前一条（包括打开会话）完成后才执行，应答顺序和发送顺序一致。任务命令走另一条队列，不等它们，见 [任务输出和控制](#任务输出和控制)。一条连接可以同时订阅多个会话，各会话互不影响。

| 命令 | 字段 | 用途 |
| --- | --- | --- |
| `subscribe` | `request_id`, `session_id`, `agent_ids?` | 订阅会话，见 [订阅会话](#订阅会话) |
| `unsubscribe` | `request_id`, `session_id`, `agent_ids?` | 停止接收部分或全部 agent |
| `task.watch` | `request_id`, `session_id`, `agent_id`, `task_id`, `since_offset?`, `tail_bytes?` | 接收一个任务的输出，见 [任务](#任务) |
| `task.unwatch` | `request_id`, `session_id`, `agent_id`, `task_id` | 停止接收任务输出 |
| `task.stop` | `request_id`, `session_id`, `agent_id`, `task_id` | 停止任务 |
| `task.background` | `request_id`, `session_id`, `agent_id`, `task_id` | 把任务转入后台 |

## 订阅会话

一个会话里可以有多个 agent：main agent、subagent、swarm 成员、侧边对话。订阅时用 `agent_ids` 选择要接收哪些 agent 的帧，默认是 `["main"]`。对同一个会话再次发送 `subscribe` 会追加 agent，不会替换已有的。

```json
{ "type": "subscribe", "request_id": "1", "session_id": "session_...", "agent_ids": ["main"] }
```

会话打开后，服务端立即应答，应答先于这个订阅的任何帧。会话无法打开时，应答带上错误码，并且不建立订阅：会话不存在时为 `40401`，`40930`、`40931` 等其他错误码说明无法打开的原因。帧格式错误时应答 `40001`。

订阅成功后，客户端按这个顺序收到帧：

1. **应答**：`subscribe` 的 `response`。
2. **待处理的交互**：这个会话所有还没有回应的审批和提问，以 `interaction` 帧发给这条连接（见 [审批与提问](#审批与提问)）。
3. **任务和状态**：对每个新开始接收的 agent，依次是 `task.list`（见 [任务](#任务)），以及 `agent`、`usage`（agent 有模型上下文时）、`goal`（仅 main agent）和 `todo`（见 [Agent 状态](#agent-状态)）。
4. **对话**：每个新开始接收的 agent 一帧 `turns`，带最近的轮次（见 [实时更新](#实时更新)）；对话无法加载时改为一帧 `turns.failed`。

`turns` 是异步加载的，可能晚于之后实时推送的 `task`、`agent`、`usage` 帧。但一个 agent 的对话帧（`turn.*`、`item.*`、`turns.removed`、`notice`）不会早于它的 `turns`：加载期间产生的对话帧会先缓存，`turns` 发出后再按顺序补发，不会遗漏。

订阅会话时如果 main agent 还不存在，服务端会先创建它，所以订阅之后总能收到 main agent 的状态帧。`agent_ids` 里列出、但订阅时还没加入会话的 agent，会在加入后直接以 `task` 和状态帧通告自己。

对已经订阅的会话再次发送 `subscribe` 时，只有新加入的 agent 会收到 `task.list`、状态帧和 `turns`，已经在接收的 agent 不会重发 `turns`。但每次成功的 `subscribe` 都会把这个会话全部待处理的交互重发一遍，客户端用这次应答之后收到的交互替换本地的交互卡片。

`unsubscribe` 停止接收所列的 agent。省略 `agent_ids`，或移除了最后一个 agent 时，取消整个会话的订阅。

### 会话在服务端关闭和重新打开

服务端会关闭一段时间没有活动的会话：默认 30 分钟（环境变量 `KIMI_CODE_SESSION_IDLE_RECLAIM_MS` 可以修改），忙碌、有待处理交互或有定时任务的会话不会被关闭，有没有订阅者不影响这个判断。`:reload` 也会先关闭再重新打开会话。

会话关闭期间不推送任何会话帧，但订阅仍然有效。会话重新打开后，服务端给这些连接重发每个已订阅 agent 的 `task.list`、`agent`、`usage`、`goal`、`todo` 和 `turns`。所以 `turns` 不只在订阅之后出现，客户端任何时候收到它，都要用它替换这个 agent 的对话。

会话被归档或删除时，服务端移除所有连接对它的订阅，不再发送会话帧，只发出对应的 [全局事件](#全局事件)。会话恢复后，客户端需要重新订阅。

### 帧的投递范围

| 帧 | 发给谁 |
| --- | --- |
| [全局事件](#全局事件) | 每个已建立的连接，不需要订阅 |
| `turns`、`turns.removed`、`turns.failed`、`turn.*`、`item.*`、`notice` | 订阅了该会话、并且正在接收这个 agent 的连接 |
| `task.list`、`task`、`agent`、`usage`、`goal`、`todo` | 同上 |
| `interaction` | 订阅了该会话的所有连接，与接收哪些 agent 无关 |
| `task.output` | 用 `task.watch` 关注了该任务输出的连接，不需要订阅会话 |

全局事件是事件帧 `{ "type", "session_id"?, "timestamp", "payload" }`，`type` 是事件类型。会话帧是平铺帧 `{ "type", "session_id", "agent_id", ... }`。

### 帧的顺序

同一个会话的帧走同一个发送队列，按产生的顺序发出。服务端每 16 毫秒、或攒够 64 帧时发送一批；`response` 和 `interaction` 立即发送，但不会越过已经排队的帧。全局事件走单独的一个全局队列，同样按发生顺序发出。

一轮结束时，`turn.ended` 总是先于 `status` 为 `idle` 的 `agent` 帧到达。例外是这个 agent 的 `turns` 还在加载时，`agent` 帧可能先到。

REST 请求的响应和 WebSocket 帧走不同的通道，到达顺序不固定。例如提交输入后，`turn.started` 和对应的 `user_message` 可能先于 HTTP 响应到达。客户端用 `prompt_id` 把两者对应起来，不要依赖到达的先后。

## 对话

一个 agent 的对话由一组轮次组成，每个轮次包含一组有序的条目。用户提交一次输入，agent 处理它的全过程就是一个轮次；轮次里的用户输入、回复、思考、工具调用都是条目。

轮次和条目都由 agent 已经持久化的会话记录生成，所以 REST 分页、`turns` 帧和服务重启后重新读取，看到的是同样的轮次和同样的 id。只存在于内存里的，只有正在运行的步骤和工具正在产生的输出。所有时间都是 ISO 8601 字符串。

### 轮次

| 字段 | 说明 |
| --- | --- |
| `turn_id` | 会话内唯一，不会复用。撤销之后新开的轮次即使沿用了被撤销轮次的 `ordinal`，也会得到新的 id |
| `ordinal` | 这一轮在 agent 当前历史中的位置，决定轮次顺序。读取更早的轮次时作为 `before_ordinal` 传入 |
| `kind` | `agent`：普通轮次。`system`：轮次之间只有一个 `system` 条目的轮次，即完成的上下文压缩，或从其他 agent 分叉出来时开头的分叉分界 |
| `status` | `running` 或 `ended`。agent 没有运行的轮次（例如被 hook 拒绝的提示词）一出现就是 `ended`。`system` 轮次不会处于 `running` |
| `outcome` | 仅已结束的轮次：`completed`、`interrupted` 或 `failed` |
| `end_reason` | `interrupted` 时为 `user_cancelled`（用户停止）或 `aborted`（其他原因中止，例如运行中服务端停止）。`failed` 时为 `error`、`max_steps`、`filtered`（输出被服务商的内容过滤拦截）或 `blocked`（输入被 hook 或策略拦下） |
| `error` | 仅失败的轮次：`{ code, message, name?, status_code?, request_id?, retryable? }` |
| `retry` | 仅运行中的轮次，在模型请求失败、等待重试时出现：`{ attempt, next_attempt, max_attempts, delay_ms, error: { name, message, status_code? } }`，`attempt` 是刚失败的那一次。下一步开始、一步结束或这一轮结束时清除 |
| `turn_number` | 引擎的轮次编号，供 [文件历史接口](./server-api-sessions.md#get-api-v1-sessions-session-id-file-history-changes) 使用 |
| `started_at`、`ended_at?`、`duration_ms?` | 开始时间、结束时间和时长 |
| `usage` | 各步骤用量之和 |
| `steps` | 已结束的步骤（一次模型请求是一步），按 `index` 排列：`{ index, outcome, started_at, ended_at?, finish_reason?, usage? }`。步骤的 `outcome` 为 `completed`、`interrupted` 或 `failed`，`usage` 为 `{ input_other, output, input_cache_read, input_cache_creation }` |
| `items` | 这一轮的条目，见下节 |

### 条目

每个条目都有这些字段：

| 字段 | 说明 |
| --- | --- |
| `item_id` | 条目 id。工具调用的 `item_id` 就是工具调用 id |
| `type` | 条目类型，见下表 |
| `step_index` | 产生这个条目的步骤 |
| `status` | `running` 或 `ended` |
| `outcome` | 已结束的条目除下文另有说明外为 `completed` |
| `created_at` | 创建时间 |
| `debug` | 服务端以 `KIMI_CODE_DEBUG=1` 运行时，每个已结束步骤的最后一个条目带上它，描述这一步的模型请求：`{ finish_reason?, usage?, timing? }`。`timing` 在有测量值时包含 `first_token_ms`、`stream_ms`、`request_build_ms`、`server_first_token_ms`、`server_decode_ms`、`client_consume_ms` 和 `client_blocked_ms`。步骤结束时，这个条目会以 `item.ended` 再下发一次 |

条目按出现的先后排列。各类型条目的其余字段如下。

#### `user_message`

一次输入进入对话后的样子。

| 字段 | 说明 |
| --- | --- |
| `prompt_ids` | 这条输入承载的 prompt id，包括打包 Skill 提交和 Skill 激活带的 `prompt_id`。同一时机插入的多条插话会合并成一条 `placement` 为 `steer` 的 `user_message`，`prompt_ids` 列出全部。客户端按「`prompt_ids` 包含本地 id」撤下本地显示的待发送气泡，不要假设一一对应。系统触发的输入为空数组 |
| `placement` | `opener`（开启这一轮的输入）或 `steer`（插入进行中轮次的输入） |
| `origin` | 输入的来源，见下表 |
| `text` | 可见文本块用换行拼接的结果。不含打包 Skill 的说明、提示词 hook 的输出、提示模型读取附件的说明和图片压缩说明。重试和内部触发的输入为空串 |
| `attachments` | 输入中的文件和媒体，按顺序：`{ kind: "image" \| "video" \| "audio" \| "file", file_id?, url?, name?, media_type?, size?, ordinal }`。上传的文件带 `file_id`，内联和远程媒体带 `url`，服务端存储的媒体在分页中以 `data:` URL 下发，按服务端本地路径附加的文件只带 `name`、`media_type` 和 `size` |
| `skills` | 随输入激活的 Skill：`{ name, path?, args? }` |
| `metadata` | 提交时的 `metadata`，原样回显 |

`origin` 的取值：

| `origin` | 来源 |
| --- | --- |
| `{ kind: "user" }` | 用户输入 |
| `{ kind: "skill", name, path?, args? }` | Skill 激活 |
| `{ kind: "plugin_command", plugin_id, command, args? }` | 插件命令 |
| `{ kind: "cron", job_id, schedule, recurring, coalesced_count, stale }` | 定时任务。定时任务只在 main agent 空闲时触发，运行中到期就推迟到空闲之后，触发时开启新的一轮。推迟期间多次到期只触发一次，次数记在 `coalesced_count`。单次任务和最后一次触发之后会自动删除 |
| `{ kind: "hook", hook_event }` | hook |
| `{ kind: "goal" }` | 目标续跑 |
| `{ kind: "retry" }` | 重试 |
| `{ kind: "system" }` | 系统。CLI 的 shell 命令（`!`）和它的输出以原始文本出现在这类 `user_message` 中，各自单独成一个已结束的轮次 |

#### `assistant_message` 和 `reasoning`

- **`assistant_message`**：`{ text }`，模型的回复。
- **`reasoning`**：`{ text, started_at, duration_ms? }`，模型的思考输出。`duration_ms` 是思考输出的时长，条目结束后才有。隐藏的思考不会下发。

#### `tool_call`

一次工具调用，`item_id` 就是工具调用 id。

| 字段 | 说明 |
| --- | --- |
| `name` | 工具名 |
| `stage` | 调用运行时的阶段：模型流式生成参数期间为 `input`，等待审批时为 `awaiting_approval`，其余时候为 `executing` |
| `input` | 工具参数 |
| `input_text` | `stage` 为 `input` 时的参数原文 |
| `output` | 运行时流式追加工具的实时输出；正常完成后为结果文本 |
| `fields` | handler 最新字段快照组成的 JSON 对象 |
| `media` | 正常完成后结果中的图片、视频和音频：`{ kind, file_id?, url?, media_type? }` |
| `error` | 调用失败（`outcome` 为 `failed`）或被停止（`interrupted`）时的结果文本，此时不带 `output`。例如停止 Bash 后，这里是已产生的输出加上中断说明。轮次结束时仍没有拿到结果的调用也记为 `interrupted`，但不带 `error` |
| `note` | 工具随结果附给模型的补充说明，例如 `ReadMediaFile` 读取图片时的大小和尺寸 |
| `task_id` | 这次调用的工作以后台任务运行时出现，无论是一开始就在后台，还是之后转到后台。任务离开 `task.list` 之后，仍然可以用它发送 `task.watch` 和 `task.stop` |
| `interaction_id` | 为这次调用发起的审批或提问，内容随 [`interaction`](#审批与提问) 帧下发 |
| `agent_refs` | 这次调用启动的 subagent：`{ agent_id, role: "child" \| "member", swarm_index?, task_id? }` |
| `display` | 仅 `ExitPlanMode` 调用：`{ kind: "plan_review", plan, path?, options: [{ label, description }], review: { state: "pending" \| "approved" \| "rejected" \| "cancelled", selected_option?, feedback? } }` |
| `started_at`、`ended_at?` | 开始和结束时间 |

这一轮在工具产生结果之前结束时，条目的 `outcome` 为 `interrupted`。前台运行中的调用没有 `task_id`，要找到它对应的任务，看任务的 `parent_tool_call_id`。

#### `notification`

投递进对话的后台任务通知。

| 字段 | 说明 |
| --- | --- |
| `notification_id`、`title`、`body` | 通知 id、标题和正文 |
| `severity` | `info` / `warning` / `error` |
| `notification_type` | 通知类型 |
| `source` | `{ kind, id }` |
| `task_id`、`agent_id` | 相关的任务和 agent |
| `output` | `{ file?, preview?, bytes?, truncated? }` |
| `answer` | 用户对后台提问的回答：`answers` 把每个问题映射到它的回答，`note` 是可选的备注 |

#### `system`

| `kind` | 字段 | 说明 |
| --- | --- | --- |
| `compaction` | `trigger: "manual" \| "auto"`, `instruction?`, `tokens_before?`, `tokens_after?`, `compacted_count?`, `summary?` | 完成的上下文压缩。在一轮运行中途完成的压缩放在该轮内。被取消或失败的压缩不在对话中留下任何内容 |
| `fork_boundary` | `source: "btw" \| "fork"`, `forked_from: { agent_id }` | 位于从其他 agent 分叉出的 agent（例如侧边对话）的对话开头。分叉时继承的对话不显示 |

### 实时更新

客户端开始接收某个 agent 时，先收到一帧 `turns`：

```json
{ "type": "turns", "session_id": "...", "agent_id": "main", "event_created_at": "...", "turns": [], "has_more": true }
```

它携带最近 10 个轮次，包括正在运行的轮次和它到此刻为止的内容，和 REST 分页一样不超过 1 MiB。更早的轮次用 [`GET .../agents/{agent_id}/turns`](./server-api-sessions.md#get-api-v1-sessions-session-id-agents-agent-id-turns) 分页读取。会话或 agent 被关闭后重新打开时，服务端会再发一次 `turns`（见 [会话在服务端关闭和重新打开](#会话在服务端关闭和重新打开)），之后再收到的 `turns` 替换客户端最新的这些轮次。

分页读取在请求开始时取快照，结果可能包含之后被撤销的轮次。收到 `turns.removed` 后，丢弃在它之前发出、还没有返回的分页结果。

对话无法加载时，改为收到 `{ type: "turns.failed", session_id, agent_id, event_created_at, code, msg }`，例如 agent 不在这个会话中时为 `40401`，或 agent 关闭后被重新加载时恢复失败。这个 agent 仍然保持订阅。

此后的变化以下面这些帧推送，每帧都带 `session_id`、`agent_id` 和 `event_created_at`：

| 帧 | 内容 | 客户端怎么处理 |
| --- | --- | --- |
| `turn.started`、`turn.ended` | 不含 `items` 的 `turn` | 替换本地的轮次，保留已有条目。已结束的轮次被修正时会再发一次 `turn.ended` |
| `turn.updated` | `turn_id`；每个已结束步骤一次的 `step`；`retry` | 把 `step` 按 `index` 写入 `steps`。用 `retry` 替换这一轮的重试状态，不带 `retry` 时清除 |
| `item.started`、`item.ended` | `turn_id` 和完整的 `item` | 替换本地同 `item_id` 的条目，本地没有的追加到这一轮末尾 |
| `item.updated` | `turn_id`、`item_id`、`set` | `set` 是运行中 `tool_call` 发生变化的字段，浅合并到条目上 |
| `item.delta` | `turn_id`、`item_id`、`field`、`delta` | 把 `delta` 追加到条目的 `field` 字段，`field` 为 `text`、`input_text` 或 `output` |
| `item.removed` | `turn_id`、`item_id` | 删除这个条目。它是一个不会完成的运行中条目，例如请求重试导致这一步重新开始 |
| `turns.removed` | `turn_ids` | 按 `turn_id` 删除轮次，`turn_ids` 按 ordinal 升序排列。撤销之后是被撤销的轮次，清空上下文之后是全部轮次 |
| `notice` | `{ level: "info" \| "warning" \| "error", title, detail?, code? }` | agent 实时发出的警告或错误，例如上下文压缩未完成时的 `compaction.cancelled`。通知不属于轮次，订阅时也不补发 |

条目的推送规则：

- 不流式产生的条目（例如 `user_message`）只发 `item.ended`。
- 流式产生的条目一直保持 `running`，直到它所在的步骤落盘，之后以落盘后的值发唯一一次 `item.ended`。同一步骤里下一段内容开始时，前面的条目不会提前结束，客户端以最后一个块判断是否仍在输出。
- `system` 轮次实时推送时，连续发送 `turn.started`、`item.ended` 和 `turn.ended`。

这些帧可能重复 `turns` 帧里已有的内容。客户端按上表用替换的方式应用，结果就是正确的。

## 提交输入

用 [`POST /api/v1/sessions/{session_id}/prompts`](./server-api-sessions.md#post-api-v1-sessions-session-id-prompts) 提交一条输入。默认发给 main agent，用 `agent_id` 可以发给其他 agent。

```sh
curl -s -X POST http://127.0.0.1:58627/api/v1/sessions/<session_id>/prompts \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"prompt_id": "p-1", "content": [{"type": "text", "text": "继续"}]}'
```

服务端按这个顺序处理一次提交：

1. 校验内容块里的媒体引用。未知或类型不匹配的 `file_id` 在这一步被拒绝，后面的设置都不会生效。
2. 把请求里的设置写入目标 agent，顺序是 `model`、`thinking`、`permission_mode`、`swarm_mode`、`disabled_tools`。设置在受理时就生效，无论这条输入是否排队；设置会一直保留，正在运行的那一轮之后的请求也会使用新设置。`permission_mode` 只修改目标 agent。请求里的 `plan_mode`、`goal_objective` 和 `goal_control` 会被忽略，`metadata` 原样记录到这条输入上。
3. 输入开启新的一轮，或者进入队列，见下一节。

### 开始执行还是排队

只有目标 agent 空闲、队列为空、并且没有在执行撤销、手动压缩或分叉时，输入才会立即开启新的一轮。这时响应会等到这一轮开始，`status` 为 `running`；如果没有开启轮次就结束，hook 拒绝了这条输入时 `status` 为 `blocked`，开启轮次之前就失败时为 `failed`（例如提示词 hook 出错或附件无法准备）。

其他情况下，输入进入队列，响应立即返回，`status` 为 `queued`。撤销、压缩或分叉期间提交的输入也不会报错，而是排队，等操作结束后自动开始。

服务端不推送队列的变化。客户端可以用 [`GET /api/v1/sessions/{session_id}/prompts`](./server-api-sessions.md#get-api-v1-sessions-session-id-prompts) 读取 main agent 正在运行和排队的输入；看到 `prompt_ids` 包含某个 id 的 `user_message` 时，说明这条输入已经进入了一轮。

### 重试和幂等

请求带 `prompt_id` 时，提交是幂等的。网络出错或超时后，用同一个 `prompt_id` 原样重发：

- 服务端已经受理过，返回第一次提交的结果，不会重复提交，请求里的设置也不会再应用一次；
- 第一次请求还在处理，等它完成后返回同样的结果；
- 第一次请求在入队之前就失败了，重发按新请求处理；入队之后才失败的，重发返回同一个错误；
- 同一个 `prompt_id` 配了不同的请求，返回 `40927`。判断依据是端点加完整的请求体，与字段顺序无关。同一会话里，`/prompts`、`/steer` 和 Skill 激活接口共用同一组 `prompt_id`，同一个 id 换到另一个端点使用也返回 `40927`。

服务端只在内存里记录 `prompt_id`：每个会话最多保留 256 条，超出时淘汰最早的已结束记录；服务端重启或会话删除后清空。不带 `prompt_id` 的请求没有幂等保护。

### 插话

agent 正在运行时，排队的输入要等当前这一轮结束才会开启下一轮。要让运行中的轮次立即读到新的内容，有两种做法：

- **直接插话**：用 [`POST /api/v1/sessions/{session_id}/steer`](./server-api-sessions.md#post-api-v1-sessions-session-id-steer) 提交内容，请求体和提交输入相同。有运行中的轮次时，响应要等这条内容在下一个插入点真正插进这一轮才返回；如果这一轮先结束了，就等它开启的下一轮开始后返回。没有运行中的轮次时，等同于普通提交。
- **把排队的输入改为插话**：用 [`POST /api/v1/sessions/{session_id}/prompts:steer`](./server-api-sessions.md#post-api-v1-sessions-session-id-prompts-steer)（多条）或 `prompts/{prompt_id}:steer`（单条）。只在 main agent 有运行中的轮次时可用，没有时返回 `40402`。多条一起改时先整体校验，任何一个 id 不在队列中或有重复，全部不处理并返回 `40402`。

插入的输入在对话里是 `placement` 为 `steer` 的 `user_message`。用 Skill 激活接口激活 Skill 时，如果 main agent 正在运行，它不开启新的一轮，而是作为插话插入当前这一轮，插入后才响应。

## 停止、撤销与压缩

| 操作 | 接口 | 效果 |
| --- | --- | --- |
| 停止当前轮次 | [`POST /api/v1/sessions/{session_id}:abort`](./server-api-sessions.md#post-api-v1-sessions-session-id-abort) | 停止 main agent 正在运行的轮次。这一轮以 `outcome: "interrupted"`、`end_reason: "user_cancelled"` 结束 |
| 停止或撤回一条输入 | [`POST .../prompts/{prompt_id}:abort`](./server-api-sessions.md#post-api-v1-sessions-session-id-prompts-prompt-id-abort) | 输入正在运行时，等同停止当前轮次；在队列中时，从队列移除 |
| 撤销 | [`POST /api/v1/sessions/{session_id}:undo`](./server-api-sessions.md#post-api-v1-sessions-session-id-undo) | 删除指定的一轮及其之后的所有轮次，不回滚文件 |
| 压缩上下文 | [`POST /api/v1/sessions/{session_id}:compact`](./server-api-sessions.md#post-api-v1-sessions-session-id-compact) | 对 main agent 的上下文发起一次手动压缩，立即返回 |
| 分叉 | [`POST /api/v1/sessions/{session_id}:fork`](./server-api-sessions.md#post-api-v1-sessions-session-id-fork) | 把会话复制成同一工作区里的新会话 |
| 侧边对话 | [`POST /api/v1/sessions/{session_id}:btw`](./server-api-sessions.md#post-api-v1-sessions-session-id-btw) | 从 main agent 分叉出一个只能用只读工具的 agent |

### 停止

`:abort` 只作用于 main agent 的当前轮次。无论有没有运行中的轮次，它都返回 `{ aborted: true }`，可以安全地重发；是否真的停下，以这一轮的 `turn.ended` 为准。

停止一轮不会清空队列：排队的用户输入和还没插入的用户插话都会保留，被停止的那一轮结束后自动开启下一轮。排队中的 Skill 激活会一并取消。服务端没有暂停队列的接口，要全部停下，先对排队的输入逐条调用 `prompts/{prompt_id}:abort` 撤回，再调用 `:abort`。

`prompts/{prompt_id}:abort` 同样只作用于 main agent。撤回排队的输入不产生轮次，也不推送任何帧；输入已经结束或不存在时返回 `40402`。

侧边对话等非 main agent 的轮次，目前没有公开的停止接口。

### 撤销

撤销成功后，接口响应带 `removed_turn_ids`，订阅者同时收到 `turn_ids` 相同的 `turns.removed` 帧。两者到达的先后顺序不固定，客户端按 `turn_id` 删除，重复删除不影响结果。agent 正在工作（有运行中的轮次、排队的输入或正在压缩）时撤销返回 `40901`，等它结束后重试。

### 压缩

手动压缩不排队：有运行中的轮次、队列不为空，或者另一个历史操作正在进行时，直接返回 `40910`；历史中没有可压缩的内容时也返回 `40910`。成功时响应为 `{}`，之后的进展从这三处看到：

- 压缩期间，main agent 的 `agent` 帧中 `compacting` 为 `true`，结束后变回 `false`；
- 压缩完成后，对话里出现一个 `system` 轮次（见 [`system`](#system)）；
- 压缩没有完成时，订阅者收到一条 `code` 为 `compaction.cancelled` 的 `notice`，对话里不留任何内容。

## 审批与提问

工具调用需要用户许可时，服务端发起审批；agent 需要用户做选择时，发起提问。两者都以 `interaction` 帧发给会话的所有订阅者：

| 字段 | 说明 |
| --- | --- |
| `interaction_id` | 交互 id，回应时使用 |
| `kind` | `approval`（审批）或 `question`（提问） |
| `status` | `pending` 或 `ended` |
| `agent_id` | 发起交互的 agent |
| `tool_call_id` | 等待中的工具调用。它的 `tool_call` 条目带有相同的 `interaction_id` |
| `request` | 审批：`{ tool_name, action, tool_input_display?, expires_at }`，`expires_at` 为发起后 24 小时。提问：`{ questions }`，见下文 |
| `response` | 审批结束后总会出现；提问只在 `outcome` 为 `answered` 时出现，被忽略或因轮次结束而取消的提问没有这个字段。形状见下文 |
| `outcome` | 结束后出现：`approved` / `rejected` / `cancelled` / `answered` / `dismissed` |
| `ended_at` | 结束时间 |

提问的 `request.questions` 包含 1–4 个问题，每个问题为 `{ id, question, header?, body?, options, multi_select?, allow_other?, other_label?, other_description? }`。`options` 有 2–4 个选项，每个为 `{ id, label, description? }`。`multi_select` 允许选择多个选项，`allow_other` 允许自由文本回答。

用 [`POST /api/v1/sessions/{session_id}/interactions/{interaction_id}`](./server-api-sessions.md#post-api-v1-sessions-session-id-interactions-interaction-id) 回应。交互结束有两种情况：被回应，或者它所在的轮次结束而被取消。结束时服务端发出这个交互的最后一帧，带 `status: "ended"`、`ended_at`、`outcome`，以及按上表规则出现的 `response`：

- 审批的 `response`：`{ decision, scope?, feedback?, selected_label? }`；
- 已回答的提问的 `response`：`{ answers, method? }`，`answers` 把每个问题的文本映射到对应的回答。

多个客户端回应同一个交互时，第一个回应生效，之后的回应返回 `40902`。服务端只记住已结束的交互 60 秒、最多 256 个，超出之后再回应返回 `40404`。客户端收到这两个错误码时，都按「交互已结束」关闭卡片。

服务端不校验提问回答的内容：未知的选项 id 会原样作为回答文本，未知的问题 id 会原样作为键，直接交给 agent。

## 任务

agent 正在运行的异步工作都是任务：Shell 命令（前台和后台）、subagent（包括 swarm 成员）和其他异步工作。任务和轮次相互独立，撤销轮次不影响任务。

### 任务列表

客户端开始接收某个 agent 时，先收到一帧 `{ type: "task.list", session_id, agent_id, tasks }`，`tasks` 是这个 agent 此刻正在运行的全部任务，客户端用它整份替换本地列表。之后每次变化收到一帧 `{ type: "task", session_id, agent_id, event_created_at, ...任务状态 }`，每帧都带完整状态。订阅时还没加入会话的 agent，直接从 `task` 帧开始。

任务结束时推送最后一帧 `task`（`status: "ended"`），之后它不再出现在 `task.list` 里。已结束任务的结果在会话历史中（工具结果和完成通知）。需要精确的最终状态时，对它发送 `task.watch`，应答里带有它的状态。任务帧和 `interaction` 一样不回放。

| 字段 | 说明 |
| --- | --- |
| `task_id` | 任务 id |
| `kind` | `shell` / `subagent` / `other` |
| `status` | `running` / `ended` |
| `outcome` | 仅已结束的任务：`completed` / `failed` / `timed_out` / `killed` / `lost` |
| `phase` | 仅运行中的 subagent：`working` / `suspended`，挂起原因在 `state_reason` |
| `detached` | 发起它的工具调用已不再等它，即后台任务 |
| `description` | 任务描述 |
| `child_agent_id` | subagent 任务的 agent id |
| `parent_tool_call_id` | 发起任务的工具调用 |
| `swarm_index` | swarm 成员在其 swarm 中的序号 |
| `command` | Shell 任务的命令 |
| `started_at`、`ended_at` | 开始和结束时间 |
| `result_summary`、`error`、`state_reason` | 结果摘要、错误和状态原因 |
| `model`、`thinking` | subagent 使用的模型和思考强度 |

### 任务输出和控制

任务输出不随 `task` 帧推送。要显示某个任务的输出，发送 `task.watch`，不需要先订阅会话。`agent_id` 是任务所属的 agent，即这个任务的 `task` 帧上的 `agent_id`。

1. 服务端先应答 `code: 0`，应答的 `task` 是任务此刻的状态（形状同 `task` 帧，不含 `type`、`session_id`、`agent_id` 和 `event_created_at`）。
2. 然后用一帧 `task.output` 发送最后 `tail_bytes` 字节的输出。`tail_bytes` 默认 32 KiB，最大 1 MiB。`since_offset` 落在这段范围内时，只发它之后的部分；没有可发送的输出时 `text` 为空。
3. 之后推送实时输出。已结束的任务同样可以 watch。

`task.output` 帧为 `{ type: "task.output", session_id, agent_id, task_id, offset, text }`，`offset` 是 `text` 在任务输出中的 UTF-8 字节偏移。重连后续传时，把 `since_offset` 设为已有输出的末尾。

`since_offset` 落在可读的尾段之内、并且在字符边界上时，首段从它开始；否则整段尾部重发。客户端合并输出的规则：

- 首段的 `offset` 等于本地输出的末尾时，直接追加；
- 否则丢弃本地输出，从首段重建；
- 首段之后的实时输出，按 `offset` 去掉和本地重叠的字节再追加。

对同一个任务再次发送 `task.watch` 时，服务端先撤掉旧的关注，再按新的 `since_offset` 重发首段。

其他控制命令：

- **`task.unwatch`**：停止推送这个任务的输出。
- **`task.stop`**：停止任务。任务已经结束时直接应答它的状态。停止前台任务时，只结束发起它的那次工具调用，工具调用拿到停止结果，这一轮继续执行。
- **`task.background`**：让发起任务的工具调用不再等它，任务转入后台继续运行。已在后台或已结束时直接应答它的状态。发起方无法不再等待的任务（例如 AgentSwarm 的成员）回复 `40933`，应答仍带任务状态。

`task.watch`、`task.stop` 和 `task.background` 成功时，应答的 `task` 都是任务此刻的状态。同一个任务的命令按到达顺序逐个处理，所以在 `task.watch` 应答之前发出的 `task.unwatch` 会在它之后生效。不同任务之间、任务命令和其他命令之间互不等待。

任务命令的错误码：

- `40001`：帧格式错误，包括 `tail_bytes` 超出范围
- `40401`：会话不存在
- `40406`：这个 agent 下没有该任务
- `40933`：任务不能转入后台
- `50001`：内部错误
- `50003`：输出无法读取

## Agent 状态

agent 自身的状态由四种帧同步。每帧都带完整的值，客户端整份替换本地副本；和任务帧一样不回放。客户端开始接收某个 agent 时，先收到它当前的这几种帧，之后某个值变化时再收到对应的帧。四种帧都带 `type`、`session_id`、`agent_id` 和 `event_created_at`。

| 帧 | 字段 | 说明 |
| --- | --- | --- |
| `agent` | `status: "idle" \| "running"`, `compacting`, `model?`, `thinking?`, `permission_mode?`, `plan_mode`, `swarm_mode`, `tower_mode` | agent 处理某一轮时 `status` 为 `running`。正在压缩这个 agent 的上下文时 `compacting` 为 `true`，无论是否在某一轮之中。正在运行的轮次和模型请求失败后的重试状态随对话帧下发 |
| `usage` | `context_tokens`, `max_context_tokens?` | 上下文用量，只在 agent 有模型上下文时发送。服务端按 250 毫秒合并：值变化后最多延迟 250 毫秒发送一次，只发最新值，中间值不发 |
| `goal` | `goal?` | 仅 main agent。没有目标时省略 `goal`，否则为 `{ objective, status: "active" \| "paused" \| "blocked" \| "complete", completion_criterion?, turns_used, tokens_used, wall_clock_ms }`。`wall_clock_ms` 是发送时的已用时长，只因时间流逝不会重发，计时走动由客户端自己累加 |
| `todo` | `items: [{ title, status: "pending" \| "in_progress" \| "done" }]` | 待办列表，取自 agent 的待办存储，所以会跟随撤销回退，服务重启后也能恢复 |

`agent`、`goal` 和 `todo` 只在内容真正变化时发送。

`agent` 帧里的模型和思考强度是 agent 当前生效的设置。会话在创建时就确定了模型（见 [创建会话](./server-api-sessions.md#post-api-v1-sessions)）；创建时没有可用模型的会话，在设置模型之前省略 `model` 和 `thinking`。

## 断线恢复

订阅不会跨断线保留。重连之后：

1. 对每个需要的会话重新发送 `subscribe`。收到成功的应答时，丢弃这个会话本地的全部轮次（包括往前翻过的页）和还没返回的分页请求。断线期间的 `turns.removed` 不会补发，撤销之后 `ordinal` 还可能被复用，所以本地旧的轮次不能保留。
2. 应答之后，服务端补发待处理的交互。不在这批交互里的本地卡片都已经结束，直接关闭。
3. 服务端重新发送各 agent 的 `task.list`、`agent`、`usage`、`goal`、`todo`，最后是带最新一页的 `turns`。更早的轮次再用 REST 分页读取。
4. 任务输出的关注同样会丢失。重新发送 `task.watch`，并把 `since_offset` 设为已有输出的末尾。
5. 断线期间错过的全局事件不会回放。用 REST 接口（例如 `GET /api/v1/sessions`）刷新本地维护的列表。

## 全局事件

全局事件发给每个已建立的连接，不需要订阅。事件帧的格式为：

```json
{ "type": "event.session.archived", "session_id": "__global__", "timestamp": "...", "payload": { "type": "event.session.archived", "workspace_id": "wd_...", "sessionId": "session_..." } }
```

`type` 是事件类型，`payload` 是事件内容。与某个会话直接相关的事件，`session_id` 是那个会话的 id；其余事件的 `session_id` 是全局标记 `__global__`，相关的会话 id 在 `payload.sessionId` 里。会话和工作区的事件可以让跨工作区的概览界面不必逐个工作区轮询。

| 事件 | 帧的 `session_id` | `payload` 字段 | 什么时候发出 |
| --- | --- | --- | --- |
| `session.meta.updated` | 会话 id | `title?`, `patch?` | 会话标题或元信息变化，例如通过 profile 接口设置了标题 |
| `event.session.created` | 会话 id | `session`：[会话对象](./server-api-sessions.md#会话对象) | 创建了会话，包括分叉 |
| `event.session.work_changed` | 会话 id | `busy`, `main_turn_active?`, `pending_interaction?`, `last_turn_reason?` | 会话的运行状态变化，字段含义同 [会话对象](./server-api-sessions.md#会话对象)。main agent 一轮结束时，结束标志和结局在同一个事件里，客户端可以用 `main_turn_active` 从 `true` 变为 `false` 做完成提醒 |
| `event.session.archived` | `__global__` | `workspace_id`, `sessionId` | 会话被归档，在线归档和冷归档都会发出 |
| `event.session.restored` | `__global__` | `workspace_id`, `sessionId` | 已归档的会话被恢复 |
| `event.session.deleted` | `__global__` | `workspace_id`, `sessionId` | 会话被删除 |
| `event.workspace.created`、`event.workspace.updated` | `__global__` | `workspace`：完整的 [工作区对象](./server-api-service.md#工作区对象) | 工作区创建或更新。创建会话时会触碰工作区，也会发出 `updated` |
| `event.workspace.deleted` | `__global__` | `workspace_id`, `root` | 工作区被删除 |
| `event.config.changed` | `__global__` | `changedFields`, `config`（同 `GET /api/v1/config` 的响应） | 配置变化 |
| `event.config.warning` | `__global__` | `warnings: [{ domain?, message }]` | 读取配置时出现警告 |
| `event.model_catalog.changed` | `__global__` | `changed: [{ provider_id, provider_name, added, removed }]`, `unchanged`, `failed: [{ provider, reason }]`, `retired_default?: { from, to, from_display_name }` | 模型目录刷新完成 |
| `event.plugin.changed` | `__global__` | 无 | 插件变化，客户端重新读取插件列表 |
| `event.capability.changed` | `__global__` | `capability_id`, `install: { running, step?, percent?, error?, note? }` | 内置能力的安装状态变化 |

这些事件只覆盖本服务进程内的变化。其他进程（例如写入同一 home 目录的 CLI）的变化，要等索引对账（约一分钟）后才可见，所以概览客户端应保留低频的兜底轮询。
