# Tower multi-agent collaboration

Tower is an experimental coordination mode that helps complete larger coding objectives faster through asynchronous parallel development in a Git repository.

While workers develop independent missions in the background, you can check progress, send updates for the tower to relay, change direction or priorities, and stop an agent at any time. The main agent becomes the tower: it splits your objective into missions and coordinates the workers.

Independent review and merge checks support this parallel workflow. Each build mission has its own branch and git worktree (a separate checkout linked to the same repository). A worker implements one mission in that worktree and commits there; an independent reviewer then audits the branch read-only. The tower routes messages and completion reports, and merges only branches that pass its checks.

Tower is therefore not just an ordinary subagent or an AgentSwarm task. It is a user-enabled, session-level coordination mode with explicit repository state, review gates, and cleanup commands.

::: warning
Tower is experimental, and its workflow and safety details may change. Tower can create branches, commits, and worktrees, and its workers and reviewers run unattended with Never Ask permissions. Use Tower only in a repository and on an objective you trust, and inspect the final diff yourself.
:::

## When Tower fits

Tower uses more tokens and repository machinery to move independent work forward asynchronously in parallel while keeping you in control.

Tower is a good fit when:

- The objective is large enough to split into mostly independent missions with clear verification, so asynchronous parallel development can shorten the wait compared with implementing them one by one.
- You want to stay in control while they run: check progress, send updates for the tower to relay, adjust direction or priorities, and stop an agent at any time.
- You want each change committed on its own branch, independently reviewed, and integrated into a local base branch.

Tower is usually unnecessary when:

- A quick edit, exploration, or single answer can be handled by the main agent or an [ordinary subagent](../customization/agents.md).
- The work is tightly coupled around the same files, so parallel branches would create more integration work than useful parallelism.
- You do not want extra branches, worktrees, unattended commands, or the token cost of multiple agents.

## Enable Tower

Tower is off by default. Enable the experiment in one of these ways, then make sure Kimi Code has been restarted before using `/tower`.

For a persistent setting, add this to `config.toml` (by default, `~/.kimi-code/config.toml`; see [Config files](../configuration/config-files.md)):

```toml
[experimental]
tower = true
```

You can also open `/experiments`, enable **Tower mode**, and apply the change; this writes the same setting. Alternatively, enable Tower for one process by setting the environment variable before launch:

```sh
KIMI_CODE_EXPERIMENTAL_TOWER=1 kimi
```

The environment variable must be present at launch. If you change `/experiments` or `config.toml` while Kimi Code is running, restart it: Tower's tools and worker profile are assembled when the process starts. The `/tower` command appears only when the experiment is enabled.

Before starting, check out the local branch you want changes merged into and inspect the checkout:

```sh
cd /path/to/project
git status
```

Tower merges into a local branch, not a remote-tracking ref or tag. If the name passed to `/tower <base-branch>` does not exist, Tower creates that local branch from the current checkout. Using an existing branch in a clean checkout is the most predictable option.

::: warning
Uncommitted and untracked files can be snapshotted into worker branches; when Tower creates a new base branch, it can commit those changes onto that base. Initializing Tower in a directory that is not yet a Git repository can also run `git init` and create an initial commit containing the existing files. Check for secrets and large files first.
:::

## Run a workflow

1. **Activate Tower and choose the base.** In Kimi Code, run `/tower feature/my-objective`. This enables Tower and sets the merge target; it does **not** send an objective. If Tower is already active, the same form re-anchors the workspace to another local base; only stale open missions then need a rebase. Use `/tower on` to enable Tower without changing the recorded base; on first initialization, that defaults to the current local branch, while a detached HEAD (no branch checked out) requires an explicit base.

2. **Send the objective as a normal message.** For example: "Split the checkout documentation update into independent missions, test each one, and merge only branches that pass independent review." Include the desired verification and finish conditions. The tower initializes `.tower/`, plans missions, and starts dependency-unblocked workers in the background. Worker completions and inbox messages wake the tower, so you do not need to poll them.

3. **Let implementation, review, and integration finish.** Workers commit on their mission branches. The tower assigns independent reviewers, rebases branches when needed, and merges approved missions in dependency order. Follow any approval prompts raised by your own permission mode, and answer questions about scope or priorities.

4. **Verify the integrated result.** Inspect `git status`, the base branch history, and the final diff, and run the acceptance checks that matter to you. Tower's merge gate is a safeguard, not a substitute for your own acceptance decision.

