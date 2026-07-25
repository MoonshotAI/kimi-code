# 内置工具

内置工具是 Kimi Code CLI 随核心引擎提供的工具集，无需安装 MCP server 即可使用。Agent 在每次对话中会根据任务需要自动选择并调用这些工具；用户可以通过权限审批界面查看每次工具调用的细节。

与 MCP 工具相比，内置工具由运行时直接管理，生命周期与会话绑定，无需外部进程。两者都遵循统一的审批机制：**只读类工具**（如 `Read`、`Grep`、`Glob`）默认自动放行，**写入与执行类工具**（如 `Write`、`Edit`、`Bash`）默认需要用户审批。YOLO 模式下普通工具调用的审批会被跳过，但 Plan 模式下的退出审批不受影响。

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

**`Write`** 接受 `path`、`content` 和可选的 `mode`（`overwrite` 或 `append`，默认覆盖）。缺失的父目录会自动创建；`append` 模式将内容追加到文件末尾，不自动添加换行。

**`Edit`** 接受 `path`、`old_string`（要替换的精确文本）和 `new_string`（替换后的文本）。默认只替换唯一一处匹配，若文件中存在多处相同内容会报错并提示使用 `replace_all: true`。`old_string` 与 `new_string` 不能相同。

**`Grep`** 调用 ripgrep 搜索文件内容，支持正则表达式（`pattern`）、搜索路径（`path`）、文件类型过滤（`type`，如 `ts`、`py`）、glob 过滤（`glob`）和输出模式（`output_mode`：`files_with_matches` / `content` / `count_matches`，默认 `files_with_matches`）。`content` 模式支持上下文行（`-A`、`-B`、`-C`）、忽略大小写（`-i`）、行号（`-n`，默认 true）、跨行匹配（`multiline`）。所有模式支持 `offset` + `head_limit` 分页，`head_limit` 默认 250、传 0 表示不限。`.env`、私钥等敏感文件会被自动过滤；`include_ignored=true` 可搜索被 `.gitignore` 忽略的文件，但敏感文件仍保持过滤。

**`Glob`** 按 glob 模式（`pattern`）在指定目录（`path`，默认工作目录）中匹配文件，结果按修改时间倒序排列，最多返回 100 条。默认尊重 `.gitignore`、`.ignore` 和 `.rgignore`；设置 `include_ignored=true` 可包含构建产物等被忽略的文件，但敏感文件仍会被过滤。支持 `*.{ts,tsx}` 这类花括号模式，也允许宽泛通配符模式，但通常会在匹配上限处截断。

**`ReadMediaFile`** 将图片或视频以多模态内容发送给模型。它接受 `path`，以及 `region`、`full_resolution` 等可选的图片细节参数；文件大小上限为 100 MB。默认读图会按配置的模型限制压缩；如果自动压缩无法安全满足限制，工具会返回错误且不发送原图，并提示模型先创建更小的副本再读取。是否可用取决于当前模型的视觉能力（`image_in` / `video_in`）。

## Shell

| 工具 | 默认审批 | 说明 |
| --- | --- | --- |
| `Bash` | 需审批 | 执行 Shell 命令 |

**`Bash`** 是权限要求最严格的工具，也是功能最通用的工具。参数：

- `command`（必填）：要执行的 Shell 命令
- `cwd`：工作目录
- `timeout`：超时时间（毫秒）；前台默认 60 秒、最长 5 分钟
- `run_in_background`：是否以后台任务运行；后台默认 10 分钟超时（print 模式 `kimi -p` 下默认无超时）
- `description`：后台任务描述，`run_in_background=true` 时必填
- `disable_timeout`：后台任务是否取消超时限制

