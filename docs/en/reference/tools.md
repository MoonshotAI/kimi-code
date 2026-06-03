# Built-in tools

Built-in tools are the toolset that Kimi Code CLI ships with its core engine — no MCP server installation required. During each conversation, the agent automatically selects and invokes these tools based on the task at hand; users can also inspect every tool call in detail through the approval request interface.

Compared to MCP tools, built-in tools are managed directly by the runtime, their lifecycle is bound to the session, and no external process is needed. Both follow a unified approval mechanism: **read-only tools** (such as `Read`, `Grep`, `Glob`, and `WebSearch`) are auto-approved by default, while **write and execute tools** (such as `Write`, `Edit`, `Bash`, and `TaskStop`) require user approval by default. In YOLO mode, approval for ordinary tool calls is skipped, but exit approval in Plan mode is not affected.

## File tools

File tools handle reading, writing, and searching the local filesystem, and are the foundational tools for code analysis and modification tasks.

| Tool | Default approval | Description |
| --- | --- | --- |
| `Read` | Auto-approved | Read the contents of a text file |
| `Write` | Requires approval | Create or overwrite a file |
| `Edit` | Requires approval | Exact string replacement |
| `Grep` | Auto-approved | Full-text search powered by ripgrep |
| `Glob` | Auto-approved | Find files by glob pattern |
| `ReadMediaFile` | Auto-approved | Read an image or video file |

**`Read`** accepts a file path (`path`) along with the optional `line_offset` (starting line number; negative values count from the end) and `n_lines` (maximum number of lines to read). At most 1000 lines or 100 KB are returned per call, with a truncation notice appended for anything beyond that limit. If the file is an image or video, the tool suggests using `ReadMediaFile` instead.

**`Write`** accepts `path`, `content`, and an optional `mode` (`overwrite` or `append`; defaults to overwrite). The parent directory must already exist; `append` mode appends content to the end of the file without automatically inserting a newline.

**`Edit`** accepts `path`, `old_string` (the exact text to replace), and `new_string` (the replacement text). By default it replaces only a single unique match; if the same content appears more than once in the file, the tool returns an error and suggests using `replace_all: true`. `old_string` and `new_string` must differ.

**`Grep`** invokes ripgrep to search file contents. It supports regular expressions (`pattern`), a search path (`path`), file-type filtering (`type`, e.g. `ts`, `py`), glob filtering (`glob`), and an output mode (`output_mode`: `files_with_matches` / `content` / `count_matches`, defaulting to `files_with_matches`). `content` mode supports `-A`, `-B`, and `-C` context-line arguments along with `-i` (case-insensitive), `-n` (line numbers, default true), and `multiline` (cross-line matching). All modes support `offset` + `head_limit` pagination; `head_limit` defaults to 250, and passing 0 removes the limit. In `files_with_matches` mode, results are sorted by the most recent file modification time in descending order; other modes preserve ripgrep's original output order. Sensitive files such as `.env`, private keys, `.aws/credentials`, and `.gcp/credentials` are automatically filtered out; `include_ignored=true` also searches files ignored by `.gitignore` and the like, but sensitive files remain filtered.

**`Glob`** matches files against a glob pattern (`pattern`) within a specified directory (`path`, defaulting to the working directory). Results are sorted by modification time in descending order, with a maximum of 1000 entries. The optional `include_dirs` (default true) controls whether directory entries are returned. Pure wildcard patterns (such as `**` or `**/*`) are rejected with a prompt to add a literal anchor; patterns containing brace expansion (`{a,b,c}`) are likewise rejected — the underlying glob engine treats `{` and `}` as literals, so such patterns silently match zero files.

**`ReadMediaFile`** sends an image or video file to the model as multimodal content, accepting only `path`. The file size limit is 100 MB. Tool availability depends on the current model's vision capabilities (`image_in` / `video_in`).

## Shell

| Tool | Default approval | Description |
| --- | --- | --- |
| `Bash` | Requires approval | Execute a shell command |

