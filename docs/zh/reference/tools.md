# 内置工具

内置工具是 Kimi Code CLI 随核心引擎一起提供的工具集，无需安装 MCP server 即可使用。Agent 在每次对话中会根据任务需要自动选择并调用这些工具；用户也可以通过权限审批界面查看每次工具调用的细节。

与 MCP 工具相比，内置工具由运行时直接管理，生命周期与会话绑定，无需外部进程。两者都遵循统一的审批机制：**只读类工具**（如 `Read`、`Grep`、`Glob`、`WebSearch` 等）默认自动放行，**写入与执行类工具**（如 `Write`、`Edit`、`Bash`、`TaskStop`）默认需要用户审批。在 YOLO 模式下，普通工具调用的审批会被跳过，但 Plan 模式下的退出审批不受影响。

## 文件类

文件类工具负责读取、写入、搜索本地文件系统，是代码分析和修改任务的基础工具。

| 工具 | 默认审批 | 说明 |
| --- | --- | --- |
| `Read` | 自动放行 | 读取文本文件内容 |
| `Write` | 需审批 | 创建或覆盖文件 |
| `Edit` | 需审批 | 精确字符串替换 |
| `Grep` | 自动放行 | 基于 ripgrep 的全文搜索 |
| `Glob` | 自动放行 | 按 glob 模式查找文件 |
| `ReadMediaFile` | 自动放行 | 读取图片或视频文件 |

**`Read`** 接受文件路径（`path`）以及可选的 `line_offset`（起始行号，支持负数从末尾倒数）和 `n_lines`（读取行数上限）。单次最多返回 1000 行或 100 KB，超出部分会附带截断提示。如果文件是图片或视频，工具会提示改用 `ReadMediaFile`。

**`Write`** 接受 `path`、`content` 和可选的 `mode`（`overwrite` 或 `append`，默认覆盖）。父目录必须已存在；`append` 模式将内容追加到文件末尾，不自动添加换行。

**`Edit`** 接受 `path`、`old_string`（要替换的精确文本）和 `new_string`（替换后的文本）。默认只替换唯一一处匹配，若文件中存在多处相同内容会报错并提示使用 `replace_all: true`。`old_string` 与 `new_string` 不能相同。

**`Grep`** 调用 ripgrep 搜索文件内容，支持正则表达式（`pattern`）、搜索路径（`path`）、文件类型过滤（`type`，如 `ts`、`py`）、glob 过滤（`glob`）和输出模式（`output_mode`：`files_with_matches` / `content` / `count_matches`，默认 `files_with_matches`）。`content` 模式支持 `-A`、`-B`、`-C` 上下文行参数与 `-i`（忽略大小写）、`-n`（行号，默认 true）、`multiline`（跨行匹配）。所有模式均支持 `offset` + `head_limit` 分页，`head_limit` 默认 250、传 0 表示不限。`files_with_matches` 模式的结果按文件最近修改时间倒序排列；其他模式保持 ripgrep 原始输出顺序。`.env`、私钥、`.aws/credentials`、`.gcp/credentials` 等敏感文件会被自动过滤；`include_ignored=true` 可同时搜索被 `.gitignore` 等忽略的文件，但敏感文件仍保持过滤。

**`Glob`** 按 glob 模式（`pattern`）在指定目录（`path`，默认为工作目录）中匹配文件，结果按修改时间倒序排列，最多返回 1000 条。可选参数 `include_dirs`（默认 true）控制是否返回目录条目。纯通配符模式（如 `**`、`**/*`）会被拒绝并提示添加字面锚点；包含花括号扩展（`{a,b,c}`）的模式同样会被拒绝——底层 glob 引擎把 `{`、`}` 当字面量处理，这类模式会静默匹配 0 个文件。

**`ReadMediaFile`** 将图片或视频文件以多模态内容发送给模型，仅接受 `path`。文件大小上限为 100 MB。工具是否可用取决于当前模型的视觉能力（`image_in` / `video_in`）。

## Shell

| 工具 | 默认审批 | 说明 |
| --- | --- | --- |
| `Bash` | 需审批 | 执行 Shell 命令 |

