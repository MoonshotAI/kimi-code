# Workflow — propose and run a dynamic workflow

Dynamic workflows orchestrate multiple subagents from a user-approved JavaScript script: sequential phases, parallel fan-out, pipelines, and structured per-agent results validated by JSON Schema. Use this tool when the user asks for a "workflow" (a large, multi-phase task that benefits from several coordinated subagents), or to run a workflow already saved in the project or user scope.

Calling this tool is a PROPOSAL: nothing executes before the user explicitly approves the run. The approval prompt shows the workflow name, description, phases, consumption warning, limits, and the full script. Runs execute in the background and do not block the current turn.

## Input

Provide exactly one of:

- `name`: the name of a saved workflow (from the project `.kimi-code/workflows` or user `~/.kimi-code/workflows` directories, or a builtin such as `deep-research`).
- `script`: the full text of a new workflow script you wrote for the user's task.

`args` is an optional argument string delivered to the script as the `args` variable.

## Script format

A workflow script is a JavaScript module whose FIRST statement is `export const meta = { name, description, whenToUse?, phases: [{ title, detail? }] }`, followed by top-level async code that drives the run and ends with `return <JSON-serializable result>`. The script runs in a restricted sandbox — no Node.js APIs (no `process`, `require`, filesystem, network, or timers). Orchestration happens ONLY through the injected API:

- `args: string` — the argument string passed to the run.
- `phase(title)` — mark the current phase (progress is reported per phase).
- `log(message)` — append a progress log line.
- `agent(prompt, { label?, phase?, schema? })` — run a subagent with the given prompt. Subagent tool calls go through the normal permission system. With `schema` (a JSON Schema object) the result is the agent's structured output, parsed and validated; without it, the result is the agent's final text. Returns `null` when the user refused or skipped that call — handle abstentions explicitly. Rejects on hard errors (you may catch them for partial results).
- `parallel(fns)` — run an array of `() => Promise` functions concurrently (actual concurrency is bounded by the run limits) and resolve to the array of results.
- `pipeline(items, ...stages)` — flow each item through the stages in sequence; items advance independently (no barrier between items). A stage returning `null`/`undefined` skips the remaining stages for that item and yields `null` for it. Resolves to the array of per-item results in input order.

Phases, logs, and per-agent progress are visible to the user live. The final `return` value is delivered as the run result.

## Rules

- NEVER claim the run finished, succeeded, or failed from this tool's result alone — this tool only STARTS the run. The user watches progress live; the terminal status arrives via background-task completion.
- Script size, agent-call count, concurrency, and duration are bounded by safe limits; design scripts to fit (e.g. cap fan-out widths).
- Keep scripts self-contained: all prompts must inline the context each subagent needs — subagents do not see this conversation.
