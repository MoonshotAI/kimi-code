Initialize a tower multi-agent workspace in the current repository.

Creates the .tower/ directory (comms state, inbox, findings, reviews, missions, activity log, worktree slots), enters tower mode, and activates the full tower tool set (TowerPlan/TowerSpawn/TowerMerge/TowerTeardown plus the shared TowerSend/TowerInbox/TowerFinding/TowerReview/TowerMission/TowerStatus).

Use this when a task is large enough to split across multiple parallel agents with isolated git worktrees and a review-gated merge protocol. Safe to call again — an existing workspace is reported, never reset. Re-entering from a new CLI session adopts the workspace: roster entries the previous session spawned are retired (their agent ids cannot be resumed across sessions), while missions, worktrees, and the activity log carry over.
