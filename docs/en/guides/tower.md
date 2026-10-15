# Tower multi-agent collaboration

Tower is an experimental multi-agent collaboration mode. It splits larger development tasks into missions (subtasks) that workers execute asynchronously in parallel within a Git repository, reducing the time spent waiting on sequential work.

Once enabled, the main agent becomes the tower and coordinates these workers. While workers run in the background, you can check progress, ask the tower to relay messages, redirect work or reprioritize, and stop any agent at any time.

The tower also arranges independent reviews of each worker's completed changes. Every mission has its own branch and Git worktree. Workers develop and commit in their respective worktrees, while reviewers inspect the corresponding branches read-only. The tower routes messages and completion reports, and merges only branches that pass its checks.

Tower is therefore neither an ordinary subagent call nor an AgentSwarm task. You must enable it explicitly. It persists repository state during collaboration and provides merge checks and cleanup commands. Tower's strengths are **responsiveness** and **parallel development**.

::: warning
Only the tower coordinator supports Ask When Needed. Workers and reviewers run automatically with Never Ask permissions and do not request approval for individual actions.
:::

## When Tower fits

Use Tower when the work can run in parallel and you are comfortable with the extra token consumption and disk usage.

Good candidates include:

- The task can be split into relatively independent missions with clear verification methods, so parallel work reduces waiting time.
- Requirements are still evolving and you expect to provide new input, redirect work, or change priorities frequently.
- You want every fix reviewed carefully, with its own branch and corresponding review.

## Enable Tower

Tower is off by default. Enable the experiment in one of the following ways.

For a persistent setting, add this to `config.toml` (by default, `~/.kimi-code/config.toml`; see [Config files](../configuration/config-files.md)):

```toml
[experimental]
tower = true
```

You can also enable **Tower mode** in `/experiments` and apply the change for the same effect. To enable it only for the current process, set this environment variable before launch:

```sh
KIMI_CODE_EXPERIMENTAL_TOWER=1 kimi
```

Set the environment variable before launch. If you modify `/experiments` or `config.toml` while Kimi Code is running, restart Kimi Code: Tower tools and the worker profile load only at process startup. `/tower` appears in the command list only after the experiment is enabled.

Before starting, check out the local branch that should receive the changes and inspect the worktree:

```sh
cd /path/to/project
git status
```

Tower can merge only into a local branch, not a remote-tracking ref or tag. If the branch passed to `/tower <base-branch>` does not exist, Tower creates it from the current checkout. Using an existing branch with a clean worktree is the safest option.

::: warning
Tower may snapshot uncommitted and untracked files into worker branches; when creating a new base branch, it may also commit those changes to that branch. In a directory that is not yet a Git repository, Tower initialization runs `git init` and creates an initial commit containing the existing files. Check for secrets and large files first.
:::

## Run a workflow

1. **Activate Tower.** In most cases, run `/tower on`. On first initialization, Tower uses the current local branch as the base; on later activations, it reuses the recorded base. This command only enables Tower and sends no objective.

   If HEAD is detached (no branch is checked out), or you need to change the base, run `/tower <base-branch>` instead, for example `/tower feature/my-objective`.

2. **Send the development objective.** Enter the task as a normal chat message, for example: "Split the checkout documentation update into independent missions, test each one, and merge only branches that pass independent review." It is best to include how to verify the work and what completion means. Tower initializes `.tower/`, plans missions, and starts workers whose dependencies are satisfied in the background. When a worker finishes or Tower receives an inbox message, Tower resumes automatically, so you do not need to poll repeatedly.

3. **Let the work proceed in the background.** Workers commit changes on their branches. Tower assigns independent reviewers, rebases when needed, and merges approved missions in dependency order. Handle approval prompts and questions about scope or priority when they appear.

4. **Verify the merged result.** Inspect `git status`, the base branch history, and the final diff, and run the tests or acceptance checks you care about. These checks are only a baseline safeguard and do not replace human acceptance.