5. **Clean up and exit.** After every mission is merged or abandoned, run `/tower teardown` to remove eligible mission worktrees, then `/tower off` to leave Tower mode. Read the differences between these actions in [Stop, teardown, and restart](#stop-teardown-and-restart).

## Check status and intervene

You can supervise the tower without driving the worker protocol yourself.

- **Read the dashboard:** `/tower` or `/tower status` reads and renders status directly, without starting a model turn. It shows the base, missions, roster, review gates, inbox count, concurrency, and recent activity.
- **Redirect the coordinator:** send a normal message while Tower is active. Input is steered into the running coordinator turn, so you can add constraints, change priorities, or ask for a summary. When the tower routes an update to a running worker, the worker sees it at the next step boundary; the current tool call is not interrupted.
- **Inspect or stop an agent:** open `/tasks` to view background agent progress and output, or stop one deliberately. Tower treats a user-stopped worker or reviewer as intentional and does not resume, reassign, or replace it unless you say otherwise.
- **Change the base:** run `/tower <base-branch>` again. Existing open missions are evaluated against the new base; only stale branches need a rebase. The main checkout must be on the recorded base before a merge can proceed.

One workspace has one tower coordinator. If a busy live session already owns it, another session cannot enable Tower there; continue in the owning session or close it first.

## Understand merges and rebases

Workers are assigned to implement missions in their own worktrees rather than in the main checkout. Before merging a build mission, Tower checks that it is complete with no open tasks or blockers, its workers are idle, its dependencies are resolved (merged or abandoned), and its branch is current with the base. It also requires a qualifying clean review with merge approval — normally from an independent reviewer — plus changes inside the mission scope, the main checkout on the recorded base, and no conflicting uncommitted files.

If the base advances, Tower can rebase a mission branch inside that mission's worktree while its worker is idle and the worktree is clean. A conflict-free rebase preserves the existing clean review's binding; a conflicting rebase is aborted and the mission goes back to the worker for resolution. Follow the structured result instead of assuming that every rebase or merge succeeded.

Let the tower perform Tower merges and rebases rather than running ad-hoc Git integration commands yourself. Do not hand-edit files under `.tower/comms/`: they are protocol records used by status, notification, and merge checks. Branches and worktrees remain available for your own read-only inspection.

## Stop, teardown, and restart

These actions have different cleanup boundaries:

| Action | What it does | What remains |
| --- | --- | --- |
| `/tower off` | Exits Tower mode in the current session. It does not stop already-running background agents or clean up files; stop agents through `/tasks` first if needed | `.tower/`, mission branches, and worktrees |
| `/tower teardown` | Asks the agent to remove eligible mission worktrees and report the result. Dirty worktrees and worktrees with live agents are protected | Mission branches and `.tower/comms/` audit records; Tower mode stays on |
| Exit Kimi Code or close the session | Stops background tasks by default; change [`background.keep_alive_on_exit`](../configuration/config-files.md#background) if your workflow requires otherwise | On-disk `.tower/` state, branches, and worktrees |

Resume the owning session after a restart when possible. If a different session adopts the workspace, roster entries from the previous session are retired, while missions and worktrees are preserved; the new coordinator must spawn fresh workers. Avoid driving the same workspace tower from two sessions.

Tower is also mutually exclusive with Goal, Plan, and swarm modes. Entering Tower exits Plan or swarm mode and pauses an active goal. Activating a goal exits Tower, as does entering Plan or swarm mode. The on-disk Tower state remains, so you can return later with `/tower on`.

## Safety and resource cost

Worktree isolation coordinates writes; it is not a security sandbox. Workers can read repository content and run tools with your permissions, and their Never Ask mode does not interrupt you for approval. Tower workers do not have the `Agent` tool, so they cannot delegate nested subagents, but mission scopes and merge checks should still be treated as coordination safeguards rather than a trust boundary.

Every worker and reviewer has an independent model context and consumes tokens independently. Coordinator planning, routing, recovery, and merge turns add further usage, so a larger fleet can increase quota pressure as well as local CPU and disk use. Tower limits concurrent agent spawns, and `/tower status` shows the current budget and in-flight count without itself starting a model turn. Start with a small number of independent missions, and remove finished worktrees to reclaim disk space.

## Next steps

- [Slash commands](../reference/slash-commands.md#modes-run-control) — exact `/tower` command forms and availability
- [Environment variables](../configuration/env-vars.md#runtime-switches) — `KIMI_CODE_EXPERIMENTAL_TOWER` and related runtime switches
- [Agents and Sub-Agents](../customization/agents.md) — the simpler delegation model for focused subtasks
