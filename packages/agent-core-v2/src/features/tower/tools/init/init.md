Initialize a tower multi-agent workspace in the current repository.

Creates the .tower/ directory (comms state, inbox, findings, reviews, missions, activity log, worktree slots) that the full tower tool set operates on (TowerPlan/TowerSpawn/TowerMerge/TowerTeardown plus the shared TowerSend/TowerInbox/TowerFinding/TowerReview/TowerMission/TowerStatus).

Tower mode must already be active before you call this — only the user can enable it, with `/tower on`; the agent can never enter tower mode by itself. While the mode is off this tool refuses: ask the user to turn tower mode on first. Use tower only when a task is large enough to split across multiple parallel agents with isolated git worktrees and a review-gated merge protocol.

Safe to call again — an existing workspace is reported, never reset. Re-entering from a new CLI session adopts the workspace: roster entries the previous session spawned are retired (their agent ids cannot be resumed across sessions), while missions, worktrees, and the activity log carry over.

Takes an optional `base`: the local branch that every mission forks from and merges back into (default: the base the user enabled tower mode with via `/tower <base>`, falling back to the branch currently checked out in the main worktree). It is recorded for the workspace's lifetime — missions, reviews, and the merge gate all evaluate against it — so choose it at init time; a re-init reporting an existing workspace keeps the recorded base. Only local branches are accepted: a remote-tracking ref such as "origin/main" cannot receive merges, so create a local branch for it first. When the base differs from the main checkout (or the checkout is detached), work proceeds normally but merges stay blocked until the checkout is switched to the base.
