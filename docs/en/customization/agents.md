# Agents and Sub-Agents

Every session in Kimi Code CLI is driven by a **main Agent**. The main Agent understands the user's intent, plans steps, calls tools, and when needed dispatches **sub-agents** to handle more focused sub-tasks — for example, exploring an unfamiliar codebase, reviewing multiple implementations in parallel, or planning a large refactor without touching the main context.

A sub-agent receives a task description from the main Agent, works in its own isolated context, and then returns its conclusions. It does not communicate with the user directly, and its intermediate reasoning and tool call records do not mix into the main Agent's history.

## Built-in Sub-Agents

Kimi Code CLI includes three built-in sub-agents, ready to use out of the box, each aimed at a different task shape:

- **`coder`**: The default sub-agent — a general-purpose software engineering assistant that can read and write files, execute commands, search code, and land concrete changes.
- **`explore`**: Dedicated to codebase exploration; performs read-only operations only and does not modify any files. Ideal for quickly searching, reading, and summarizing a repository without touching files.
- **`plan`**: Dedicated to implementation planning and architecture design; even shell commands are not available, keeping the focus on "figuring out how to do something" rather than "actually doing it."

## How to Invoke

Sub-agents are scheduled automatically by the main Agent — based on task complexity, context consumption, and sub-task independence, they are dispatched at the right moment without the user having to specify one.

Each dispatch is presented in the terminal as an approval request (unless it matches an allow rule or YOLO mode is active), giving you a chance to review the task description. You can also instruct the main Agent directly in conversation to use a specific sub-agent, for example: "Use explore to map out the relevant files before making any changes."

Sub-agents support running in the background: results are automatically returned to the main Agent upon completion, with no manual polling needed. You can also call back an existing sub-agent instance to continue the same task.

## Context Isolation and Resource Cost

Each sub-agent has a fully independent context window. It can only see the task description explicitly passed by the main Agent and cannot see the main Agent's conversation history. The sub-agent's own intermediate reasoning and tool call records do not flow back; only the final result appears in the main Agent's context.

This isolation provides two benefits:

- **The main Agent's context stays lean** and is not filled with large volumes of exploratory logs during long sessions.
- **Multiple sub-agents can run in parallel** without interfering with each other.

Note that each sub-agent independently consumes model tokens. For simple tasks, there is no need to dispatch a sub-agent — the main Agent handles them more economically. Sub-agents also cannot themselves schedule further nested sub-agents.

## Permission Inheritance

Sub-agent permission rules are inherited from the main Agent: "always allow" rules that the main Agent has accepted via `/permission` or through an approval dialog automatically propagate to all sub-agents it dispatches, so sub-agents do not need to re-approve the same types of tool calls. The `Agent` tool itself is allowed by default, enabling the main Agent to delegate multiple times without interrupting the user.

If you need a particular type of tool to be permanently unavailable inside sub-agents, tighten the corresponding permission rule on the main Agent.

## Instruction Files

Global Kimi-specific instructions can live at `$KIMI_CODE_HOME/AGENTS.md` (default: `~/.kimi-code/AGENTS.md`). When you relocate the data root with `KIMI_CODE_HOME`, this global instruction file moves with it. Generic cross-tool instructions can still live under `~/.agents/AGENTS.md` in the real OS home, and project-level instructions remain under the project tree, for example `.kimi-code/AGENTS.md` or `AGENTS.md`.

## System Prompt Override

You can replace the default system prompt (the high-level behavior profile sent to the model at the start of every turn) with your own text. This is useful when you want a consistent persona, coding style, or set of ground rules across all sessions.

Two override files are supported:

- **Global**: `$KIMI_CODE_HOME/sysprompt.md` (default: `~/.kimi-code/sysprompt.md`)
- **Project-level**: `.kimi-code/sysprompt.md` in the current working directory

If a project-level file exists, it takes precedence over the global file. If neither exists, the CLI falls back to its built-in profile system prompt. The file content is used verbatim, so write it as plain Markdown text.

::: tip Note
`AGENTS.md` is appended as supplementary context; `sysprompt.md` replaces the entire system prompt. You can use both together — for example, put your base persona in `sysprompt.md` and project-specific conventions in `AGENTS.md`.
:::

## Session-Level Sampling Overrides

Use the `/spiceup` slash command to override model sampling parameters for the current session. The values take effect immediately, last until the session ends, override any defaults from `config.toml`, and are inherited by every sub-agent spawned in the session.

The dialog lets you adjust:

- **Temperature** — `0.0` (deterministic) to `2.0` (very random)
- **Top P** — nucleus-sampling cutoff (`0.0`–`1.0`)
- **Top K** — limit the token pool to the top K candidates
- **Max tokens** — maximum tokens to generate
- **Frequency penalty** — penalize repeated tokens (`-2.0`–`2.0`)
- **Presence penalty** — penalize repeated topics (`-2.0`–`2.0`)

Leave a field empty to clear that override. When all fields are empty, `/spiceup` removes every session-level sampling override and the model reverts to the values from `config.toml`.

## Storage Location in the Session Directory

Sub-agent runtime state is persisted to the `agents/` subdirectory of the current session directory. Each sub-agent instance has its own directory, which contains a `wire.jsonl` file that records prompts, message history, and final state in chronological order. Background sub-agents also expose their lifecycle status through a `tasks/` subdirectory.

::: warning Note
Session directories, wire files, and task records are all local debug materials that may contain user prompts, command output, repository paths, tool return values, or traces of credentials. Do not commit these files directly to public repositories, issues, or chat logs; redact sensitive information before sharing.
:::

## Next steps

- [Hooks](./hooks.md) — Trigger local script notifications or interceptions at key points such as sub-agent completion
- [Agent Skills](./skills.md) — Inject specialized knowledge and workflows into sub-agents
