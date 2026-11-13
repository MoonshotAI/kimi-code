# 会话接口

本页列出 `/api/v1/sessions` 下的 REST 接口（会话文件系统接口见 [文件接口](./server-api-files.md)），以及 `/api/v2/sessions` 的会话列表与批量归档接口。WebSocket 一侧（对话帧、[订阅会话](./server-api-conversation.md#订阅会话)、客户端如何驱动一轮对话）见 [会话与对话](./server-api-conversation.md)；响应信封、鉴权、错误码和分页等通用约定见 [服务 API](./server-api.md)。

## 会话

这部分接口管理会话本身：创建、列出、读取和修改会话，执行 fork、压缩、撤销等会话动作，以及读取目标、告警、环境、文件历史等会话级信息。返回会话的接口都使用 [会话对象](#会话对象) 格式。

### 会话对象

所有返回会话的接口都使用这种格式。

实时状态字段（`busy`、`main_turn_active`、`pending_interaction`、`last_turn_reason`）从会话的活动汇总中解析得出。会话未加载到本服务进程（冷会话）时，这些字段始终上报为不忙碌、无待处理交互。少数字段目前是占位值，已在说明中逐一注明。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 会话 id（`session_...`） |
| `workspace_id` | string | 所属工作区 id |
| `title` | string | 会话标题，无标题时为 `""` |
| `created_at` / `updated_at` | string | 创建时间与最后更新时间，ISO 8601 |
| `archived` | boolean | 会话是否已归档。归档的会话不出现在默认会话列表中 |
| `archived_at` | string | 归档时间，ISO 8601。仅在已归档时存在 |
| `busy` | boolean | 任一 Agent 有进行中的轮次、有运行中的任务（前台任务也算）或正在压缩上下文时为 `true` |
| `main_turn_active` | boolean | main agent 有进行中的轮次时为 `true` |
| `pending_interaction` | string | 正在等待答复的交互：`none` / `approval` / `question`。审批和提问同时待处理时为 `approval` |
| `last_turn_reason` | string | main agent 最近一轮的结果：`completed` / `cancelled` / `failed`。main agent 开始新一轮时清除 |
| `last_prompt` | string | 最近一条用户提示词的文本（如有） |
| `forked_from` | string | 直接来源会话的 id，仅在该会话由 fork 创建时存在 |
| `metadata` | object | 自定义元数据，始终带 `cwd`（会话的工作目录） |
| `agent_config` | object | 只含 `model`。会话已加载到当前服务端进程、且 main agent 有模型时，`model` 为 main agent 当前的模型，否则为 `""`。创建会话的响应同样带上该模型，除非创建时没有可用的模型 |
| `usage` | object | token 汇总：`input_tokens`、`output_tokens`、`cache_read_tokens`、`cache_creation_tokens`、`context_tokens`，以及可选的 `context_limit`、`total_cost_usd`、`turn_count`。目前始终为零。实时的上下文大小由每个 Agent 的 [`usage` 帧](./server-api-conversation.md#agent-状态) 通过 WebSocket 下发 |
| `permission_rules` | array | 会话权限规则，目前始终为 `[]` |
| `message_count` | integer | 消息数，目前始终为 `0` |

### 创建、查询与修改会话

创建会话、列出和读取会话，以及修改会话的标题、元数据和 main agent 配置。

| 方法与路径 | 说明 |
| --- | --- |
| `POST /api/v1/sessions` | 创建会话（需要 `workspace_id` 或 `metadata.cwd`） |
| `GET /api/v1/sessions` | 列出会话，游标分页，支持 `busy`、`archived_only` 等过滤 |
| `GET /api/v1/sessions/{session_id}` | 读取单个会话 |
| `GET /api/v1/sessions/{session_id}/profile` | 读取会话档案 |
| `POST /api/v1/sessions/{session_id}/profile` | 更新标题、元数据和 main agent 配置 |
| `POST /api/v1/sessions/{session_id}/title/generate` | 通过托管的 `chat_title` 工具生成标题 |

#### `POST /api/v1/sessions`

创建会话并返回。创建成功时，服务端广播全局事件 `event.session.created`（见 [全局事件](./server-api-conversation.md#全局事件)）。

会话的目录来自 `workspace_id`（已注册的工作区）或 `metadata.cwd`（首次使用时注册该工作区）。两者同时提供时必须一致。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `workspace_id` | body | string | 未提供 `metadata.cwd` 时必填。已注册的工作区 id，会话创建在该工作区的根目录 |
| `metadata` | body | object | 自定义元数据。`metadata.cwd` 是工作目录，未提供 `workspace_id` 时必填；与 `workspace_id` 同时提供时必须等于工作区根目录。其他键保存为会话的自定义元数据，保留键 `goal`、`parent_session_id`、`child_session_kind` 会被丢弃 |
| `title` | body | string | 初始标题，至少 1 个字符。不提供时会话没有标题 |
| `agent_config` | body | object | main agent 的部分配置，在返回会话之前应用。字段与 [`POST /api/v1/sessions/{session_id}/profile`](#post-api-v1-sessions-session-id-profile) 的 `agent_config` 相同，另加 `profile` |
| `environment_id` | body | string | main agent 运行所在的环境 id，`local` 表示本机。不提供时使用 `config.toml` 中 `[environments]` 的 `default`，没有配置时为本机。非本机环境必须已在 `[environments]` 中声明或已注册。提供了非 `local` 的值时，服务端在返回会话之前就创建 main agent |
| `environment_cwd` | body | string | 环境上的工作目录。提供时必须同时提供 `environment_id`。非本机环境不提供时，使用该环境在 `[environments]` 中的 `defaultCwd` |

创建会话时就绑定 main agent：

- `agent_config.profile` 指定 Agent 档案，默认 `agent`。Agent 档案之后不能更改。
- `agent_config.model` 指定模型，默认为服务端当前的默认模型。之后修改默认模型不影响该会话。
- `agent_config.thinking` 在同一次绑定中按该模型校验。

`agent_config` 无法应用时，服务端不创建会话，直接返回错误。`agent_config` 设置了 `tower_mode: true` 时返回 `40001`：进入 Tower 模式会改动仓库，创建失败时无法撤销，因此要在会话建好后通过 `POST /api/v1/sessions/{session_id}/profile` 开启。

没有可用模型（未配置默认模型，或默认模型无法解析）时，会话照常创建，但没有模型。此时如果 `agent_config` 设置了 `profile` 或 `thinking`，服务端不创建会话。

成功时 `data` 为新会话的 [会话对象](#会话对象)。

- `40001`：`workspace_id` 与 `metadata.cwd` 都未提供；`metadata.cwd` 与工作区根目录不一致；`agent_config` 设置了 `tower_mode: true`（`details` 列出该字段）；`agent_config.model` 未配置；`agent_config.profile` 是未知的 Agent 档案；模型不支持 `agent_config.thinking`；提供了 `environment_cwd` 但没有 `environment_id`；非本机环境未声明、注册失败，或没有可用的工作目录
- `40113`：没有可用模型，而 `agent_config` 设置了 `profile` 或 `thinking`
- `40409`：工作目录不存在或不是目录。使用非本机环境时，不检查工作目录是否存在
- `40410`：没有以该 `workspace_id` 注册的工作区
- `40420`：环境不存在
- `40913`–`40918`、`40920`：`agent_config` 因目标相关错误无法应用
- `40926`：环境不可用

#### `GET /api/v1/sessions`

跨工作区列出会话，`updated_at` 最新的在前。游标分页遵循 [分页](./server-api.md#分页) 约定，但有一个例外：既不传 `page_size` 也不传 `archived_only` 时，响应是一个不分页的窗口，`has_more` 恒为 `false`。要真正翻页，必须传 `page_size`。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `before_id` | query | string | 只保留早于该 id 的会话。与 `after_id` 互斥 |
| `after_id` | query | string | 只保留晚于该 id 的会话。与 `before_id` 互斥 |
| `page_size` | query | integer | 1–100。分页生效时默认 `20`；不传时的行为见上文 |
| `busy` | query | boolean | 只保留忙碌（或只保留空闲）的会话 |
| `include_archive` | query | boolean | 在活跃会话之外同时列出已归档会话。默认 `false` |
| `archived_only` | query | boolean | 只列出已归档会话。与 `include_archive` 互斥。不传 `page_size` 时也启用游标分页 |
| `exclude_empty` | query | boolean | 去掉没有任何用户提示词的会话 |
| `workspace_id` | query | string | 只列出该工作区的会话，接受工作区别名 |

成功时 `data` 为 `{ items, has_more }`，`items` 的每项是 [会话对象](#会话对象)。

- `40001`：校验失败，例如 `before_id` 与 `after_id` 同时传入，或 `archived_only` 与 `include_archive` 同时传入
- `40410`：`workspace_id` 未知

#### `GET /api/v1/sessions/{session_id}`

从索引中读取单个会话。会话已加载到本进程时带实时状态字段；冷会话上报为不忙碌，并带上它最后持久化的轮次结果。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | 必填。会话 id |

成功时 `data` 为 [会话对象](#会话对象)。

- `40401`：会话不存在，或会话的工作区已无法解析

#### `GET /api/v1/sessions/{session_id}/profile`

读取会话档案，返回内容与 `GET /api/v1/sessions/{session_id}` 相同。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | 必填。会话 id |

成功时 `data` 为 [会话对象](#会话对象)。

- `40401`：会话不存在

#### `POST /api/v1/sessions/{session_id}/profile`

更新会话档案：标题、自定义元数据和 main agent 的配置。

这里设置的标题是自定义标题，优先于生成的标题。设置标题时，服务端广播全局事件 `session.meta.updated`。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | 必填。会话 id |
| `title` | body | string | 新标题，至少 1 个字符。会成为自定义标题 |
| `metadata` | body | object | 非空时整体替换会话的自定义元数据。保留键 `cwd`、`goal`、`parent_session_id`、`child_session_kind` 会被忽略，会话已存的这些键保持不变 |
| `agent_config` | body | object | main agent 的部分配置，字段见下表 |

`agent_config` 的字段都是可选的，服务端按 `model`、`thinking`、`permission_mode`、`plan_mode`、`swarm_mode`、`tower_mode`、`goal_objective`、`goal_control` 的顺序逐个应用到 main agent。应用不是原子的：某个字段出错时，排在它前面的字段已经生效，不会回滚。除 `goal_objective` 和 `goal_control` 外，其他字段重复发送不会产生额外效果，可以安全重发。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `model` | string | 模型别名 id。空字符串会被忽略 |
| `thinking` | string | Thinking 强度等级 |
| `permission_mode` | string | `manual` / `yolo` / `auto`。同步到会话中的所有 Agent，固定了权限模式的 Agent（例如 Tower worker）除外 |
| `plan_mode` | boolean | 进入或退出 Plan 模式 |
| `swarm_mode` | boolean | 进入或退出 swarm 模式 |
| `tower_mode` | boolean | 进入或退出 Tower 模式。需要开启 Tower 实验开关（`KIMI_CODE_EXPERIMENTAL_TOWER=1`，或 `config.toml` 中 `[experimental] tower = true`） |
| `tower_base` | string | 进入 Tower 模式时使用的基础分支，只在同时设置 `tower_mode: true` 时使用。分支不存在时，服务端在仓库中创建并切换到该分支，并把未提交的改动提交到这个分支上 |
| `goal_objective` | string | 以该文本为内容创建一个目标 |
| `goal_control` | string | 控制当前目标：`pause` / `resume` / `cancel` |

成功时 `data` 为更新后的 [会话对象](#会话对象)。

- `40001`：`model` 未配置；模型不支持 `thinking`；带了 `agent_config.profile`（Agent 档案只能在创建会话时指定）
- `40113`：会话没有模型，而请求只设置了 `thinking`、没有同时设置 `model`
- `40401`：会话不存在
- `40913`–`40918`、`40920`：`goal_objective` 或 `goal_control` 因目标相关错误无法应用，例如已有目标、没有目标，或目标状态不允许该操作
- `40935`：无法进入 Tower 模式：实验开关未开启；Tower 功能未在本服务进程中装配，需要重启；工作区的 Tower 被另一个正在运行或等待答复的会话占用

#### `POST /api/v1/sessions/{session_id}/title/generate`

根据会话的提示词生成标题并应用到会话，同时广播 `session.meta.updated`。标题由托管供应商的 `chat_title` 工具生成。

生成标题需要托管 OAuth 登录。不传 `force` 时，已有自定义标题或生成标题的会话会上报为不可用，现有标题不会被覆盖。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | 必填。会话 id |
| `force` | body | boolean | 已有自定义标题或生成标题时也重新生成。默认 `false` |
| `source` | body | string | 生成标题所用的输入：`user_prompts`（默认）/ `first_turn` / `digest` |

成功时 `data` 为 `{ title }`，即会话当前应用的标题。

- `40401`：会话不存在
- `40923`：无法生成标题：开关未开启；没有托管 OAuth 登录；会话还没有任何提示词内容；已有标题但未传 `force`；后端请求失败

### 会话动作

会话动作是对单个会话的非 CRUD 操作，按 `:{action}` 约定 POST 到 `/api/v1/sessions/{session_id}:{action}`。

| 方法与路径 | 说明 |
| --- | --- |
| `POST /api/v1/sessions/{session_id}:fork` | 把会话复制成同一工作区的新会话 |
| `POST /api/v1/sessions/{session_id}:compact` | 手动压缩 main agent 的上下文 |
| `POST /api/v1/sessions/{session_id}:undo` | 撤销某一轮及其之后的轮次 |
| `POST /api/v1/sessions/{session_id}:abort` | 取消 main agent 正在运行的轮次 |
| `POST /api/v1/sessions/{session_id}:btw` | 开启只读的旁路对话 |
| `POST /api/v1/sessions/{session_id}:archive` | 归档会话 |
| `POST /api/v1/sessions/{session_id}:restore` | 取消归档 |
| `POST /api/v1/sessions/{session_id}:delete` | 永久删除会话 |
| `POST /api/v1/sessions/{session_id}:reload` | 按磁盘上的最新配置重新加载会话 |
| `POST /api/v1/sessions/{session_id}:takeover` | 移除其他进程残留的会话锁 |

#### `POST /api/v1/sessions/{session_id}:{action}`

所有会话动作走同一条路由：路径末尾解析为 `{session_id}:{action}`，请求体按该动作的 schema 校验。下面各动作的参数表只列请求体字段。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | 必填。会话 id |
| `action` | path | string | 必填。动作名，取值见上表 |

- `40001`：动作缺失或未知（`unsupported action: ...`）
- `40401`：会话不存在。每个动作都会先解析会话，因此每个动作都可能返回此码

#### `POST /api/v1/sessions/{session_id}:fork`

把会话复制到同一工作区中的新会话，包括对话、Agent 状态与文件，并广播 `event.session.created`。源会话会继续运行。

源会话有进行中的轮次时，fork 保留该轮之前最近一个已完成的边界，并把当前轮的用户提示词保存为一个只含提示词的 `cancelled` 轮次。这个轮次不包含 Assistant 输出、工具活动、排队输入或之后的事件。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `title` | body | string | fork 的标题，至少 1 个字符。默认 `Fork: <source title>` |
| `metadata` | body | object | fork 的自定义元数据 |
| `turn_index` | body | integer | 保留到哪一轮（包含该轮），取持久化的 engine `turnId`，允许编号有空洞。必须是非负安全整数，且该轮已经完成 |

成功时 `data` 为新会话的 [会话对象](#会话对象)。

- `40001`：`turn_index` 无效、不存在，或指向进行中的轮次
- `40901`：另一项会话历史操作正在进行

#### `POST /api/v1/sessions/{session_id}:compact`

对 main agent 的上下文发起一次手动全量压缩。调用立即返回，不等压缩完成。

压缩期间，WebSocket [`agent` 帧](./server-api-conversation.md#agent-状态) 的 `compacting` 为 `true`。压缩完成后，结果以 [`system`](./server-api-conversation.md#system) 条目出现在对话中。压缩被取消时，对话中不留任何内容，订阅者收到一条 `code` 为 `compaction.cancelled` 的 [`notice` 帧](./server-api-conversation.md#实时更新)。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `instruction` | body | string | 给压缩摘要的额外指引。空值会被忽略 |

压缩不排队，只能在 main agent 空闲时开始，流程见 [压缩](./server-api-conversation.md#压缩)。

成功时 `data` 为 `{}`。

- `40910`：已有压缩正在进行；有正在运行的轮次；队列中有待处理的提示词；有其他上下文变更或会话历史操作（例如撤销、fork）正在进行；历史中没有可压缩的内容

#### `POST /api/v1/sessions/{session_id}:undo`

撤销某个 Agent 对话中的一轮及其之后的所有轮次，包括其间的 system 轮次和由定时任务等触发的轮次。服务端同步修正派生的会话状态（包括会话的 `last_prompt`），不回滚文件。流程见 [撤销](./server-api-conversation.md#撤销)。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `turn_id` | body | string | 必填。要撤销的轮次。必须是 `agent` 轮次，且开场的 `user_message` 来自用户、用户以斜杠调用的 Skill 或 plugin command |
| `agent_id` | body | string | 要撤销其对话的 Agent。默认 `main` |

成功时 `data` 为 `{ removed_turn_ids }`：被删除的轮次，按 ordinal 升序排列，第一个就是 `turn_id`。订阅者会收到 `turn_ids` 相同的 [`turns.removed` 帧](./server-api-conversation.md#实时更新)，响应与该帧到达的先后顺序不固定。

- `40421`：这一轮不存在
- `40901`：Agent 正在工作（有运行中的轮次、排队的输入，或正在压缩上下文），等它结束后可以重试
- `40911`：这一轮无法撤销：开场不是用户输入，或要删除的范围跨过了上下文压缩
- `40932`：会话已被其他客户端更新。服务端已重新载入会话，这次没有撤销任何内容（见 [错误码](./server-api.md#错误码)）

#### `POST /api/v1/sessions/{session_id}:abort`

停止 main agent 当前的轮次，相当于用户在 TUI 中中止轮次。只作用于 main agent，其他 Agent 的轮次不受影响。

无论当时有没有正在运行的轮次，成功时 `data` 都为 `{ aborted: true }`，因此可以安全重试。要确认轮次已经停止，等待该轮的 `turn.ended` 帧。

停止轮次不会清空队列：排队的用户提示词和尚未插入的用户插话保留下来，在被停止的轮次结束后开始执行；排队的 Skill 激活被取消。流程见 [停止](./server-api-conversation.md#停止)。

#### `POST /api/v1/sessions/{session_id}:btw`

开启一个 "by the way" 旁路对话：把 main agent fork 成一个只能使用只读工具（`Read`、`Grep`、`Glob`）的 subagent，让临时的小问题在隔离环境中运行，不触碰工作上下文。需要可用的模型配置。

成功时 `data` 为 `{ agent_id }`，即新 subagent 的 id。

旁路对话等非 main agent 的轮次没有公开的停止接口，[`:abort`](#post-api-v1-sessions-session-id-abort) 只停止 main agent。

#### `POST /api/v1/sessions/{session_id}:archive`

将会话标记为已归档，并广播全局事件 `event.session.archived`。归档后会话不出现在默认会话列表中，使用 `include_archive` 或 `archived_only` 时仍会列出。

成功时 `data` 为 `{ archived: true }`。

#### `POST /api/v1/sessions/{session_id}:restore`

取消会话的归档状态。会话原本已归档时，服务端广播全局事件 `event.session.restored`。

成功时 `data` 为 [会话对象](#会话对象)，其中 `archived` 为 `false`。

#### `POST /api/v1/sessions/{session_id}:delete`

永久删除会话。会话已加载到本进程时先被关闭，然后服务端删除它在磁盘上的数据、索引条目和文件历史，并广播全局事件 `event.session.deleted`（见 [全局事件](./server-api-conversation.md#全局事件)）。删除无法撤销。

成功时 `data` 为 `{ deleted: true }`。

#### `POST /api/v1/sessions/{session_id}:reload`

按磁盘上的最新配置重新加载会话：重读 `config.toml` 与插件，重载工作区的 Skill 与 subagent 目录，然后关闭会话并从磁盘恢复。服务端还会通过系统提醒（system-reminder）把 `AGENTS.md`、Skill、subagent 及模型的外部变更告知 main agent。

成功时 `data` 为 [会话对象](#会话对象)。会话虽然被关闭后重新打开，已有的订阅仍然有效，服务端会重新发送各帧，见 [会话在服务端关闭和重新打开](./server-api-conversation.md#会话在服务端关闭和重新打开)。

- `40901`：任一 Agent 有正在运行的轮次或正在压缩上下文，无法重新加载

#### `POST /api/v1/sessions/{session_id}:takeover`

移除其他 Kimi Code 进程在该会话上持有的锁。之后可以重试此前返回 [`40931`](./server-api.md#错误码) 的请求。

只在持锁进程已退出、锁残留时使用。该进程仍在运行时，两个进程会同时写入该会话直到它空闲，会话历史可能交错。

成功时 `data` 为 `{ taken_over: true }`。

- `40401`：会话不存在

### 子会话

子会话是从当前会话 fork 出来、并记录为其子会话的会话。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/v1/sessions/{session_id}/children` | 列出子会话 |
| `POST /api/v1/sessions/{session_id}/children` | 创建子会话（fork 并打标） |

#### `GET /api/v1/sessions/{session_id}/children`

列出通过 `POST /api/v1/sessions/{session_id}/children` 创建的子会话。游标分页遵循 [分页](./server-api.md#分页) 约定。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | 必填。会话 id |
| `before_id` | query | string | 只保留早于该 id 的子会话。与 `after_id` 互斥 |
| `after_id` | query | string | 只保留晚于该 id 的子会话。与 `before_id` 互斥 |
| `page_size` | query | integer | 1–100。默认 `100` |
| `busy` | query | boolean | 只保留忙碌（或只保留空闲）的子会话 |

成功时 `data` 为 `{ items, has_more }`，`items` 的每项是 [会话对象](#会话对象)。

- `40401`：会话不存在

#### `POST /api/v1/sessions/{session_id}/children`

创建子会话：fork 当前会话并记录为它的子会话，之后可以在 `GET /api/v1/sessions/{session_id}/children` 中列出。创建成功时，服务端广播 `event.session.created`。

源会话正在运行时，采用与 [`:fork`](#post-api-v1-sessions-session-id-fork) 相同的边界：保留最近一个已完成的轮次，当前轮次保存为只含提示词的 `cancelled` 轮次。创建子会话不接受历史 `turn_index` 参数。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | 必填。会话 id |
| `title` | body | string | 子会话的标题，至少 1 个字符。默认 `Child: <source title>` |
| `metadata` | body | object | 子会话的自定义元数据 |

成功时 `data` 为新会话的 [会话对象](#会话对象)。

- `40401`：会话不存在
- `40901`：另一项会话历史操作正在进行

### 目标

读取和修改会话当前的目标。创建、暂停、恢复或取消目标通过 [`POST /api/v1/sessions/{session_id}/profile`](#post-api-v1-sessions-session-id-profile) 的 `goal_objective` 和 `goal_control` 完成。与本 API 的大多数载荷不同，目标接口的载荷使用 camelCase 键。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/v1/sessions/{session_id}/goal` | 读取当前目标快照（没有时为 `null`） |
| `PATCH /api/v1/sessions/{session_id}/goal` | 就地修改当前目标的 objective |

#### `GET /api/v1/sessions/{session_id}/goal`

读取会话当前的目标快照。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | 必填。会话 id |

没有目标时 `data` 为 `null`。目标完成后即被清除，因此之后读取也返回 `null`。否则 `data` 为目标快照：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `goalId` | string | 目标 id |
| `objective` | string | 目标内容 |
| `completionCriterion` | string | 完成标准，可选 |
| `status` | string | `active` / `paused` / `blocked` / `complete` |
| `turnsUsed` | number | 已用轮次 |
| `tokensUsed` | number | 已用 token |
| `wallClockMs` | number | 已用的 wall-clock 时间，毫秒 |
| `budget.tokenBudget` / `budget.turnBudget` / `budget.wallClockBudgetMs` | number \| null | token、轮次与 wall-clock（毫秒）预算。未设置对应预算时为 `null` |
| `budget.remainingTokens` / `budget.remainingTurns` / `budget.remainingWallClockMs` | number \| null | 各项预算的剩余量，最小为 `0`。未设置对应预算时为 `null` |
| `budget.tokenBudgetReached` / `budget.turnBudgetReached` / `budget.wallClockBudgetReached` | boolean | 已用量达到对应预算时为 `true`。未设置对应预算时为 `false` |
| `budget.overBudget` | boolean | 任一预算已达到时为 `true` |
| `terminalReason` | string | 目标离开 `active` 状态（暂停、受阻）的原因，可选。目标回到 `active` 时清除 |

- `40401`：会话不存在

#### `PATCH /api/v1/sessions/{session_id}/goal`

替换当前目标的 objective，`goalId`、状态、进度和预算都保持不变。适用于 `active`、`paused`、`blocked` 状态的目标。

正在运行的轮次不会被打断，Agent 在下一轮收到新的 objective。订阅了该会话的客户端会收到新的 WebSocket [`goal` 帧](./server-api-conversation.md#agent-状态)。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | 必填。会话 id |
| `objective` | body | string | 必填。新的 objective，首尾空白会被去除 |

成功时 `data` 为更新后的目标快照，结构与 `GET /api/v1/sessions/{session_id}/goal` 相同（camelCase）。

- `40401`：会话不存在
- `40914`：当前没有目标
- `40915`：目标已完成
- `40917`：objective 为空
- `40918`：objective 超过 4000 字符

### 告警与环境

读取会话级告警，以及 main agent 运行所在的环境和会话可用的环境。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/v1/sessions/{session_id}/warnings` | 会话级告警 |
| `GET /api/v1/sessions/{session_id}/environment` | 读取 main agent 的环境绑定 |
| `GET /api/v1/sessions/{session_id}/environments` | 列出会话工作区已注册的环境 |

#### `GET /api/v1/sessions/{session_id}/warnings`

读取会话级告警。目前只有 `AGENTS.md` 过大检查（`agents-md-oversized`）会产生告警，因此大多数会话的列表为空。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | 必填。会话 id |

成功时 `data` 为 `{ warnings }`：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `warnings[].code` | string | 告警代码，例如 `agents-md-oversized` |
| `warnings[].message` | string | 告警信息 |
| `warnings[].severity` | string | `info` / `warning` / `error` |

- `40401`：会话不存在

#### `GET /api/v1/sessions/{session_id}/environment`

读取 main agent 的环境绑定，即该会话的 Agent 循环运行在哪个环境上。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | 必填。会话 id |

成功时 `data` 为：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `workspace_id` | string | 工作区 id |
| `environment_id` | string | 绑定的环境 id |
| `cwd` | string | 被绑定环境上的工作目录。绑定带有该值时才返回 |

- `40401`：会话不存在

#### `GET /api/v1/sessions/{session_id}/environments`

列出会话可用的环境，即会话所在工作区已注册的环境。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | 必填。会话 id |

成功时 `data` 为 `{ environments }`：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `environments[].environment_id` | string | 环境 id |
| `environments[].type` | string | `local` / `ssh` / `docker` / `command` |
| `environments[].status` | string | `pending` / `connecting` / `ready` / `disconnected` / `disposed`。`pending` 表示没有可用连接、也没有观察到失败（尚未连接过） |
| `environments[].connect_error` | string | `disconnected` 条目的失败原因 |

- `40401`：会话不存在

### 导出与媒体

这两个接口返回二进制流而不是 JSON 信封，Range、ETag 等 HTTP 行为见 [二进制与流式端点](./server-api-files.md#二进制与流式端点)。

| 方法与路径 | 说明 |
| --- | --- |
| `POST /api/v1/sessions/{session_id}/export` | 导出会话与诊断信息（zip 流，不走信封） |
| `GET /api/v1/sessions/{session_id}/media/{file_id}` | 按文件 id 下载提示词媒体（二进制） |

#### `POST /api/v1/sessions/{session_id}/export`

把会话连同诊断日志导出为 zip 附件（`kimi-session-<id>.zip`）。响应是二进制流，不是 JSON 信封；支持的 HTTP 能力与失败语义见 [二进制与流式端点](./server-api-files.md#二进制与流式端点)。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | 必填。会话 id |
| `web_log` | body | string | 要放进归档的客户端日志文本，最多 256 KB UTF-8 |
| `desktop` | body | boolean | 同时包含桌面宿主的日志。默认 `false` |

#### `GET /api/v1/sessions/{session_id}/media/{file_id}`

按文件 id 下载提示词媒体文件，即会话提示词引用的图片或其他附件。该 id 尚未提交到会话时，服务端回退到暂存的上传中查找。

响应是二进制，支持 `Range`（范围请求返回 206），共享约定见 [二进制与流式端点](./server-api-files.md#二进制与流式端点)。会话或文件不存在时，返回真正的 HTTP 404 状态码，响应体是信封；这一点与那里以 HTTP 200 返回错误信封的端点不同。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | 必填。会话 id |
| `file_id` | path | string | 必填。媒体文件 id |

### 文件历史

按轮次读取 main agent 改动过的文件及其前后内容，可用来展示一轮的 diff。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/v1/sessions/{session_id}/file-history/changes` | 列出一轮改动过的文件 |
| `GET /api/v1/sessions/{session_id}/file-history/content` | 读取文件在一轮开始或结束时的内容 |

#### `GET /api/v1/sessions/{session_id}/file-history/changes`

从轮次级文件历史中列出 main agent 某一轮改动过的文件。服务端比较这一轮开始时与结束时记录的内容；轮次仍在进行时，与磁盘上的当前文件比较。没有变化的文件不列出。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | 必填。会话 id |
| `turn_number` | query | integer | 必填。轮次的 `turn_number`（见 [轮次](./server-api-conversation.md#轮次)） |

成功时 `data` 为 `{ changes, recorded }`：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `changes[].path` | string | 文件路径 |
| `changes[].status` | string | `added` / `modified` / `deleted` |
| `changes[].additions` / `changes[].deletions` | number | 新增与删除的行数 |
| `changes[].binary` | boolean | 文件不是文本，或内容已不再保存。此时行数都为 `0` |
| `changes[].oversize` | boolean | 文件过大，没有记录。此时行数都为 `0` |
| `recorded` | boolean | 这一轮的文件历史不完整（从未记录，或部分已记录的内容后来被清理）时为 `false`，此时 `changes` 可能为空或不全 |

- `40001`：`turn_number` 缺失或无效
- `40401`：会话不存在

#### `GET /api/v1/sessions/{session_id}/file-history/content`

读取 main agent 的文件历史在某一轮开始或结束时记录的文件内容，例如用来展示这一轮的 diff。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | 必填。会话 id |
| `turn_number` | query | integer | 必填。轮次的 `turn_number` |
| `path` | query | string | 必填。文件路径，与 `file-history/changes` 列出的一致 |
| `phase` | query | string | `start`（默认）取这一轮之前的内容，`end` 取这一轮之后的内容 |

成功时 `data` 为 `{ content }`。以下情况 `content` 为 `null`：这一轮没有该阶段的记录；文件没有被记录、过大，或已保存的内容已不存在。其他情况下 `content` 为：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `content.version` | number | 文件在历史中的版本号 |
| `content.content` | string | 文本内容 |
| `content.binary` | boolean | 文件不是文本时为 `true` |

`content.content` 和 `content.binary` 都没有时，表示文件在这个时间点不存在。`phase=end` 时，这一轮没有改动的文件按开始时的内容返回。

- `40001`：`turn_number` 或 `path` 缺失或无效
- `40401`：会话不存在

### 满意度问卷

一轮结束后，客户端可能显示满意度问卷。客户端用下面的接口询问是否显示问卷，并上报问卷何时显示、用户如何回答。

| 方法与路径 | 说明 |
| --- | --- |
| `POST /api/v1/sessions/{session_id}/rating` | 询问是否显示满意度问卷，并上报问卷的显示和回答 |

#### `POST /api/v1/sessions/{session_id}/rating`

一轮完成后，客户端先用 `evaluate` 询问要不要显示问卷，再上报问卷的显示与回答。是否给出问卷取决于 Kimi Code 服务设定的抽样规则和本地冷却时间，因此多数询问不会给出问卷。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | 必填。会话 id |
| `op` | body | string | 必填。`evaluate` / `shown` / `respond` / `abandon` |
| `turn_id` | body | string | `evaluate` 时必填。刚完成的轮次的 `turn_id` |
| `appearance_id` | body | string | `shown` / `respond` / `abandon` 时必填。`evaluate` 返回的 `id` |
| `response` | body | string | `respond` 时必填。`bad` / `fine` / `good` / `dismissed` |

`evaluate` 时 `data` 为 `{ appearance }`。客户端此时应显示问卷时，`appearance` 为 `{ id, survey }`，`survey` 为 `session` 或 `long_context`；否则为 `null`。以下情况也属于返回 `null`：该轮不是 main agent 最近完成的轮次、开启了 `disable_feedback_survey`、关闭了遥测。

之后按问卷的去向上报，这三种操作都返回 `data: null`：

| `op` | 何时上报 |
| --- | --- |
| `shown` | 问卷已显示 |
| `respond` | 用户已作答。用户关掉问卷时 `response` 为 `dismissed` |
| `abandon` | 问卷没有得到回答就消失了，例如用户转去了别处 |

- `40001`：校验失败

### 会话 Skill

列出会话可用的 Skill，或在会话中激活 Skill。激活相当于斜杠命令 `/<skill>` 的 REST 形式，非 CRUD 操作同样使用 `:{action}` 约定。不创建会话、按工作区读取 Skill 目录见 [`GET /api/v1/workspaces/{workspace_id}/skills`](./server-api-service.md#get-api-v1-workspaces-workspace-id-skills)。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/v1/sessions/{session_id}/skills` | 会话级 Skill 目录 |
| `POST /api/v1/sessions/{session_id}/skills/{skill_name}:activate` | 激活 Skill（开启一个轮次） |

#### `GET /api/v1/sessions/{session_id}/skills`

列出单个会话可用的 Skill，按会话的优先级合并所有来源（内置、插件、extra、用户、项目）。会话为冷会话时，读取目录会恢复该会话。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | 必填。会话 id |

成功时 `data` 为 `{ skills }`，每项是一个 Skill 描述符：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `skills[].name` | string | Skill 名称 |
| `skills[].description` | string | Skill 描述 |
| `skills[].path` | string | Skill 的路径。同名 Skill 可以作为多个变体返回，各自的 `path` 不同 |
| `skills[].source` | string | `project` / `user` / `extra` / `builtin`。插件提供的 Skill 上报为 `extra` |
| `skills[].workspace_dir` | string | 项目级 Skill 的根目录。其他来源省略该字段 |
| `skills[].type` | string | Skill 类别，可选。只有用户可激活的类型才能被激活 |
| `skills[].disable_model_invocation` | boolean | 可选。为 `true` 时 Skill 对模型不可见 |
| `skills[].scopes` | array | 可选。Skill 适用的客户端界面：`tui` / `web`。省略时适用于所有界面 |

- `40401`：会话不存在（或未激活）

#### `POST /api/v1/sessions/{session_id}/skills/{skill_name}:activate`

在会话中激活 Skill，相当于斜杠命令 `/<skill>`：以 Skill 内容加上 `args` 与附件，在 main agent 上开启一个轮次。

main agent 正在运行时，激活不会开启新轮次，而是作为插话插入当前轮次，响应在插入之后返回（见 [插话](./server-api-conversation.md#插话)）。

该接口经单一路由 `POST /api/v1/sessions/{session_id}/skills/{tail}` 分发：`{tail}` 按 `{skill_name}:{action}` 解析，`activate` 是唯一的动作。只给名称或动作未知时返回 `40001`（`unsupported action: ...`）。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | 必填。会话 id |
| `skill_name` | path | string | 必填。要激活的 Skill 名称 |
| `path` | body | string | 会话 Skill 目录中某个 `SKILL.md` 的精确路径，用于选择同名变体。必须与目录返回的条目匹配 |
| `args` | body | string | 传给 Skill 的自由文本参数，相当于斜杠命令后的文本 |
| `prompt_id` | body | string | 客户端选定的激活消息 id，会出现在对话中对应 `user_message` 条目的 `prompt_ids` 里（见 [条目](./server-api-conversation.md#条目)）。幂等规则与 [提交提示词的 `prompt_id`](#post-api-v1-sessions-session-id-prompts) 相同，并与其共用同一张记录表 |
| `metadata` | body | object | 客户端自定义元数据，随激活消息保存，与提交提示词时的 `metadata` 相同 |
| `attachments` | body | array | 随激活携带的媒体块。`image` / `video` 块带 `source` 对象，`kind` 为 `url` / `base64` / `file` / `session_media`，与 [提示词内容块](#post-api-v1-sessions-session-id-prompts) 同形；`file` 块带顶层 `file_id`、`name`、`media_type`、`size` |

成功时 `data` 为 `{ activated: true, skill_name }`。

- `40001`：校验失败，或动作后缀不支持
- `40401`：会话不存在（或未激活）
- `40407`：引用的附件文件不存在
- `40415`：没有该名称的 Skill
- `40912`：Skill 存在，但其类型不允许用户激活
- `40927`：`prompt_id` 已被另一个请求使用，包括提交提示词和 `/steer` 的请求

### 会话列表（v2）

`/api/v2/sessions` 是面向会话列表页和管理页的新一代接口：列表查询的筛选、排序、字段组都放在查询参数里，并提供批量归档与恢复。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/v2/sessions` | 按筛选、排序和字段组查询会话，可按工作区分组 |
| `POST /api/v2/sessions:archive` | 批量归档会话 |
| `POST /api/v2/sessions:restore` | 批量恢复会话 |

#### `GET /api/v2/sessions`

面向列表页的会话查询，筛选、排序、字段组都在查询参数里。使用 `page_token` 或 `page` 分页（见 [分页](./server-api.md#分页)）。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `workspace.id` | query | string | 按工作区过滤，可重复 |
| `activity.status` | query | string | 按活动状态过滤：`running` / `approval` / `question` / `failed` / `idle`，可重复 |
| `meta.updated_after` | query | integer | 只看该时间（epoch 毫秒）之后更新过的会话 |
| `meta.updated_before` | query | integer | 只看该时间（epoch 毫秒）之前更新过的会话 |
| `meta.archived` | query | string | `true` / `false`（默认）/ `all` |
| `meta.has_prompt` | query | boolean | `true` 只保留有用户提示词的会话，`false` 只保留空会话（等价于 `GET /api/v1/sessions` 的 `exclude_empty`） |
| `view` | query | string | `flat`（默认）/ `by_workspace`，见下文 |
| `group.page_size` | query | integer | `view=by_workspace` 时每个工作区返回的会话数：1–100，默认 5（使用 `id,archived` 投影时上限 10000） |
| `sort` | query | string | `meta.updated_at_desc`（默认）/ `meta.updated_at_asc` / `meta.created_at_desc` |
| `include` | query | string | 逗号分隔的附加字段组。目前支持 `git`（分支与 PR 信息，按环境与工作目录去重并缓存 60 秒） |
| `fields` | query | string | 逗号分隔的字段投影。目前只支持 `id,archived`，每项裁剪为 `{ id, archived }`（用于全选匹配场景） |
| `page_size` | query | integer | 1–100，默认 50；使用 `id,archived` 投影时上限放宽至 10000。`view=by_workspace` 时按组计数 |
| `page_token` | query | string | 上一页返回的翻页令牌 |
| `page` | query | integer | 无状态的页码，从 1 开始。与 `page_token` 互斥 |

列表中的每一项固定包含 `workspace`、`meta`、`activity` 三组字段，`include=git` 时再附加 `git` 组；`fields=id,archived` 时每项只有 `{ id, archived }`。`activity` 组还带 `model`：会话仍加载在当前进程时为其绑定的模型别名，冷会话（未加载）为 `null`。各组的字段可参考下文分组视图示例中的会话项。

每页额外带 `total`，即过滤后的集合大小。翻页令牌绑定首页的查询条件（含投影），中途改变条件返回 `40922`。`page` 模式是用于跳页的无状态替代：每次请求都是独立快照，不签发令牌，`next_page_token` 恒为 `null`。

`view=by_workspace` 时，同一份过滤、排序后的集合会重新投影为按工作区分组的形态。概览页因此可以用一次请求代替逐个工作区轮询：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "groups": [
      {
        "workspace": { "id": "wd_my-app_a1b2c3d4e5f6", "cwd": "/Users/dev/my-app" },
        "sessions": [ { "id": "session_...", "workspace": { "id": "wd_my-app_a1b2c3d4e5f6", "cwd": "/Users/dev/my-app" }, "meta": { "title": "Fix the login page", "last_prompt": "adjust the button spacing", "created_at": 1787000000000, "updated_at": 1787000100000, "archived": false, "archived_at": null }, "activity": { "status": "idle", "model": "kimi-for-coding" } } ],
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

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `groups[].workspace` | object | 分组所属的工作区 |
| `groups[].sessions` | array | 该工作区按请求的 `sort` 排序的前 `group.page_size` 条会话 |
| `groups[].total` | integer | 该工作区匹配过滤条件的会话总数，可用作「查看全部」入口 |
| `total` | integer | 分组视图下为组数 |

只有至少有一条匹配会话的工作区才会出现。组之间按组内第一条会话的排序键排序，相同时按工作区 id 排序。`page` 与 `page_token` 按组翻页，令牌的指纹绑定规则相同，并且同时覆盖 `view` 与分组参数，翻页途中改变它们同样返回 `40922`。

- `40001`：未开启分组视图时传入 `group.page_size`；`fields=id,archived` 与 `include=git` 同时传入；`page` 与 `page_token` 同时传入
- `40922`：翻页途中查询条件（含投影、`view` 与分组参数）与 `page_token` 不符

#### `POST /api/v2/sessions:archive`

批量归档会话，面向会话管理页。仍在线的会话走完整的生命周期；未加载的冷会话直接改写磁盘上的元数据，不会被加载。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `ids` | body | array | 必填。会话 id 数组，不能为空，去重后不超过 5000 条 |

只有请求体校验失败才会让整个请求失败，其他错误按条返回：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `results` | array | 每个 id 的结果，保持输入顺序。成功项为 `{ id, ok }`，失败项为 `{ id, ok: false, error }`。不存在的 id 在自己的条目里报 `40401` |
| `succeeded` | integer | 成功条数 |
| `failed` | integer | 失败条数 |

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

- `40001`：请求体校验失败

#### `POST /api/v2/sessions:restore`

批量恢复已归档的会话。请求体、在线与冷会话的处理方式、按条返回的结果和错误码都与 [`POST /api/v2/sessions:archive`](#post-api-v2-sessions-archive) 相同。

## 对话

这部分接口读取对话历史、提交提示词、答复审批与提问。对话的实时推送走 WebSocket，见 [会话与对话](./server-api-conversation.md)。

### 消息与轮次

`messages` 接口分页返回 main agent 扁平化的消息历史；`turns` 接口按轮次与条目分页返回某个 Agent 的对话，与 WebSocket 实时推送的 [轮次](./server-api-conversation.md#轮次) 是同一套模型。更早的历史用这些接口读取，订阅后收到的 `turns` 帧之后的内容都走 WebSocket。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/v1/sessions/{session_id}/messages` | 消息分页（`before_id` / `after_id` / `role`） |
| `GET /api/v1/sessions/{session_id}/messages/{message_id}` | 读取单条消息 |
| `GET /api/v1/sessions/{session_id}/agents/{agent_id}/turns` | 某个 Agent 的轮次分页（`before_ordinal` / `page_size`） |

#### `GET /api/v1/sessions/{session_id}/messages`

分页返回 main agent 的消息历史（扁平化的上下文转录），最新的在前。游标分页遵循 [分页](./server-api.md#分页) 约定。会话为冷会话时，读取历史会恢复该会话。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | 必填。会话 id |
| `before_id` | query | string | 只保留早于该消息 id 的消息。与 `after_id` 互斥 |
| `after_id` | query | string | 只保留晚于该消息 id 的消息。与 `before_id` 互斥 |
| `page_size` | query | integer | 1–100。默认 `50` |
| `role` | query | string | 只保留一种角色：`user` / `assistant` / `tool` / `system`。过滤在分页切片之后进行，因此过滤后的一页可能少于 `page_size` 条而 `has_more` 仍为 `true`，需要一直翻到 `has_more` 为 `false` |

成功时 `data` 为 `{ items, has_more }`，`items` 的每项是消息对象：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 消息 id |
| `session_id` | string | 会话 id |
| `role` | string | 消息角色 |
| `content` | array | 内容块数组，格式同 [提示词内容块](#post-api-v1-sessions-session-id-prompts)，类型包括 `text`、`tool_use`、`tool_result`、`image`、`video`、`file`、`thinking` |
| `created_at` | string | 创建时间 |
| `prompt_id` | string | 可选 |
| `parent_message_id` | string | 可选 |
| `metadata` | object | 可选 |

- `40001`：校验失败，例如 `before_id` 与 `after_id` 同时传入
- `40401`：会话不存在

#### `GET /api/v1/sessions/{session_id}/messages/{message_id}`

按 id 从同一份历史中读取单条消息。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | 必填。会话 id |
| `message_id` | path | string | 必填。消息 id |

成功时 `data` 为消息对象，结构见 [`GET /api/v1/sessions/{session_id}/messages`](#get-api-v1-sessions-session-id-messages)。

- `40401`：会话不存在
- `40403`：该会话中不存在此 id 的消息

#### `GET /api/v1/sessions/{session_id}/agents/{agent_id}/turns`

返回某个 Agent 的一页轮次，最旧的在前，轮次与条目的结构见 [轮次](./server-api-conversation.md#轮次) 和 [条目](./server-api-conversation.md#条目)。会话或已结束的 subagent 不在内存中时，读取会将其载入。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | 必填。会话 id |
| `agent_id` | path | string | 必填。Agent id，不含路径分隔符 |
| `before_ordinal` | query | integer | 只保留 `ordinal` 小于该值的轮次。不要求存在该 `ordinal` 的轮次（例如撤销之后）。默认返回最新的一页 |
| `page_size` | query | integer | 1–200 个轮次。默认 `50` |

成功时 `data` 为 `{ turns, has_more }`。`has_more` 表示还有更早的轮次，把这一页第一轮的 `ordinal` 作为 `before_ordinal` 传入即可读取。

一页不超过 1 MiB。放不下 `page_size` 个轮次时，最旧的轮次不放入，`has_more` 为 `true`；最新的一轮总会放入。最新一页包含正在运行的轮次（如有）及其到此刻为止的内容。

每一页是请求开始时的快照，可能包含之后被撤销的轮次。收到 `turns.removed` 帧后，丢弃在它之前发出的分页请求的结果。

任务、Agent 的运行状态与设置、上下文用量、目标、待办和待处理交互都不属于轮次。它们分别通过 WebSocket 的 `task`、`agent`、`usage`、`goal`、`todo`、`interaction` 帧到达，见 [任务](./server-api-conversation.md#任务)、[Agent 状态](./server-api-conversation.md#agent-状态) 和 [审批与提问](./server-api-conversation.md#审批与提问)。

- `40001`：校验失败
- `40401`：会话或 Agent 不存在

### 提示词

提示词是一次用户输入的单位。提交的提示词进入会话 main agent（或指定 Agent）的队列；排队中的提示词可以插入进行中的轮次，运行中或排队中的提示词可以中止。轮次进度通过 WebSocket 推送（见 [实时更新](./server-api-conversation.md#实时更新)），不经过这些接口。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/v1/sessions/{session_id}/prompts` | 进行中与排队中的提示词 |
| `POST /api/v1/sessions/{session_id}/prompts` | 提交提示词（内容块数组，可带模型、权限模式等覆盖项） |
| `POST /api/v1/sessions/{session_id}/steer` | 直接把消息内容插入进行中的轮次 |
| `POST /api/v1/sessions/{session_id}/prompts:steer` | 把排队的提示词插入进行中的轮次 |
| `POST /api/v1/sessions/{session_id}/prompts/{prompt_id}:abort` | 中止运行中或排队中的提示词 |
| `POST /api/v1/sessions/{session_id}/prompts/{prompt_id}:steer` | 插入单条排队的提示词 |

#### `GET /api/v1/sessions/{session_id}/prompts`

读取 main agent 的提示词队列快照，其他 Agent 的队列不在其中。队列变化没有 WebSocket 推送，需要最新状态时重新读取。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | 必填。会话 id |

成功时 `data` 为 `{ active, queued }`：`active` 是运行中的提示词，空闲时为 `null`；`queued` 按顺序列出等待中的提示词。每个提示词对象为：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `prompt_id` | string | 提示词 id |
| `user_message_id` | string | 对应的用户消息 id |
| `status` | string | `running` / `queued` / `blocked` / `failed` |
| `content` | array | 内容块数组，格式同 `POST /api/v1/sessions/{session_id}/prompts` 接受的内容块 |
| `created_at` | string | 创建时间 |
| `metadata` | object | 提交或激活 Skill 时附带的 `metadata`，可选 |

- `40401`：会话不存在

#### `POST /api/v1/sessions/{session_id}/prompts`

向会话提交一条用户提示词。响应不等待轮次执行完。

目标 Agent 空闲、队列为空，并且不在撤销、手动压缩或 fork 的过程中时（只有 fork 一个空闲的 Agent 才会让它进入这种状态），提示词立即开始一轮，响应等到轮次开始（`status` 为 `running`）才返回。其他情况下提示词进入队列，响应立即返回，`status` 为 `queued`。撤销、压缩或 fork 期间提交的提示词同样排队，不会被拒绝。见 [开始执行还是排队](./server-api-conversation.md#开始执行还是排队)。

服务端先校验媒体引用，然后按 `model`、`thinking`、`permission_mode`、`swarm_mode`、`disabled_tools` 的顺序把覆盖项应用到目标 Agent，最后让提示词入队。覆盖项在提示词被接受时就生效，不论提示词是否排队，并且之后一直保留。`permission_mode` 只改变目标 Agent，不像 [profile 接口](#post-api-v1-sessions-session-id-profile) 那样同步到所有 Agent。

提供 `skills` 时，提示词以打包的 Skill 激活方式运行，而不是作为普通用户提示词。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | 必填。会话 id |
| `content` | body | array | 必填。非空的内容块数组，变体见下文 |
| `agent_id` | body | string | 目标 Agent。默认为 main agent |
| `prompt_id` | body | string | 客户端选定的提示词 id，让提交幂等，带 `skills` 时同样适用。规则见下文 |
| `skills` | body | array | 打包的 Skill 激活，至少 1 项，每项为 `{ name, path?, args? }`。每个 Skill 必须存在且可由用户激活。`path` 用于选择会话 Skill 目录中的同名变体 |
| `model` | body | string | 要切换到的模型别名 |
| `thinking` | body | string | Thinking 强度等级 |
| `permission_mode` | body | string | `manual` / `yolo` / `auto` |
| `swarm_mode` | body | boolean | 进入或退出 swarm 模式 |
| `disabled_tools` | body | array | 要为会话禁用的工具名 |
| `metadata` | body | object | 客户端自定义元数据，随提示词保存，并在提示词对象的 `metadata` 中返回 |

schema 还接受 `plan_mode`、`goal_objective` 和 `goal_control`，但提交接口目前不会应用它们。

`prompt_id` 的幂等规则如下，流程见 [重试和幂等](./server-api-conversation.md#重试和幂等)：

- 服务端用接口加完整请求体作为请求指纹，键的顺序不影响指纹。同一个 id 配上不同的指纹时返回 `40927`。
- `/prompts`、`/steer` 和 [`skills/{skill_name}:activate`](#post-api-v1-sessions-session-id-skills-skill-name-activate) 在同一个会话中共用一张记录表，同一个 id 用在另一个接口上也返回 `40927`。
- 指纹相同的重发返回第一次的结果，第一次还在处理时等它完成。重发不会再次应用覆盖项。
- 第一次请求在入队之前失败时，重发按新请求处理；在入队之后失败时，重发返回同样的错误。
- 记录只保存在内存中，每个会话最多保留 256 条，超出时淘汰最早已结束的记录。服务重启或会话被删除后记录清空。
- 不带 `prompt_id` 的请求没有幂等保护。

`content` 的每个内容块是按 `type` 区分的对象：

| 内容块 | 字段 | 说明 |
| --- | --- | --- |
| `text` | `text` | 纯文本 |
| `image` / `video` | `source` | 媒体输入，`source` 的形式见下文 |
| `file` | `file_id`、`name`、`media_type`、`size` | 通过 [`POST /api/v1/files`](./server-api-service.md#文件上传) 上传的文件附件 |

`source` 取以下形式之一：

- `{ kind: "url", url, id? }`
- `{ kind: "base64", media_type, data }`
- `{ kind: "file", file_id }`：来自 `POST /api/v1/files` 的上传
- `{ kind: "session_media", file_id }`：已提交到本会话的媒体

schema 还接受共享消息格式中的 `tool_use`、`tool_result` 和 `thinking` 内容块，但它们在用户提示词中没有意义。`file_id` 引用未知、或与内容块的媒体 kind 不匹配时，服务端在创建提示词和应用任何覆盖项之前就拒绝请求。

成功时 `data` 为被接受的提示词，结构见 [`GET /api/v1/sessions/{session_id}/prompts`](#get-api-v1-sessions-session-id-prompts) 的提示词对象。立即开始的提示词也可能在轮次开始之前就结束：hook 拒绝了该提示词时 `status` 为 `blocked`；提交在轮次开始前失败时为 `failed`，例如提示词 hook 出错或附件无法准备。

- `40001`：校验失败，例如未知的 `model`、模型不支持的 `thinking` 强度，或带了 `profile` 字段（Agent 档案只能在创建会话时指定）
- `40110`：尚未配置供应商（需要先完成登录）
- `40111`：解析出的供应商没有凭据（`details.provider_id`）
- `40112`：供应商的凭据被拒绝（`details.provider_id`）
- `40113`：模型无法解析（已知时带 `details.model_id` / `details.provider_id`），或会话没有模型时只设置了 `thinking`、没有同时设置 `model`
- `40401`：会话不存在
- `40407`：引用的 `file_id` 不存在，或与内容块的媒体 kind 不匹配
- `40415`：某个 `skills` 条目指向未知的 Skill
- `40912`：Skill 存在，但无法由用户激活
- `40927`：`prompt_id` 已被另一个请求使用

#### `POST /api/v1/sessions/{session_id}/steer`

直接把消息内容插入进行中的轮次。只需一次请求，不必先提交提示词再按 id steer。

目标 Agent 没有正在运行的轮次时，行为与普通提交相同。有正在运行的轮次时，响应等到消息在下一个插话点真正插入后才返回；该轮先结束时，响应等到接续的轮次开始。见 [插话](./server-api-conversation.md#插话)。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | 必填。会话 id |

请求体字段与 [`POST /api/v1/sessions/{session_id}/prompts`](#post-api-v1-sessions-session-id-prompts) 相同，包括 `content`、`agent_id`、`prompt_id`、`skills`、`model`、`thinking`、`permission_mode`、`swarm_mode`、`disabled_tools` 和 `metadata`。媒体引用与打包 Skill 也复用提示词提交的校验和准备流程。

覆盖项的应用顺序与生效方式、`prompt_id` 的幂等规则都与提示词提交相同。

成功时 `data` 与提示词提交返回的被接受提示词结构相同。错误也与提示词提交一致，包括校验、媒体、环境和幂等错误。

#### `POST /api/v1/sessions/{session_id}/prompts:steer`

把排队的提示词插入进行中的轮次，让运行中的轮次立即消费它们，而不是等当前轮次运行结束。

只在 main agent 有正在运行的轮次时可用。没有正在运行的轮次时，即使提示词在队列中，也返回 `40402`。多个 id 整体校验：任一 id 不在队列中或重复出现时，不插入任何提示词。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | 必填。会话 id |
| `prompt_ids` | body | array | 必填。非空的排队提示词 id 数组 |

成功时 `data` 为 `{ steered: true, prompt_ids }`。

- `40001`：校验失败
- `40401`：会话不存在
- `40402`：main agent 没有正在运行的轮次，或有 id 不在队列中、重复出现

#### `POST /api/v1/sessions/{session_id}/prompts/{prompt_id}:abort`

中止 main agent 的一条提示词：

- 提示词正在运行时，效果与 [`:abort`](#post-api-v1-sessions-session-id-abort) 停止当前轮次相同。
- 提示词在队列中时，把它移出队列，不产生轮次，也不发送任何帧。
- 提示词已结束或 id 未知时，返回 `40402`。

本接口与下面的 `:steer` 走同一条路由 `POST /api/v1/sessions/{session_id}/prompts/{tail}`：`{tail}` 解析为 `{prompt_id}:{action}`，动作缺失或未知时返回 `40001`（`unsupported action: ...`）。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | 必填。会话 id |
| `prompt_id` | path | string | 必填。提示词 id |

成功时 `data` 为 `{ aborted: true }`。

- `40401`：会话不存在
- `40402`：提示词已结束，或不存在该 id 的提示词

#### `POST /api/v1/sessions/{session_id}/prompts/{prompt_id}:steer`

把单条排队的提示词插入进行中的轮次，是 [`POST /api/v1/sessions/{session_id}/prompts:steer`](#post-api-v1-sessions-session-id-prompts-steer) 的单提示词形式。同样只在 main agent 有正在运行的轮次时可用。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | 必填。会话 id |
| `prompt_id` | path | string | 必填。排队中的提示词 id |

成功时 `data` 为 `{ steered: true, prompt_ids: [prompt_id] }`。

- `40401`：会话不存在
- `40402`：main agent 没有正在运行的轮次，或没有该 id 的排队提示词

### 审批与提问

审批与提问是会话中等待用户答复的两类交互：审批为工具调用请求许可，提问请求带标签选项的结构化输入。待处理的交互通过 WebSocket 的 `interaction` 帧下发（见 [审批与提问](./server-api-conversation.md#审批与提问)），客户端用下面的接口答复。

| 方法与路径 | 说明 |
| --- | --- |
| `POST /api/v1/sessions/{session_id}/interactions/{interaction_id}` | 答复待处理的审批或提问 |

#### `POST /api/v1/sessions/{session_id}/interactions/{interaction_id}`

答复一个待处理的交互，让等待中的工具调用继续。请求体的 `kind` 必须与交互的类型一致。

第一个答复生效，之后的答复返回 `40902`。服务端只记住 60 秒内结束的交互，且最多 256 个；超出之后再答复返回 `40404`。客户端应把这两个错误码都当作交互已经结束处理。流程见 [审批与提问](./server-api-conversation.md#审批与提问)。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | 必填。会话 id |
| `interaction_id` | path | string | 必填。`interaction` 帧中的 `interaction_id` |
| `kind` | body | string | 必填。`approval` 或 `question` |

答复审批时使用这些字段：

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `decision` | body | string | 必填。`approved` / `rejected` / `cancelled` |
| `scope` | body | string | 配合 `approved` 使用。唯一取值 `session`，让该审批规则在会话的剩余时间内被记住 |
| `feedback` | body | string | 回传给 Agent 的自由文本反馈 |
| `selected_label` | body | string | 请求提供了带标签的选项（例如计划审阅）时，所选选项的标签 |

答复提问时，`answers` 和 `dismissed` 二选一：

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `answers` | body | object | 提问条目 `id`（来自帧中的 `request.questions`）到答案对象的映射，答案变体见下表 |
| `dismissed` | body | boolean | 为 `true` 时忽略该提问，不作回答 |
| `method` | body | string | 答案的产生方式：`enter` / `space` / `number_key` / `click` |

每个答案是按 `kind` 区分的对象：

| `kind` | 字段 | 说明 |
| --- | --- | --- |
| `single` | `option_id` | 选中的单个选项 |
| `multi` | `option_ids` | 选中的多个选项，至少 1 个 |
| `other` | `text` | 自由文本回答 |
| `multi_with_other` | `option_ids`、`other_text` | 选项加自由文本 |
| `skipped` | — | 跳过了该条目 |

服务端不校验提问的答案：未知的选项 id 原样作为答案文本传给 Agent，未知的提问条目 id 原样作为键。

成功时 `data` 为 `{ outcome, ended_at }`：审批的 `outcome` 为 `approved` / `rejected` / `cancelled`，提问的为 `answered` / `dismissed`。订阅者同时会收到这个交互的最后一帧 `interaction`。

- `40001`：校验失败（`details` 列出每个字段），或 `kind` 与交互的类型不一致
- `40401`：会话不存在
- `40404`：会话中没有该 id 的交互，包括已结束超过 60 秒或超出记录上限的交互
- `40902`：交互已经结束