**`Bash`** is the most versatile and the most permission-sensitive tool. It accepts `command` (required) along with the optional `cwd` (working directory), `timeout` (milliseconds), `description` (background task description, required when `run_in_background=true`), `run_in_background` (whether to run as a background task), and `disable_timeout` (whether to disable the timeout for a background task). The foreground `timeout` defaults to 60 seconds and is capped at 5 minutes; the background `timeout` defaults to 10 minutes and is also capped at 10 minutes.

In foreground mode `Bash` blocks the current turn until the command finishes or times out; in background mode it returns a task ID immediately. Background tasks time out after 10 minutes by default; if a task really needs to run without a timeout, set `disable_timeout=true`. When the task completes, fails, or is stopped, the agent is automatically notified to continue processing; during execution, the result can also be inspected explicitly via `TaskOutput`. stdin is always closed, so interactive commands receive EOF immediately. A two-phase termination strategy (SIGTERM → 5-second grace period → SIGKILL) ensures processes terminate reliably after a timeout. On Windows, Git Bash is used as the shell by default.

## Network tools

| Tool | Default approval | Description |
| --- | --- | --- |
| `WebSearch` | Auto-approved | Search the web |
| `FetchURL` | Auto-approved | Fetch the content of a given URL |

**`WebSearch`** accepts `query` (search terms) and the optional `limit` (number of results to return, 1–20, default 5) and `include_content` (whether to return the page body; default false — enabling this consumes significantly more tokens). This tool requires the host to provide a search implementation; if no implementation is injected, it does not appear in the tool list.

**`FetchURL`** accepts a single `url` parameter and returns the page content. For HTML pages, the host extracts the main article body (`extracted`) rather than returning the full HTML; plain-text or Markdown pages are passed through directly (`passthrough`). Likewise requires a host-injected implementation.

## Plan mode

| Tool | Default approval | Description |
| --- | --- | --- |
| `EnterPlanMode` | Auto-approved | Enter Plan mode |
| `ExitPlanMode` | Auto-approved (requires user plan confirmation) | Exit Plan mode and submit the plan |

Plan mode is a constrained working state: once entered, `Write` and `Edit` are tightened — they may only write to the current plan file, and other paths are blocked; `TaskStop` is also blocked entirely. The remaining tools (including `Bash`) are still governed by the current permission rules, so a `Bash` command can in principle still modify files — whether it is allowed depends on the active approval policy.

**`EnterPlanMode`** takes no parameters. On success it returns workflow instructions, including the plan file path if one was provided by the host.

**`ExitPlanMode`** reads the current plan file contents, presents the plan to the user for approval, and then exits Plan mode. The optional `options` parameter lets the agent provide 1–3 alternative proposals (each with a `label` and `description`; the `label` is capped at 80 characters) for the user to choose from during approval. Labels must be unique and cannot use the reserved words `Approve`, `Reject`, `Reject and Exit`, or `Revise` (the system uses these to mark approval results). Once the user approves, all tools become available again; if the user requests changes, the agent remains in Plan mode.

## State management

| Tool | Default approval | Description |
| --- | --- | --- |
| `TodoList` | Auto-approved | Manage the task to-do list |

**`TodoList`** maintains a visible subtask list across multi-step operations; state is stored within the agent session. The `todos` parameter accepts an array where each item has a `title` and a `status` (`pending` / `in_progress` / `done`). Omitting `todos` queries the current list; passing an empty array clears it.

## Collaboration tools

Collaboration tools handle inter-agent coordination, user interaction, and skill invocation.

| Tool | Default approval | Description |
| --- | --- | --- |
| `Agent` | Auto-approved | Spawn a subagent to execute a subtask |
| `AgentSwarm` | Auto-approved | Launch multiple subagents from a prompt template |
| `AskUserQuestion` | Auto-approved | Ask the user a question to obtain structured input |
| `Skill` | Auto-approved | Invoke a registered inline skill |

