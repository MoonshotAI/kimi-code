Wait for background tasks to finish without ending the current turn.

Only call this tool when you really have no other work to do and your next step cannot proceed without the result of a running background task (a sub-agent, a background bash command, or a background AskUserQuestion). The call suspends inside the current turn until the task finishes or the timeout elapses, then returns the outcome so you can keep working in the same turn. While waiting, no LLM requests are made, but the user is kept waiting too.

When background tasks finish, they notify you automatically, so you do not need to busily wait for them.

Guidelines:

- Before calling WaitFor, think about what else you can do meanwhile: another part of the task, verifying earlier work, or ending your turn with a progress update. If there is anything, do that instead.
- Do not call WaitFor right after dispatching work whose result you do not need yet.
- After a timeout, prefer moving on to other work over calling WaitFor again; repeated waits keep the user waiting.
- Without `task_id`, tasks started during the wait are not covered by it; their completion arrives via the usual automatic notification.
- With `task_id`, the wait ends when that task finishes. An unknown `task_id` is an error; a task that has already finished returns immediately.
- When no background tasks are running, WaitFor returns immediately without waiting.
- Waiting has no side effects on the waited tasks: WaitFor never stops a task, and interrupting the wait (for example, a new user message) leaves every task running.
- A finished task's result is delivered exactly once: tasks reported by WaitFor do not also produce an automatic completion notification.
- You can only wait for background tasks started by this agent; task IDs belonging to other agents are unknown here.
