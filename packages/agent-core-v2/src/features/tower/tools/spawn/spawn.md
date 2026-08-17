Spawn a tower worker or reviewer as a background subagent and register it in the tower roster.

Workers: pass mission_id — the tool creates the mission worktree, marks the mission active with this worker as owner, and briefs the agent with the full mission text. Reviewers: pass review_target — the agent gets a review checklist and must submit its verdict via TowerReview.

The briefing prompt is assembled by this tool (worktree path, scope, protocol rules); use instructions only for extra context. If the name is already registered, resume the existing agent with the Agent tool instead of spawning a duplicate.