**`Agent`** delegates a subtask to a subagent. Required parameters are `prompt` (the full task description) and `description` (a short 3–5 word summary for UI display). Optional parameters include `subagent_type` (agent type, default `coder`), `resume` (the ID of an existing agent to resume), `run_in_background` (whether to run in the background, default false), and `timeout` (timeout in seconds, 30–3600). `subagent_type` and `resume` are mutually exclusive: when resuming an existing agent, addressing is done solely by ID. When the foreground `timeout` is omitted, the subagent runs to completion with no time limit; when the background `timeout` is omitted, it falls back to `[background] agent_task_timeout_s` in `config.toml`, and if that field is also unset, there is no time limit. In foreground mode the parent agent waits for the subagent to complete before continuing; in background mode it returns a task ID immediately, and upon completion a synthetic user message automatically routes control back to the main agent, with no polling required. For details on the subagent system, see [Subagents](../customization/agents.md).

**`AgentSwarm`** launches multiple subagents from a shared `prompt_template` and an `items` array. The template must contain the `{{item}}` placeholder; each item replaces that placeholder and launches one subagent. Pass `subagent_type` to choose the profile used by every subagent in the swarm, or omit it to use `coder`. The tool accepts 2 to 50 items, waits for all subagents to finish, and returns an aggregated report. In the TUI, foreground swarms show a live `Agent swarm` progress panel above the input box.

**`AskUserQuestion`** presents the user with a structured multiple-choice question, suitable for disambiguation or option-selection scenarios. The `questions` parameter accepts 1–4 questions; each question requires a `question` (question text ending with `?`), `options` (2–4 choices, each with a `label` and `description`), and the optional `header` (a short category label of up to 12 characters, such as `Auth` or `Style`) and `multi_select` (whether multiple choices are allowed, default false). An "Other" option is automatically appended by the system, so there is no need to provide it manually in `options`. When `background` is true, the tool starts a background question task and returns a task ID immediately; the agent can continue working and will receive the answer automatically, or inspect it with `TaskOutput`. If the host does not implement interactive questioning, this tool returns a failure notice and the agent should instead ask the user directly in its text reply.

**`Skill`** allows the agent to explicitly invoke a registered inline-type skill. It accepts `skill` (the skill name) and an optional `args` (additional argument text). Only skills with `type = "inline"` can be invoked through this tool; other types (such as `prompt` or `flow`) and skills that set `disableModelInvocation: true` in their frontmatter are rejected. To prevent recursive infinite loops, skill nesting depth is limited to 3 levels. For details on the skill system, see [Skills](../customization/skills.md).

## Background tasks

Background task tools manage background tasks started via `Bash`, `Agent`, or `AskUserQuestion`. When a background task reaches a terminal state such as completed, failed, stopped, or lost, its status and tail output are automatically sent back to the agent; use `TaskOutput` only when you want to inspect progress before that automatic notification arrives.

| Tool | Default approval | Description |
| --- | --- | --- |
| `TaskList` | Auto-approved | List background tasks |
| `TaskOutput` | Auto-approved | View the output of a background task |
| `TaskStop` | Requires approval | Stop a running background task |

**`TaskList`** returns a list of background tasks by serializing each task's info record as snake_case fields, omitting null and undefined fields. Common fields include `task_id`, task `kind`, status, description, and timestamps. Process tasks additionally include `command` and `pid`, and include `exit_code` when an exit code is known; background subagent tasks additionally include `agent_id` and `subagent_type` when available. Optional parameters: `active_only` (default true, lists only running tasks) and `limit` (maximum number of entries to return, default 20, range 1–100). Tasks explicitly terminated by `TaskStop` additionally include `stop_reason`.

**`TaskOutput`** returns the status and output of a specified task by `task_id`. For process tasks, output is command stdout/stderr; for background subagent tasks, output is the subagent's final summary once it completes. The inline preview includes at most the most recent 32 KB of content; the full log is saved on disk, and the tool also returns `output_path` with a prompt to paginate it via `Read` (around 300 lines per page is recommended). Optional `block` (default false) and `timeout` (seconds to wait, default 30, range 0–3600) parameters can be used to wait for the task to finish before returning. In the response, `retrieval_status` is one of `success` / `timeout` / `not_ready`; tasks aborted by an external deadline timeout return `status: timed_out` and `terminal_reason: timed_out`, and tasks explicitly terminated by `TaskStop` additionally include `stop_reason` and `terminal_reason: stopped`.

