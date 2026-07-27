# Dynamic Workflows

Dynamic workflows orchestrate multiple subagents from a single user-approved JavaScript script. The script runs in phases, fans out subagents in parallel (starting several at once and waiting for all of them), pipelines items through processing stages, validates structured output against JSON Schema (a standard format for describing the expected shape of JSON data), and returns a final result. They are built for large, multi-step tasks — for example, researching a question across many sources or auditing a whole repository — that would otherwise take many manual turns.

> Dynamic workflows are an experimental feature and consume significantly more tokens than a normal session. Enable them only when you need this kind of orchestration.

::: warning Note
A workflow script runs in a sandbox (an isolated environment that restricts what the script can access), but the sandbox is a control boundary, not a security barrier. Every workflow run therefore requires your explicit approval before anything executes.
:::

## Enabling dynamic workflows

The feature is gated by the `dynamic-workflows` experimental flag and is off by default. Enable it in one of three ways:

- Open the experimental feature panel with `/experiments` (Settings → Experiments) and turn on **Dynamic workflows**.
- Set the environment variable `KIMI_CODE_EXPERIMENTAL_DYNAMIC_WORKFLOWS=1` before starting Kimi Code CLI.
- Add `dynamic-workflows = true` under `[experimental]` in `config.toml`.

## Writing a workflow script

A workflow is a `.js` file. Its first statement exports a `meta` object describing the workflow; the rest of the file is a top-level async body that drives the orchestration:

```js
export const meta = {
  name: 'repo-audit',
  description: 'Review repository areas in parallel and summarize the findings',
  whenToUse: 'When the user asks for a broad audit of the repository',
  phases: [
    { title: 'Review', detail: 'Fan out one reviewer per area' },
    { title: 'Summarize' },
  ],
};

phase('Review');
const reports = await parallel([
  () => agent('Review src/auth for security issues', { label: 'auth' }),
  () => agent('Review src/api for security issues', { label: 'api' }),
]);

phase('Summarize');
return await agent(`Summarize these audit reports: ${JSON.stringify(reports)}`);
```

`meta.name` is required, must be kebab-case, and must match the file name (without the `.js` extension). `meta.description` tells the model what the workflow does, the optional `meta.whenToUse` describes when to reach for it, the optional `meta.argumentHint` hints at the expected arguments in the autocomplete popup, and `meta.phases` declares the phase list shown in the confirmation dialog and the run browser.

### The sandbox API

The script body orchestrates subagents through a small set of globals:

- `args`: the argument string passed at invocation, for example the `<question>` in `/workflow run deep-research <question>`
- `phase(title)`: mark the current phase; the title should come from `meta.phases`
- `log(message)`: append a message to the run's log
- `agent(prompt, { label?, phase?, schema? })`: run one subagent with the given prompt. The subagent goes through the normal permission system, so its tool calls are approved the same way as in a regular session. With a `schema` (a JSON Schema), the subagent returns a validated object instead of free text. If you decline the subagent's approval request, `agent()` returns `null`; on failure it throws
- `parallel(fns)`: run the given functions concurrently and wait for all results
- `pipeline(items, ...stages)`: pass each item through the stages in order. Items flow independently — there is no barrier between stages — and a stage returning `null` skips the remaining stages for that item
- `return <value>`: end the workflow with a final result; the value must be JSON-serializable

The sandbox has no Node.js APIs: no `process`, `require`, `fs`, network access, or timers. Standard JavaScript built-ins such as `URL`, `URLSearchParams`, `TextEncoder`, `TextDecoder`, `JSON`, and `Math` are available.

## Workflow locations

Kimi Code CLI scans workflow directories across four scopes; more specific scopes take higher priority: **Project > User > Extra > Built-in**. Within a scope, the Kimi-specific (brand) directory wins over the generic one.

**Project level** (project root = the nearest directory containing `.git`, searching upward from the working directory):
- `.kimi-code/workflows/`
- `.agents/workflows/`