前台模式会阻塞当前轮次，直到命令结束或超时；命令运行期间，TUI 会把 stdout 和 stderr 流式显示在正在运行的 `Bash` 工具卡片中。前台命令超时后默认不会被终止，而是转为后台任务继续运行（受 600 秒默认后台超时约束）；如需恢复超时即终止的行为，将 `[background]` 的 [`bash_auto_background_on_timeout`](../configuration/config-files.md#background) 设为 `false`。600 秒的默认后台超时可通过 [`bash_task_timeout_s`](../configuration/config-files.md#background) 配置（`0` = 无超时），且在 print 模式（`kimi -p`）下默认无超时。后台模式立即返回任务 ID，任务结束时自动通知 Agent。stdin 始终被关闭，交互式命令会立即收到 EOF。任务被停止或后台超时时采用两阶段终止策略（SIGTERM → 5 秒宽限期 → SIGKILL），确保进程可靠结束。Windows 平台默认使用 Git Bash。

## 网络类

| 工具 | 默认审批 | 说明 |
| --- | --- | --- |
| `WebSearch` | 自动放行 | 网络搜索 |
| `FetchURL` | 自动放行 | 获取指定 URL 的内容 |

**`WebSearch`** 接受 `query`（搜索词）。需要宿主提供搜索实现，未注入时不会出现在工具列表中。

**`FetchURL`** 接受单个 `url` 参数，返回页面内容。对 HTML 页面，宿主会提取正文而非返回完整 HTML；纯文本或 Markdown 页面直接透传。同样需要宿主注入实现。

## Plan 模式

| 工具 | 默认审批 | 说明 |
| --- | --- | --- |
| `EnterPlanMode` | 自动放行 | 进入 Plan 模式 |
| `ExitPlanMode` | 自动放行（需用户确认计划） | 退出 Plan 模式并提交计划 |

Plan 模式是一种受约束的工作状态：进入后 `Write` 与 `Edit` 只允许写入当前的计划文件，`TaskStop` 被完全拦截。其余工具（包括 `Bash`）仍按当前权限规则处理。

**`EnterPlanMode`** 不接受任何参数，进入成功后返回工作流指引及计划文件路径。

**`ExitPlanMode`** 读取当前计划文件内容，将计划呈现给用户审批后退出 Plan 模式。可选参数 `options` 允许 Agent 提供 1–3 个备选方案（每项含 `label` 与 `description`，`label` 最长 80 字符），供用户在审批时选择；`label` 不能重复，也不能使用 `Approve`、`Reject`、`Reject and Exit`、`Revise` 等保留词。

## 状态管理

| 工具 | 默认审批 | 说明 |
| --- | --- | --- |
| `TodoList` | 自动放行 | 管理任务待办列表 |

**`TodoList`** 在多步骤操作中维护一份可见的子任务列表，状态存储在 Agent 会话内。`todos` 参数接受一个数组，每项含 `title` 和 `status`（`pending` / `in_progress` / `done`）；省略 `todos` 则仅查询当前列表，传入空数组则清空列表。

## 协作类

协作类工具负责 Agent 间协作、用户交互和 Skill 调用。

| 工具 | 默认审批 | 说明 |
| --- | --- | --- |
| `Agent` | 自动放行 | 派生子 Agent 执行子任务 |
| `AgentSwarm` | swarm mode 中自动放行，否则需审批 | 启动基于 item 的子 Agent，或恢复已有子 Agent |
| `AskUserQuestion` | 自动放行 | 向用户提问以获取结构化输入 |
| `Skill` | 自动放行 | 调用已注册的 inline Skill |

**`Agent`** 将子任务委托给子 Agent 执行。必填参数：`prompt`（完整任务描述）和 `description`（3–5 个词的简短说明）。可选参数：`subagent_type`（默认 `coder`）、`resume`（恢复已有 Agent 的 ID，与 `subagent_type` 互斥）、`run_in_background`（默认 false）和 `model`（`"secondary"` 表示 `[secondary_model] model` 配置的次主力模型，`"primary"` 表示主模型；resume 时无效；在 `kimi web` 或实验性 `kimi -p` 下启用次主力模型实验功能后可用，TUI 下被忽略）。显式 `model` 会覆盖所选 [Agent profile 的 `model_preference`](../customization/agents.md#agent-文件格式)；两者均未设置时，已配置的次主力模型为默认值，未配置时则继承调用方模型。Agent 任务默认 2 小时超时，可通过 `config.toml` 的 `[subagent] timeout_ms`（`0` = 无超时，或 `KIMI_SUBAGENT_TIMEOUT_MS` 环境变量）配置，且在 print 模式（`kimi -p`）下默认无超时。前台模式下父 Agent 等待子 Agent 完成再继续；后台模式立即返回任务 ID，完成时通过合成 User 消息自动回到主 Agent。多个前台 `Agent` 调用在同一步运行时，TUI 会合并展示，并为每个子 Agent 显示运行、等待、完成或失败状态以及已耗时长。子 Agent 体系细节见 [Agent 与子 Agent](../customization/agents.md)。

**`AgentSwarm`** 可以从共享的 `prompt_template` 和 `items` 数组启动子 Agent，也可以通过 `resume_agent_ids` 恢复已有子 Agent，或在一次调用中同时使用两者。模板必须包含 `{{item}}` 占位符；每个 item 会替换该占位符，并启动一个新的子 Agent。传入 `subagent_type` 可以指定整个 swarm 中所有新启动的子 Agent 使用的 profile；省略时默认使用 `coder`。传入 `model`（在 `kimi web` 或实验性 `kimi -p` 下启用次主力模型实验功能后可用，TUI 下被忽略）可以让新启动的子 Agent 运行在 `[secondary_model] model` 配置的次主力模型（`"secondary"`）或主模型（`"primary"`）上。这项显式选择会覆盖所选 [Agent profile 的 `model_preference`](../customization/agents.md#agent-文件格式)；两者均未设置时，已配置的次主力模型为默认值，未配置时则继承调用方模型。恢复的子 Agent 保持其原有模型。不传 `resume_agent_ids` 时，本工具要求至少 2 个 item；传入 `resume_agent_ids` 时，可以恢复 1 个或多个已有子 Agent。本工具最多支持 128 个子 Agent，会等待全部子 Agent 完成，并返回聚合报告。在 TUI 中，前台 swarm 会在输入框上方显示实时 `Agent swarm` 进度面板。若一次模型响应调用 `AgentSwarm`，该调用必须是该响应中的唯一工具调用；如需运行多个 swarm，应先调用一个 `AgentSwarm` 并等待结果，再调用下一个，若单个模板可以覆盖这些工作，也可以合并为一个 swarm。在 `manual` 权限模式下，未处于 swarm mode 时调用 `AgentSwarm` 会触发审批，除非已有权限规则允许；swarm mode 已开启时，`AgentSwarm` 本身会自动放行。权限规则只能按工具名 `AgentSwarm` 匹配，不支持 `AgentSwarm(swarm)` 这类参数模式。默认情况下，本工具会逐步提升并发且不设上限（立即启动 5 个子 Agent，之后每 700 毫秒再启动 1 个）；将 `KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY` 设为正整数可限制该阶段同时运行的子 Agent 数量，不设置则表示不限制。若设置为非正整数的值，本次 AgentSwarm 调用会立即失败。

**`AskUserQuestion`** 以结构化多选题的形式向用户提问，适用于需要消歧或选择方案的场景。`questions` 参数接受 1–4 道题，每道题需提供 `question`（以 `?` 结尾）、`options`（2–4 个选项，每项含 `label` 和 `description`）以及可选的 `header`（最多 12 字符）和 `multi_select`（默认 false）。系统自动附加"其他"选项。`background` 为 true 时启动后台问题任务并立即返回任务 ID。宿主未实现交互式提问能力时返回失败提示，Agent 应改为在文本回复中直接提问。

**`Skill`** 允许 Agent 主动调用已注册的 inline 类型 Skill。接受 `skill`（Skill 名称）和可选的 `args`（附加参数文本）。只有 `type = "inline"` 的 Skill 能通过此工具调用；`disableModelInvocation: true` 的 Skill 会被拒绝。嵌套调用深度上限 3 层。Skill 体系细节见 [Agent Skills](../customization/skills.md)。

## 后台任务

后台任务工具用于管理通过 `Bash`、`Agent` 或 `AskUserQuestion` 启动的后台任务。任务进入终止状态时会自动把状态和已保存的输出路径送回 Agent；如需提前检查进度，使用 `TaskOutput`。

| 工具 | 默认审批 | 说明 |
| --- | --- | --- |
| `TaskList` | 自动放行 | 列出后台任务 |
| `TaskOutput` | 自动放行 | 查看后台任务的输出 |
| `TaskStop` | 需审批 | 停止正在运行的后台任务 |

**`TaskList`** 返回后台任务列表。可选参数 `active_only`（默认 true，仅列出运行中的任务）和 `limit`（默认 20，取值范围 1–100）。

**`TaskOutput`** 根据 `task_id` 返回任务状态与输出。内联预览最多包含最近 32 KB 的内容；完整日志保存在磁盘上，工具会一并返回 `output_path` 并提示通过 `Read` 分页读取。可选 `block`（默认 false）和 `timeout`（等待秒数，默认 30，取值范围 0–3600）参数可用于等待任务完成后再返回。

**`TaskStop`** 接受 `task_id` 和可选的 `reason`（默认 `Stopped by TaskStop`）。对已处于终止状态的任务也能安全调用。

## 定时任务

定时任务工具允许 Agent 把一段 prompt 在未来某个时间重新注入到当前会话——既可以是一次性提醒，也可以是按 cron 周期触发的任务（定期巡检、每日报表、部署监控等）。计划绑定到会话，用 `kimi --session` 恢复会话后仍然有效，但不会带入全新的会话。单个会话最多保留 50 个生效中的定时任务。设置 `KIMI_DISABLE_CRON=1` 可整体禁用，详见[环境变量](../configuration/env-vars.md#运行时开关)。

| 工具 | 默认审批 | 说明 |
| --- | --- | --- |
| `CronCreate` | 需审批 | 安排一个在未来时刻触发的 prompt |
| `CronList` | 自动放行 | 列出已安排的定时任务 |
| `CronDelete` | 需审批 | 取消已安排的定时任务 |

**`CronCreate`** 接受 `cron`（用户本地时区下标准的 5 段 cron 表达式：`minute hour day-of-month month day-of-week`）、`prompt`（触发时要注入的文本，UTF-8 上限 8 KB）以及可选的 `recurring`（默认 `true`；传 `false` 表示一次性提醒，触发后自动删除）。成功时返回 8 位 16 进制 `id`、人类可读的 `humanSchedule`（如 `every 5 minutes`）和 `nextFireAt`（下次触发时间的 ISO 时间戳）。

为避免整批用户在整点同时触发，调度器会做确定性抖动：周期任务向后偏移 `min(周期的 10%, 15 分钟)`；一次性任务若恰好落在 `:00` 或 `:30` 则向前提前最多 90 秒。如果调度器错过了若干触发时刻（如笔记本合盖），唤醒后只会触发一次，prompt 会包裹在 `<cron-fire>` 信封里并附带 `coalescedCount`。周期任务存活超过 7 天后会以 `stale="true"` 做最后一次触发后自动删除；想继续保留时，再次调用 `CronCreate` 即可。

**`CronList`** 是只读工具，不接受任何参数。为每个生效中的任务返回一条记录，字段包括 `id`、`cron`、`humanSchedule`、`nextFireAt`、`recurring`、`ageDays` 和 `stale`。记录用 `---` 分隔，按调度时间排列。

**`CronDelete`** 只接受一个 `id`。对周期任务，未来所有触发立即停止；对一次性任务，挂起的那次触发会被取消。已触发的一次性任务会自动删除，因此对已触发过的一次性任务调用 `CronDelete` 会返回 `No cron job with id ...`。删除不可撤销，需要还原时只能再次 `CronCreate`。`CronDelete` 在 Plan 模式下同样会被拦截。

## 下一步

- [Agent 与子 Agent](../customization/agents.md) — `Agent` 工具的调度机制与上下文隔离
- [Hooks](../customization/hooks.md) — 在工具调用前后触发本地脚本
- [斜杠命令](./slash-commands.md) — TUI 内置控制命令速查
