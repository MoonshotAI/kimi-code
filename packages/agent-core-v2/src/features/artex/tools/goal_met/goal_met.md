[End the entire task immediately] — call only when you are sure [all of the task's goals are truly met and it is complete overall] (the task as a whole; having met just one goal / one flag / one finding does not count — in that case mark that goal with prove_goal).

It is NOT for "ending this planning round": if there is no new intent to dispatch this round, or you are waiting on worker output, just end the round — do NOT call this tool (0 intents is a perfectly normal outcome). Prefer prove_goal to prove goals one by one; goal_met is only a means to skip per-goal proofs and complete the task globally.

- `reason`: grounds for completion (must be evidence that the goals are truly met, not a round-ending reason like "no new directions this round").
