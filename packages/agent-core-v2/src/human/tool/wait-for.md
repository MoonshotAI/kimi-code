Wait for background tasks to finish without ending the current turn.

Use this when your next step depends on the result of a running background task (a sub-agent, a background bash command, or a background AskUserQuestion). The call suspends inside the current turn until the task finishes or the timeout elapses, then returns the outcome so you can keep working in the same turn. While waiting, no LLM requests are made.

Guidelines:

- Do not call WaitFor right after dispatching work whose result you do not need yet — finished background tasks notify you automatically. WaitFor is for the moment you genuinely cannot proceed without a result.
- `timeout` is required, in seconds, capped at 600. To wait longer, call WaitFor again; waking up periodically also lets you re-evaluate the situation.
- A timeout is not an error: the result lists the tasks that are still running, and you decide whether to wait again or do other work meanwhile.
- Without `task_id`, the wait ends as soon as any background task that was running at call time finishes. Tasks started during the wait are not covered by it; their completion arrives via the usual automatic notification.
- With `task_id`, the wait ends when that task finishes. An unknown `task_id` is an error; a task that has already finished returns immediately.
- When no background tasks are running, WaitFor returns immediately without waiting.
- When the wait ends because a task finished, the result also lists other tasks that finished during the wait window, so failures surface with context.
- Waiting has no side effects on the waited tasks: WaitFor never stops a task, and interrupting the wait (for example, a user interruption) leaves every task running.
- A finished task's result is delivered exactly once: tasks reported by WaitFor do not also produce an automatic completion notification.
- You can only wait for background tasks started by this agent; task IDs belonging to other agents are unknown here.
