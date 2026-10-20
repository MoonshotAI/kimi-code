Tear down the tower workspace after all missions are merged (or abandoned).

Removes the mission worktrees — worktrees with uncommitted changes are kept and listed unless force is set. Tower mode stays active after teardown: the next objective starts with TowerInit, and the human turns the mode off explicitly with /tower off. The .tower/comms/ directory (state, inbox, findings, reviews, activity log) is always kept as the audit trail.