**`TaskStop`** accepts `task_id` and an optional `reason` (reason for stopping, default `Stopped by TaskStop`). It is safe to call on a task that is already in a terminal state — it returns the current status without error.

## Scheduled tasks

Scheduled task tools let the agent re-inject a prompt into the current session at a future time, either once (a reminder) or on a recurring cron schedule (a periodic check, daily report, deploy watcher, etc.). Schedules are scoped to the session: they survive `kimi resume` of the same session, but never carry over into a brand-new session. A session is capped at 50 live scheduled tasks. Setting `KIMI_DISABLE_CRON=1` blocks the entire feature — see [Environment variables](../configuration/env-vars.md#runtime-switches).

| Tool | Default approval | Description |
| --- | --- | --- |
| `CronCreate` | Requires approval | Schedule a prompt to fire at a future time |
| `CronList` | Auto-approved | List scheduled tasks |
| `CronDelete` | Requires approval | Cancel a scheduled task |

**`CronCreate`** accepts `cron` (a standard 5-field cron expression in the user's local timezone: `minute hour day-of-month month day-of-week`), `prompt` (the text to re-inject when the schedule fires, capped at 8 KB UTF-8), and an optional `recurring` (default `true`; pass `false` for a one-shot reminder that fires once and then auto-deletes). The tool requires the expression to have at least one fire within five years and rejects one-shot tasks whose next fire would land more than ~350 days in the future (typically a pinned day/month that already passed this year). On success it returns an 8-character hex `id`, a human-readable `humanSchedule` (e.g. `every 5 minutes`), the `recurring` flag, and `nextFireAt` (the ISO timestamp of the next post-jitter fire). The approval scope is tied to the exact `(cron, prompt, recurring)` payload — re-approving once does not authorize later schedules. `CronCreate` is also blocked in Plan mode.

To avoid synchronized fleet-wide fires on round minute marks, the scheduler applies a deterministic per-task jitter: recurring tasks shift forward by up to `min(10% of the period, 15 minutes)`; one-shot tasks landing on `:00` or `:30` shift earlier by up to 90 seconds. If the scheduler sleeps past several ideal fire times (laptop closed, long-running turn, etc.), it delivers only one fire when it wakes up — the prompt is wrapped in a `<cron-fire>` envelope carrying `coalescedCount` so the agent reacts to "I missed N checks; only the latest state matters" instead of running the prompt N times. Recurring tasks older than seven days fire one final time with `stale="true"` on the envelope and the system then auto-deletes the task; to keep the schedule running, just call `CronCreate` again. One-shot tasks are never marked stale.

**`CronList`** is read-only and takes no parameters. It returns one record per live task, each carrying `id`, `cron`, `humanSchedule`, the JSON-encoded `prompt` (truncated to ~200 UTF-8 bytes for context-window safety), `nextFireAt` (the post-jitter ISO timestamp the scheduler will actually fire on), `recurring`, `ageDays`, and `stale`. Records are separated by a line containing `---` in scheduling order. The empty case returns `cron_jobs: 0\nNo cron jobs scheduled.`. Use this to recall pending tasks after a context compaction, or to look up an `id` for `CronDelete`.

**`CronDelete`** accepts a single `id` — the 8-character hex value returned by `CronCreate` or shown in `CronList`. For a recurring task it stops all future fires immediately; for a one-shot it cancels the pending fire. One-shot tasks that have already fired auto-delete themselves, so calling `CronDelete` on a fired one-shot returns `No cron job with id ...` — a signal that the model should call `CronList` rather than retry with the same id. Deletion is irreversible; recreate the task with `CronCreate` to undo. `CronDelete` is also blocked in Plan mode.