**`Bash`** 是最通用也是权限要求最严格的工具。它接受 `command`（必填）以及可选的 `cwd`（工作目录）、`timeout`（毫秒）、`description`（后台任务描述，`run_in_background=true` 时必填）、`run_in_background`（是否以后台任务运行）和 `disable_timeout`（后台任务是否取消超时）。前台 `timeout` 默认 60 秒、最长 5 分钟；后台 `timeout` 默认 10 分钟、最长 10 分钟。

前台模式下 `Bash` 会阻塞当前轮次，直到命令结束或超时；后台模式会立即返回任务 ID。后台任务默认 10 分钟后超时；如果确实需要让任务不受超时限制，可以设置 `disable_timeout=true`。任务结束、失败或被停止时会自动通知 Agent 继续处理，过程中也可通过 `TaskOutput` 主动查看结果。stdin 始终被关闭，交互式命令会立即收到 EOF。两阶段终止策略（SIGTERM → 5 秒宽限期 → SIGKILL）确保超时后进程能可靠结束。Windows 平台下默认使用 Git Bash 作为 shell。

## 网络类

| 工具 | 默认审批 | 说明 |
| --- | --- | --- |
| `WebSearch` | 自动放行 | 网络搜索 |
| `FetchURL` | 自动放行 | 获取指定 URL 的内容 |

**`WebSearch`** 接受 `query`（搜索词）和可选的 `limit`（返回结果数，1–20，默认 5）及 `include_content`（是否返回网页正文，默认 false，开启后消耗 token 较多）。该工具需要宿主提供搜索实现，未注入实现时不会出现在工具列表中。

**`FetchURL`** 接受单个 `url` 参数，返回页面内容。对于 HTML 页面，宿主会提取正文文章（`extracted`）而非返回完整 HTML；纯文本或 Markdown 页面则直接透传（`passthrough`）。同样需要宿主注入实现。

## Plan 模式

| 工具 | 默认审批 | 说明 |
| --- | --- | --- |
| `EnterPlanMode` | 自动放行 | 进入 Plan 模式 |
| `ExitPlanMode` | 自动放行（需用户确认计划） | 退出 Plan 模式并提交计划 |

Plan 模式是一种受约束的工作状态：进入后 `Write` 与 `Edit` 工具被收紧——只允许写入当前的计划文件，其它路径会被阻断；`TaskStop` 也被完全拦截。其余工具（包括 `Bash`）仍按当前权限规则处理，因此通过 `Bash` 调用的命令理论上仍可能修改文件，是否放行取决于当前的审批策略。

**`EnterPlanMode`** 不接受任何参数，进入成功后返回工作流指引，包括计划文件路径（如果宿主提供了的话）。

**`ExitPlanMode`** 读取当前计划文件内容，将计划呈现给用户审批后退出 Plan 模式。可选参数 `options` 允许 Agent 提供 1–3 个备选方案（每项含 `label` 与 `description`，`label` 最长 80 字符），供用户在审批时选择；标签需互不重复，且不能使用 `Approve`、`Reject`、`Reject and Exit`、`Revise` 这些保留词（系统用它们标记审批结果）。用户批准后，所有工具重新可用；若用户要求修改，Agent 将继续留在 Plan 模式中。

## 状态管理

| 工具 | 默认审批 | 说明 |
| --- | --- | --- |
| `TodoList` | 自动放行 | 管理任务待办列表 |
| `get_goal` | 自动放行 | 读取当前持久化 goal |
| `create_goal` | 自动放行 | 创建持久化 goal |
| `update_goal` | 自动放行 | 将当前 goal 标记为完成或阻塞 |

**`TodoList`** 用于在多步骤操作中维护一份可见的子任务列表，状态存储在 Agent 会话内。`todos` 参数接受一个数组，每项含 `title`（标题）和 `status`（`pending` / `in_progress` / `done`）；省略 `todos` 则仅查询当前列表，传入空数组则清空列表。

**`get_goal`** 返回当前 goal 及其状态、token 用量、活跃耗时和可选 token 预算。**`create_goal`** 接受 `objective` 和可选的正整数 `token_budget`；它只应用于用户明确请求的 goal 模式，并会在已有 goal 时拒绝创建。**`update_goal`** 仅在目标完全完成后接受 `complete`。仅当同一阻塞条件连续出现至少三个 goal turn，且继续取得实质进展需要用户输入或外部状态变化时，才接受 `blocked`。

