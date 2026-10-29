Wait for background tasks to finish without ending the current turn.

The call suspends the turn until a task finishes or `timeout` elapses. No LLM requests are made while waiting, but the user waits too, and finished tasks notify you automatically anyway — so waiting is worth it only when your next step cannot proceed without a result and nothing else is left to do.

- Tasks started during a wait are not covered by it; their completion arrives through the usual automatic notification.
- An unknown `task_id` is an error; a task that has already finished, or a wait with no background tasks running, returns immediately.
- Waiting never stops a task, and an interrupted wait leaves every task running.
- A finished task's result is delivered once: tasks reported by WaitFor produce no separate completion notification.
- You can only wait for background tasks started by this agent.