5. **Clean up and exit.** After every mission is merged or abandoned, run `/tower teardown` to clean up removable mission worktrees, then `/tower off` to exit Tower. See [Stop, teardown, and restart](#stop-teardown-and-restart) for the differences between these actions.

## Check status and intervene

You do not need to understand the worker communication protocol to monitor and intervene in Tower.

- **Read the dashboard:** `/tower` or `/tower status` reads the current state directly without triggering a new model request. It shows the base, missions, roster, merge checks, inbox count, concurrency, and recent activity.
- **Redirect work:** while Tower is active, send a normal message to add constraints, change priorities, or request a summary. After Tower relays a message to a worker, the worker sees it on the next step without interrupting the current tool call.
- **Inspect or stop an agent:** open `/tasks` to view background agent progress and output, and stop one if needed. For a worker or reviewer you stop deliberately, Tower does not resume, reassign, or replace it unless you say otherwise.
- **Change the base:** run `/tower <base-branch>` again. Tower re-evaluates existing missions against the new base, and only stale branches need a rebase. The main checkout must be on the recorded base before merging.

Each workspace can have only one tower coordinator. If another session is already using Tower for this project, the current session cannot enable it. Close Tower in the original session first.

## Understand merges and rebases

Before merging a mission, Tower confirms that it is complete and that its branch is up to date with the base. It also requires a valid clean review and merge approval, usually from an independent reviewer. Changes must stay within the mission scope, the main checkout must be on the recorded base, and there must be no conflicting uncommitted changes.

After the base advances, if the worker is idle and the worktree is clean, Tower can rebase the mission branch onto the new base in the corresponding worktree. If there are no conflicts, the existing clean review's binding is preserved. If a conflict occurs, the rebase is aborted and the worker resolves it.

Let Tower handle merges and rebases; do not run additional Git integration commands yourself. Do not edit files under `.tower/comms/` directly: status, notifications, and merge checks depend on these records. You can inspect branches and worktrees read-only.

## Stop, teardown, and restart

These actions clean up different things:

| Action | What it does | What remains |
| --- | --- | --- |
| `/tower off` | Exits Tower mode in the current session without stopping background agents or cleaning up files | `.tower/`, mission branches, and worktrees |
| `/tower teardown` | Asks the agent to remove eligible mission worktrees and report the result; worktrees with uncommitted changes or running agents are not removed | Mission branches and `.tower/comms/` audit records; Tower mode stays on |
| Exit Kimi Code or close the session | Stops Tower workers and reviewers; they must be spawned again later | On-disk `.tower/` state, branches, and worktrees |

After Kimi Code restarts, if another session takes over the current project, the previous session's roster entries become inactive, but missions and worktrees are preserved. The new coordinator must spawn workers again. A project cannot have multiple tower coordinators at the same time.

## Mode exclusivity and secondary model

Tower is mutually exclusive with Goal, Plan, and swarm modes. Entering Tower exits Plan or swarm and pauses the active goal; activating a goal or entering Plan or swarm also exits Tower. Tower state remains on disk, and you can return later with `/tower on`.

Workers and reviewers follow different model-selection rules. Without `[secondary_model]`, both use Tower's current primary model. Once it is configured, newly spawned workers use `default_model`, while **reviewers continue to use the primary model**; however, when `[secondary_model].force = true`, reviewers also use `default_model`. `TowerSpawn` currently does not support selecting a model for an individual mission or spawn. See [Subagent model pool](../configuration/config-files.md#subagent-model-pool) for configuration details.

To control token costs, you can assign workers a cheaper secondary model. When `force = true` is not set, reviewers remain on the primary model, preserving budget for independent review.

## Safety and resource cost

Worktrees isolate writes, but they are not a security sandbox. Workers can read repository content and run tools with your permissions. In Never Ask mode, workers and reviewers do not request your approval for individual actions. Tower workers do not have the `Agent` tool and cannot spawn subagents. Mission scopes and merge checks are process constraints, not security boundaries.

Each worker and reviewer has an independent model context and consumes tokens separately. Tower's planning, message routing, recovery, and merge turns also consume tokens. More agents increase pressure on quota, CPU, and disk. Tower limits concurrently spawned agents; `/tower status` shows the current budget and running count without starting a model turn. Start with a small number of independent missions and remove finished worktrees to reclaim disk space.

## Next steps

- [Slash commands](../reference/slash-commands.md#modes-run-control) — `/tower` command forms
- [Environment variables](../configuration/env-vars.md#runtime-switches) — `KIMI_CODE_EXPERIMENTAL_TOWER` and related runtime switches
- [Agents and Sub-Agents](../customization/agents.md) — simpler delegation for focused subtasks
