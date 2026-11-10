Tear down the tower workspace after all missions are merged (or abandoned).

Removes the mission worktrees and reports one line per worktree. A worktree is kept, with the reason in the report, when:

- its roster agent still has a running task in this session (`live agent: <name>`) — this protection cannot be overridden, not even with force;
- it is named in exclude (`excluded`);
- it contains uncommitted changes (`uncommitted changes`) — removed only when force is set.

Worktrees git no longer knows are reported as already removed. Set dry_run to preview the exact remove/keep decisions with their reasons before committing to them; a dry run changes nothing on disk or in state.

Tower mode stays active after teardown: the next objective starts with TowerInit, and the human turns the mode off explicitly with /tower off. The .tower/comms/ directory (state, inbox, findings, reviews, activity log) is always kept as the audit trail.
