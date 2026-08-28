Spawn a tower worker or reviewer as a background subagent and register it in the tower roster.

Workers: pass mission_id — the tool creates the mission worktree, marks the mission active with this worker as owner, and briefs the agent with the full mission text. Reviewers: pass review_target — the agent gets a review checklist and must submit its verdict via TowerReview.

If the base checkout has uncommitted changes (staged, unstaged, or untracked) when a worker spawns, the tool captures them as a snapshot commit that becomes the mission branch's first commit — the worker starts from HEAD + that WIP instead of plain HEAD. The checkout itself is never touched (nothing is committed, staged, or stashed there), and the merge gate later diffs the branch from that snapshot, so the WIP is never mistaken for the worker's own scope. The snapshot only happens when the branch is first created; re-adding an existing branch reuses it as-is.

The briefing prompt is assembled by this tool (worktree path, scope, protocol rules); use instructions only for extra context. If the name is already registered, resume the existing agent with the Agent tool instead of spawning a duplicate.
