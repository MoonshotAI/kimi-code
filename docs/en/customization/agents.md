# Agents and Sub-Agents

Every session in Kimi Code CLI is driven by a **main Agent**. The main Agent understands the user's intent, plans steps, calls tools, and when needed dispatches **sub-agents** to handle more focused sub-tasks — for example, exploring an unfamiliar codebase, reviewing multiple implementations in parallel, or planning a large refactor without touching the main context.

A sub-agent receives a task description from the main Agent, works in its own isolated context, and then returns its conclusions. It does not communicate with the user directly, and its intermediate reasoning and tool call records do not mix into the main Agent's history.

## Built-in Sub-Agents

Kimi Code CLI includes three built-in sub-agents, ready to use out of the box, each aimed at a different task shape:

- **`coder`**: The default sub-agent — a general-purpose software engineering assistant that can read and write files, execute commands, search code, and land concrete changes.
- **`explore`**: Dedicated to codebase exploration; performs read-only operations only and does not modify any files. Ideal for quickly searching, reading, and summarizing a repository without touching files.
- **`plan`**: Dedicated to implementation planning and architecture design; even shell commands are not available, keeping the focus on "figuring out how to do something" rather than "actually doing it."

A `coder` sub-agent shares most of the main Agent's tool set: it can run shell commands in the background, maintain todo lists, enter Plan mode, invoke Agent Skills, and dispatch its own nested sub-agents when a task decomposes naturally. If it finishes its turn while background tasks are still running, its run only reports completion after those tasks settle, so the parent receives the result after the underlying work has actually finished.

## How to Invoke

Sub-agents are scheduled automatically by the main Agent — based on task complexity, context consumption, and sub-task independence, they are dispatched at the right moment without the user having to specify one.

Each dispatch is presented in the terminal as an approval request (unless it matches an allow rule or YOLO mode is active), giving you a chance to review the task description. You can also instruct the main Agent directly in conversation to use a specific sub-agent, for example: "Use explore to map out the relevant files before making any changes."

Sub-agents support running in the background: results are automatically returned to the main Agent upon completion, with no manual polling needed. You can also call back an existing sub-agent instance to continue the same task.

## Context Isolation and Resource Cost

Each sub-agent has a fully independent context window. It can only see the task description explicitly passed by the main Agent and cannot see the main Agent's conversation history. The sub-agent's own intermediate reasoning and tool call records do not flow back; only the final result appears in the main Agent's context.

This isolation provides two benefits:

- **The main Agent's context stays lean** and is not filled with large volumes of exploratory logs during long sessions.
- **Multiple sub-agents can run in parallel** without interfering with each other.

Note that each sub-agent independently consumes model tokens. For simple tasks, there is no need to dispatch a sub-agent — the main Agent handles them more economically.

## Permission Inheritance

Sub-agent permission rules are inherited from the main Agent: "always allow" rules that the main Agent has accepted via `/permission` or through an approval dialog automatically propagate to all sub-agents it dispatches, so sub-agents do not need to re-approve the same types of tool calls. The `Agent` tool itself is allowed by default, enabling the main Agent to delegate multiple times without interrupting the user.

If you need a particular type of tool to be permanently unavailable inside sub-agents, tighten the corresponding permission rule on the main Agent.

## Custom Agents

Beyond the three built-in sub-agents, you can define your own agents as Markdown files. Each file describes one agent: the frontmatter (YAML metadata at the top of the file) declares its name, description, and tool access, and the file body is its system prompt. Custom agents can be delegated to as sub-agents — the main Agent discovers them automatically alongside the built-in ones — or selected as the main Agent at startup.

### Agent Locations

Kimi Code CLI discovers agent files by scope; more specific scopes take higher priority: **Project > Extra > User > Built-in**. When two files define the same `name`, the higher-priority scope wins. Each directory is scanned recursively for `.md` files.

**User level** (applies to all projects):
- `$KIMI_CODE_HOME/agents/` (default: `~/.kimi-code/agents/`)
- `~/.agents/agents/`

The Kimi-specific user agent directory moves with `KIMI_CODE_HOME`, while the generic `~/.agents/agents/` directory stays under the real OS home so it can be shared across tools.

**Project level** (project root = the nearest directory containing `.git`, searching upward from the working directory):
- `.kimi-code/agents/`
- `.agents/agents/`

**Extra directories**: Declared via `extra_agent_dirs` at the top level of `config.toml`:

```toml
extra_agent_dirs = ["~/team-agents", ".agents/team-agents"]
```

**Built-in agents** are distributed with the CLI and have the lowest priority. A directory-discovered file does not override a same-name built-in Agent unless its frontmatter declares `override: true`. A file loaded through `--agent-file` is treated as explicit launch intent, may override a same-name built-in Agent, outranks every directory scope, and applies to the current launch only.

### Agent File Format

An agent file is plain Markdown with a frontmatter block:

```markdown
---
name: reviewer
description: Strict code reviewer that reports severity-ranked findings
whenToUse: Code reviews and PR checks
override: false
mode: replace
tools:
  - Read
  - Grep
  - Glob
  - mcp__github__*
disallowedTools:
  - Bash
---

You are a strict code reviewer. Read the diff, then report findings grouped by severity…
```

