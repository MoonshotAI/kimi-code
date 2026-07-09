Read the current goal: its objective, completion criterion, status, and budgets (turns, tokens,
time, and how much of each remains). When the goal has stopped, it also reports the terminal reason.

Use `GetGoal` before deciding whether to continue working, report completion, report a blocker,
or respect a pause. It returns `{ "goal": null }` when there is no current goal.
