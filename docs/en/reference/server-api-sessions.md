# Session endpoints

This page lists the REST endpoints under `/api/v1/sessions` (session file system endpoints are in [File endpoints](./server-api-files.md)), plus the session list and batch archive endpoints under `/api/v2/sessions`. For the WebSocket side (conversation frames, [subscribing to a session](./server-api-conversation.md#subscribing-to-a-session), and how a client drives a turn), see [Sessions and conversations](./server-api-conversation.md). For shared conventions such as the response envelope, authentication, error codes, and pagination, see [Server API](./server-api.md).

## Sessions

These endpoints manage sessions themselves: create, list, read, and update sessions, run session actions such as fork, compact, and undo, and read session-level information such as the goal, warnings, environments, and file history. Every endpoint that returns a session uses the [session object](#session-object) shape.

### Session object

Every endpoint that returns a session uses this shape.

The live status fields (`busy`, `main_turn_active`, `pending_interaction`, `last_turn_reason`) are resolved from the session's activity aggregate. When the session is not loaded in this server process (a cold session), these fields always report not busy with no pending interaction. A few fields are currently placeholders; each one is noted in its description.

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | Session id (`session_...`) |
| `workspace_id` | string | Owning workspace id |
| `title` | string | Session title; `""` when untitled |
| `created_at` / `updated_at` | string | Creation and last-update times, ISO 8601 |
| `archived` | boolean | Whether the session is archived. Archived sessions do not appear in the default session list |
| `archived_at` | string | Archive time, ISO 8601. Present only when archived |
| `busy` | boolean | `true` when any agent has an active turn, a running task (foreground tasks count), or a context compaction in progress |
| `main_turn_active` | boolean | `true` when the main agent has an active turn |
| `pending_interaction` | string | The interaction waiting for an answer: `none` / `approval` / `question`. `approval` when an approval and a question are both pending |
| `last_turn_reason` | string | Outcome of the main agent's latest turn: `completed` / `cancelled` / `failed`. Cleared when the main agent starts a new turn |
| `last_prompt` | string | Text of the most recent user prompt, when present |
| `metadata` | object | Custom metadata; always carries `cwd` (the session's working directory) |
| `agent_config` | object | Contains only `model`. When the session is loaded in the current server process and the main agent has a model, `model` is the main agent's current model; otherwise it is `""`. The create-session response carries this model too, unless no model was available at creation |
| `usage` | object | Token rollup: `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_creation_tokens`, `context_tokens`, and the optional `context_limit`, `total_cost_usd`, and `turn_count`. Currently always zeros. The live context size comes with each agent's [`usage` frame](./server-api-conversation.md#agent-state) over the WebSocket |
| `permission_rules` | array | Session permission rules; currently always `[]` |
| `message_count` | integer | Message count; currently always `0` |

### Create, read, and update sessions

Create sessions, list and read them, and update a session's title, metadata, and main agent config.

| Method and path | Description |
| --- | --- |
| `POST /api/v1/sessions` | Create a session (requires `workspace_id` or `metadata.cwd`) |
| `GET /api/v1/sessions` | List sessions; cursor pagination with filters such as `busy` and `archived_only` |
| `GET /api/v1/sessions/{session_id}` | Read one session |
| `GET /api/v1/sessions/{session_id}/profile` | Read the session profile |
| `POST /api/v1/sessions/{session_id}/profile` | Update the title, metadata, and main agent config |
| `POST /api/v1/sessions/{session_id}/title/generate` | Generate a title through the managed `chat_title` tool |

#### `POST /api/v1/sessions`

Creates a session and returns it. On success, the server broadcasts the global `event.session.created` event (see [Global events](./server-api-conversation.md#global-events)).

The session's directory comes from `workspace_id` (a registered workspace) or `metadata.cwd` (the workspace is registered on first use). When both are given, they must agree.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `workspace_id` | body | string | Required when `metadata.cwd` is absent. A registered workspace id; the session is created at that workspace's root |
| `metadata` | body | object | Custom metadata. `metadata.cwd` is the working directory and is required when `workspace_id` is absent; with `workspace_id` also given, it must equal the workspace root. Other keys are kept as the session's custom metadata; the reserved keys `goal`, `parent_session_id`, and `child_session_kind` are dropped |
| `title` | body | string | Initial title, at least 1 character. Without it, the session is untitled |
| `agent_config` | body | object | Partial main agent config, applied before the session is returned. Same fields as `agent_config` in [`POST /api/v1/sessions/{session_id}/profile`](#post-api-v1-sessions-session-id-profile), plus `profile` |
| `environment_id` | body | string | Id of the environment the main agent runs in; `local` means this machine. Without it, the server uses `default` under `[environments]` in `config.toml`, or this machine when that is not configured. A non-local environment must be declared under `[environments]` or already registered. With a value other than `local`, the server creates the main agent before returning the session |
| `environment_cwd` | body | string | Working directory on the environment. Requires `environment_id`. For a non-local environment without this field, the environment's `defaultCwd` under `[environments]` is used |

The main agent is bound when the session is created:

- `agent_config.profile` picks the agent profile, default `agent`. The agent profile cannot change afterwards.
- `agent_config.model` picks the model, default the server's current default model. Later changes to the default model do not affect the session.
- `agent_config.thinking` is checked against that model in the same bind.

When `agent_config` cannot be applied, the server does not create the session and returns the error. When `agent_config` sets `tower_mode: true`, the request fails with `40001`: entering Tower mode changes the repository and cannot be undone if creation fails, so enable it through `POST /api/v1/sessions/{session_id}/profile` after the session exists.

When no model is available (no default model is configured, or the default model cannot be resolved), the session is still created, but without a model. In that case, if `agent_config` sets `profile` or `thinking`, the server does not create the session.

On success, `data` is the [session object](#session-object) of the new session.

- `40001`: neither `workspace_id` nor `metadata.cwd` is given; `metadata.cwd` does not match the workspace root; `agent_config` sets `tower_mode: true` (`details` lists the field); `agent_config.model` is not configured; `agent_config.profile` is an unknown agent profile; the model does not support `agent_config.thinking`; `environment_cwd` is given without `environment_id`; a non-local environment is not declared, fails to register, or has no usable working directory
- `40113`: no model is available while `agent_config` sets `profile` or `thinking`
- `40409`: the working directory does not exist or is not a directory. With a non-local environment, the server does not check whether the working directory exists
- `40410`: no workspace is registered with that `workspace_id`
- `40420`: the environment does not exist
- `40913`–`40918`, `40920`: `agent_config` could not be applied because of a goal error
- `40926`: the environment is unavailable

#### `GET /api/v1/sessions`

Lists sessions across workspaces, newest `updated_at` first. Cursor pagination follows the [Pagination](./server-api.md#pagination) conventions, with one exception: when neither `page_size` nor `archived_only` is given, the response is a single unpaginated window and `has_more` is always `false`. To actually page, pass `page_size`.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `before_id` | query | string | Only sessions older than this id. Mutually exclusive with `after_id` |
| `after_id` | query | string | Only sessions newer than this id. Mutually exclusive with `before_id` |
| `page_size` | query | integer | 1–100. Default `20` when paging applies; see above for the behavior without it |
| `busy` | query | boolean | Keep only busy (or only idle) sessions |
| `include_archive` | query | boolean | List archived sessions alongside active ones. Default `false` |
| `archived_only` | query | boolean | List only archived sessions. Mutually exclusive with `include_archive`. Enables cursor pagination even without `page_size` |
| `exclude_empty` | query | boolean | Drop sessions that have no user prompt |
| `workspace_id` | query | string | List only this workspace's sessions; accepts workspace aliases |

On success, `data` is `{ items, has_more }`, where each item is a [session object](#session-object).

- `40001`: validation failure, for example `before_id` together with `after_id`, or `archived_only` together with `include_archive`
- `40410`: unknown `workspace_id`

#### `GET /api/v1/sessions/{session_id}`

Reads one session from the index. When the session is loaded in this process, the live status fields are included; a cold session reports not busy and carries its last persisted turn outcome.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | Required. Session id |

On success, `data` is a [session object](#session-object).

- `40401`: the session does not exist, or its workspace can no longer be resolved

#### `GET /api/v1/sessions/{session_id}/profile`

Reads the session profile. The response is the same as `GET /api/v1/sessions/{session_id}`.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | Required. Session id |

On success, `data` is a [session object](#session-object).

- `40401`: the session does not exist

#### `POST /api/v1/sessions/{session_id}/profile`

Updates the session profile: the title, custom metadata, and the main agent's config.

A title set here is a custom title and takes precedence over generated titles. Setting a title broadcasts the global `session.meta.updated` event.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | Required. Session id |
| `title` | body | string | New title, at least 1 character. Becomes a custom title |
| `metadata` | body | object | When non-empty, replaces the session's custom metadata as a whole. The reserved keys `cwd`, `goal`, `parent_session_id`, and `child_session_kind` are ignored, and the values the session already stores for them are kept |
| `agent_config` | body | object | Partial main agent config; fields in the table below |

All `agent_config` fields are optional. The server applies them to the main agent one by one in this order: `model`, `thinking`, `permission_mode`, `plan_mode`, `swarm_mode`, `tower_mode`, `goal_objective`, `goal_control`. Applying is not atomic: when a field fails, the fields before it have already taken effect and are not rolled back. Except for `goal_objective` and `goal_control`, sending a field again has no extra effect, so these fields are safe to resend.

| Field | Type | Description |
| --- | --- | --- |
| `model` | string | Model alias id. An empty string is ignored |
| `thinking` | string | Thinking effort level |
| `permission_mode` | string | `manual` / `yolo` / `auto`. Synced to every agent in the session, except agents with a fixed permission mode (for example Tower workers) |
| `plan_mode` | boolean | Enter or exit Plan mode |
| `swarm_mode` | boolean | Enter or exit swarm mode |
| `tower_mode` | boolean | Enter or exit Tower mode. Requires the Tower experimental flag (`KIMI_CODE_EXPERIMENTAL_TOWER=1`, or `[experimental] tower = true` in `config.toml`) |
| `tower_base` | string | Base branch used when entering Tower mode; used only together with `tower_mode: true`. When the branch does not exist, the server creates it in the repository, switches to it, and commits uncommitted changes onto it |
| `goal_objective` | string | Create a goal with this text |
| `goal_control` | string | Control the current goal: `pause` / `resume` / `cancel` |

On success, `data` is the updated [session object](#session-object).

- `40001`: `model` is not configured; the model does not support `thinking`; `agent_config.profile` is given (the agent profile can only be chosen when the session is created)
- `40113`: the session has no model, and the request sets only `thinking` without `model`
- `40401`: the session does not exist
- `40913`–`40918`, `40920`: `goal_objective` or `goal_control` could not be applied because of a goal error, for example a goal already exists, there is no goal, or the goal's status does not allow the operation
- `40935`: Tower mode cannot be entered: the experimental flag is off; the Tower feature is not wired into this server process and a restart is needed; or the workspace's Tower is held by another session that is running or waiting for an answer

#### `POST /api/v1/sessions/{session_id}/title/generate`

Generates a title from the session's prompts, applies it to the session, and broadcasts `session.meta.updated`. The title is generated by the managed provider's `chat_title` tool.

Title generation requires the managed OAuth login. Without `force`, a session that already has a custom or generated title is reported unavailable, and its existing title is not overwritten.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | Required. Session id |
| `force` | body | boolean | Regenerate even when a custom or generated title exists. Default `false` |
| `source` | body | string | Input used to generate the title: `user_prompts` (default) / `first_turn` / `digest` |

On success, `data` is `{ title }`, the title now applied to the session.

- `40401`: the session does not exist
- `40923`: the title cannot be generated: the flag is off; there is no managed OAuth login; the session has no prompt content yet; a title exists and `force` is not set; the backend request failed

### Session actions

Session actions are non-CRUD operations on one session. Following the `:{action}` convention, they are POSTed to `/api/v1/sessions/{session_id}:{action}`.

| Method and path | Description |
| --- | --- |
| `POST /api/v1/sessions/{session_id}:fork` | Copy the session into a new session in the same workspace |
| `POST /api/v1/sessions/{session_id}:compact` | Manually compact the main agent's context |
| `POST /api/v1/sessions/{session_id}:undo` | Undo a turn and the turns after it |
| `POST /api/v1/sessions/{session_id}:abort` | Cancel the main agent's running turn |
| `POST /api/v1/sessions/{session_id}:btw` | Start a read-only side conversation |
| `POST /api/v1/sessions/{session_id}:archive` | Archive the session |
| `POST /api/v1/sessions/{session_id}:restore` | Unarchive the session |
| `POST /api/v1/sessions/{session_id}:delete` | Permanently delete the session |
| `POST /api/v1/sessions/{session_id}:reload` | Reload the session with the latest on-disk configuration |
| `POST /api/v1/sessions/{session_id}:takeover` | Remove a session lock left behind by another process |

#### `POST /api/v1/sessions/{session_id}:{action}`

All session actions go through one route: the end of the path is parsed as `{session_id}:{action}`, and the request body is validated against that action's schema. The parameter tables of the actions below list only body fields.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | Required. Session id |
| `action` | path | string | Required. Action name; values in the table above |

- `40001`: the action is missing or unknown (`unsupported action: ...`)
- `40401`: the session does not exist. Every action resolves the session first, so every action can return this code

#### `POST /api/v1/sessions/{session_id}:fork`

Copies the session, including its conversation, agent state, and files, into a new session in the same workspace, and broadcasts `event.session.created`. The source session keeps running.

When the source session has an active turn, the fork keeps the most recent completed boundary before that turn and saves the current turn's user prompt as a prompt-only `cancelled` turn. That turn contains no assistant output, tool activity, queued input, or later events.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `title` | body | string | Title for the fork, at least 1 character. Default `Fork: <source title>` |
| `metadata` | body | object | Custom metadata for the fork |
| `turn_index` | body | integer | The turn to keep up to, inclusive, as the persisted engine `turnId`; gaps in the numbering are allowed. Must be a non-negative safe integer, and the turn must be complete |

On success, `data` is the [session object](#session-object) of the new session.

- `40001`: `turn_index` is invalid, does not exist, or points to the active turn
- `40901`: another session history operation is in progress

#### `POST /api/v1/sessions/{session_id}:compact`

Starts a manual full compaction of the main agent's context. The call returns immediately without waiting for the compaction to finish.

During compaction, `compacting` is `true` in the WebSocket [`agent` frame](./server-api-conversation.md#agent-state). When compaction finishes, the result appears in the conversation as a [`system`](./server-api-conversation.md#system) item. When compaction is cancelled, nothing is left in the conversation, and subscribers receive a [`notice` frame](./server-api-conversation.md#live-updates) with `code` `compaction.cancelled`.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `instruction` | body | string | Extra guidance for the compaction summary. A blank value is ignored |

Compaction is not queued. It can start only when the main agent is idle; see [Compaction](./server-api-conversation.md#compaction) for the flow.

On success, `data` is `{}`.

- `40910`: a compaction is already in progress; a turn is running; prompts are pending in the queue; another context change or session history operation (for example undo or fork) is in progress; the history has nothing to compact

#### `POST /api/v1/sessions/{session_id}:undo`

Undoes a turn and every turn after it in an agent's conversation, including the system turns and the turns triggered by scheduled tasks and the like in between. The server also reconciles the derived session state (including the session's `last_prompt`). Files are not rolled back. See [Undo](./server-api-conversation.md#undo) for the flow.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `turn_id` | body | string | Required. The turn to undo. It must be an `agent` turn whose opening `user_message` comes from the user, a skill the user invoked with a slash command, or a plugin command |
| `agent_id` | body | string | The agent whose conversation to undo. Default `main` |

On success, `data` is `{ removed_turn_ids }`: the removed turns in ascending ordinal order, starting with `turn_id`. Subscribers receive a [`turns.removed` frame](./server-api-conversation.md#live-updates) with the same `turn_ids`. The response and the frame can arrive in either order.

- `40421`: the turn does not exist
- `40901`: the agent is working (a running turn, queued input, or a context compaction in progress); retry after it finishes
- `40911`: the turn cannot be undone: it does not open with user input, or the removed range crosses a context compaction
- `40932`: another client updated the session. The server has reloaded the session, and nothing was undone this time (see [Error codes](./server-api.md#error-codes))

#### `POST /api/v1/sessions/{session_id}:abort`

Stops the main agent's current turn, the equivalent of the user aborting a turn in the TUI. Only the main agent is affected; other agents' turns keep running.

On success, `data` is always `{ aborted: true }`, whether or not a turn was running, so the call is safe to retry. To confirm the turn has stopped, wait for that turn's `turn.ended` frame.

Stopping a turn does not clear the queue: queued user prompts and user steering messages not yet inserted are kept and start after the stopped turn ends; queued skill activations are cancelled. See [Stopping a turn](./server-api-conversation.md#stopping-a-turn) for the flow.

#### `POST /api/v1/sessions/{session_id}:btw`

Starts a "by the way" side conversation: forks the main agent into a subagent that can use only the read-only tools `Read`, `Grep`, and `Glob`, so quick side questions run in isolation without touching the working context. Requires a usable model configuration.

On success, `data` is `{ agent_id }`, the id of the new subagent.

Turns of agents other than the main agent, such as side conversations, have no public stop endpoint. [`:abort`](#post-api-v1-sessions-session-id-abort) stops only the main agent.

#### `POST /api/v1/sessions/{session_id}:archive`

Marks the session archived and broadcasts the global `event.session.archived` event. An archived session does not appear in the default session list; it is still listed with `include_archive` or `archived_only`.

On success, `data` is `{ archived: true }`.

#### `POST /api/v1/sessions/{session_id}:restore`

Unarchives the session. When the session was archived, the server broadcasts the global `event.session.restored` event.

On success, `data` is the [session object](#session-object), with `archived` set to `false`.

#### `POST /api/v1/sessions/{session_id}:delete`

Permanently deletes the session. When the session is loaded in this process, it is closed first. The server then deletes its on-disk data, index entry, and file history, and broadcasts the global `event.session.deleted` event (see [Global events](./server-api-conversation.md#global-events)). Deletion cannot be undone.

On success, `data` is `{ deleted: true }`.

#### `POST /api/v1/sessions/{session_id}:reload`

Reloads the session with the latest on-disk configuration: re-reads `config.toml` and plugins, reloads the workspace's skill and subagent catalogs, then closes the session and resumes it from disk. The server also notifies the main agent of external changes to `AGENTS.md`, skills, subagents, and models through system reminders (system-reminder).

On success, `data` is the [session object](#session-object). Although the session is closed and reopened, existing subscriptions stay valid and the server resends the frames; see [When the server closes and reopens a session](./server-api-conversation.md#when-the-server-closes-and-reopens-a-session).

- `40901`: an agent has a running turn or a context compaction in progress, so the session cannot be reloaded

#### `POST /api/v1/sessions/{session_id}:takeover`

Removes the lock another Kimi Code process holds on the session. After that, requests that previously failed with [`40931`](./server-api.md#error-codes) can be retried.

Use it only when the process holding the lock has exited and left the lock behind. If that process is still running, both processes write to the session until it goes idle, and the session history can interleave.

On success, `data` is `{ taken_over: true }`.

- `40401`: the session does not exist

### Child sessions

A child session is a session forked from the current session and recorded as its child.

| Method and path | Description |
| --- | --- |
| `GET /api/v1/sessions/{session_id}/children` | List child sessions |
| `POST /api/v1/sessions/{session_id}/children` | Create a child session (fork with a tag) |

#### `GET /api/v1/sessions/{session_id}/children`

Lists the child sessions created through `POST /api/v1/sessions/{session_id}/children`. Cursor pagination follows the [Pagination](./server-api.md#pagination) conventions.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | Required. Session id |
| `before_id` | query | string | Only child sessions older than this id. Mutually exclusive with `after_id` |
| `after_id` | query | string | Only child sessions newer than this id. Mutually exclusive with `before_id` |
| `page_size` | query | integer | 1–100. Default `100` |
| `busy` | query | boolean | Keep only busy (or only idle) child sessions |

On success, `data` is `{ items, has_more }`, where each item is a [session object](#session-object).

- `40401`: the session does not exist

#### `POST /api/v1/sessions/{session_id}/children`

Creates a child session: forks the current session and records the fork as its child, so it is listed by `GET /api/v1/sessions/{session_id}/children`. On success, the server broadcasts `event.session.created`.

When the source session is running, the same boundary as [`:fork`](#post-api-v1-sessions-session-id-fork) applies: the most recent completed turn is kept, and the current turn is saved as a prompt-only `cancelled` turn. Creating a child session does not accept a historical `turn_index` parameter.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | Required. Session id |
| `title` | body | string | Title for the child session, at least 1 character. Default `Child: <source title>` |
| `metadata` | body | object | Custom metadata for the child session |

On success, `data` is the [session object](#session-object) of the new session.

- `40401`: the session does not exist
- `40901`: another session history operation is in progress

### Goals

Read and edit the session's current goal. Creating, pausing, resuming, or cancelling a goal goes through `goal_objective` and `goal_control` in [`POST /api/v1/sessions/{session_id}/profile`](#post-api-v1-sessions-session-id-profile). Unlike most payloads in this API, goal payloads use camelCase keys.

| Method and path | Description |
| --- | --- |
| `GET /api/v1/sessions/{session_id}/goal` | Read the current goal snapshot (`null` when there is none) |
| `PATCH /api/v1/sessions/{session_id}/goal` | Edit the current goal's objective in place |

#### `GET /api/v1/sessions/{session_id}/goal`

Reads the session's current goal snapshot.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | Required. Session id |

When there is no goal, `data` is `null`. A goal is cleared once it completes, so later reads also return `null`. Otherwise `data` is the goal snapshot:

| Field | Type | Description |
| --- | --- | --- |
| `goalId` | string | Goal id |
| `objective` | string | Goal content |
| `completionCriterion` | string | Completion criterion; optional |
| `status` | string | `active` / `paused` / `blocked` / `complete` |
| `turnsUsed` | number | Turns used |
| `tokensUsed` | number | Tokens used |
| `wallClockMs` | number | Wall-clock time used, in milliseconds |
| `budget.tokenBudget` / `budget.turnBudget` / `budget.wallClockBudgetMs` | number \| null | Token, turn, and wall-clock (milliseconds) budgets. `null` when the corresponding budget is not set |
| `budget.remainingTokens` / `budget.remainingTurns` / `budget.remainingWallClockMs` | number \| null | Remaining amount of each budget, at least `0`. `null` when the corresponding budget is not set |
| `budget.tokenBudgetReached` / `budget.turnBudgetReached` / `budget.wallClockBudgetReached` | boolean | `true` when usage has reached the corresponding budget. `false` when that budget is not set |
| `budget.overBudget` | boolean | `true` when any budget has been reached |
| `terminalReason` | string | Why the goal left the `active` status (paused, blocked); optional. Cleared when the goal returns to `active` |

- `40401`: the session does not exist

#### `PATCH /api/v1/sessions/{session_id}/goal`

Replaces the current goal's objective. The `goalId`, status, progress, and budget stay unchanged. Works on goals in the `active`, `paused`, and `blocked` statuses.

A running turn is not interrupted; the agent receives the new objective on its next turn. Clients subscribed to the session receive a new WebSocket [`goal` frame](./server-api-conversation.md#agent-state).

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | Required. Session id |
| `objective` | body | string | Required. The new objective; leading and trailing whitespace is trimmed |

On success, `data` is the updated goal snapshot, in the same shape as `GET /api/v1/sessions/{session_id}/goal` (camelCase).

- `40401`: the session does not exist
- `40914`: there is no current goal
- `40915`: the goal is complete
- `40917`: the objective is empty
- `40918`: the objective exceeds 4000 characters

### Warnings and environments

Read session-level warnings, the environment the main agent runs in, and the environments available to the session.

| Method and path | Description |
| --- | --- |
| `GET /api/v1/sessions/{session_id}/warnings` | Session-level warnings |
| `GET /api/v1/sessions/{session_id}/environment` | Read the main agent's environment binding |
| `GET /api/v1/sessions/{session_id}/environments` | List the environments registered for the session's workspace |

#### `GET /api/v1/sessions/{session_id}/warnings`

Reads session-level warnings. Currently only the oversized `AGENTS.md` check (`agents-md-oversized`) produces warnings, so the list is empty for most sessions.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | Required. Session id |

On success, `data` is `{ warnings }`:

| Field | Type | Description |
| --- | --- | --- |
| `warnings[].code` | string | Warning code, for example `agents-md-oversized` |
| `warnings[].message` | string | Warning message |
| `warnings[].severity` | string | `info` / `warning` / `error` |

- `40401`: the session does not exist

#### `GET /api/v1/sessions/{session_id}/environment`

Reads the main agent's environment binding, that is, which environment the session's agent loop runs on.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | Required. Session id |

On success, `data` is:

| Field | Type | Description |
| --- | --- | --- |
| `workspace_id` | string | Workspace id |
| `environment_id` | string | Id of the bound environment |
| `cwd` | string | Working directory on the bound environment. Returned only when the binding carries one |

- `40401`: the session does not exist

#### `GET /api/v1/sessions/{session_id}/environments`

Lists the environments available to the session, that is, the environments registered for the session's workspace.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | Required. Session id |

On success, `data` is `{ environments }`:

| Field | Type | Description |
| --- | --- | --- |
| `environments[].environment_id` | string | Environment id |
| `environments[].type` | string | `local` / `ssh` / `docker` / `command` |
| `environments[].status` | string | `pending` / `connecting` / `ready` / `disconnected` / `disposed`. `pending` means there is no live connection and no observed failure (never connected) |
| `environments[].connect_error` | string | Failure reason of a `disconnected` entry |

- `40401`: the session does not exist

### Export and media

Export a session archive, materialize remote images into session media, and download session media files. `POST /api/v1/sessions/{session_id}/export` and `GET /api/v1/sessions/{session_id}/media/{file_id}` return binary streams instead of a JSON envelope; for HTTP behavior such as Range and ETag, see [Binary and streaming endpoints](./server-api-files.md#binary-and-streaming-endpoints).

| Method and path | Description |
| --- | --- |
| `POST /api/v1/sessions/{session_id}/export` | Export the session with diagnostics (zip stream, not enveloped) |
| `POST /api/v1/sessions/{session_id}/media` | Create session media from a remote image URL |
| `GET /api/v1/sessions/{session_id}/media/{file_id}` | Download prompt media by file id (binary) |

#### `POST /api/v1/sessions/{session_id}/export`

Exports the session together with diagnostic logs as a zip attachment (`kimi-session-<id>.zip`). The response is a binary stream, not a JSON envelope; for the supported HTTP capabilities and failure semantics, see [Binary and streaming endpoints](./server-api-files.md#binary-and-streaming-endpoints).

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | Required. Session id |
| `web_log` | body | string | Client log text to include in the archive, at most 256 KB UTF-8 |
| `desktop` | body | boolean | Also include the desktop host's logs. Default `false` |

#### `POST /api/v1/sessions/{session_id}/media`

Creates a session-canonical media file from a remote HTTP(S) image. The Web Markdown renderer automatically loads remote images through this endpoint, so rendering a session can issue requests to intranet addresses reachable by the daemon.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | Required. Session id |
| `url` | body | string | Required. Remote image URL, at most 4096 characters; embedded credentials are rejected |

The server follows at most 3 redirects and enforces a 10-second total budget across DNS, redirects, and body reading. Responses are limited to 10 MiB and identified by their bytes as PNG, JPEG, GIF, WebP, or AVIF; `Content-Type` is not trusted, and HTML, SVG, and other formats are rejected. RFC1918 addresses are allowed, while loopback, link-local, multicast, and common cloud metadata targets are blocked and revalidated on every redirect. The upstream request does not forward `Cookie` or `Authorization` headers.

On success, `data` is the stored file metadata `{ id, name, media_type, size, created_at }`. The id is deterministic for the same URL and image bytes, so repeated loads reuse a media record while changed content creates a new one. Download it through `GET /api/v1/sessions/{session_id}/media/{file_id}`.

- `40001`: invalid or disallowed URL, resolution failure, or unsupported image content
- `40401`: the session does not exist
- `40930`: the session requires a newer server to read
- `41301`: image exceeds 10 MiB
- `50001`: upstream request, redirect, or timeout failure

#### `GET /api/v1/sessions/{session_id}/media/{file_id}`

Downloads a prompt media file by file id, that is, an image or other attachment referenced by the session's prompts. When the id is not yet committed to the session, the server falls back to the staged uploads.

The response is binary and supports `Range` (ranged requests return 206); see [Binary and streaming endpoints](./server-api-files.md#binary-and-streaming-endpoints) for the shared conventions. When the session or file does not exist, the response has a real HTTP 404 status with an envelope body. This differs from the endpoints there that return error envelopes with HTTP 200.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | Required. Session id |
| `file_id` | path | string | Required. Media file id |

### File history

Read the files the main agent changed in a turn and their contents before and after, for example to show a turn's diff.

| Method and path | Description |
| --- | --- |
| `GET /api/v1/sessions/{session_id}/file-history/changes` | List the files one turn changed |
| `GET /api/v1/sessions/{session_id}/file-history/content` | Read a file's content at the start or end of a turn |

#### `GET /api/v1/sessions/{session_id}/file-history/changes`

Lists the files one turn of the main agent changed, from the turn-level file history. The server compares the contents recorded when the turn started with those recorded when it ended; while the turn is still running, it compares with the current files on disk. Unchanged files are not listed.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | Required. Session id |
| `turn_number` | query | integer | Required. The turn's `turn_number` (see [Turns](./server-api-conversation.md#turns)) |

On success, `data` is `{ changes, recorded }`:

| Field | Type | Description |
| --- | --- | --- |
| `changes[].path` | string | File path |
| `changes[].status` | string | `added` / `modified` / `deleted` |
| `changes[].additions` / `changes[].deletions` | number | Number of added and deleted lines |
| `changes[].binary` | boolean | The file is not text, or its content is no longer stored. Both line counts are `0` |
| `changes[].oversize` | boolean | The file was too large to record. Both line counts are `0` |
| `recorded` | boolean | `false` when the turn's file history is incomplete (never recorded, or some recorded contents were later cleaned up); `changes` may then be empty or partial |

- `40001`: `turn_number` is missing or invalid
- `40401`: the session does not exist

#### `GET /api/v1/sessions/{session_id}/file-history/content`

Reads a file's content as the main agent's file history recorded it at the start or end of a turn, for example to show the turn's diff.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | Required. Session id |
| `turn_number` | query | integer | Required. The turn's `turn_number` |
| `path` | query | string | Required. File path, as listed by `file-history/changes` |
| `phase` | query | string | `start` (default) for the content before the turn, `end` for the content after it |

On success, `data` is `{ content }`. `content` is `null` when the turn has no record for that phase, or the file was not recorded, was too large, or its stored content no longer exists. Otherwise `content` is:

| Field | Type | Description |
| --- | --- | --- |
| `content.version` | number | The file's version number in the history |
| `content.content` | string | Text content |
| `content.binary` | boolean | `true` when the file is not text |

When neither `content.content` nor `content.binary` is present, the file did not exist at that point. With `phase=end`, a file the turn did not change is returned with its content at the start.

- `40001`: `turn_number` or `path` is missing or invalid
- `40401`: the session does not exist

### Satisfaction survey

After a turn ends, a client may show a satisfaction survey. The client uses the endpoint below to ask whether to show the survey and to report when it was shown and how the user answered.

| Method and path | Description |
| --- | --- |
| `POST /api/v1/sessions/{session_id}/rating` | Ask whether to show the satisfaction survey, and report its display and answer |

#### `POST /api/v1/sessions/{session_id}/rating`

After a turn completes, the client first asks with `evaluate` whether to show the survey, then reports the survey's display and answer. Whether a survey is offered depends on sampling rules set by the Kimi Code service and on local cooldowns, so most evaluations offer no survey.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | Required. Session id |
| `op` | body | string | Required. `evaluate` / `shown` / `respond` / `abandon` |
| `turn_id` | body | string | Required with `evaluate`. The `turn_id` of the turn that just completed |
| `appearance_id` | body | string | Required with `shown` / `respond` / `abandon`. The `id` returned by `evaluate` |
| `response` | body | string | Required with `respond`. `bad` / `fine` / `good` / `dismissed` |

With `evaluate`, `data` is `{ appearance }`. When the client should show a survey now, `appearance` is `{ id, survey }`, with `survey` either `session` or `long_context`; otherwise it is `null`. It is also `null` when the turn is not the main agent's latest completed turn, when `disable_feedback_survey` is on, or when telemetry is off.

Then report what happened to the survey. All three operations return `data: null`:

| `op` | When to report |
| --- | --- |
| `shown` | The survey has been shown |
| `respond` | The user has answered. When the user closes the survey, `response` is `dismissed` |
| `abandon` | The survey went away without an answer, for example because the user moved elsewhere |

- `40001`: validation failure

### Session skills

List the skills available to a session, or activate a skill in a session. Activation is the REST form of the `/<skill>` slash command; as a non-CRUD operation, it also uses the `:{action}` convention. To read a workspace's skill catalog without creating a session, see [`GET /api/v1/workspaces/{workspace_id}/skills`](./server-api-service.md#get-api-v1-workspaces-workspace-id-skills).

| Method and path | Description |
| --- | --- |
| `GET /api/v1/sessions/{session_id}/skills` | Session-level skill catalog |
| `POST /api/v1/sessions/{session_id}/skills/{skill_name}:activate` | Activate a skill (starts a turn) |

#### `GET /api/v1/sessions/{session_id}/skills`

Lists the skills available to one session, merged from every source (built-in, plugin, extra, user, project) with the session's precedence applied. Reading the catalog resumes the session when it is cold.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | Required. Session id |

On success, `data` is `{ skills }`, where each item is a skill descriptor:

| Field | Type | Description |
| --- | --- | --- |
| `skills[].name` | string | Skill name |
| `skills[].description` | string | Skill description |
| `skills[].path` | string | Path of the skill. Same-name skills can be returned as several variants, each with a different `path` |
| `skills[].source` | string | `project` / `user` / `extra` / `builtin`. Skills provided by plugins are reported as `extra` |
| `skills[].workspace_dir` | string | Root directory of a project skill. Omitted for other sources |
| `skills[].type` | string | Skill category; optional. Only user-activatable types can be activated |
| `skills[].disable_model_invocation` | boolean | Optional. When `true`, the skill is hidden from the model |
| `skills[].scopes` | array | Optional. Client surfaces the skill applies to: `tui` / `web`. When omitted, it applies to all surfaces |

- `40401`: the session does not exist (or is not activated)

#### `POST /api/v1/sessions/{session_id}/skills/{skill_name}:activate`

Activates a skill in the session, the equivalent of the `/<skill>` slash command: starts a turn on the main agent with the skill's content plus `args` and attachments.

When the main agent is running, activation does not start a new turn. It is inserted into the current turn as steering, and the response returns after the insertion (see [Steering](./server-api-conversation.md#steering)).

The endpoint dispatches through one route, `POST /api/v1/sessions/{session_id}/skills/{tail}`: `{tail}` is parsed as `{skill_name}:{action}`, and `activate` is the only action. A bare name or an unknown action returns `40001` (`unsupported action: ...`).

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | Required. Session id |
| `skill_name` | path | string | Required. Name of the skill to activate |
| `path` | body | string | Exact path of a `SKILL.md` in the session skill catalog, used to select a same-name variant. Must match an entry returned by the catalog |
| `args` | body | string | Free-form arguments passed to the skill, like the text after a slash command |
| `prompt_id` | body | string | Client-chosen id of the activation message. It appears in the `prompt_ids` of the matching `user_message` item in the conversation (see [Items](./server-api-conversation.md#items)). The idempotency rules are the same as for [`prompt_id` in prompt submission](#post-api-v1-sessions-session-id-prompts), and both share one record table |
| `metadata` | body | object | Client-defined metadata saved with the activation message, same as `metadata` in prompt submission |
| `attachments` | body | array | Media blocks attached to the activation. `image` / `video` blocks carry a `source` object whose `kind` is `url` / `base64` / `file` / `session_media`, in the same shape as [prompt content blocks](#post-api-v1-sessions-session-id-prompts); `file` blocks carry the top-level `file_id`, `name`, `media_type`, and `size` |

On success, `data` is `{ activated: true, skill_name }`.

- `40001`: validation failure, or an unsupported action suffix
- `40401`: the session does not exist (or is not activated)
- `40407`: a referenced attachment file does not exist
- `40415`: no skill with that name
- `40912`: the skill exists, but its type cannot be activated by the user
- `40927`: `prompt_id` is already used by another request, including prompt submission and `/steer` requests

### Session list (v2)

`/api/v2/sessions` is the next-generation API for session list and management views: filtering, sorting, and field groups for list queries all go in query parameters, and batch archive and restore are provided.

| Method and path | Description |
| --- | --- |
| `GET /api/v2/sessions` | Query sessions by filter, sort, and field group; can group by workspace |
| `POST /api/v2/sessions:archive` | Archive sessions in batch |
| `POST /api/v2/sessions:restore` | Restore sessions in batch |

#### `GET /api/v2/sessions`

A session query for list views, with filtering, sorting, and field groups all in query parameters. Paginate with `page_token` or `page` (see [Pagination](./server-api.md#pagination)).

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `workspace.id` | query | string | Filter by workspace; repeatable |
| `activity.status` | query | string | Filter by activity status: `running` / `approval` / `question` / `failed` / `idle`; repeatable |
| `meta.updated_after` | query | integer | Only sessions updated after this time (epoch milliseconds) |
| `meta.updated_before` | query | integer | Only sessions updated before this time (epoch milliseconds) |
| `meta.archived` | query | string | `true` / `false` (default) / `all` |
| `meta.has_prompt` | query | boolean | `true` keeps only sessions with a user prompt, `false` keeps only empty sessions (equivalent to `exclude_empty` in `GET /api/v1/sessions`) |
| `view` | query | string | `flat` (default) / `by_workspace`; see below |
| `group.page_size` | query | integer | Sessions returned per workspace under `view=by_workspace`: 1–100, default 5 (up to 10000 with the `id,archived` projection) |
| `sort` | query | string | `meta.updated_at_desc` (default) / `meta.updated_at_asc` / `meta.created_at_desc` |
| `include` | query | string | Comma-separated extra field groups. Currently supports `git` (branch and PR info, deduplicated per environment and working directory and cached for 60 seconds) |
| `fields` | query | string | Comma-separated field projection. Currently supports only `id,archived`, which trims each item to `{ id, archived }` (for select-all-matching flows) |
| `page_size` | query | integer | 1–100, default 50; up to 10000 with the `id,archived` projection. Under `view=by_workspace` it counts groups |
| `page_token` | query | string | Pagination token returned by the previous page |
| `page` | query | integer | Stateless page number, starting at 1. Mutually exclusive with `page_token` |

Every item in the list always carries the `workspace`, `meta`, and `activity` groups, plus the `git` group with `include=git`; with `fields=id,archived`, each item has only `{ id, archived }`. The `activity` group also carries `model`: the session's bound model alias while it is loaded in the current process, `null` for a cold (not loaded) session. For the fields of each group, see the session items in the grouped view example below.

Every page also carries `total`, the size of the filtered set. The pagination token binds the first page's query conditions (including the projection); changing them mid-pagination returns `40922`. `page` mode is a stateless alternative for jumping to arbitrary pages: every request is an independent snapshot, no token is issued, and `next_page_token` is always `null`.

With `view=by_workspace`, the same filtered and sorted set is re-projected into per-workspace groups. An overview page can therefore use one request instead of polling each workspace:

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

| Field | Type | Description |
| --- | --- | --- |
| `groups[].workspace` | object | The workspace the group belongs to |
| `groups[].sessions` | array | The workspace's first `group.page_size` sessions, ordered by the requested `sort` |
| `groups[].total` | integer | Total number of the workspace's sessions that match the filters; usable for a "view all" entry |
| `total` | integer | Number of groups in the grouped view |

Only workspaces with at least one matching session appear. Groups are ordered by the sort key of their first session, with ties broken by workspace id. `page` and `page_token` paginate over groups with the same token fingerprint binding, which also covers `view` and the grouping parameters; changing them mid-pagination also returns `40922`.

- `40001`: `group.page_size` is given without the grouped view; `fields=id,archived` is combined with `include=git`; `page` is combined with `page_token`
- `40922`: during pagination, the query conditions (including the projection, `view`, and grouping parameters) do not match `page_token`

#### `POST /api/v2/sessions:archive`

Archives sessions in batch, for session management views. Sessions that are still live go through the full lifecycle; cold sessions that are not loaded have their on-disk metadata rewritten directly and are not loaded.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `ids` | body | array | Required. Array of session ids; must not be empty, at most 5000 after deduplication |

Only a body validation failure fails the whole request. Other errors are returned per item:

| Field | Type | Description |
| --- | --- | --- |
| `results` | array | Result for each id, in input order. A success is `{ id, ok }`; a failure is `{ id, ok: false, error }`. An id that does not exist reports `40401` in its own entry |
| `succeeded` | integer | Number of successes |
| `failed` | integer | Number of failures |

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

- `40001`: request body validation failure

#### `POST /api/v2/sessions:restore`

Restores archived sessions in batch. The request body, the handling of live and cold sessions, the per-item results, and the error codes are the same as [`POST /api/v2/sessions:archive`](#post-api-v2-sessions-archive).

## Conversation

These endpoints read the conversation history, submit prompts, and answer approvals and questions. Live conversation updates go over the WebSocket; see [Sessions and conversations](./server-api-conversation.md).

### Messages and turns

The `messages` endpoints page the main agent's flattened message history. The `turns` endpoint pages one agent's conversation by turns and items, the same model as the [turns](./server-api-conversation.md#turns) the WebSocket pushes live. Read older history with these endpoints; everything after the `turns` frame received on subscription comes over the WebSocket.

| Method and path | Description |
| --- | --- |
| `GET /api/v1/sessions/{session_id}/messages` | Page messages (`before_id` / `after_id` / `role`) |
| `GET /api/v1/sessions/{session_id}/messages/{message_id}` | Read one message |
| `GET /api/v1/sessions/{session_id}/agents/{agent_id}/turns` | Page one agent's turns (`before_ordinal` / `page_size`) |

#### `GET /api/v1/sessions/{session_id}/messages`

Pages the main agent's message history (the flattened context transcript), newest first. Cursor pagination follows the [Pagination](./server-api.md#pagination) conventions. Reading the history resumes the session when it is cold.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | Required. Session id |
| `before_id` | query | string | Only messages older than this message id. Mutually exclusive with `after_id` |
| `after_id` | query | string | Only messages newer than this message id. Mutually exclusive with `before_id` |
| `page_size` | query | integer | 1–100. Default `50` |
| `role` | query | string | Keep only one role: `user` / `assistant` / `tool` / `system`. The filter applies after the page is sliced, so a filtered page can hold fewer than `page_size` items while `has_more` is still `true`; keep paging until `has_more` is `false` |

On success, `data` is `{ items, has_more }`, where each item is a message object:

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | Message id |
| `session_id` | string | Session id |
| `role` | string | Message role |
| `content` | array | Array of content blocks, in the same format as [prompt content blocks](#post-api-v1-sessions-session-id-prompts); types include `text`, `tool_use`, `tool_result`, `image`, `video`, `file`, and `thinking` |
| `created_at` | string | Creation time |
| `prompt_id` | string | Optional |
| `parent_message_id` | string | Optional |
| `metadata` | object | Optional |

- `40001`: validation failure, for example `before_id` together with `after_id`
- `40401`: the session does not exist

#### `GET /api/v1/sessions/{session_id}/messages/{message_id}`

Reads one message from the same history by id.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | Required. Session id |
| `message_id` | path | string | Required. Message id |

On success, `data` is a message object; see [`GET /api/v1/sessions/{session_id}/messages`](#get-api-v1-sessions-session-id-messages) for its shape.

- `40401`: the session does not exist
- `40403`: no message with that id in this session

#### `GET /api/v1/sessions/{session_id}/agents/{agent_id}/turns`

Returns one page of an agent's turns, oldest first. For the shape of turns and items, see [Turns](./server-api-conversation.md#turns) and [Items](./server-api-conversation.md#items). When the session or a finished subagent is not in memory, reading loads it.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | Required. Session id |
| `agent_id` | path | string | Required. Agent id, without path separators |
| `before_ordinal` | query | integer | Only turns whose `ordinal` is below this value. No turn needs to have that `ordinal` (for example after an undo). By default, the latest page is returned |
| `page_size` | query | integer | 1–200 turns. Default `50` |

On success, `data` is `{ turns, has_more }`. `has_more` means older turns remain; to read them, pass the `ordinal` of this page's first turn as `before_ordinal`.

A page is at most 1 MiB. When `page_size` turns do not fit, the oldest turns are left out and `has_more` is `true`; the newest turn is always included. The latest page holds the running turn, if any, with its content so far.

Each page is a snapshot taken when the request starts and can include turns that are later undone. After receiving a `turns.removed` frame, discard the results of page requests sent before it.

Tasks, the agent's running status and settings, context usage, the goal, todos, and pending interactions are not part of turns. They arrive as the WebSocket `task`, `agent`, `usage`, `goal`, `todo`, and `interaction` frames; see [Tasks](./server-api-conversation.md#tasks), [Agent state](./server-api-conversation.md#agent-state), and [Approvals and questions](./server-api-conversation.md#approvals-and-questions).

- `40001`: validation failure
- `40401`: the session or agent does not exist

### Prompts

A prompt is one unit of user input. A submitted prompt enters the queue of the session's main agent (or a specified agent); queued prompts can be steered into the active turn, and running or queued prompts can be aborted. Turn progress is pushed over the WebSocket (see [Live updates](./server-api-conversation.md#live-updates)), not through these endpoints.

| Method and path | Description |
| --- | --- |
| `GET /api/v1/sessions/{session_id}/prompts` | Active and queued prompts |
| `POST /api/v1/sessions/{session_id}/prompts` | Submit a prompt (content block array, with optional overrides such as model and permission mode) |
| `POST /api/v1/sessions/{session_id}/steer` | Steer message content directly into the active turn |
| `POST /api/v1/sessions/{session_id}/prompts:steer` | Steer queued prompts into the active turn |
| `POST /api/v1/sessions/{session_id}/prompts/{prompt_id}:abort` | Abort a running or queued prompt |
| `POST /api/v1/sessions/{session_id}/prompts/{prompt_id}:steer` | Steer one queued prompt |

#### `GET /api/v1/sessions/{session_id}/prompts`

Reads a snapshot of the main agent's prompt queue. Other agents' queues are not included. Queue changes are not pushed over the WebSocket; read again when you need the latest state.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | Required. Session id |

On success, `data` is `{ active, queued }`: `active` is the running prompt, `null` when idle; `queued` lists the waiting prompts in order. Each prompt object is:

| Field | Type | Description |
| --- | --- | --- |
| `prompt_id` | string | Prompt id |
| `user_message_id` | string | Id of the corresponding user message |
| `status` | string | `running` / `queued` / `blocked` / `failed` |
| `content` | array | Array of content blocks, in the format accepted by `POST /api/v1/sessions/{session_id}/prompts` |
| `created_at` | string | Creation time |
| `metadata` | object | The `metadata` attached when submitting the prompt or activating the skill; optional |

- `40401`: the session does not exist

#### `POST /api/v1/sessions/{session_id}/prompts`

Submits a user prompt to the session. The response does not wait for the turn to finish.

When the target agent is idle, its queue is empty, and it is not in the middle of an undo, a manual compaction, or a fork (only forking an idle agent puts it in this state), the prompt starts a turn immediately, and the response returns once the turn starts (`status` is `running`). Otherwise the prompt is queued, and the response returns immediately with `status` `queued`. Prompts submitted during an undo, compaction, or fork are also queued, not rejected. See [Starting or queueing](./server-api-conversation.md#starting-or-queueing).

The server first validates media references, then applies the overrides to the target agent in the order `model`, `thinking`, `permission_mode`, `swarm_mode`, `disabled_tools`, and finally enqueues the prompt. Overrides take effect when the prompt is accepted, whether or not the prompt is queued, and they persist afterwards. `permission_mode` changes only the target agent; unlike the [profile endpoint](#post-api-v1-sessions-session-id-profile), it is not synced to all agents.

With `skills`, the prompt runs as a bundled skill activation instead of a plain user prompt.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | Required. Session id |
| `content` | body | array | Required. Non-empty array of content blocks; variants below |
| `agent_id` | body | string | Target agent. Default the main agent |
| `prompt_id` | body | string | Client-chosen prompt id that makes the submission idempotent, also with `skills`. Rules below |
| `skills` | body | array | Bundled skill activations, at least 1 entry, each `{ name, path?, args? }`. Every skill must exist and be user-activatable. `path` selects a same-name variant from the session skill catalog |
| `model` | body | string | Model alias to switch to |
| `thinking` | body | string | Thinking effort level |
| `permission_mode` | body | string | `manual` / `yolo` / `auto` |
| `swarm_mode` | body | boolean | Enter or exit swarm mode |
| `disabled_tools` | body | array | Tool names to disable for the session |
| `metadata` | body | object | Client-defined metadata, saved with the prompt and returned in the prompt object's `metadata` |

The schema also accepts `plan_mode`, `goal_objective`, and `goal_control`, but the submit endpoint currently does not apply them.

The idempotency rules for `prompt_id` are as follows; see [Retries and idempotency](./server-api-conversation.md#retries-and-idempotency) for the flow:

- The server uses the endpoint plus the full request body as the request fingerprint; key order does not affect it. The same id with a different fingerprint returns `40927`.
- `/prompts`, `/steer`, and [`skills/{skill_name}:activate`](#post-api-v1-sessions-session-id-skills-skill-name-activate) share one record table within a session, so using the same id on another endpoint also returns `40927`.
- A resend with the same fingerprint returns the first result, waiting for the first request if it is still being processed. A resend does not apply the overrides again.
- When the first request failed before being enqueued, a resend is handled as a new request; when it failed after being enqueued, a resend returns the same error.
- Records are kept only in memory, at most 256 per session; beyond that, the oldest finished records are evicted. Records are cleared when the server restarts or the session is deleted.
- Requests without `prompt_id` have no idempotency protection.

Each `content` block is an object discriminated by `type`:

| Block | Fields | Description |
| --- | --- | --- |
| `text` | `text` | Plain text |
| `image` / `video` | `source` | Media input; forms of `source` below |
| `file` | `file_id`, `name`, `media_type`, `size` | A file attachment uploaded through [`POST /api/v1/files`](./server-api-service.md#file-uploads) |

`source` takes one of these forms:

- `{ kind: "url", url, id? }`
- `{ kind: "base64", media_type, data }`
- `{ kind: "file", file_id }`: an upload from `POST /api/v1/files`
- `{ kind: "session_media", file_id }`: media already committed to this session

The schema also accepts the `tool_use`, `tool_result`, and `thinking` blocks of the shared message format, but they are not meaningful in a user prompt. When a `file_id` reference is unknown or does not match the block's media kind, the server rejects the request before creating the prompt and before applying any override.

On success, `data` is the accepted prompt; see the prompt object in [`GET /api/v1/sessions/{session_id}/prompts`](#get-api-v1-sessions-session-id-prompts) for its shape. A prompt that starts immediately can still end before its turn starts: `status` is `blocked` when a hook rejected the prompt, and `failed` when submission failed before the turn started, for example because a prompt hook errored or an attachment could not be prepared.

- `40001`: validation failure, for example an unknown `model`, a `thinking` level the model does not support, or a `profile` field (the agent profile can only be chosen when the session is created)
- `40110`: no provider is configured yet (finish login first)
- `40111`: the resolved provider has no credential (`details.provider_id`)
- `40112`: the provider's credential was rejected (`details.provider_id`)
- `40113`: the model cannot be resolved (with `details.model_id` / `details.provider_id` when known), or the session has no model and only `thinking` is set without `model`
- `40401`: the session does not exist
- `40407`: a referenced `file_id` does not exist, or does not match the block's media kind
- `40415`: a `skills` entry points to an unknown skill
- `40912`: the skill exists but cannot be activated by the user
- `40927`: `prompt_id` is already used by another request

#### `POST /api/v1/sessions/{session_id}/steer`

Steers message content directly into the active turn. It takes one request, with no need to submit a prompt first and then steer it by id.

When the target agent has no running turn, it behaves like a plain submission. When a turn is running, the response returns after the message is actually inserted at the next steering point; if that turn ends first, the response returns once the follow-up turn starts. See [Steering](./server-api-conversation.md#steering).

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | Required. Session id |

The body fields are the same as [`POST /api/v1/sessions/{session_id}/prompts`](#post-api-v1-sessions-session-id-prompts), including `content`, `agent_id`, `prompt_id`, `skills`, `model`, `thinking`, `permission_mode`, `swarm_mode`, `disabled_tools`, and `metadata`. Media references and bundled skills also reuse the validation and preparation flow of prompt submission.

The order and effect of applying overrides and the `prompt_id` idempotency rules are the same as for prompt submission.

On success, `data` has the same shape as the accepted prompt returned by prompt submission. Errors also match prompt submission, including validation, media, environment, and idempotency errors.

#### `POST /api/v1/sessions/{session_id}/prompts:steer`

Steers queued prompts into the active turn, so the running turn consumes them immediately instead of waiting for the current turn to finish.

Available only when the main agent has a running turn. Without a running turn, it returns `40402` even if the prompts are in the queue. Multiple ids are validated as a whole: when any id is not in the queue or appears more than once, no prompt is steered.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | Required. Session id |
| `prompt_ids` | body | array | Required. Non-empty array of queued prompt ids |

On success, `data` is `{ steered: true, prompt_ids }`.

- `40001`: validation failure
- `40401`: the session does not exist
- `40402`: the main agent has no running turn, or an id is not in the queue or appears more than once

#### `POST /api/v1/sessions/{session_id}/prompts/{prompt_id}:abort`

Aborts one of the main agent's prompts:

- When the prompt is running, the effect is the same as stopping the current turn with [`:abort`](#post-api-v1-sessions-session-id-abort).
- When the prompt is queued, it is removed from the queue; no turn is produced and no frame is sent.
- When the prompt has ended or the id is unknown, `40402` is returned.

This endpoint and `:steer` below go through one route, `POST /api/v1/sessions/{session_id}/prompts/{tail}`: `{tail}` is parsed as `{prompt_id}:{action}`, and a missing or unknown action returns `40001` (`unsupported action: ...`).

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | Required. Session id |
| `prompt_id` | path | string | Required. Prompt id |

On success, `data` is `{ aborted: true }`.

- `40401`: the session does not exist
- `40402`: the prompt has ended, or there is no prompt with that id

#### `POST /api/v1/sessions/{session_id}/prompts/{prompt_id}:steer`

Steers one queued prompt into the active turn; the single-prompt form of [`POST /api/v1/sessions/{session_id}/prompts:steer`](#post-api-v1-sessions-session-id-prompts-steer). It is also available only when the main agent has a running turn.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | Required. Session id |
| `prompt_id` | path | string | Required. Queued prompt id |

On success, `data` is `{ steered: true, prompt_ids: [prompt_id] }`.

- `40401`: the session does not exist
- `40402`: the main agent has no running turn, or there is no queued prompt with that id

### Approvals and questions

Approvals and questions are the two kinds of interaction in a session that wait for a user answer: an approval asks permission for a tool call, and a question asks for structured input with labeled options. Pending interactions arrive as WebSocket `interaction` frames (see [Approvals and questions](./server-api-conversation.md#approvals-and-questions)), and clients answer them with the endpoint below.

| Method and path | Description |
| --- | --- |
| `POST /api/v1/sessions/{session_id}/interactions/{interaction_id}` | Answer a pending approval or question |

#### `POST /api/v1/sessions/{session_id}/interactions/{interaction_id}`

Answers a pending interaction, letting the waiting tool call continue. The body's `kind` must match the interaction's type.

The first answer wins; later answers return `40902`. The server remembers only interactions that ended within the last 60 seconds, at most 256 of them; answering beyond that returns `40404`. Clients should treat both error codes as "the interaction has ended". See [Approvals and questions](./server-api-conversation.md#approvals-and-questions) for the flow.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | Required. Session id |
| `interaction_id` | path | string | Required. The `interaction_id` from the `interaction` frame |
| `kind` | body | string | Required. `approval` or `question` |

To answer an approval, use these fields:

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `decision` | body | string | Required. `approved` / `rejected` / `cancelled` |
| `scope` | body | string | Used with `approved`. The only value is `session`, which remembers the approval rule for the rest of the session |
| `feedback` | body | string | Free-form feedback passed back to the agent |
| `selected_label` | body | string | The label of the chosen option, when the request offered labeled options (for example a plan review) |

To answer a question, use exactly one of `answers` and `dismissed`:

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `answers` | body | object | Map from question item `id` (from `request.questions` in the frame) to an answer object; answer variants in the table below |
| `dismissed` | body | boolean | When `true`, dismisses the question without answering |
| `method` | body | string | How the answer was produced: `enter` / `space` / `number_key` / `click` |

Each answer is an object discriminated by `kind`:

| `kind` | Fields | Description |
| --- | --- | --- |
| `single` | `option_id` | One chosen option |
| `multi` | `option_ids` | Several chosen options, at least 1 |
| `other` | `text` | A free-text answer |
| `multi_with_other` | `option_ids`, `other_text` | Options plus free text |
| `skipped` | — | The item was skipped |

The server does not validate question answers: an unknown option id is passed to the agent as-is as answer text, and an unknown question item id is kept as-is as a key.

On success, `data` is `{ outcome, ended_at }`: for an approval, `outcome` is `approved` / `rejected` / `cancelled`; for a question, `answered` / `dismissed`. Subscribers also receive the interaction's last `interaction` frame.

- `40001`: validation failure (`details` lists each field), or `kind` does not match the interaction's type
- `40401`: the session does not exist
- `40404`: no interaction with that id in the session, including interactions that ended more than 60 seconds ago or fell beyond the record limit
- `40902`: the interaction has already ended