| Field | Required | Description |
| --- | --- | --- |
| `name` | yes | Unique identifier in kebab-case. Files without a valid `name` are skipped with a warning |
| `description` | yes | What the agent does. Shown to the main Agent when it picks a sub-agent, so write it to guide delegation decisions |
| `whenToUse` | no | Extra hint describing when the agent should be used |
| `override` | no | Whether this file may replace a same-name built-in Agent. Defaults to `false`; `--agent-file` is already explicit and does not require this field |
| `mode` | no | `replace` (default): the body is the agent's entire system prompt. `append`: the body is added to the default system prompt, keeping workspace instructions and Skill injections in effect |
| `tools` | no | Allowlist of tool names such as `Read` or `Bash`; MCP tools are matched with globs such as `mcp__github__*`. Omit to allow all tools; an empty list (`tools: []`) disables all tools |
| `disallowedTools` | no | Denylist with the same matching rules, applied after `tools` |

Unknown fields are ignored, so newer files stay readable by older versions.

A file with invalid content discovered in a directory is skipped with a warning and does not affect other files. A file passed explicitly via `--agent-file` must be valid — otherwise the CLI reports the error and exits.

::: warning Note
`tools` and `disallowedTools` only shape which tools the model is told about — they are not an execution-time sandbox. For a hard guarantee that a tool cannot run, tighten the corresponding permission rule instead.
:::

Custom agents delegated as sub-agents run without the built-in sub-agent framing ("your final message is the entire handoff"). If you write an agent meant for delegation, state in the body that its last message should be the complete, self-contained result for the caller.

### Selecting the Main Agent

Two CLI flags select which agent drives the session. **Both currently require the v2 engine** — `kimi -p` with `KIMI_CODE_EXPERIMENTAL_FLAG=1`; the interactive TUI (v1) rejects them with a clear error for now:

- **`--agent <name>`**: Start the session with the named agent as the main Agent. The name can refer to a built-in agent or to any discovered file; an unknown name fails with an error listing the available agents.
- **`--agent-file <path>`**: Load one agent file at the highest priority for this launch and start with it. Repeat the flag to register several files — without `--agent`, the profile defined by the last `--agent-file` is selected — and combine it with `--agent <name>` to choose among them by name.

For example, in print mode:

```sh
KIMI_CODE_EXPERIMENTAL_FLAG=1 kimi -p --agent reviewer "Review the changes on this branch"
```

The bound agent is the session's identity: it is fixed at the session's first bind and cannot be switched later. Re-selecting the already-bound agent (for example resuming with the same `--agent`) is a no-op; selecting a different one fails with an "already bound" error.

For main-agent customization, prefer `mode: append` so the environment, workspace-instruction, and Skill injections stay in effect; `mode: replace` fits self-contained sub-agents that own their entire prompt.

### Overriding the main agent's system prompt with SYSTEM.md

To override the main agent's system prompt permanently — without passing `--agent` or `--agent-file` on every launch — write a `$KIMI_CODE_HOME/SYSTEM.md` file (default: `~/.kimi-code/SYSTEM.md`; it moves with `KIMI_CODE_HOME`). While the file exists and is non-empty, it replaces the built-in default main agent's system prompt in full — and only the prompt: the description and tool set are inherited from the built-in defaults. Like `--agent` / `--agent-file`, SYSTEM.md currently takes effect only under the v2 engine (`KIMI_CODE_EXPERIMENTAL_FLAG=1`); the v1 engine ignores the file.

SYSTEM.md is a plain Markdown body — no frontmatter is required or read. A missing or empty file has no effect, and a read failure falls back to the built-in prompt with a warning. Explicit intent still outranks it: a project-scoped same-name agent file declaring `override: true` and any file passed via `--agent-file` take precedence, and selecting another agent with `--agent` bypasses it entirely. Within the user scope itself, SYSTEM.md wins over a same-name file discovered in the `agents/` directories.

Unlike a regular agent file whose body is used as-is, SYSTEM.md is rendered as a template each time the prompt is built — `${var}` placeholders in the body are substituted:

| Variable | Content |
| --- | --- |
| `${skills}` | The merged Agent Skills injection; empty when the `Skill` tool is unavailable |
| `${agents_md}` | Content of the workspace instruction files (such as `AGENTS.md`) |
| `${cwd}` | Current working directory |
| `${cwd_listing}` | Listing of the working directory |
| `${os}` | Operating system kind |
| `${shell}` | Shell name and path, for example `bash (\`/bin/bash\`)` |
| `${now}` | Current time in ISO format |

Unknown variables stay verbatim, a bare `$` is never special, and a variable with no context value renders as an empty string. The variables are enough to rebuild the skeleton of the built-in prompt, for example:

```markdown
You are Kimi, running at ${cwd} on ${os}.

${agents_md}

${skills}
```

## Instruction Files

Global Kimi-specific instructions can live at `$KIMI_CODE_HOME/AGENTS.md` (default: `~/.kimi-code/AGENTS.md`). When you relocate the data root with `KIMI_CODE_HOME`, this global instruction file moves with it. Generic cross-tool instructions can still live under `~/.agents/AGENTS.md` in the real OS home, and project-level instructions remain under the project tree, for example `.kimi-code/AGENTS.md` or `AGENTS.md`.

## Storage Location in the Session Directory

Sub-agent runtime state is persisted to the `agents/` subdirectory of the current session directory. Each sub-agent instance has its own directory, which contains a `wire.jsonl` file that records prompts, message history, and final state in chronological order. Background sub-agents also expose their lifecycle status through a `tasks/` subdirectory.

::: warning Note
Session directories, wire files, and task records are all local debug materials that may contain user prompts, command output, repository paths, tool return values, or traces of credentials. Do not commit these files directly to public repositories, issues, or chat logs; redact sensitive information before sharing.
:::

## Next steps

- [Hooks](./hooks.md) — Trigger local script notifications or interceptions at key points such as sub-agent completion
- [Agent Skills](./skills.md) — Inject specialized knowledge and workflows into sub-agents