**User level** (applies to all projects):
- `$KIMI_CODE_HOME/workflows/` (default: `~/.kimi-code/workflows/`)
- `~/.agents/workflows/`

The Kimi-specific user workflow directory moves with `KIMI_CODE_HOME`, so isolated data roots also get isolated workflows. The generic `~/.agents/workflows/` directory stays under the real OS home so it can be shared across tools.

**Extra directories**: Declared via `extra_workflow_dirs` under `[workflows]` in `config.toml`:

```toml
[workflows]
extra_workflow_dirs = ["~/team-workflows"]
```

**Built-in workflows** are distributed with the CLI and have the lowest priority; see [Built-in `deep-research` workflow](#built-in-deep-research-workflow).

A workflow file with invalid content — for example a missing or malformed `meta` block — is skipped with a warning that states the reason, and does not affect other workflows.

## Running a workflow

### Kimi Code CLI (TUI)

The `/workflow` slash command (alias `/workflows`) manages workflows from the TUI:

| Command | Description |
| --- | --- |
| `/workflow list` | List all discovered workflows |
| `/workflow run <name> [args]` | Run a workflow by name, passing `args` to the script |
| `/workflow runs` | Open the run browser (see [Monitoring runs](#monitoring-runs)) |
| `/workflow show <name>` | Show a workflow's metadata and script |
| `/workflow cancel <runId>` | Cancel a running workflow |
| `/workflow save <runId> [--user]` | Save the script of a run for reuse (see [Saving a workflow for reuse](#saving-a-workflow-for-reuse)) |
| `/workflow reload` | Rescan the workflow directories |
| `/workflow on` | Enable Dynamic Workflow mode (see below) |
| `/workflow off` | Disable Dynamic Workflow mode |

When you type `/workflow run ` the autocomplete popup lists the available workflows with their argument hints, so you can quickly find the workflow you need. `/workflow` without arguments opens the run browser directly.

You can also just ask Kimi in natural language to create or run a workflow — for example, "research how our auth flow handles token refresh with a workflow". The model then proposes the run through the `Workflow` tool, and nothing executes before your approval.

Whether a run comes from `/workflow run` or from the model, execution always starts with a confirmation dialog showing the workflow's name, description, and phases, a warning about token consumption, the configured limits, and an option to inspect the full script. The workflow runs only after you explicitly confirm.

### Kimi Code Web UI

Workflow management is also available in the **Kimi Code Web UI** through a dedicated graphical interface. Open it with the `/workflow` command in the chat composer or by clicking the **Workflow** toggle under the Mode menu in the composer toolbar.

The **Workflow Hub** dialog provides two tabs:

- **Catalog**: Browse all discovered workflows (built-in, project, and user workflows). Each entry shows its name, description, source badge, phase list, and a **Run Now** button. Clicking a workflow expands full details including the script.
- **Runs**: Monitor active and historical workflow runs. Each run displays its status badge (Running / Completed / Failed / Cancelled), current phase, agent call count, timestamps, and the last log lines. Active runs can be cancelled directly from the dialog.

When a workflow is running, an **active run strip** appears at the bottom of the chat dock showing the workflow name, current phase, and a cancel button. It auto-refreshes every 2 seconds so you can follow progress without opening the hub.

The **Workflow mode** toggle in the composer's mode menu (next to Plan, Swarm, and Goal) instructs the agent to prefer writing workflow scripts for large or multi-step tasks. When enabled, a "Workflow" badge appears in the composer toolbar, and the agent receives the "You are in dynamic workflow mode" system instruction.

All workflow operations in the Web UI use the same backend endpoints as the CLI, so runs started from either interface are visible in both.

## Monitoring runs

Workflow runs execute in the background and never block your session. `/workflow runs` opens the run browser, which lists every run with its status, the current phase (`N/M`), the number of agent calls made so far, and its log output, plus the final result or error once the run finishes. Keyboard shortcuts in the browser let you cancel a run, save its script, or view the script.

Workflow start and completion events also appear directly in the conversation, and each run shows up in `/tasks` as a background task of kind `workflow`, alongside other background work. The tasks browser shows the workflow name, current phase progress, and agent call count for workflow tasks.

## Dynamic Workflow mode

When enabled via `/workflow on` or the **Workflow** toggle in the Web UI composer's Mode menu, **Dynamic Workflow mode** instructs the model to analyse the task first and, for large or multi-phase tasks, propose a dynamic workflow script (via the `Workflow` tool) instead of executing directly. The proposal goes through the same confirmation dialog as any other workflow — nothing runs before you approve.

A `Dynamic Workflow` label in the terminal footer (CLI) or a `Workflow` badge in the composer toolbar (Web UI) shows that the mode is active. Disable it at any time with `/workflow off` or the mode toggle.

Dynamic Workflow mode composes with all existing modes:
- **Plan mode**: while planning, the agent reads the codebase and writes a plan; when you exit plan mode, the agent can convert the approved plan into a workflow script.
- **Swarm mode**: swarm fans out independent subagents; workflow mode orchestrates sequenced phases. They are independent and can be active together.
- **Goal mode**: the goal drives autonomous turns; inside a turn the agent may create a workflow, which then runs in the background while the goal continues.
- **Permission**: every workflow run still requires explicit approval (the `workflow-run-review-ask` policy); in `auto` mode the policy approves automatically, matching the semantics of goal and swarm.

## Saving a workflow for reuse

When a run's script turns out to be useful — including one the model wrote ad hoc from a natural-language request — save it while the run is active or after it finishes:

```sh
/workflow save <runId>          # save into the project (.kimi-code/workflows/)
/workflow save <runId> --user   # save into your user directory (~/.kimi-code/workflows/)
```

A saved workflow becomes a regular discovered workflow and can be executed by name with `/workflow run <name> [args]`.

## Built-in `deep-research` workflow

Kimi Code CLI ships one predefined built-in workflow, `deep-research`: multi-source deep research with adversarial verification. It works through five phases — Scope, Search, Fetch, Verify, and Synthesize — and cross-checks what it finds before writing the final report.

```sh
/workflow run deep-research How does our billing service handle proration?
```

## Configuration

The `[workflows]` section of `config.toml` tunes run limits and declares extra workflow directories:

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `max_concurrency` | `integer` | `4` | Maximum number of subagents a workflow runs concurrently (`1`–`16`) |
| `max_agent_calls` | `integer` | `50` | Maximum number of `agent()` calls a single run may make |
| `max_duration_ms` | `integer` | `1800000` (30 minutes) | Maximum wall-clock time (milliseconds) of a single run |
| `max_script_bytes` | `integer` | `262144` (256 KB) | Maximum size in bytes of a workflow script; larger files are skipped during discovery |
| `extra_workflow_dirs` | `array<string>` | — | Additional workflow directories, scanned at the extra scope |

See [Config Files — `workflows`](../configuration/config-files.md#workflows) for the full field reference.

## Failure behavior

Workflows never report false success. A failing subagent throws out of `agent()`, a declined approval request comes back as `null` so the script can abstain explicitly, and cancelling a run stops it as cancelled rather than completed. If a run ends early — through an error, a limit, or cancellation — the run browser reports the partial result together with the reason.

## Current limitations

- Dynamic workflows are experimental: the script format and the `/workflow` subcommands may change between releases.
- Only `.js` scripts in the format documented on this page are supported; workflow scripts are not compatible with Claude Code.
- Natural-language requests always produce a proposal first — the model never executes a workflow directly without your confirmation.

## Next steps

- [Agents and Subagents](./agents.md) — How subagents work and how to customize them
- [Agent Skills](./skills.md) — A lighter-weight way to package reusable instructions
- [Config Files](../configuration/config-files.md#workflows) — Full `[workflows]` field reference
- [Slash Commands](../reference/slash-commands.md#dynamic-workflows) — `/workflow` subcommand reference
