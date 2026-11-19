Initialize a tower multi-agent workspace in the current repository.

Creates the .tower/ directory (comms state, inbox, findings, reviews, missions, activity log, worktree slots) that the full tower tool set operates on.

Tower mode must already be active before you call this — while the mode is off this tool refuses, so ask the user to turn it on first. Only the user can enable it (`/tower on`); the agent can never enter tower mode by itself.

Idempotent — an existing workspace is reported, never reset. Re-entering from a new CLI session adopts the workspace: roster entries the previous session spawned are retired (their agent ids cannot be resumed across sessions), while missions, worktrees, and the activity log carry over.

Takes an optional `base`: the local branch that every mission forks from and merges back into (default: the branch currently checked out in the main worktree; a fresh init on a detached HEAD requires an explicit `base`). Missions, reviews, and the merge gate all evaluate against the recorded base. A re-init with no explicit base keeps the recorded one; a re-init with an explicit different base re-anchors the workspace to it — allowed anytime, even with open missions. Each open mission is then reported as up-to-date (its branch already contains the new base), stale (it does not and needs TowerRebase before merging), or no-branch (no branch exists yet); only stale branches must rebase onto the new base before merging. Only local branches are accepted (a remote-tracking ref such as "origin/main" cannot receive merges) — create a local branch first. When the base differs from the main checkout (or the checkout is detached), work proceeds normally but merges stay blocked until the checkout is switched to the base.