## 协作类

协作类工具负责 Agent 间协作、用户交互和 Skill 调用。

| 工具 | 默认审批 | 说明 |
| --- | --- | --- |
| `Agent` | 自动放行 | 派生子 Agent 执行子任务 |
| `AskUserQuestion` | 自动放行 | 向用户提问以获取结构化输入 |
| `Skill` | 自动放行 | 调用已注册的 inline Skill |

**`Agent`** 用于将子任务委托给子 Agent 执行。必填参数为 `prompt`（完整任务描述）和 `description`（3–5 个词的简短说明，用于 UI 展示）。可选参数包括 `subagent_type`（Agent 类型，默认 `coder`）、`resume`（恢复已有 Agent 的 ID）、`run_in_background`（是否后台运行，默认 false）和 `timeout`（超时秒数，30–3600）。`subagent_type` 与 `resume` 互斥：恢复已有 Agent 时只通过 ID 寻址。前台 `timeout` 缺省表示不超时，子 Agent 运行至完成；后台 `timeout` 缺省时回落到 `config.toml` 的 `[background] agent_task_timeout_s`，该字段也未设置则无时间上限。前台模式下父 Agent 会等待子 Agent 完成再继续；后台模式立即返回任务 ID，完成时通过合成 user 消息自动回到主 Agent，无需轮询。子 Agent 体系细节参见 [子 Agent](../customization/agents.md)。

**`AskUserQuestion`** 以结构化多选题的形式向用户提问，适用于需要用户消歧或选择方案的场景。`questions` 参数接受 1–4 道题，每道题需提供 `question`（问题文本，以 `?` 结尾）、`options`（2–4 个选项，每项含 `label` 和 `description`）以及可选的 `header`（最多 12 字符的短分类标签，如 `Auth`、`Style`）和 `multi_select`（是否多选，默认 false）。系统会自动附加「其他」选项，无需在 `options` 中手工提供。若宿主未实现交互式提问能力，本工具会返回失败提示，Agent 应改为直接在文本回复中向用户提问。

**`Skill`** 允许 Agent 主动调用已注册的 inline 类型 Skill。接受 `skill`（Skill 名称）和可选的 `args`（附加参数文本）。只有 `type = "inline"` 的 Skill 能通过此工具调用；其他类型（如 `prompt`、`flow`）以及在 frontmatter 中设置了 `disableModelInvocation: true` 的 Skill 会被拒绝。为防止递归死循环，Skill 嵌套调用深度上限为 3 层。Skill 体系细节参见 [Skills](../customization/skills.md)。

## 后台任务

后台任务工具用于管理通过 `Bash` 或 `Agent` 启动的后台任务。后台任务进入完成、失败、停止或丢失等终止状态时，会把状态和末尾输出自动送回 Agent；如果只想提前检查进度，再使用 `TaskOutput`。

| 工具 | 默认审批 | 说明 |
| --- | --- | --- |
| `TaskList` | 自动放行 | 列出后台任务 |
| `TaskOutput` | 自动放行 | 查看后台任务的输出 |
| `TaskStop` | 需审批 | 停止正在运行的后台任务 |

**`TaskList`** 返回后台任务列表，每条记录包含任务 ID、状态、命令、描述和 PID。可选参数 `active_only`（默认 true，仅列出运行中的任务）和 `limit`（最多返回条数，默认 20，取值范围 1–100）。已进入终止状态的任务还会附带 `exit_code`，被 `TaskStop` 显式终止的任务会附带 `reason`。

**`TaskOutput`** 根据 `task_id` 返回指定任务的状态与输出。内联预览最多包含最近 32 KB 的内容；完整日志保存在磁盘上，工具会一并返回 `output_path` 并提示通过 `Read` 分页读取（建议每页约 300 行）。可选 `block`（默认 false）和 `timeout`（等待秒数，默认 30，取值范围 0–3600）参数可用于等待任务完成后再返回。返回结构中 `retrieval_status` 取 `success` / `timeout` / `not_ready`；任务因超时被外部 deadline 中止时会附带 `timed_out: true` 与 `terminal_reason: timed_out`，被 `TaskStop` 显式终止时会附带 `stop_reason` 与 `terminal_reason: stopped`。

**`TaskStop`** 接受 `task_id` 和可选的 `reason`（停止原因，默认 `Stopped by TaskStop`）。对已处于终止状态的任务也能安全调用，会直接返回当前状态而不报错。

## 定时任务

定时任务工具允许 Agent 把一段 prompt 在未来某个时间重新注入到当前会话中，既可以是一次性的提醒，也可以是按 cron 周期触发的任务（定期巡检、每日报表、部署监控等）。计划绑定到会话：同一会话执行 `kimi resume` 后仍然有效，但不会带入全新的会话。单个会话最多保留 50 个生效中的定时任务。设置 `KIMI_DISABLE_CRON=1` 可整体禁用该功能，详见 [环境变量](../configuration/env-vars.md#运行时开关)。

| 工具 | 默认审批 | 说明 |
| --- | --- | --- |
| `CronCreate` | 需审批 | 安排一个在未来时刻触发的 prompt |
| `CronList` | 自动放行 | 列出已安排的定时任务 |
| `CronDelete` | 需审批 | 取消已安排的定时任务 |

**`CronCreate`** 接受 `cron`（用户本地时区下标准的 5 段 cron 表达式：`minute hour day-of-month month day-of-week`）、`prompt`（触发时要重新注入的文本，UTF-8 编码上限 8 KB）以及可选的 `recurring`（默认 `true`；传 `false` 表示一次性提醒，触发后自动删除）。工具会校验表达式在未来 5 年内至少有一次触发，并拒绝那些下次触发会落在 350 天之后的一次性任务（通常意味着指定的日/月在今年已经过去）。成功时返回 8 位 16 进制 `id`、人类可读的 `humanSchedule`（如 `every 5 minutes`）、`recurring` 标记，以及 `nextFireAt`（下次抖动后触发时间的 ISO 时间戳）。审批范围与 `(cron, prompt, recurring)` 这组精确载荷绑定——一次性批准不会授权后续的其它计划。`CronCreate` 在 Plan 模式下同样会被拦截。

为了避免整批用户在整点同时触发，调度器会按任务 id 做确定性抖动：周期任务向后偏移 `min(周期的 10%, 15 分钟)`；一次性任务若恰好落在 `:00` 或 `:30`，则向前提前最多 90 秒。如果调度器错过了若干理想触发时刻（笔记本合盖、长时间运行的轮次等），唤醒后只会触发一次——prompt 会被包裹在 `<cron-fire>` 信封里并附带 `coalescedCount`，让 Agent 按「我错过了 N 次检查，只看最新状态」处理，而不是把 prompt 重复执行 N 次。周期任务存活超过 7 天后会以 `stale="true"` 的信封做最后一次触发，随后系统自动删除；想继续保留这条计划时，直接再调用一次 `CronCreate` 即可。一次性任务永远不会被标记为 stale。

**`CronList`** 是只读工具，不接受任何参数。它为每个生效中的任务返回一条记录，字段包括 `id`、`cron`、`humanSchedule`、JSON 编码的 `prompt`（出于上下文窗口安全考虑，截断到约 200 UTF-8 字节）、`nextFireAt`（抖动后调度器实际会触发的 ISO 时间戳）、`recurring`、`ageDays` 和 `stale`。记录之间用一行 `---` 分隔，按调度时间排列。空列表返回 `cron_jobs: 0\nNo cron jobs scheduled.`。上下文压缩后想要回忆挂起的任务，或者要找 `CronDelete` 所需的 `id`，都可以用这个工具。

**`CronDelete`** 只接受一个 `id`——即 `CronCreate` 返回或 `CronList` 中展示的 8 位 16 进制值。对周期任务，未来所有触发立即停止；对一次性任务，挂起的那次触发会被取消。已经触发过的一次性任务会自动删除，因此对已触发过的一次性任务再次调用 `CronDelete` 会返回 `No cron job with id ...`——这是提示模型应该先调用 `CronList` 而不是用同一个 id 重试。删除不可撤销，需要还原时只能再次 `CronCreate`。`CronDelete` 在 Plan 模式下同样会被拦截。
